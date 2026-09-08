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
import { VetBookingPolicy } from './policies/vet-booking.policy';
import { VetFreeScope } from './vet-appointment.enums';
import { VET_ENTITIES } from './vet-appointments.module';
import { VetBookingService } from './vet-booking.service';
import { VET_ADMIN_MANUAL_RULE } from './vet-manual-assignment.constants';
import { VetManualAssignmentService } from './vet-manual-assignment.service';

const enabled =
  process.env.VET_RUN_DB_TESTS === '1' &&
  process.env.VET_TEST_DATABASE_CONFIRM === 'DISPOSABLE';
const describeDatabase = enabled ? describe : describe.skip;
const testHash = '$2b$12$' + 'a'.repeat(53);
const testKey = randomBytes(32);

describeDatabase('Day 2F admin manual assignment real PostgreSQL', () => {
  let source: DataSource;
  let availability: VetAvailabilityService;
  let assignments: VetManualAssignmentService;
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
    const bookingConfig = new ConfigService({
      VET_FIRST_FREE_SCOPE: VetFreeScope.OWNER,
      VET_FIRST_FREE_POLICY_VERSION: 'vet-first-free-v1',
      VET_FIELD_ENCRYPTION_KEY: testKey.toString('base64'),
    });
    freeBooking = new VetBookingService(
      source,
      bookingConfig,
      new VetBookingPolicy(bookingConfig),
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

  it('applies the manual-assignment migration idempotently', async () => {
    await applyMigration('20260909-enable-vet-admin-manual-assignment.sql');
    const [row] = await source.query<Array<{ body: string }>>(
      `SELECT prosrc body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='vet_assert_free_claim'`,
    );
    expect(row.body).toContain(VET_ADMIN_MANUAL_RULE);
    expect(row.body).toContain('ADMIN_ASSIGNED');
  });

  it('creates a direct confirmed assignment with audit and no hold/payment/claim', async () => {
    const customer = await user();
    const f = await fixture(1);
    const result = await assignments.create(
      { customerUserId: customer.id, slotId: f.slots[0].id },
      'test-admin',
    );
    expect(result).toMatchObject({
      assignmentSource: 'ADMIN_MANUAL',
      status: 'CONFIRMED',
      customer: { id: customer.id, fullName: 'Test Customer' },
      pricing: {
        kind: 'FREE',
        feeAmountMinor: '0',
        ruleVersion: VET_ADMIN_MANUAL_RULE,
      },
    });
    expect(result).not.toHaveProperty('holdExpiresAt');
    expect(JSON.stringify(result)).not.toContain(customer.phone);
    expect(JSON.stringify(result)).not.toContain(customer.nationalId);
    expect(await sideEffects(result.appointmentId)).toEqual({
      assignments: 1,
      claims: 0,
      payments: 0,
      video: 0,
      notifications: 0,
      pending: 0,
    });
  });

  it('preserves first-free entitlement after manual assignment', async () => {
    const customer = await user();
    const f = await fixture(2);
    const manual = await assignments.create(
      { customerUserId: customer.id, slotId: f.slots[0].id },
      'test-admin',
    );
    expect(
      await source.getRepository(VetFreeConsultationClaim).countBy({
        ownerUserId: customer.id,
      }),
    ).toBe(0);
    const selfBooked = await freeBooking.book(customer.id, {
      bookingRequestId: randomUUID(),
      slotId: f.slots[1].id,
    });
    expect(selfBooked.status).toBe('CONFIRMED');
    expect(
      await source.getRepository(VetFreeConsultationClaim).countBy({
        ownerUserId: customer.id,
      }),
    ).toBe(1);
    expect(await sideEffects(manual.appointmentId)).toMatchObject({
      claims: 0,
    });
  });

  it('requires a persisted CUSTOMER and reports missing identities safely', async () => {
    const f = await fixture(1);
    await expect(
      assignments.create(
        { customerUserId: randomUUID(), slotId: f.slots[0].id },
        'test-admin',
      ),
    ).rejects.toMatchObject({ status: 404 });
    const adminUser = await user(UserRole.ADMIN);
    await expect(
      assignments.create(
        { customerUserId: adminUser.id, slotId: f.slots[0].id },
        'test-admin',
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('verifies optional passport existence, ACTIVE state, and selected-customer ownership', async () => {
    const customer = await user();
    const other = await user();
    const owned = await bird(customer.phone);
    const foreign = await bird(other.phone);
    const f = await fixture(3);
    await expect(
      assignments.create(
        {
          customerUserId: customer.id,
          slotId: f.slots[0].id,
          passportCode: 'B99999999',
        },
        'test-admin',
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      assignments.create(
        {
          customerUserId: customer.id,
          slotId: f.slots[0].id,
          passportCode: foreign.code,
        },
        'test-admin',
      ),
    ).rejects.toThrow(ForbiddenException);
    const result = await assignments.create(
      {
        customerUserId: customer.id,
        slotId: f.slots[0].id,
        passportCode: owned.code,
      },
      'test-admin',
    );
    expect(result.passport).toEqual({
      code: owned.code,
      birdName: owned.birdName,
      species: owned.species,
    });
  });

  it('rejects unavailable slots, terminal windows, and inactive doctors', async () => {
    const customer = await user();
    const blocked = await fixture(1);
    await source.query(
      `UPDATE public.vet_appointment_slots SET status='BLOCKED' WHERE id=$1`,
      [blocked.slots[0].id],
    );
    await expect(
      assignments.create(
        { customerUserId: customer.id, slotId: blocked.slots[0].id },
        'test-admin',
      ),
    ).rejects.toThrow(ConflictException);

    const terminal = await fixture(1);
    await availability.cancel(terminal.window.id);
    await expect(
      assignments.create(
        { customerUserId: customer.id, slotId: terminal.slots[0].id },
        'test-admin',
      ),
    ).rejects.toThrow(ConflictException);

    const inactive = await fixture(1);
    await source.getRepository(VetDoctor).update(inactive.doctor.id, {
      active: false,
    });
    await expect(
      assignments.create(
        { customerUserId: customer.id, slotId: inactive.slots[0].id },
        'test-admin',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('allows exactly one concurrent assignment to the same slot', async () => {
    const firstCustomer = await user();
    const secondCustomer = await user();
    const f = await fixture(1);
    const results = await Promise.allSettled([
      assignments.create(
        { customerUserId: firstCustomer.id, slotId: f.slots[0].id },
        'admin-one',
      ),
      assignments.create(
        { customerUserId: secondCustomer.id, slotId: f.slots[0].id },
        'admin-two',
      ),
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
      }),
    ).toBe(1);
  });

  it.each(['cancel', 'retire'] as const)(
    'races assignment with %s and leaves one valid scheduling outcome',
    async (action) => {
      const customer = await user();
      const f = await fixture(1);
      const results = await Promise.allSettled([
        assignments.create(
          { customerUserId: customer.id, slotId: f.slots[0].id },
          'test-admin',
        ),
        availability[action](f.window.id),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter((result) => result.status === 'rejected');
      if (action === 'cancel') {
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toEqual([
          {
            status: 'rejected',
            reason: expect.any(ConflictException) as unknown,
          },
        ]);
      } else {
        // Retirement is allowed to complete after a booking wins: its established
        // contract retains the occupied slot while closing unused future slots.
        expect(fulfilled.length === 1 || fulfilled.length === 2).toBe(true);
        if (rejected.length)
          expect(rejected).toEqual([
            {
              status: 'rejected',
              reason: expect.any(ConflictException) as unknown,
            },
          ]);
      }
      const [state] = await source.query<
        Array<{
          appointments: string;
          windowStatus: string;
          slotStatus: string;
        }>
      >(
        `SELECT
         (SELECT count(*) FROM public.vet_appointments WHERE "slotId"=$1) appointments,
         w.status "windowStatus",s.status "slotStatus"
         FROM public.vet_appointment_slots s
         JOIN public.vet_availability_windows w ON w.id=s."availabilityWindowId"
         WHERE s.id=$1`,
        [f.slots[0].id],
      );
      const assignmentWon =
        state.appointments === '1' &&
        state.windowStatus === 'ACTIVE' &&
        state.slotStatus === 'AVAILABLE';
      const lifecycleWon =
        state.appointments === '0' &&
        state.windowStatus ===
          (action === 'cancel' ? 'CANCELLED' : 'RETIRED') &&
        state.slotStatus === 'CANCELLED';
      const occupiedRetired =
        action === 'retire' &&
        state.appointments === '1' &&
        state.windowStatus === 'RETIRED' &&
        state.slotStatus === 'AVAILABLE';
      expect(assignmentWon || lifecycleWon || occupiedRetired).toBe(true);
    },
  );

  it('keeps the ADMIN_ASSIGNED audit event append-only', async () => {
    const customer = await user();
    const f = await fixture(1);
    const result = await assignments.create(
      { customerUserId: customer.id, slotId: f.slots[0].id },
      'audit-admin',
    );
    const [event] = await source.query<
      Array<{
        id: string;
        actorType: string;
        actorId: string;
        metadata: object;
      }>
    >(
      `SELECT id,"actorType","actorId",metadata FROM public.vet_appointment_events
       WHERE "appointmentId"=$1 AND "eventKey"='admin-manual-assignment'`,
      [result.appointmentId],
    );
    expect(event).toMatchObject({
      actorType: 'ADMIN',
      actorId: 'audit-admin',
      metadata: { source: 'ADMIN_MANUAL' },
    });
    await expect(
      source.query(
        `UPDATE public.vet_appointment_events SET metadata='{}'::jsonb WHERE id=$1`,
        [event.id],
      ),
    ).rejects.toBeDefined();
  });

  async function sideEffects(appointmentId: string) {
    const [row] = await source.query<Array<Record<string, string>>>(
      `SELECT
       (SELECT count(*) FROM public.vet_appointment_events WHERE "appointmentId"=$1 AND "eventKey"='admin-manual-assignment') assignments,
       (SELECT count(*) FROM public.vet_free_consultation_claims WHERE "appointmentId"=$1) claims,
       (SELECT count(*) FROM public.vet_appointment_payments WHERE "appointmentId"=$1) payments,
       (SELECT count(*) FROM public.vet_video_rooms WHERE "appointmentId"=$1) video,
       (SELECT count(*) FROM public.vet_notification_outbox WHERE "appointmentId"=$1) notifications,
       (SELECT count(*) FROM public.vet_appointments WHERE id=$1 AND (status='PAYMENT_PENDING' OR "holdExpiresAt" IS NOT NULL)) pending`,
      [appointmentId],
    );
    return Object.fromEntries(
      Object.entries(row).map(([name, count]) => [name, Number(count)]),
    );
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

  async function user(role = UserRole.CUSTOMER) {
    const suffix = String(randomInt(100_000_000, 1_000_000_000));
    const value = await source.getRepository(User).save({
      id: randomUUID(),
      phone: `09${suffix}`,
      firstName: 'Test',
      lastName: 'Customer',
      nationalId: `0${suffix}`,
      profileCompleted: true,
      loyaltyPoints: 0,
      role,
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
    return { doctor, ...created };
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
