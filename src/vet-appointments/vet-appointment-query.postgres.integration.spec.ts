import { ConfigService } from '@nestjs/config';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { VET_TEST_ENTITIES } from '../../test/vet-test-entities';
import { VetAppointmentQueryService } from './vet-appointment-query.service';

const enabled =
  process.env.VET_RUN_DB_TESTS === '1' &&
  process.env.VET_TEST_DATABASE_CONFIRM === 'DISPOSABLE';
const describeDatabase = enabled ? describe : describe.skip;
const testHash = '$2b$12$' + 'a'.repeat(53);
const ciphertext = `v1:${'A'.repeat(16)}:${'B'.repeat(22)}:${'C'.repeat(14)}`;

describeDatabase('Day 4A appointment queries real PostgreSQL', () => {
  let source: DataSource;
  let suiteLock: QueryRunner | undefined;
  let runner: QueryRunner;
  let service: VetAppointmentQueryService;
  let fixture: Awaited<ReturnType<typeof seed>>;

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
      extra: { max: 3 },
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
    const [schema] = await source.query<
      Array<{ appointments: string | null; videos: string | null }>
    >(
      `SELECT to_regclass('public.vet_appointments')::text appointments,
              to_regclass('public.vet_video_rooms')::text videos`,
    );
    if (!schema.appointments || !schema.videos)
      throw new Error('Current disposable Vet schema is required');

    suiteLock = source.createQueryRunner();
    await suiteLock.connect();
    await suiteLock.query(
      "SELECT pg_advisory_lock(hashtextextended('test:vet-postgres-suites', 0))",
    );
    runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('READ COMMITTED');
    fixture = await seed(runner);

    const manager = {
      query: (sql: string, parameters?: unknown[]) => {
        if (
          sql === 'SET TRANSACTION READ ONLY' ||
          sql.startsWith('SET LOCAL statement_timeout')
        )
          return Promise.resolve([]);
        return runner.query(sql, parameters);
      },
    } as unknown as EntityManager;
    service = new VetAppointmentQueryService(
      {
        transaction: async (
          _isolation: string,
          work: (value: EntityManager) => Promise<unknown>,
        ) => work(manager),
      } as unknown as DataSource,
      new ConfigService(),
    );
  }, 30_000);

  afterAll(async () => {
    try {
      if (runner?.isTransactionActive) await runner.rollbackTransaction();
      if (runner) await runner.release();
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
      if (source?.isInitialized) await source.destroy();
    }
  });

  it('enforces customer and doctor scope for list and detail reads', async () => {
    const customer = await service.listCustomer(fixture.customerOne, {
      page: 1,
      pageSize: 20,
    });
    expect(customer.pagination.total).toBe(3);
    expect(customer.items).toHaveLength(3);
    expect(JSON.stringify(customer)).not.toContain(fixture.customerTwo);
    await expect(
      service.detailCustomer(fixture.customerOne, fixture.otherAppointment),
    ).rejects.toMatchObject({ status: 404 });

    const doctor = await service.listDoctor(fixture.doctorOne, {
      page: 1,
      pageSize: 20,
    });
    expect(doctor.pagination.total).toBe(3);
    expect(JSON.stringify(doctor)).not.toContain(fixture.customerOne);
    await expect(
      service.detailDoctor(fixture.doctorOne, fixture.otherAppointment),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('filters admin views and exposes the manual-assignment source', async () => {
    const result = await service.listAdmin({
      page: 1,
      pageSize: 20,
      doctorId: fixture.doctorOne,
      customerUserId: fixture.customerOne,
      status: 'CONFIRMED' as never,
      from: fixture.rangeFrom.toISOString(),
      to: fixture.rangeTo.toISOString(),
    });
    expect(result.pagination.total).toBe(3);
    expect(result.items).toHaveLength(3);
    const firstItem = result.items[0] as Record<string, unknown>;
    expect(firstItem.source).toBe('ADMIN_MANUAL');
    expect(firstItem.customer).toEqual({
      id: fixture.customerOne,
      displayName: 'Query Customer',
    });
    expect(JSON.stringify(result)).not.toContain(fixture.customerTwo);
  });

  it('paginates deterministically and separates upcoming from past by DB time', async () => {
    const first = await service.listCustomer(fixture.customerOne, {
      page: 1,
      pageSize: 1,
      period: 'upcoming' as never,
    });
    const second = await service.listCustomer(fixture.customerOne, {
      page: 2,
      pageSize: 1,
      period: 'upcoming' as never,
    });
    expect(first.pagination.total).toBe(2);
    expect(first.items[0]).toMatchObject({
      appointmentId: fixture.openAppointment,
    });
    expect(second.items[0]).toMatchObject({
      appointmentId: fixture.futureAppointment,
    });

    const past = await service.listCustomer(fixture.customerOne, {
      page: 1,
      pageSize: 20,
      period: 'past' as never,
    });
    expect(past.pagination.total).toBe(1);
    expect(past.items[0]).toMatchObject({
      appointmentId: fixture.pastAppointment,
    });
  });

  it('projects current video eligibility from DB time without exposing internals', async () => {
    const open = await service.detailCustomer(
      fixture.customerOne,
      fixture.openAppointment,
    );
    const future = await service.detailCustomer(
      fixture.customerOne,
      fixture.futureAppointment,
    );
    const past = await service.detailCustomer(
      fixture.customerOne,
      fixture.pastAppointment,
    );
    expect(open).toMatchObject({
      video: {
        eligible: true,
        joinAllowedNow: true,
        state: 'OPEN',
        roomStatus: 'READY',
      },
    });
    expect(future).toMatchObject({
      video: { eligible: true, joinAllowedNow: false, state: 'TOO_EARLY' },
    });
    expect(past).toMatchObject({
      video: { eligible: true, joinAllowedNow: false, state: 'CLOSED' },
    });
    const serialized = JSON.stringify(open);
    for (const forbidden of [
      'ownerMobile',
      'nationalId',
      'providerMeetingId',
      'lastErrorCode',
      'feeAmountMinor',
      'eventType',
    ])
      expect(serialized).not.toContain(forbidden);
  });

  async function seed(queryRunner: QueryRunner) {
    const customerOne = randomUUID();
    const customerTwo = randomUUID();
    const doctorOne = randomUUID();
    const doctorTwo = randomUUID();
    const suffix = () => String(randomInt(100_000_000, 1_000_000_000));
    await queryRunner.query(
      `INSERT INTO users
        (id,phone,"firstName","lastName","nationalId","profileCompleted","loyaltyPoints",role,"createdAt","updatedAt")
       VALUES
        ($1,$2,'Query','Customer One',$3,true,0,'customer',now(),now()),
        ($4,$5,'Query','Customer Two',$6,true,0,'customer',now(),now())`,
      [
        customerOne,
        `09${suffix()}`,
        `0${suffix()}`,
        customerTwo,
        `09${suffix()}`,
        `0${suffix()}`,
      ],
    );
    await queryRunner.query(
      `INSERT INTO vet_doctors
        (id,username,"passwordHash","displayName",mobile,active,"consultationFeeMinor",currency,"createdAt","updatedAt")
       VALUES
        ($1,$2,$3,'Query Doctor One',$4,true,100000,'IRR',now(),now()),
        ($5,$6,$3,'Query Doctor Two',$7,true,100000,'IRR',now(),now())`,
      [
        doctorOne,
        `query_${randomBytes(5).toString('hex')}`,
        testHash,
        `09${suffix()}`,
        doctorTwo,
        `query_${randomBytes(5).toString('hex')}`,
        `09${suffix()}`,
      ],
    );
    const timeRows = (await queryRunner.query(
      'SELECT transaction_timestamp() AS now',
    )) as Array<{ now: Date | string }>;
    const [{ now }] = timeRows;
    const minute = Math.floor(new Date(now).getTime() / 60_000) * 60_000;
    const at = (minutes: number) => new Date(minute + minutes * 60_000);
    const open = await manual(
      queryRunner,
      customerOne,
      doctorOne,
      at(5),
      at(35),
    );
    const future = await manual(
      queryRunner,
      customerOne,
      doctorOne,
      at(60),
      at(90),
    );
    const past = await manual(
      queryRunner,
      customerOne,
      doctorOne,
      at(-60),
      at(-30),
    );
    const other = await manual(
      queryRunner,
      customerTwo,
      doctorTwo,
      at(10),
      at(40),
    );
    await queryRunner.query(
      `INSERT INTO vet_video_rooms
       (id,"appointmentId",provider,"providerMeetingId",status,"providerEndDate","attemptCount","createdAt","updatedAt")
       VALUES ($1,$2,'INTERNAL',$3,'READY',$4,1,now(),now())`,
      [randomUUID(), open.appointmentId, `query-${open.appointmentId}`, at(50)],
    );
    await queryRunner.query('SET CONSTRAINTS ALL IMMEDIATE');
    await queryRunner.query('SET CONSTRAINTS ALL DEFERRED');
    return {
      customerOne,
      customerTwo,
      doctorOne,
      doctorTwo,
      openAppointment: open.appointmentId,
      futureAppointment: future.appointmentId,
      pastAppointment: past.appointmentId,
      otherAppointment: other.appointmentId,
      rangeFrom: at(-90),
      rangeTo: at(120),
    };
  }

  async function manual(
    queryRunner: QueryRunner,
    customerId: string,
    doctorId: string,
    startsAt: Date,
    endsAt: Date,
  ) {
    const windowId = randomUUID();
    const slotId = randomUUID();
    const appointmentId = randomUUID();
    const bookingRequestId = randomUUID();
    const reference = `V${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
    const customerRows = (await queryRunner.query(
      'SELECT phone,"nationalId" FROM users WHERE id=$1',
      [customerId],
    )) as Array<{ phone: string; nationalId: string }>;
    const doctorRows = (await queryRunner.query(
      'SELECT "displayName" FROM vet_doctors WHERE id=$1',
      [doctorId],
    )) as Array<{ displayName: string }>;
    const [customer] = customerRows;
    const [doctor] = doctorRows;
    await queryRunner.query(
      `INSERT INTO vet_availability_windows
       (id,"doctorId","startsAt","endsAt","timeZone","slotDurationMinutes",status,"createdByAdmin","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'Asia/Tehran',30,'ACTIVE','query-test',now(),now())`,
      [windowId, doctorId, startsAt, endsAt],
    );
    await queryRunner.query(
      `INSERT INTO vet_appointment_slots
       (id,"availabilityWindowId","doctorId","startsAt","endsAt",status,"createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'AVAILABLE',now(),now())`,
      [slotId, windowId, doctorId, startsAt, endsAt],
    );
    await queryRunner.query(
      `INSERT INTO vet_appointments
       (id,"publicReference","bookingRequestId","customerUserId","slotId","doctorId","birdPassportId",status,
        "pricingKind","feeAmountMinor",currency,"pricingRuleVersion","holdExpiresAt","ownerFullNameSnapshot",
        "ownerMobileSnapshot","doctorNameSnapshot","passportCodeSnapshot","birdNameSnapshot","birdSpeciesSnapshot",
        "passportOwnerFullNameSnapshot","nationalIdCiphertext","nationalIdLast4","confirmedAt","completedAt",
        "cancelledAt","cancelledByType","cancelledById","cancellationReason","createdAt","updatedAt")
       VALUES
       ($1,$2,$3,$4,$5,$6,NULL,'CONFIRMED','FREE',0,'IRR','vet-admin-manual-v1',NULL,'Query Customer',
        $7,$8,NULL,NULL,NULL,NULL,$9,right($10,4),transaction_timestamp(),NULL,NULL,NULL,NULL,NULL,now(),now())`,
      [
        appointmentId,
        reference,
        bookingRequestId,
        customerId,
        slotId,
        doctorId,
        customer.phone,
        doctor.displayName,
        ciphertext,
        customer.nationalId,
      ],
    );
    await queryRunner.query(
      `INSERT INTO vet_appointment_events
       (id,"appointmentId","eventType","eventKey","actorType","actorId","previousStatus","newStatus",metadata,"createdAt")
       VALUES ($1,$2,'ADMIN_ASSIGNED','admin-manual-assignment','ADMIN','query-test',NULL,'CONFIRMED',
               '{"source":"ADMIN_MANUAL"}'::jsonb,now())`,
      [randomUUID(), appointmentId],
    );
    return { appointmentId, slotId };
  }
});
