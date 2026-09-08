import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource, QueryRunner } from 'typeorm';
import { VET_TEST_ENTITIES } from '../../test/vet-test-entities';
import {
  BirdPassport,
  BirdPassportGender,
  BirdPassportStatus,
} from '../bird-passports/entities/bird-passport.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { VetAvailabilityService } from './availability.service';
import { VetAppointmentEvent } from './entities/appointment-event.entity';
import { VetAppointment } from './entities/appointment.entity';
import { VetDoctor } from './entities/doctor.entity';
import { VetFreeConsultationClaim } from './entities/free-consultation-claim.entity';
import { VetBookingPolicy } from './policies/vet-booking.policy';
import { encryptVetField } from './security/vet-field-encryption';
import {
  VetActorType,
  VetAppointmentStatus,
  VetFreeScope,
} from './vet-appointment.enums';
import { VET_ENTITIES } from './vet-appointments.module';
import { VetBookingService } from './vet-booking.service';
import { VetPaidHoldService } from './vet-paid-hold.service';

const enabled =
  process.env.VET_RUN_DB_TESTS === '1' &&
  process.env.VET_TEST_DATABASE_CONFIRM === 'DISPOSABLE';
const describeDatabase = enabled ? describe : describe.skip;
const testHash = '$2b$12$' + 'a'.repeat(53);
const testKey = randomBytes(32);

describeDatabase('Day 2E paid hold and reaper real PostgreSQL', () => {
  let source: DataSource;
  let availability: VetAvailabilityService;
  let holds: VetPaidHoldService;
  let freeBooking: VetBookingService;
  let suiteLock: QueryRunner | undefined;
  let disposableConfirmed = false;
  const createdUsers: string[] = [];
  const createdPassports: string[] = [];

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
    ])
      await applyMigration(name);
    availability = new VetAvailabilityService(source);
    holds = new VetPaidHoldService(
      source,
      new ConfigService({
        VET_PAYMENT_HOLD_SECONDS: 900,
        VET_FIELD_ENCRYPTION_KEY: testKey.toString('base64'),
      }),
    );
    const freeConfig = new ConfigService({
      VET_FIRST_FREE_SCOPE: VetFreeScope.OWNER,
      VET_FIRST_FREE_POLICY_VERSION: 'vet-first-free-v1',
      VET_FIELD_ENCRYPTION_KEY: testKey.toString('base64'),
    });
    freeBooking = new VetBookingService(
      source,
      freeConfig,
      new VetBookingPolicy(freeConfig),
    );
  }, 60_000);

  afterAll(async () => {
    if (!source?.isInitialized) return;
    try {
      if (disposableConfirmed) {
        await dropVetObjects();
        if (createdPassports.length)
          await source
            .getRepository(BirdPassport)
            .delete(createdPassports.map((id) => ({ id })));
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

  it('applies the hold migration idempotently without enabling paid confirmation or payments', async () => {
    await applyMigration('20260908-enable-vet-paid-holds.sql');
    const customer = await user();
    const f = await fixture(1);
    const hold = await holds.createInternalHold(customer.id, {
      bookingRequestId: randomUUID(),
      slotId: f.slots[0].id,
    });
    await expect(
      source.query(
        `UPDATE public.vet_appointments SET status='CONFIRMED', "confirmedAt"=now() WHERE id=$1`,
        [hold.appointmentId],
      ),
    ).rejects.toBeDefined();
    await expect(
      source.query(
        `INSERT INTO public.vet_appointment_payments
         ("appointmentId","clientRequestId",provider,"amountMinor",currency)
         VALUES ($1,$2,'DISABLED',1,'IRR')`,
        [hold.appointmentId, randomUUID()],
      ),
    ).rejects.toBeDefined();
  });

  it('creates an authoritative DB-timed paid hold with no external or entitlement side effects', async () => {
    const customer = await user();
    const passport = await bird(customer.phone);
    const f = await fixture(1, '7654321');
    const request = {
      bookingRequestId: randomUUID(),
      slotId: f.slots[0].id,
      passportCode: passport.code,
    };
    const first = await holds.createInternalHold(customer.id, request);
    const retry = await holds.createInternalHold(customer.id, request);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      status: VetAppointmentStatus.PAYMENT_PENDING,
      feeAmountMinor: '7654321',
      currency: 'IRR',
    });
    const [row] = await source.query<Array<Record<string, string>>>(
      `SELECT
       (SELECT count(*) FROM public.vet_appointments WHERE id=$1 AND status='PAYMENT_PENDING' AND "holdExpiresAt" > "createdAt") appointments,
       (SELECT count(*) FROM public.vet_appointment_events WHERE "appointmentId"=$1 AND "eventKey"='paid-hold-created') events,
       (SELECT count(*) FROM public.vet_free_consultation_claims WHERE "appointmentId"=$1) claims,
       (SELECT count(*) FROM public.vet_appointment_payments WHERE "appointmentId"=$1) payments,
       (SELECT count(*) FROM public.vet_video_rooms WHERE "appointmentId"=$1) video,
       (SELECT count(*) FROM public.vet_notification_outbox WHERE "appointmentId"=$1) notifications`,
      [first.appointmentId],
    );
    expect(numeric(row)).toEqual({
      appointments: 1,
      events: 1,
      claims: 0,
      payments: 0,
      video: 0,
      notifications: 0,
    });
  });

  it('expires bounded batches, is idempotent, and never mutates free confirmations', async () => {
    const expired = await Promise.all([
      expiredHold(),
      expiredHold(),
      expiredHold(),
    ]);
    const customer = await user();
    const freeFixture = await fixture(1);
    const free = await freeBooking.book(customer.id, {
      bookingRequestId: randomUUID(),
      slotId: freeFixture.slots[0].id,
    });
    await expect(holds.expireHolds(2)).resolves.toEqual({ expired: 2 });
    await expect(holds.expireHolds(2)).resolves.toEqual({ expired: 1 });
    await expect(holds.expireHolds(2)).resolves.toEqual({ expired: 0 });
    const rows = await source.query<Array<{ status: string; events: string }>>(
      `SELECT a.status, count(e.id)::text events
       FROM public.vet_appointments a
       LEFT JOIN public.vet_appointment_events e
         ON e."appointmentId"=a.id AND e."eventKey"='paid-hold-expired'
       WHERE a.id = ANY($1::uuid[]) GROUP BY a.id,a.status`,
      [expired.map((item) => item.appointmentId)],
    );
    expect(rows).toHaveLength(3);
    expect(
      rows.every((row) => row.status === 'EXPIRED' && row.events === '1'),
    ).toBe(true);
    expect(
      await source.getRepository(VetAppointment).findOneByOrFail({
        id: free.appointmentId,
      }),
    ).toMatchObject({ status: VetAppointmentStatus.CONFIRMED });
    expect(
      await source.getRepository(VetFreeConsultationClaim).countBy({
        appointmentId: free.appointmentId,
      }),
    ).toBe(1);
  });

  it('lets two reapers contend without duplicate expiry or audit events', async () => {
    const item = await expiredHold();
    const results = await Promise.all([
      holds.expireHolds(1),
      holds.expireHolds(1),
    ]);
    expect(results.reduce((sum, result) => sum + result.expired, 0)).toBe(1);
    const [row] = await source.query<Array<{ status: string; events: string }>>(
      `SELECT a.status,
       (SELECT count(*) FROM public.vet_appointment_events e
        WHERE e."appointmentId"=a.id AND e."eventKey"='paid-hold-expired') events
       FROM public.vet_appointments a WHERE a.id=$1`,
      [item.appointmentId],
    );
    expect(row).toEqual({ status: 'EXPIRED', events: '1' });
  });

  it('makes a slot reusable only after its expired hold becomes EXPIRED', async () => {
    const firstCustomer = await user();
    const secondCustomer = await user();
    const f = await fixture(1);
    const expired = await insertExpiredHold(
      firstCustomer,
      f.slots[0].id,
      f.doctor.id,
    );
    await expect(
      holds.createInternalHold(secondCustomer.id, {
        bookingRequestId: randomUUID(),
        slotId: f.slots[0].id,
      }),
    ).rejects.toThrow(ConflictException);
    await expect(holds.expireHolds(1)).resolves.toEqual({ expired: 1 });
    const replacement = await holds.createInternalHold(secondCustomer.id, {
      bookingRequestId: randomUUID(),
      slotId: f.slots[0].id,
    });
    expect(replacement.status).toBe(VetAppointmentStatus.PAYMENT_PENDING);
    expect(
      await source.getRepository(VetAppointment).findOneByOrFail({
        id: expired.appointmentId,
      }),
    ).toMatchObject({ status: VetAppointmentStatus.EXPIRED });
  });

  it('keeps hold creation and availability cancellation mutually safe', async () => {
    const customer = await user();
    const f = await fixture(1);
    const results = await Promise.allSettled([
      holds.createInternalHold(customer.id, {
        bookingRequestId: randomUUID(),
        slotId: f.slots[0].id,
      }),
      availability.cancel(f.window.id),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      { status: 'rejected', reason: expect.any(ConflictException) as unknown },
    ]);
    const [state] = await source.query<
      Array<{ holds: string; windowStatus: string; slotStatus: string }>
    >(
      `SELECT
       (SELECT count(*) FROM public.vet_appointments WHERE "slotId"=$1 AND status='PAYMENT_PENDING') holds,
       w.status "windowStatus", s.status "slotStatus"
       FROM public.vet_appointment_slots s
       JOIN public.vet_availability_windows w ON w.id=s."availabilityWindowId"
       WHERE s.id=$1`,
      [f.slots[0].id],
    );
    expect(
      (state.holds === '1' &&
        state.windowStatus === 'ACTIVE' &&
        state.slotStatus === 'AVAILABLE') ||
        (state.holds === '0' &&
          state.windowStatus === 'CANCELLED' &&
          state.slotStatus === 'CANCELLED'),
    ).toBe(true);
  });

  it('allows only one concurrent live hold occupant for a slot', async () => {
    const firstCustomer = await user();
    const secondCustomer = await user();
    const f = await fixture(1);
    const results = await Promise.allSettled([
      holds.createInternalHold(firstCustomer.id, {
        bookingRequestId: randomUUID(),
        slotId: f.slots[0].id,
      }),
      holds.createInternalHold(secondCustomer.id, {
        bookingRequestId: randomUUID(),
        slotId: f.slots[0].id,
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      { status: 'rejected', reason: expect.any(ConflictException) as unknown },
    ]);
    expect(
      await source.getRepository(VetAppointment).countBy({
        slotId: f.slots[0].id,
        status: VetAppointmentStatus.PAYMENT_PENDING,
      }),
    ).toBe(1);
  });

  it('expires safely while a forbidden confirmation-style transition races', async () => {
    const item = await expiredHold();
    const [transition, reaper] = await Promise.allSettled([
      source.query(
        `UPDATE public.vet_appointments SET status='CONFIRMED', "confirmedAt"=now() WHERE id=$1`,
        [item.appointmentId],
      ),
      holds.expireHolds(1),
    ]);
    expect(transition.status).toBe('rejected');
    expect(reaper.status).toBe('fulfilled');
    if (reaper.status === 'fulfilled' && reaper.value.expired === 0)
      await expect(holds.expireHolds(1)).resolves.toEqual({ expired: 1 });
    expect(
      await source.getRepository(VetAppointment).findOneByOrFail({
        id: item.appointmentId,
      }),
    ).toMatchObject({ status: VetAppointmentStatus.EXPIRED });
  });

  it('keeps the Day 2D consumed-entitlement endpoint on payment unavailable with no hold', async () => {
    const customer = await user();
    const f = await fixture(2);
    await freeBooking.book(customer.id, {
      bookingRequestId: randomUUID(),
      slotId: f.slots[0].id,
    });
    await expect(
      freeBooking.book(customer.id, {
        bookingRequestId: randomUUID(),
        slotId: f.slots[1].id,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'VET_PAYMENT_COMING_SOON' },
    });
    const [row] = await source.query<Array<{ count: string }>>(
      `SELECT count(*) FROM public.vet_appointments
       WHERE "customerUserId"=$1 AND status='PAYMENT_PENDING'`,
      [customer.id],
    );
    expect(row.count).toBe('0');
  });

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

  async function bird(ownerMobile: string) {
    const value = await source.getRepository(BirdPassport).save({
      id: randomUUID(),
      code: `B${String(randomInt(10_000_000, 100_000_000))}`,
      ownerMobile,
      ownerFullName: 'Test Customer',
      birdName: 'Bird',
      imagePath: null,
      birthDate: '2025-01-01',
      gender: BirdPassportGender.UNKNOWN,
      species: 'Parrot',
      subspecies: 'Test',
      status: BirdPassportStatus.ACTIVE,
    });
    createdPassports.push(value.id);
    return value;
  }

  async function fixture(slotCount: number, fee = '100000') {
    const doctor = await source.getRepository(VetDoctor).save({
      username: `doctor_${randomBytes(5).toString('hex')}`,
      passwordHash: testHash,
      displayName: 'Test Doctor',
      mobile: `09${String(randomInt(100_000_000, 1_000_000_000))}`,
      active: true,
      consultationFeeMinor: fee,
      currency: 'IRR',
    });
    const created = await availability.create(
      {
        doctorId: doctor.id,
        startsAt: '2035-01-02T10:00:00Z',
        endsAt: `2035-01-02T10:${String(slotCount * 15).padStart(2, '0')}:00Z`,
        slotDurationMinutes: 15,
        timeZone: 'Asia/Tehran',
      },
      'test-admin',
    );
    return { doctor, ...created };
  }

  async function expiredHold() {
    const customer = await user();
    const f = await fixture(1);
    return insertExpiredHold(customer, f.slots[0].id, f.doctor.id);
  }

  async function insertExpiredHold(
    customer: User,
    slotId: string,
    doctorId: string,
  ) {
    const appointmentId = randomUUID();
    await source.transaction('READ COMMITTED', async (manager) => {
      await manager.query(
        `INSERT INTO public.vet_appointments
         (id,"publicReference","bookingRequestId","customerUserId","slotId","doctorId",
          status,"pricingKind","feeAmountMinor",currency,"pricingRuleVersion","holdExpiresAt",
          "ownerFullNameSnapshot","ownerMobileSnapshot","doctorNameSnapshot",
          "nationalIdCiphertext","nationalIdLast4","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'PAYMENT_PENDING','PAID',100000,'IRR','vet-paid-hold-v1',
          transaction_timestamp()-interval '1 minute','Test Customer',$7,'Test Doctor',$8,$9,
          transaction_timestamp()-interval '2 minutes',transaction_timestamp()-interval '2 minutes')`,
        [
          appointmentId,
          `V${appointmentId.replace(/-/g, '').toUpperCase()}`,
          randomUUID(),
          customer.id,
          slotId,
          doctorId,
          customer.phone,
          encryptVetField(
            customer.nationalId,
            testKey,
            `${appointmentId}:nationalId`,
          ),
          customer.nationalId.slice(-4),
        ],
      );
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
    });
    return { appointmentId, slotId };
  }

  function numeric(row: Record<string, string>) {
    return Object.fromEntries(
      Object.entries(row).map(([name, count]) => [name, Number(count)]),
    );
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
