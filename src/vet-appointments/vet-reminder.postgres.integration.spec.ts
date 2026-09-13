import { ConfigService } from '@nestjs/config';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource, QueryRunner } from 'typeorm';
import { VET_TEST_ENTITIES } from '../../test/vet-test-entities';
import { SmsError } from '../common/sms/sms.types';
import { SmsService } from '../common/sms/sms.service';
import { User, UserRole } from '../users/entities/user.entity';
import { VetAvailabilityService } from './availability.service';
import { VetDoctor } from './entities/doctor.entity';
import { VET_ENTITIES } from './vet-appointments.module';
import { VetManualAssignmentService } from './vet-manual-assignment.service';
import {
  VET_REMINDER_LEAD_HOURS,
  VET_REMINDER_NOTIFICATION_TYPE,
  VetReminderWorker,
} from './vet-reminder.worker';

const enabled =
  process.env.VET_RUN_DB_TESTS === '1' &&
  process.env.VET_TEST_DATABASE_CONFIRM === 'DISPOSABLE';
const describeDatabase = enabled ? describe : describe.skip;
const testHash = '$2b$12$' + 'a'.repeat(53);
const testKey = randomBytes(32);

describeDatabase('vet appointment reminders real PostgreSQL', () => {
  let source: DataSource;
  let availability: VetAvailabilityService;
  let assignments: VetManualAssignmentService;
  let suiteLock: QueryRunner | undefined;
  let disposableConfirmed = false;
  const createdUsers: string[] = [];

  beforeAll(async () => {
    const value = process.env.VET_TEST_DATABASE_URL?.trim();
    if (!value) throw new Error('VET_TEST_DATABASE_URL is required');
    const url = new URL(value);
    if (
      url.pathname.slice(1) !== 'vet_appointments_disposable_test' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.search ||
      url.hash
    )
      throw new Error(
        'Local dedicated disposable PostgreSQL URL required; no URL options allowed',
      );
    source = new DataSource({
      type: 'postgres',
      url: value,
      entities: VET_TEST_ENTITIES,
      synchronize: false,
      logging: false,
      extra: { max: 12 },
    });
    await source.initialize();
    const [identity] = await source.query<
      Array<{ database: string; address: string }>
    >(
      'SELECT current_database() AS database, host(inet_server_addr()) AS address',
    );
    if (
      identity.database !== 'vet_appointments_disposable_test' ||
      !['127.0.0.1', '::1'].includes(identity.address)
    )
      throw new Error('Disposable database identity mismatch');
    suiteLock = source.createQueryRunner();
    await suiteLock.connect();
    await suiteLock.query(
      "SELECT pg_advisory_lock(hashtextextended('test:vet-postgres-suites', 0))",
    );
    disposableConfirmed = true;
    await provisionDisposableParents();
    await dropVetObjects();
    await source.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    for (const name of [
      '20260907-create-vet-appointments-v1.sql',
      '20260907-enable-vet-availability-replacement.sql',
      '20260908-enable-vet-paid-holds.sql',
      '20260909-enable-vet-admin-manual-assignment.sql',
    ])
      await applyMigration(name);
    availability = new VetAvailabilityService(source);
    assignments = new VetManualAssignmentService(
      source,
      new ConfigService({
        VET_FIELD_ENCRYPTION_KEY: testKey.toString('base64'),
      }),
    );
  }, 60_000);

  afterAll(async () => {
    if (!source?.isInitialized) return;
    try {
      if (disposableConfirmed) {
        await dropVetObjects();
        if (createdUsers.length)
          await source
            .getRepository(User)
            .delete(createdUsers.map((id) => ({ id })));
      }
    } finally {
      if (suiteLock) {
        try {
          await suiteLock.query(
            "SELECT pg_advisory_unlock(hashtextextended('test:vet-postgres-suites', 0))",
          );
        } finally {
          await suiteLock.release();
        }
      }
      await source.destroy();
    }
  });

  it('schedules once at the bounded reminder time and excludes terminal appointments', async () => {
    const confirmed = await confirmedAppointment(48);
    const cancelled = await confirmedAppointment(49);
    const completed = await confirmedAppointment(50);
    await source.query(
      `UPDATE public.vet_appointments
       SET status='CANCELLED', "cancelledAt"=transaction_timestamp(),
           "cancelledByType"='ADMIN', "cancelledById"='test-admin',
           "cancellationReason"='integration test'
       WHERE id=$1`,
      [cancelled.appointmentId],
    );
    await source.query(
      `UPDATE public.vet_appointments
       SET status='COMPLETED', "completedAt"=transaction_timestamp()
       WHERE id=$1`,
      [completed.appointmentId],
    );
    const worker = createWorker({ sendText: jest.fn() });

    expect(await worker.scheduleReminders()).toBe(1);
    expect(await worker.scheduleReminders()).toBe(0);
    const rows = await source.query<
      Array<{
        appointmentId: string;
        nextAttemptAt: Date;
        startsAt: Date;
        payload: Record<string, unknown>;
      }>
    >(
      `SELECT notification."appointmentId" AS "appointmentId",
              notification."nextAttemptAt" AS "nextAttemptAt",
              notification.payload,
              slot."startsAt" AS "startsAt"
       FROM public.vet_notification_outbox notification
       JOIN public.vet_appointments appointment ON appointment.id=notification."appointmentId"
       JOIN public.vet_appointment_slots slot ON slot.id=appointment."slotId"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].appointmentId).toBe(confirmed.appointmentId);
    expect(rows[0].payload).toEqual({});
    expect(rows[0].startsAt.getTime() - rows[0].nextAttemptAt.getTime()).toBe(
      VET_REMINDER_LEAD_HOURS * 60 * 60 * 1000,
    );
  });

  it('claims due reminders once across concurrent workers', async () => {
    const first = await confirmedAppointment(1);
    const second = await confirmedAppointment(2);
    const workerOne = createWorker({ sendText: jest.fn() });
    const workerTwo = createWorker({ sendText: jest.fn() });
    await workerOne.scheduleReminders();

    const [one, two] = await Promise.all([
      workerOne.claimDueRows(),
      workerTwo.claimDueRows(),
    ]);
    const claimed = [...one, ...two];
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((row) => row.id)).size).toBe(2);
    const appointmentIds = await source.query<Array<{ appointmentId: string }>>(
      `SELECT "appointmentId" FROM public.vet_notification_outbox
       WHERE id = ANY($1::uuid[])`,
      [claimed.map((row) => row.id)],
    );
    expect(new Set(appointmentIds.map((row) => row.appointmentId))).toEqual(
      new Set([first.appointmentId, second.appointmentId]),
    );
  });

  it('retries a failed SMS and atomically marks successful delivery', async () => {
    const appointment = await confirmedAppointment(3);
    const sendText = jest
      .fn<Promise<void>, [string, string]>()
      .mockRejectedValueOnce(new SmsError('SMS_TIMEOUT'))
      .mockResolvedValueOnce();
    const worker = createWorker({ sendText });

    await worker.scheduleReminders();
    const [firstClaim] = await worker.claimDueRows();
    await worker.deliverClaim(firstClaim);
    let [row] = await reminder(appointment.appointmentId);
    expect(row).toMatchObject({
      status: 'FAILED',
      attemptCount: 1,
      deliveredAt: null,
      leaseExpiresAt: null,
      lastErrorCode: 'SMS_TIMEOUT',
    });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await source.query(
      `UPDATE public.vet_notification_outbox
       SET "nextAttemptAt"=transaction_timestamp()
       WHERE "appointmentId"=$1 AND "notificationType"=$2`,
      [appointment.appointmentId, VET_REMINDER_NOTIFICATION_TYPE],
    );
    const [retryClaim] = await worker.claimDueRows();
    await worker.deliverClaim(retryClaim);
    [row] = await reminder(appointment.appointmentId);
    expect(row).toMatchObject({
      status: 'DELIVERED',
      attemptCount: 2,
      leaseExpiresAt: null,
      lastErrorCode: null,
    });
    expect(row.deliveredAt).toBeInstanceOf(Date);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.calls[0][0]).toMatch(/^09[0-9]{9}$/);
    expect(sendText.mock.calls[0][1]).not.toMatch(/token|https?:|room/i);
  });

  function createWorker(sms: { sendText: jest.Mock }) {
    return new VetReminderWorker(
      source,
      sms as unknown as SmsService,
      new ConfigService({ NODE_ENV: 'test' }),
    );
  }

  async function reminder(appointmentId: string) {
    return source.query<
      Array<{
        status: string;
        attemptCount: number;
        nextAttemptAt: Date;
        leaseExpiresAt: Date | null;
        deliveredAt: Date | null;
        lastErrorCode: string | null;
      }>
    >(
      `SELECT status, "attemptCount" AS "attemptCount",
              "nextAttemptAt" AS "nextAttemptAt",
              "leaseExpiresAt" AS "leaseExpiresAt",
              "deliveredAt" AS "deliveredAt",
              "lastErrorCode" AS "lastErrorCode"
       FROM public.vet_notification_outbox
       WHERE "appointmentId"=$1 AND "notificationType"=$2`,
      [appointmentId, VET_REMINDER_NOTIFICATION_TYPE],
    );
  }

  async function confirmedAppointment(hoursFromNow: number) {
    const customer = await user();
    const fixture = await availabilityFixture(hoursFromNow);
    return assignments.create(
      { customerUserId: customer.id, slotId: fixture.slotId },
      'test-admin',
    );
  }

  async function user() {
    const suffix = String(randomInt(100_000_000, 1_000_000_000));
    const value = await source.getRepository(User).save({
      id: randomUUID(),
      phone: `09${suffix}`,
      firstName: 'Test',
      lastName: 'Customer',
      nationalId: `0${suffix}`,
      profileCompleted: true,
      loyaltyPoints: 0,
      role: UserRole.CUSTOMER,
    });
    createdUsers.push(value.id);
    return value;
  }

  async function availabilityFixture(hoursFromNow: number) {
    const doctor = await source.getRepository(VetDoctor).save({
      username: `doctor_${randomBytes(5).toString('hex')}`,
      passwordHash: testHash,
      displayName: 'Test Doctor',
      mobile: `09${String(randomInt(100_000_000, 1_000_000_000))}`,
      active: true,
      consultationFeeMinor: '100000',
      currency: 'IRR',
    });
    const startsAt = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
    startsAt.setUTCSeconds(0, 0);
    const endsAt = new Date(startsAt.getTime() + 15 * 60 * 1000);
    const created = await availability.create(
      {
        doctorId: doctor.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        slotDurationMinutes: 15,
        timeZone: 'Asia/Tehran',
      },
      'test-admin',
    );
    return { doctor, slotId: created.slots[0].id };
  }

  async function applyMigration(name: string) {
    const sql = (
      await readFile(resolve(process.cwd(), 'scripts/migrations', name), 'utf8')
    ).replace(/^\\set[^\r\n]*(?:\r?\n)?/, '');
    const runner = source.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(sql);
    } catch (error) {
      await runner.query('ROLLBACK');
      throw error;
    } finally {
      await runner.release();
    }
  }

  async function provisionDisposableParents() {
    await source.query(`ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS phone varchar NULL,
      ADD COLUMN IF NOT EXISTS "firstName" varchar NULL,
      ADD COLUMN IF NOT EXISTS "lastName" varchar NULL,
      ADD COLUMN IF NOT EXISTS email varchar NULL,
      ADD COLUMN IF NOT EXISTS "nationalId" varchar NULL,
      ADD COLUMN IF NOT EXISTS "profileCompleted" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "loyaltyPoints" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS role varchar NOT NULL DEFAULT 'customer',
      ADD COLUMN IF NOT EXISTS "createdAt" timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz NOT NULL DEFAULT now()`);
    await source.query(`ALTER TABLE public.bird_passports
      ADD COLUMN IF NOT EXISTS code varchar(9) NULL,
      ADD COLUMN IF NOT EXISTS "ownerMobile" varchar(11) NULL,
      ADD COLUMN IF NOT EXISTS "ownerFullName" varchar(150) NULL,
      ADD COLUMN IF NOT EXISTS "birdName" varchar(100) NULL,
      ADD COLUMN IF NOT EXISTS "imagePath" text NULL,
      ADD COLUMN IF NOT EXISTS "birthDate" date NULL,
      ADD COLUMN IF NOT EXISTS gender varchar NULL,
      ADD COLUMN IF NOT EXISTS species varchar NULL,
      ADD COLUMN IF NOT EXISTS subspecies varchar NULL,
      ADD COLUMN IF NOT EXISTS status varchar NOT NULL DEFAULT 'draft',
      ADD COLUMN IF NOT EXISTS "createdAt" timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz NOT NULL DEFAULT now()`);
  }

  async function dropVetObjects() {
    if (!disposableConfirmed)
      throw new Error('Disposable identity not confirmed');
    for (const entity of [...VET_ENTITIES].reverse()) {
      const table = source.getMetadata(entity).tableName;
      if (!/^vet_[a-z_]+$/.test(table)) throw new Error('Unsafe fixture table');
      await source.query(`DROP TABLE IF EXISTS public.${table}`);
    }
    for (const name of [
      'vet_guard_slot',
      'vet_guard_window',
      'vet_guard_appointment_update',
      'vet_reject_history_mutation',
      'vet_assert_free_claim',
      'vet_guard_external_record',
    ])
      await source.query(`DROP FUNCTION IF EXISTS public.${name}()`);
  }
});
