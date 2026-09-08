import { ConflictException, ForbiddenException } from '@nestjs/common';
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
import { VetAppointment } from './entities/appointment.entity';
import { VetDoctor } from './entities/doctor.entity';
import { VetFreeConsultationClaim } from './entities/free-consultation-claim.entity';
import { VET_ENTITIES } from './vet-appointments.module';
import { VetFreeScope } from './vet-appointment.enums';
import {
  VET_PAYMENT_COMING_SOON,
  VetBookingPolicy,
} from './policies/vet-booking.policy';
import { VetBookingService } from './vet-booking.service';

const enabled =
  process.env.VET_RUN_DB_TESTS === '1' &&
  process.env.VET_TEST_DATABASE_CONFIRM === 'DISPOSABLE';
const describeDatabase = enabled ? describe : describe.skip;
const testHash = '$2b$12$' + 'a'.repeat(53);

describeDatabase('Day 2D customer booking real PostgreSQL', () => {
  let source: DataSource;
  let availability: VetAvailabilityService;
  let ownerBooking: VetBookingService;
  let passportBooking: VetBookingService;
  let suiteLock: QueryRunner | undefined;
  let disposableConfirmed = false;
  const createdUsers: string[] = [];
  const createdPassports: string[] = [];
  const key = randomBytes(32).toString('base64');

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
    await requireParentSchema();
    await dropVetObjects();
    await source.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    for (const name of [
      '20260907-create-vet-appointments-v1.sql',
      '20260907-enable-vet-availability-replacement.sql',
    ]) {
      const sql = (
        await readFile(
          resolve(process.cwd(), 'scripts/migrations', name),
          'utf8',
        )
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
    availability = new VetAvailabilityService(source);
    ownerBooking = booking(VetFreeScope.OWNER);
    passportBooking = booking(VetFreeScope.PASSPORT);
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

  it('atomically confirms the first free visit and returns an identical safe retry', async () => {
    const customer = await user();
    const f = await fixture(2);
    const passport = await bird(customer.phone);
    const input = {
      bookingRequestId: randomUUID(),
      slotId: f.slots[0].id,
      passportCode: passport.code,
    };
    const first = await ownerBooking.book(customer.id, input);
    const retry = await ownerBooking.book(customer.id, input);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      status: 'CONFIRMED',
      pricing: { kind: 'FREE', feeAmountMinor: '0' },
      passport: { code: passport.code },
    });
    expect(JSON.stringify(first)).not.toContain(customer.phone);
    expect(JSON.stringify(first)).not.toContain(customer.nationalId);
    await expect(
      ownerBooking.book(customer.id, { ...input, slotId: f.slots[1].id }),
    ).rejects.toThrow('identifier was already used');
    expect(await rowCounts(input.bookingRequestId)).toEqual({
      appointments: 1,
      claims: 1,
      events: 1,
      payments: 0,
      video: 0,
      notifications: 0,
    });
  });

  it('returns the payment-unavailable 409 without any writes after OWNER entitlement is used', async () => {
    const customer = await user();
    const f = await fixture(2);
    await ownerBooking.book(customer.id, {
      bookingRequestId: randomUUID(),
      slotId: f.slots[0].id,
    });
    const secondRequest = randomUUID();
    await expect(
      ownerBooking.book(customer.id, {
        bookingRequestId: secondRequest,
        slotId: f.slots[1].id,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: VET_PAYMENT_COMING_SOON, paymentAvailable: false },
    });
    expect(await rowCounts(secondRequest)).toEqual({
      appointments: 0,
      claims: 0,
      events: 0,
      payments: 0,
      video: 0,
      notifications: 0,
    });
    const [unsafe] = await source.query<Array<{ count: string }>>(
      "SELECT count(*) FROM public.vet_appointments WHERE status='PAYMENT_PENDING'",
    );
    expect(unsafe.count).toBe('0');
  });

  it('verifies passport ownership and supports independent PASSPORT entitlements', async () => {
    const customer = await user();
    const other = await user();
    const ownedOne = await bird(customer.phone);
    const ownedTwo = await bird(customer.phone);
    const foreign = await bird(other.phone);
    const f = await fixture(3);
    await expect(
      passportBooking.book(customer.id, {
        bookingRequestId: randomUUID(),
        slotId: f.slots[0].id,
        passportCode: foreign.code,
      }),
    ).rejects.toThrow(ForbiddenException);
    await passportBooking.book(customer.id, {
      bookingRequestId: randomUUID(),
      slotId: f.slots[0].id,
      passportCode: ownedOne.code,
    });
    await passportBooking.book(customer.id, {
      bookingRequestId: randomUUID(),
      slotId: f.slots[1].id,
      passportCode: ownedTwo.code,
    });
    await expect(
      passportBooking.book(customer.id, {
        bookingRequestId: randomUUID(),
        slotId: f.slots[2].id,
        passportCode: ownedOne.code,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await source.getRepository(VetFreeConsultationClaim).countBy({
        subjectType: VetFreeScope.PASSPORT,
      }),
    ).toBe(2);
  });

  it('serializes concurrent OWNER claims and fails the loser closed', async () => {
    const customer = await user();
    const f = await fixture(2);
    const results = await Promise.allSettled(
      f.slots.map((slot) =>
        ownerBooking.book(customer.id, {
          bookingRequestId: randomUUID(),
          slotId: slot.id,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      { status: 'rejected', reason: expect.any(ConflictException) as unknown },
    ]);
    expect(
      await source.getRepository(VetAppointment).countBy({
        customerUserId: customer.id,
      }),
    ).toBe(1);
    expect(
      await source.getRepository(VetFreeConsultationClaim).countBy({
        ownerUserId: customer.id,
      }),
    ).toBe(1);
  });

  it('returns one result for concurrent identical retries', async () => {
    const customer = await user();
    const f = await fixture(1);
    const input = {
      bookingRequestId: randomUUID(),
      slotId: f.slots[0].id,
    };
    const [first, second] = await Promise.all([
      ownerBooking.book(customer.id, input),
      ownerBooking.book(customer.id, input),
    ]);
    expect(second).toEqual(first);
    expect(await rowCounts(input.bookingRequestId)).toMatchObject({
      appointments: 1,
      claims: 1,
      events: 1,
    });
  });

  it('allows only one customer to occupy a concurrently requested slot', async () => {
    const firstCustomer = await user();
    const secondCustomer = await user();
    const f = await fixture(1);
    const results = await Promise.allSettled([
      ownerBooking.book(firstCustomer.id, {
        bookingRequestId: randomUUID(),
        slotId: f.slots[0].id,
      }),
      ownerBooking.book(secondCustomer.id, {
        bookingRequestId: randomUUID(),
        slotId: f.slots[0].id,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      { status: 'rejected', reason: expect.any(ConflictException) as unknown },
    ]);
    expect(
      await source.getRepository(VetAppointment).countBy({
        slotId: f.slots[0].id,
      }),
    ).toBe(1);
  });

  function booking(scope: VetFreeScope) {
    const config = new ConfigService({
      VET_FIELD_ENCRYPTION_KEY: key,
      VET_FIRST_FREE_SCOPE: scope,
      VET_FIRST_FREE_POLICY_VERSION: 'vet-first-free-v1',
    });
    return new VetBookingService(source, config, new VetBookingPolicy(config));
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
    const digits = String(randomInt(10_000_000, 100_000_000));
    const value = await source.getRepository(BirdPassport).save({
      id: randomUUID(),
      code: `B${digits}`,
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

  async function fixture(slotCount: number) {
    const doctor = await source.getRepository(VetDoctor).save({
      username: `doctor_${randomBytes(5).toString('hex')}`,
      passwordHash: testHash,
      displayName: 'Test Doctor',
      mobile: `09${String(randomInt(100_000_000, 1_000_000_000))}`,
      active: true,
      consultationFeeMinor: '100000',
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
    return { doctor, slots: created.slots };
  }

  async function rowCounts(bookingRequestId: string) {
    const [row] = await source.query<Array<Record<string, string>>>(
      `SELECT
      (SELECT count(*) FROM public.vet_appointments WHERE "bookingRequestId"=$1) appointments,
      (SELECT count(*) FROM public.vet_free_consultation_claims c JOIN public.vet_appointments a ON a.id=c."appointmentId" WHERE a."bookingRequestId"=$1) claims,
      (SELECT count(*) FROM public.vet_appointment_events e JOIN public.vet_appointments a ON a.id=e."appointmentId" WHERE a."bookingRequestId"=$1) events,
      (SELECT count(*) FROM public.vet_appointment_payments p JOIN public.vet_appointments a ON a.id=p."appointmentId" WHERE a."bookingRequestId"=$1) payments,
      (SELECT count(*) FROM public.vet_video_rooms v JOIN public.vet_appointments a ON a.id=v."appointmentId" WHERE a."bookingRequestId"=$1) video,
      (SELECT count(*) FROM public.vet_notification_outbox n JOIN public.vet_appointments a ON a.id=n."appointmentId" WHERE a."bookingRequestId"=$1) notifications`,
      [bookingRequestId],
    );
    return Object.fromEntries(
      Object.entries(row).map(([name, count]) => [name, Number(count)]),
    );
  }

  async function requireParentSchema() {
    const rows = await source.query<Array<{ table: string; column: string }>>(
      `SELECT table_name AS table, column_name AS column FROM information_schema.columns
       WHERE table_schema='public' AND table_name IN ('users','bird_passports')`,
    );
    const names = new Set(rows.map((row) => `${row.table}.${row.column}`));
    for (const required of [
      'users.id',
      'users.phone',
      'users.firstName',
      'users.lastName',
      'users.nationalId',
      'users.profileCompleted',
      'bird_passports.id',
      'bird_passports.code',
      'bird_passports.ownerMobile',
      'bird_passports.ownerFullName',
      'bird_passports.birdName',
      'bird_passports.species',
      'bird_passports.status',
    ])
      if (!names.has(required))
        throw new Error(`Disposable parent schema missing ${required}`);
  }

  async function provisionDisposableParents() {
    // The foundation suites intentionally need only parent IDs. Day 2D needs
    // authoritative customer/passport fields, so expand those disposable-only
    // stubs without involving an application database or production migration.
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
