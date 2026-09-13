import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, QueryRunner } from 'typeorm';
import { SmsService } from '../common/sms/sms.service';
import { getSmsErrorCode } from '../common/sms/sms.types';

export const VET_REMINDER_NOTIFICATION_TYPE = 'APPOINTMENT_REMINDER_24H';
export const VET_REMINDER_TEMPLATE = 'vet.appointment-reminder-24h';
export const VET_REMINDER_LEAD_HOURS = 24;
export const VET_REMINDER_WORKER_INTERVAL_MS = 60_000;
export const VET_REMINDER_LEASE_SECONDS = 120;
export const VET_REMINDER_BATCH_SIZE = 10;
export const VET_REMINDER_SCHEDULE_HORIZON_DAYS = 8;
export const VET_REMINDER_MAX_ATTEMPTS = 5;
const RETRY_BASE_SECONDS = 60;
const RETRY_MAX_SECONDS = 3_600;

export interface VetReminderClaim {
  id: string;
  attemptCount: number;
  leaseExpiresAt: Date;
}

interface VetReminderDelivery {
  phone: string;
  doctorDisplayName: string;
  startsAt: Date;
}

@Injectable()
export class VetReminderWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(VetReminderWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly source: DataSource,
    private readonly sms: SmsService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled()) return;
    this.timer = setInterval(
      () => void this.runOnce(),
      VET_REMINDER_WORKER_INTERVAL_MS,
    );
    this.timer.unref();
    void this.runOnce();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.scheduleReminders();
      const claims = await this.claimDueRows();
      for (const claim of claims) {
        try {
          await this.deliverClaim(claim);
        } catch {
          this.logger.warn('Vet reminder delivery transaction failed');
        }
      }
    } catch {
      this.logger.warn('Vet reminder cycle failed');
    } finally {
      this.running = false;
    }
  }

  async scheduleReminders(): Promise<number> {
    const rows = await this.source.query<Array<{ id: string }>>(
      `INSERT INTO public.vet_notification_outbox
         ("appointmentId", "recipientType", "recipientPhoneSnapshot",
          "notificationType", template, payload, status, "attemptCount",
          "nextAttemptAt", "leaseExpiresAt", "deliveredAt", "lastErrorCode")
       SELECT appointment.id, 'CUSTOMER', appointment."ownerMobileSnapshot",
              $1, $2, '{}'::jsonb, 'PENDING', 0,
              GREATEST(
                slot."startsAt" - make_interval(hours => $3),
                transaction_timestamp()
              ),
              NULL, NULL, NULL
       FROM public.vet_appointments appointment
       JOIN public.vet_appointment_slots slot ON slot.id = appointment."slotId"
       WHERE appointment.status = 'CONFIRMED'
         AND appointment."confirmedAt" IS NOT NULL
         AND appointment."ownerMobileSnapshot" ~ '^09[0-9]{9}$'
         AND slot."startsAt" > transaction_timestamp()
         AND slot."startsAt" <= transaction_timestamp() + make_interval(days => $4)
       ORDER BY slot."startsAt", appointment.id
       LIMIT $5
       ON CONFLICT ("appointmentId", "notificationType", "recipientType", "recipientPhoneSnapshot")
       DO NOTHING
       RETURNING id`,
      [
        VET_REMINDER_NOTIFICATION_TYPE,
        VET_REMINDER_TEMPLATE,
        VET_REMINDER_LEAD_HOURS,
        VET_REMINDER_SCHEDULE_HORIZON_DAYS,
        VET_REMINDER_BATCH_SIZE,
      ],
    );
    return rows.length;
  }

  async claimDueRows(): Promise<VetReminderClaim[]> {
    const result = await this.source.query<
      Array<{ id: string; attemptCount: number; leaseExpiresAt: Date }>
    >(
      `WITH due AS (
         SELECT notification.id
         FROM public.vet_notification_outbox notification
         JOIN public.vet_appointments appointment
           ON appointment.id = notification."appointmentId"
         JOIN public.vet_appointment_slots slot
           ON slot.id = appointment."slotId"
         WHERE notification."notificationType" = $1
           AND notification."recipientType" = 'CUSTOMER'
           AND notification."attemptCount" < $2
           AND (
             (notification.status IN ('PENDING', 'FAILED')
               AND notification."nextAttemptAt" <= transaction_timestamp())
             OR
             (notification.status = 'SENDING'
               AND notification."leaseExpiresAt" <= transaction_timestamp())
           )
           AND appointment.status = 'CONFIRMED'
           AND appointment."confirmedAt" IS NOT NULL
           AND appointment."ownerMobileSnapshot" = notification."recipientPhoneSnapshot"
           AND appointment."ownerMobileSnapshot" ~ '^09[0-9]{9}$'
           AND slot."startsAt" > transaction_timestamp()
         ORDER BY notification."nextAttemptAt", notification.id
         FOR UPDATE OF notification SKIP LOCKED
         LIMIT $3
       )
       UPDATE public.vet_notification_outbox notification
       SET status = 'SENDING',
           "attemptCount" = notification."attemptCount" + 1,
           "leaseExpiresAt" = transaction_timestamp() + make_interval(secs => $4),
           "lastErrorCode" = NULL,
           "updatedAt" = transaction_timestamp()
       FROM due
       WHERE notification.id = due.id
       RETURNING notification.id,
                 notification."attemptCount" AS "attemptCount",
                 notification."leaseExpiresAt" AS "leaseExpiresAt"`,
      [
        VET_REMINDER_NOTIFICATION_TYPE,
        VET_REMINDER_MAX_ATTEMPTS,
        VET_REMINDER_BATCH_SIZE,
        VET_REMINDER_LEASE_SECONDS,
      ],
    );
    return returnedRows<{
      id: string;
      attemptCount: number;
      leaseExpiresAt: Date;
    }>(result);
  }

  async deliverClaim(claim: VetReminderClaim): Promise<void> {
    const runner = this.source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('READ COMMITTED');
    try {
      const delivery = await this.lockEligibleDelivery(runner, claim);
      if (!delivery) {
        await this.markIneligible(runner, claim);
        await runner.commitTransaction();
        return;
      }
      try {
        await this.sms.sendText(
          delivery.phone,
          buildVetReminderMessage(
            delivery.doctorDisplayName,
            delivery.startsAt,
          ),
        );
      } catch (error) {
        await this.markFailed(runner, claim, getSmsErrorCode(error));
        await runner.commitTransaction();
        return;
      }
      const delivered = returnedRows<{ id: string }>(
        await runner.query(
          `UPDATE public.vet_notification_outbox
           SET status = 'DELIVERED',
               "deliveredAt" = transaction_timestamp(),
               "leaseExpiresAt" = NULL,
               "lastErrorCode" = NULL,
               "updatedAt" = transaction_timestamp()
           WHERE id = $1
             AND status = 'SENDING'
           RETURNING id`,
          [claim.id],
        ),
      );
      if (delivered.length !== 1) throw new Error('Reminder lease lost');
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async lockEligibleDelivery(
    runner: QueryRunner,
    claim: VetReminderClaim,
  ): Promise<VetReminderDelivery | null> {
    const rows = (await runner.query(
      `SELECT appointment."ownerMobileSnapshot" AS phone,
              appointment."doctorNameSnapshot" AS "doctorDisplayName",
              slot."startsAt" AS "startsAt"
       FROM public.vet_notification_outbox notification
       JOIN public.vet_appointments appointment
         ON appointment.id = notification."appointmentId"
       JOIN public.vet_appointment_slots slot ON slot.id = appointment."slotId"
       WHERE notification.id = $1
         AND notification.status = 'SENDING'
         AND notification."leaseExpiresAt" > transaction_timestamp()
         AND notification."notificationType" = $2
         AND notification."recipientType" = 'CUSTOMER'
         AND notification."recipientPhoneSnapshot" = appointment."ownerMobileSnapshot"
         AND appointment."ownerMobileSnapshot" ~ '^09[0-9]{9}$'
         AND appointment.status = 'CONFIRMED'
         AND appointment."confirmedAt" IS NOT NULL
         AND slot."startsAt" > transaction_timestamp()
       FOR UPDATE OF notification, appointment`,
      [claim.id, VET_REMINDER_NOTIFICATION_TYPE],
    )) as Array<{
      phone: string;
      doctorDisplayName: string;
      startsAt: Date;
    }>;
    return rows[0] ?? null;
  }

  private async markFailed(
    runner: QueryRunner,
    claim: VetReminderClaim,
    errorCode: string,
  ): Promise<void> {
    await runner.query(
      `UPDATE public.vet_notification_outbox
       SET status = 'FAILED',
           "nextAttemptAt" = transaction_timestamp() + make_interval(secs => $2),
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = $3,
           "updatedAt" = transaction_timestamp()
       WHERE id = $1 AND status = 'SENDING'`,
      [
        claim.id,
        retryDelaySeconds(claim.attemptCount),
        errorCode.slice(0, 100),
      ],
    );
  }

  private async markIneligible(
    runner: QueryRunner,
    claim: VetReminderClaim,
  ): Promise<void> {
    await runner.query(
      `UPDATE public.vet_notification_outbox
       SET status = 'FAILED',
           "attemptCount" = $2,
           "nextAttemptAt" = transaction_timestamp(),
           "leaseExpiresAt" = NULL,
           "lastErrorCode" = 'APPOINTMENT_INELIGIBLE',
           "updatedAt" = transaction_timestamp()
       WHERE id = $1 AND status = 'SENDING'`,
      [claim.id, VET_REMINDER_MAX_ATTEMPTS],
    );
  }

  private enabled(): boolean {
    const configured = this.config
      .get<string>('VET_REMINDER_WORKER_ENABLED')
      ?.trim()
      .toLowerCase();
    if (configured !== undefined) return configured === 'true';
    return this.config.get<string>('NODE_ENV') !== 'test';
  }
}

export function retryDelaySeconds(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 10));
  return Math.min(RETRY_BASE_SECONDS * 2 ** exponent, RETRY_MAX_SECONDS);
}

export function buildVetReminderMessage(
  doctorDisplayName: string,
  startsAt: Date,
): string {
  const doctor = doctorDisplayName.trim();
  if (!doctor || !Number.isFinite(startsAt.getTime()))
    throw new Error('Invalid vet reminder data');
  const date = new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Tehran',
  }).format(startsAt);
  return `یادآوری نوبت دامپزشکی شما: ${date} با ${doctor}.`;
}

function returnedRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (Array.isArray(result[0]) && typeof result[1] === 'number')
    return result[0] as T[];
  return result as T[];
}
