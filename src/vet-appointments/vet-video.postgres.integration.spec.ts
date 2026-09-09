import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource, QueryRunner } from 'typeorm';
import { VET_TEST_ENTITIES } from '../../test/vet-test-entities';
import { User, UserRole } from '../users/entities/user.entity';
import { VetAvailabilityService } from './availability.service';
import { VetAppointment } from './entities/appointment.entity';
import { VetDoctor } from './entities/doctor.entity';
import { VetVideoRoom } from './entities/video-room.entity';
import { VetBookingPolicy } from './policies/vet-booking.policy';
import { encryptVetField } from './security/vet-field-encryption';
import {
  VetAppointmentStatus,
  VetFreeScope,
  VetPricingKind,
  VetVideoStatus,
} from './vet-appointment.enums';
import { VET_ENTITIES } from './vet-appointments.module';
import { VetBookingService } from './vet-booking.service';
import { VetManualAssignmentService } from './vet-manual-assignment.service';
import {
  LiveKitRoomTransport,
  LiveKitVetVideoProvider,
} from './vet-livekit-provider';
import {
  InternalVetVideoProvider,
  VET_INTERNAL_VIDEO_PROVIDER,
} from './vet-video-provider';
import { VetVideoService } from './vet-video.service';

const enabled =
  process.env.VET_RUN_DB_TESTS === '1' &&
  process.env.VET_TEST_DATABASE_CONFIRM === 'DISPOSABLE';
const describeDatabase = enabled ? describe : describe.skip;
const testHash = '$2b$12$' + 'a'.repeat(53);
const testKey = randomBytes(32);

describeDatabase('Day 3A video consultation real PostgreSQL', () => {
  let source: DataSource;
  let availability: VetAvailabilityService;
  let booking: VetBookingService;
  let assignment: VetManualAssignmentService;
  let video: VetVideoService;
  let livekitVideo: VetVideoService;
  let ensureLiveKitRoom: jest.MockedFunction<
    LiveKitRoomTransport['ensureRoom']
  >;
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
      extra: { max: 16 },
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
      '20260909-enable-vet-video-consultation.sql',
      '20260910-enable-vet-livekit-provider.sql',
    ])
      await applyMigration(name);
    availability = new VetAvailabilityService(source);
    const bookingConfig = new ConfigService({
      VET_FIRST_FREE_SCOPE: VetFreeScope.OWNER,
      VET_FIRST_FREE_POLICY_VERSION: 'vet-first-free-v1',
      VET_FIELD_ENCRYPTION_KEY: testKey.toString('base64'),
    });
    booking = new VetBookingService(
      source,
      bookingConfig,
      new VetBookingPolicy(bookingConfig),
    );
    assignment = new VetManualAssignmentService(source, bookingConfig);
    video = new VetVideoService(
      source,
      new ConfigService({
        VET_VIDEO_JOIN_BEFORE_MINUTES: '15',
        VET_VIDEO_GRACE_AFTER_MINUTES: '15',
        VET_VIDEO_ACCESS_TOKEN_SECONDS: '60',
      }),
      new InternalVetVideoProvider(
        new JwtService({ secret: 'video-test-secret' }),
      ),
    );
    ensureLiveKitRoom = jest.fn().mockResolvedValue(undefined);
    const livekitConfig = new ConfigService({
      LIVEKIT_URL: 'wss://video.example.test',
      LIVEKIT_API_KEY: 'test-api-key',
      LIVEKIT_API_SECRET: 'test-api-secret-with-at-least-32-characters',
    });
    livekitVideo = new VetVideoService(
      source,
      new ConfigService({
        VET_VIDEO_JOIN_BEFORE_MINUTES: '15',
        VET_VIDEO_GRACE_AFTER_MINUTES: '15',
        VET_VIDEO_ACCESS_TOKEN_SECONDS: '60',
      }),
      new LiveKitVetVideoProvider(livekitConfig, {
        ensureRoom: ensureLiveKitRoom,
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

  it('applies the LiveKit migration idempotently', async () => {
    await applyMigration('20260910-enable-vet-livekit-provider.sql');
    const [constraint] = await source.query<Array<{ definition: string }>>(
      `SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
       WHERE conrelid='public.vet_video_rooms'::regclass
         AND conname='CHK_vet_video_provider'`,
    );
    expect(constraint.definition).toContain('INTERNAL');
    expect(constraint.definition).toContain('LIVEKIT');
  });

  it('persists one LiveKit room for concurrent authorized joins without network', async () => {
    ensureLiveKitRoom.mockClear();
    const customer = await user();
    const f = await fixture(5);
    const appointment = await assignment.create(
      { customerUserId: customer.id, slotId: f.slot.id },
      'livekit-admin',
    );
    const [customerJoin, doctorJoin] = await Promise.all([
      livekitVideo.joinCustomer(appointment.appointmentId, customer.id),
      livekitVideo.joinDoctor(appointment.appointmentId, f.doctor.id),
    ]);
    expect(customerJoin.roomId).toBe(doctorJoin.roomId);
    expect(customerJoin.provider).toBe('LIVEKIT');
    expect(customerJoin.serverUrl).toBe('wss://video.example.test');
    expect(await roomCount(appointment.appointmentId)).toBe(1);
    const room = await source.getRepository(VetVideoRoom).findOne({
      select: {
        id: true,
        provider: true,
        providerMeetingId: true,
        guestUrlCiphertext: true,
        hostUrlCiphertext: true,
      },
      where: { appointmentId: appointment.appointmentId },
    });
    expect(room).toMatchObject({
      provider: 'LIVEKIT',
      providerMeetingId: `vet-${appointment.appointmentId}`,
      guestUrlCiphertext: null,
      hostUrlCiphertext: null,
    });
    expect(
      new Set(ensureLiveKitRoom.mock.calls.map((call) => call[1])),
    ).toEqual(new Set([`vet-${appointment.appointmentId}`]));
  });

  it('creates and retries one room for a Day 2D first-free appointment', async () => {
    const customer = await user();
    const f = await fixture(5);
    const appointment = await booking.book(customer.id, {
      bookingRequestId: randomUUID(),
      slotId: f.slot.id,
    });
    const first = await video.joinCustomer(
      appointment.appointmentId,
      customer.id,
    );
    const retry = await video.joinCustomer(
      appointment.appointmentId,
      customer.id,
    );
    expect(retry.roomId).toBe(first.roomId);
    expect(first).toMatchObject({
      appointmentId: appointment.appointmentId,
      provider: 'INTERNAL',
      status: 'READY',
      accessRole: 'CUSTOMER',
    });
    expect(first.accessToken).toEqual(expect.any(String));
    expect(first).not.toHaveProperty('providerMeetingId');
    expect(JSON.stringify(first)).not.toContain(customer.phone);
    expect(JSON.stringify(first)).not.toContain(customer.nationalId);
    expect(await roomCount(appointment.appointmentId)).toBe(1);
  });

  it('supports a Day 2F admin-manual confirmed appointment', async () => {
    const customer = await user();
    const f = await fixture(5);
    const appointment = await assignment.create(
      { customerUserId: customer.id, slotId: f.slot.id },
      'video-admin',
    );
    const joined = await video.joinDoctor(
      appointment.appointmentId,
      f.doctor.id,
    );
    expect(joined).toMatchObject({
      appointmentId: appointment.appointmentId,
      accessRole: 'DOCTOR',
      provider: VET_INTERNAL_VIDEO_PROVIDER,
    });
    expect(await roomCount(appointment.appointmentId)).toBe(1);
  });

  it('is pricing-neutral for a future paid confirmed appointment', async () => {
    await setPaidConfirmedAllowed(true);
    let appointmentId: string | undefined;
    try {
      const direct = await directAppointment(
        VetAppointmentStatus.CONFIRMED,
        5,
        VetPricingKind.PAID,
      );
      appointmentId = direct.appointment.id;
      const joined = await video.joinCustomer(
        appointmentId,
        direct.customer.id,
      );
      expect(joined).toMatchObject({
        appointmentId,
        status: 'READY',
        provider: 'INTERNAL',
      });
    } finally {
      if (appointmentId) {
        await source.getRepository(VetVideoRoom).delete({ appointmentId });
        await source
          .getRepository(VetAppointment)
          .delete({ id: appointmentId });
      }
      await setPaidConfirmedAllowed(false);
    }
  });

  it('forbids the wrong customer and wrong doctor', async () => {
    const customer = await user();
    const wrongCustomer = await user();
    const f = await fixture(5);
    const other = await fixture(5);
    const appointment = await booking.book(customer.id, {
      bookingRequestId: randomUUID(),
      slotId: f.slot.id,
    });
    await expect(
      video.joinCustomer(appointment.appointmentId, wrongCustomer.id),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      video.joinDoctor(appointment.appointmentId, other.doctor.id),
    ).rejects.toThrow(ForbiddenException);
    expect(await roomCount(appointment.appointmentId)).toBe(0);
  });

  it('denies access too early without creating a room', async () => {
    const customer = await user();
    const f = await fixture(60);
    const appointment = await booking.book(customer.id, {
      bookingRequestId: randomUUID(),
      slotId: f.slot.id,
    });
    await expect(
      video.joinCustomer(appointment.appointmentId, customer.id),
    ).rejects.toEqual(new ConflictException('Video room is not open yet'));
    expect(await roomCount(appointment.appointmentId)).toBe(0);
  });

  it('expires a provider-ended room and reruns expiry idempotently', async () => {
    const direct = await directAppointment(
      VetAppointmentStatus.CONFIRMED,
      -60,
      VetPricingKind.FREE,
    );
    await source.getRepository(VetVideoRoom).insert({
      appointmentId: direct.appointment.id,
      provider: VET_INTERNAL_VIDEO_PROVIDER,
      providerMeetingId: `vet_${randomUUID().replaceAll('-', '')}`,
      status: VetVideoStatus.READY,
      guestUrlCiphertext: null,
      hostUrlCiphertext: null,
      providerEndDate: new Date(Date.now() - 30_000),
      creationLeaseExpiresAt: null,
      attemptCount: 1,
      lastErrorCode: null,
      deletedAt: null,
    });
    expect(await video.expireEndedRooms(10)).toBe(1);
    expect(await video.expireEndedRooms(10)).toBe(0);
    await expect(
      video.joinCustomer(direct.appointment.id, direct.customer.id),
    ).rejects.toEqual(
      new ConflictException('Video room access window has closed'),
    );
    const room = await source.getRepository(VetVideoRoom).findOneByOrFail({
      appointmentId: direct.appointment.id,
    });
    expect(room.status).toBe(VetVideoStatus.EXPIRED);
  });

  it.each([
    VetAppointmentStatus.CANCELLED,
    VetAppointmentStatus.EXPIRED,
    VetAppointmentStatus.PAYMENT_PENDING,
  ])('denies a %s appointment without creating a room', async (status) => {
    const pricing =
      status === VetAppointmentStatus.CANCELLED
        ? VetPricingKind.FREE
        : VetPricingKind.PAID;
    const direct = await directAppointment(status, 5, pricing);
    await expect(
      video.joinCustomer(direct.appointment.id, direct.customer.id),
    ).rejects.toEqual(
      new ConflictException('Appointment is not video-consultable'),
    );
    expect(await roomCount(direct.appointment.id)).toBe(0);
    if (status === VetAppointmentStatus.CANCELLED)
      await expect(
        source.getRepository(VetVideoRoom).insert({
          appointmentId: direct.appointment.id,
          provider: VET_INTERNAL_VIDEO_PROVIDER,
          status: VetVideoStatus.EXPIRED,
        }),
      ).rejects.toBeDefined();
  });

  it('serializes concurrent customer and doctor creation to one room', async () => {
    const customer = await user();
    const f = await fixture(5);
    const appointment = await assignment.create(
      { customerUserId: customer.id, slotId: f.slot.id },
      'video-admin',
    );
    const [customerJoin, doctorJoin] = await Promise.all([
      video.joinCustomer(appointment.appointmentId, customer.id),
      video.joinDoctor(appointment.appointmentId, f.doctor.id),
    ]);
    expect(customerJoin.roomId).toBe(doctorJoin.roomId);
    expect(customerJoin.accessRole).toBe('CUSTOMER');
    expect(doctorJoin.accessRole).toBe('DOCTOR');
    expect(await roomCount(appointment.appointmentId)).toBe(1);
  });

  it('fails closed when cancellation races room creation', async () => {
    const customer = await user();
    const f = await fixture(5);
    const appointment = await assignment.create(
      { customerUserId: customer.id, slotId: f.slot.id },
      'video-admin',
    );
    const results = await Promise.allSettled([
      video.joinCustomer(appointment.appointmentId, customer.id),
      source.query(
        `UPDATE public.vet_appointments SET status='CANCELLED',
         "cancelledAt"=statement_timestamp(),"cancelledByType"='ADMIN',
         "cancelledById"='race-admin',"cancellationReason"='race test'
         WHERE id=$1`,
        [appointment.appointmentId],
      ),
    ]);
    expect(results[1].status).toBe('fulfilled');
    if (results[0].status === 'rejected')
      expect(results[0].reason).toEqual(expect.any(ConflictException));
    const rooms = await source.getRepository(VetVideoRoom).findBy({
      appointmentId: appointment.appointmentId,
    });
    expect(rooms).toHaveLength(results[0].status === 'fulfilled' ? 1 : 0);
    if (rooms.length) expect(rooms[0].status).toBe(VetVideoStatus.EXPIRED);
  });

  async function roomCount(appointmentId: string) {
    return source.getRepository(VetVideoRoom).countBy({ appointmentId });
  }

  async function directAppointment(
    status: VetAppointmentStatus,
    startOffsetMinutes: number,
    pricingKind: VetPricingKind,
  ) {
    const customer = await user();
    const f = await fixture(startOffsetMinutes);
    const appointmentId = randomUUID();
    const confirmed = [
      VetAppointmentStatus.CONFIRMED,
      VetAppointmentStatus.COMPLETED,
      VetAppointmentStatus.CANCELLED,
      VetAppointmentStatus.NO_SHOW,
    ].includes(status);
    const now = new Date();
    await source.transaction('READ COMMITTED', async (manager) => {
      await manager.getRepository(VetAppointment).insert({
        id: appointmentId,
        publicReference: `V${randomBytes(8).toString('hex').toUpperCase()}`,
        bookingRequestId: randomUUID(),
        customerUserId: customer.id,
        slotId: f.slot.id,
        doctorId: f.doctor.id,
        birdPassportId: null,
        status,
        pricingKind,
        feeAmountMinor: pricingKind === VetPricingKind.FREE ? '0' : '100000',
        currency: 'IRR',
        pricingRuleVersion: 'vet-first-free-v1',
        holdExpiresAt:
          pricingKind === VetPricingKind.PAID && !confirmed
            ? new Date(now.getTime() + 30 * 60_000)
            : null,
        ownerFullNameSnapshot: 'Video Customer',
        ownerMobileSnapshot: customer.phone,
        doctorNameSnapshot: f.doctor.displayName,
        passportCodeSnapshot: null,
        birdNameSnapshot: null,
        birdSpeciesSnapshot: null,
        passportOwnerFullNameSnapshot: null,
        nationalIdCiphertext: encryptVetField(
          customer.nationalId,
          testKey,
          `${appointmentId}:nationalId`,
        ),
        nationalIdLast4: customer.nationalId.slice(-4),
        confirmedAt: confirmed ? now : null,
        completedAt: null,
        cancelledAt: status === VetAppointmentStatus.CANCELLED ? now : null,
        cancelledByType:
          status === VetAppointmentStatus.CANCELLED ? 'ADMIN' : null,
        cancelledById:
          status === VetAppointmentStatus.CANCELLED ? 'test-admin' : null,
        cancellationReason:
          status === VetAppointmentStatus.CANCELLED
            ? 'test cancellation'
            : null,
      });
      if (pricingKind === VetPricingKind.FREE)
        await manager.query(
          `INSERT INTO public.vet_free_consultation_claims
           ("policyVersion","subjectType","ownerUserId","appointmentId")
           VALUES ('vet-first-free-v1','OWNER',$1,$2)`,
          [customer.id, appointmentId],
        );
    });
    return {
      customer,
      appointment: await source
        .getRepository(VetAppointment)
        .findOneByOrFail({ id: appointmentId }),
    };
  }

  async function user() {
    const suffix = String(randomInt(100_000_000, 1_000_000_000));
    const value = await source.getRepository(User).save({
      id: randomUUID(),
      phone: `09${suffix}`,
      firstName: 'Video',
      lastName: 'Customer',
      nationalId: `0${suffix}`,
      profileCompleted: true,
      loyaltyPoints: 0,
      role: UserRole.CUSTOMER,
    });
    createdUsers.push(value.id);
    return value;
  }

  async function fixture(startOffsetMinutes: number) {
    const doctor = await source.getRepository(VetDoctor).save({
      username: `doctor_${randomBytes(5).toString('hex')}`,
      passwordHash: testHash,
      displayName: 'Video Doctor',
      mobile: `09${String(randomInt(100_000_000, 1_000_000_000))}`,
      active: true,
      consultationFeeMinor: '100000',
      currency: 'IRR',
    });
    const minute = 60_000;
    const start = new Date(
      Math.ceil(Date.now() / minute) * minute + startOffsetMinutes * minute,
    );
    const created = await availability.create(
      {
        doctorId: doctor.id,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 15 * minute).toISOString(),
        slotDurationMinutes: 15,
        timeZone: 'Asia/Tehran',
      },
      'video-test-admin',
    );
    return { doctor, window: created.window, slot: created.slots[0] };
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

  async function setPaidConfirmedAllowed(allowed: boolean) {
    await source.query(
      'ALTER TABLE public.vet_appointments DROP CONSTRAINT "CHK_vet_appointments_hold_lifecycle"',
    );
    const paidConfirmed = allowed
      ? ` OR ("pricingKind"='PAID' AND "status"='CONFIRMED' AND "slotId" IS NOT NULL
          AND "holdExpiresAt" IS NULL AND "confirmedAt" IS NOT NULL)`
      : '';
    await source.query(`ALTER TABLE public.vet_appointments
      ADD CONSTRAINT "CHK_vet_appointments_hold_lifecycle" CHECK (
        ("pricingKind"='FREE' AND "slotId" IS NOT NULL
          AND "status" IN ('CONFIRMED','COMPLETED','CANCELLED','NO_SHOW')
          AND "confirmedAt" IS NOT NULL AND "holdExpiresAt" IS NULL)
        OR ("pricingKind"='PAID' AND (
          ("status"='PAYMENT_UNAVAILABLE' AND "slotId" IS NULL
            AND "holdExpiresAt" IS NULL AND "confirmedAt" IS NULL)
          OR ("status" IN ('PAYMENT_PENDING','EXPIRED') AND "slotId" IS NOT NULL
            AND "holdExpiresAt" IS NOT NULL AND isfinite("holdExpiresAt")
            AND "holdExpiresAt" > "createdAt" AND "confirmedAt" IS NULL)
        ))${paidConfirmed}
      )`);
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
      'vet_expire_video_room_on_appointment_change',
    ])
      await source.query(`DROP FUNCTION IF EXISTS public.${name}()`);
  }
});
