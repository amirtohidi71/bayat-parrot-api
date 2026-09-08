import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { normalizeBirdPassportCode } from '../bird-passports/bird-passport-code';
import { normalizeBirdPassportMobile } from '../bird-passports/mobile-normalizer';
import {
  BirdPassport,
  BirdPassportStatus,
} from '../bird-passports/entities/bird-passport.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { VetAppointmentEvent } from './entities/appointment-event.entity';
import { VetAppointmentSlot } from './entities/appointment-slot.entity';
import { VetAppointment } from './entities/appointment.entity';
import { VetAvailabilityWindow } from './entities/availability-window.entity';
import { VetDoctor } from './entities/doctor.entity';
import {
  VetActorType,
  VetAppointmentStatus,
  VetAvailabilityStatus,
  VetPricingKind,
  VetSlotStatus,
} from './vet-appointment.enums';
import { encryptVetField } from './security/vet-field-encryption';

export interface CreateVetPaidHoldInput {
  bookingRequestId: string;
  slotId: string;
  passportCode?: string;
}

interface NormalizedHoldInput extends CreateVetPaidHoldInput {
  passportCode?: string;
}

export interface VetPaidHoldResult {
  appointmentId: string;
  bookingRequestId: string;
  slotId: string;
  status: VetAppointmentStatus.PAYMENT_PENDING | VetAppointmentStatus.EXPIRED;
  feeAmountMinor: string;
  currency: string;
  holdExpiresAt: string;
}

const DEFAULT_HOLD_SECONDS = 15 * 60;
const MAX_HOLD_SECONDS = 60 * 60;
const MAX_REAPER_BATCH = 100;

/** Internal Day 2E core. Deliberately has no controller or payment provider. */
@Injectable()
export class VetPaidHoldService {
  private readonly holdSeconds: number;

  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
  ) {
    const configured = config.get<string | number>('VET_PAYMENT_HOLD_SECONDS');
    const seconds =
      configured === undefined ? DEFAULT_HOLD_SECONDS : Number(configured);
    if (
      !Number.isInteger(seconds) ||
      seconds < 60 ||
      seconds > MAX_HOLD_SECONDS
    )
      throw new Error(
        'VET_PAYMENT_HOLD_SECONDS must be an integer from 60 to 3600',
      );
    this.holdSeconds = seconds;
  }

  async createInternalHold(
    customerUserId: string,
    raw: CreateVetPaidHoldInput,
  ): Promise<VetPaidHoldResult> {
    const input = this.input(customerUserId, raw);
    const retry = await this.existing(
      this.source.manager,
      customerUserId,
      input,
    );
    if (retry) return retry;
    return this.write(
      async (manager) => {
        const inTransactionRetry = await this.existing(
          manager,
          customerUserId,
          input,
        );
        if (inTransactionRetry) return inTransactionRetry;

        // Slot is the first row lock, matching availability cancellation order.
        const slot = await manager.getRepository(VetAppointmentSlot).findOne({
          where: { id: input.slotId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!slot)
          throw new NotFoundException('Vet appointment slot not found');
        const [{ now, expiresAt }] = await manager.query<
          Array<{ now: Date; expiresAt: Date }>
        >(
          'SELECT transaction_timestamp() AS now, transaction_timestamp() + ($1 * interval \'1 second\') AS "expiresAt"',
          [this.holdSeconds],
        );
        if (
          slot.status !== VetSlotStatus.AVAILABLE ||
          slot.startsAt.getTime() <= now.getTime()
        )
          throw new ConflictException('Vet appointment slot is unavailable');
        const occupied = await manager.query<unknown[]>(
          `SELECT 1 FROM public.vet_appointments
         WHERE "slotId"=$1 AND status IN ('PAYMENT_PENDING','CONFIRMED','COMPLETED','NO_SHOW') LIMIT 1`,
          [slot.id],
        );
        if (occupied.length)
          throw new ConflictException('Vet appointment slot is unavailable');

        const user = await manager.getRepository(User).findOne({
          select: {
            id: true,
            phone: true,
            firstName: true,
            lastName: true,
            nationalId: true,
            profileCompleted: true,
            role: true,
          },
          where: { id: customerUserId },
          lock: { mode: 'pessimistic_read' },
        });
        if (!user) throw new NotFoundException('Customer not found');
        if (user.role !== UserRole.CUSTOMER)
          throw new ForbiddenException('Customer access required');
        const ownerFullName = this.customerProfile(user);

        const passport = input.passportCode
          ? await manager.getRepository(BirdPassport).findOne({
              select: {
                id: true,
                code: true,
                ownerMobile: true,
                ownerFullName: true,
                birdName: true,
                species: true,
                status: true,
              },
              where: { code: input.passportCode },
              lock: { mode: 'pessimistic_read' },
            })
          : null;
        if (input.passportCode && !passport)
          throw new NotFoundException('Bird passport not found');
        if (passport) {
          this.authorizePassport(passport, user);
          this.bookablePassport(passport);
        }

        const doctor = await manager.getRepository(VetDoctor).findOne({
          select: {
            id: true,
            displayName: true,
            active: true,
            consultationFeeMinor: true,
            currency: true,
          },
          where: { id: slot.doctorId },
          lock: { mode: 'pessimistic_read' },
        });
        if (!doctor) throw new NotFoundException('Vet doctor not found');
        if (!doctor.active)
          throw new ConflictException('Vet doctor is inactive');
        if (!/^[1-9][0-9]*$/.test(String(doctor.consultationFeeMinor)))
          throw new ConflictException('Paid consultation fee is unavailable');

        const window = await manager
          .getRepository(VetAvailabilityWindow)
          .findOne({
            select: { id: true, status: true },
            where: { id: slot.availabilityWindowId },
          });
        if (!window || window.status !== VetAvailabilityStatus.ACTIVE)
          throw new ConflictException('Vet appointment slot is unavailable');

        const appointmentId = randomUUID();
        const appointment = manager.getRepository(VetAppointment).create({
          id: appointmentId,
          publicReference: `V${randomBytes(8).toString('hex').toUpperCase()}`,
          bookingRequestId: input.bookingRequestId,
          customerUserId,
          slotId: slot.id,
          doctorId: doctor.id,
          birdPassportId: passport?.id ?? null,
          status: VetAppointmentStatus.PAYMENT_PENDING,
          pricingKind: VetPricingKind.PAID,
          feeAmountMinor: String(doctor.consultationFeeMinor),
          currency: doctor.currency,
          pricingRuleVersion: 'vet-paid-hold-v1',
          holdExpiresAt: expiresAt,
          ownerFullNameSnapshot: ownerFullName,
          ownerMobileSnapshot: normalizeBirdPassportMobile(user.phone),
          doctorNameSnapshot: doctor.displayName.trim(),
          passportCodeSnapshot: passport?.code ?? null,
          birdNameSnapshot: passport?.birdName?.trim() ?? null,
          birdSpeciesSnapshot: passport?.species?.trim() ?? null,
          passportOwnerFullNameSnapshot:
            passport?.ownerFullName?.trim() ?? null,
          nationalIdCiphertext: encryptVetField(
            user.nationalId,
            this.encryptionKey(),
            `${appointmentId}:nationalId`,
          ),
          nationalIdLast4: user.nationalId.slice(-4),
          confirmedAt: null,
          completedAt: null,
          cancelledAt: null,
          cancelledByType: null,
          cancelledById: null,
          cancellationReason: null,
        });
        await manager.getRepository(VetAppointment).insert(appointment);
        await manager.getRepository(VetAppointmentEvent).insert({
          appointmentId,
          eventType: 'HOLD_CREATED',
          eventKey: 'paid-hold-created',
          actorType: VetActorType.SYSTEM,
          actorId: null,
          previousStatus: null,
          newStatus: VetAppointmentStatus.PAYMENT_PENDING,
          metadata: {},
        });
        return this.result(appointment);
      },
      customerUserId,
      input,
    );
  }

  async expireHolds(batchSize = 50): Promise<{ expired: number }> {
    if (
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > MAX_REAPER_BATCH
    )
      throw new BadRequestException('Invalid hold expiry batch size');
    return this.write(async (manager) => {
      const rows = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM public.vet_appointments
         WHERE status='PAYMENT_PENDING' AND "holdExpiresAt" <= transaction_timestamp()
         ORDER BY "holdExpiresAt", id
         FOR UPDATE SKIP LOCKED LIMIT $1`,
        [batchSize],
      );
      if (!rows.length) return { expired: 0 };
      const ids = rows.map((row) => row.id);
      const updated = await manager.query<Array<{ id: string }>>(
        `WITH updated AS (
           UPDATE public.vet_appointments
           SET status='EXPIRED', "updatedAt"=transaction_timestamp()
           WHERE id = ANY($1::uuid[]) AND status='PAYMENT_PENDING'
             AND "holdExpiresAt" <= transaction_timestamp()
           RETURNING id
         ) SELECT id FROM updated ORDER BY id`,
        [ids],
      );
      if (updated.length !== ids.length)
        throw new ConflictException('Expired hold state changed concurrently');
      await manager.getRepository(VetAppointmentEvent).insert(
        updated.map(({ id }) => ({
          appointmentId: id,
          eventType: 'HOLD_EXPIRED',
          eventKey: 'paid-hold-expired',
          actorType: VetActorType.SYSTEM,
          actorId: null,
          previousStatus: VetAppointmentStatus.PAYMENT_PENDING,
          newStatus: VetAppointmentStatus.EXPIRED,
          metadata: {},
        })),
      );
      return { expired: updated.length };
    });
  }

  private async write<T>(
    action: (manager: EntityManager) => Promise<T>,
    customerUserId?: string,
    input?: NormalizedHoldInput,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.source.transaction(
          'READ COMMITTED',
          async (manager) => {
            await manager.query("SET LOCAL lock_timeout = '5s'");
            await manager.query("SET LOCAL statement_timeout = '15s'");
            return action(manager);
          },
        );
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const code = this.postgresCode(error);
        if (['40P01', '40001', '55P03'].includes(code ?? '') && attempt < 2)
          continue;
        if (code === '23505' && customerUserId && input) {
          const existing = await this.existing(
            this.source.manager,
            customerUserId,
            input,
          );
          if (existing) return existing as T;
        }
        if (
          [
            '23505',
            '23P01',
            '23514',
            '23503',
            '40P01',
            '40001',
            '55P03',
            '57014',
          ].includes(code ?? '')
        )
          throw new ConflictException(
            'Vet hold conflicts with current scheduling state',
          );
        if (['22007', '22008', '22P02', '22003'].includes(code ?? ''))
          throw new BadRequestException('Invalid vet hold input');
        throw new InternalServerErrorException('Vet hold operation failed');
      }
    }
  }

  private async existing(
    manager: EntityManager,
    customerUserId: string,
    input: NormalizedHoldInput,
  ): Promise<VetPaidHoldResult | null> {
    const appointment = await manager.getRepository(VetAppointment).findOneBy({
      customerUserId,
      bookingRequestId: input.bookingRequestId,
    });
    if (!appointment) return null;
    if (
      appointment.pricingKind !== VetPricingKind.PAID ||
      appointment.slotId !== input.slotId ||
      appointment.passportCodeSnapshot !== (input.passportCode ?? null) ||
      !appointment.holdExpiresAt ||
      ![
        VetAppointmentStatus.PAYMENT_PENDING,
        VetAppointmentStatus.EXPIRED,
      ].includes(appointment.status)
    )
      throw new ConflictException(
        'Booking request identifier was already used',
      );
    return this.result(appointment);
  }

  private result(appointment: VetAppointment): VetPaidHoldResult {
    if (!appointment.slotId || !appointment.holdExpiresAt)
      throw new InternalServerErrorException('Vet hold state is invalid');
    return {
      appointmentId: appointment.id,
      bookingRequestId: appointment.bookingRequestId,
      slotId: appointment.slotId,
      status: appointment.status as
        | VetAppointmentStatus.PAYMENT_PENDING
        | VetAppointmentStatus.EXPIRED,
      feeAmountMinor: appointment.feeAmountMinor,
      currency: appointment.currency,
      holdExpiresAt: appointment.holdExpiresAt.toISOString(),
    };
  }

  private input(
    customerUserId: string,
    input: CreateVetPaidHoldInput,
  ): NormalizedHoldInput {
    if (
      !isUUID(customerUserId) ||
      !isUUID(input?.bookingRequestId) ||
      !isUUID(input?.slotId)
    )
      throw new BadRequestException('Invalid vet hold identifier');
    return {
      bookingRequestId: input.bookingRequestId.toLowerCase(),
      slotId: input.slotId.toLowerCase(),
      ...(input.passportCode
        ? { passportCode: normalizeBirdPassportCode(input.passportCode) }
        : {}),
    };
  }

  private customerProfile(user: User): string {
    const firstName = user.firstName?.trim() ?? '';
    const lastName = user.lastName?.trim() ?? '';
    const fullName = `${firstName} ${lastName}`;
    if (
      !user.profileCompleted ||
      !firstName ||
      !lastName ||
      fullName.length > 150 ||
      !/^09[0-9]{9}$/.test(user.phone) ||
      !/^[0-9]{10}$/.test(user.nationalId ?? '')
    )
      throw new BadRequestException('Customer profile is incomplete');
    return fullName;
  }

  private authorizePassport(passport: BirdPassport, user: User): void {
    if (
      normalizeBirdPassportMobile(passport.ownerMobile) !==
      normalizeBirdPassportMobile(user.phone)
    )
      throw new ForbiddenException('Bird passport does not belong to customer');
  }

  private bookablePassport(passport: BirdPassport): void {
    if (
      passport.status !== BirdPassportStatus.ACTIVE ||
      !passport.ownerFullName?.trim() ||
      !passport.birdName?.trim() ||
      !passport.species?.trim() ||
      passport.ownerFullName.trim().length > 150 ||
      passport.birdName.trim().length > 100 ||
      passport.species.trim().length > 150
    )
      throw new ConflictException('Bird passport is not bookable');
  }

  private encryptionKey(): Buffer {
    const encoded = (
      this.config.get<string>('VET_FIELD_ENCRYPTION_KEY') ??
      this.config.get<string>('VET_FIELD_ENCRYPTION_KEY_BASE64') ??
      ''
    ).trim();
    let key: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(encoded)) key = Buffer.from(encoded, 'hex');
    else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded))
      key = Buffer.from(encoded, 'base64');
    else key = Buffer.alloc(0);
    if (key.length !== 32)
      throw new InternalServerErrorException(
        'Vet hold encryption is not configured',
      );
    return key;
  }

  private postgresCode(error: unknown): string | undefined {
    return error instanceof QueryFailedError
      ? (error.driverError as { code?: string }).code
      : undefined;
  }
}
