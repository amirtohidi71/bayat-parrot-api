import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource, EntityManager } from 'typeorm';
import { VET_ENTITIES } from './vet-appointments.module';
import { VET_TEST_ENTITIES } from '../../test/vet-test-entities';
import { VetAppointment } from './entities/appointment.entity';
import { VetDoctor } from './entities/doctor.entity';
import { VetBookingPolicy } from './policies/vet-booking.policy';
import { ConfigService } from '@nestjs/config';
import { encryptVetField } from './security/vet-field-encryption';

const enabled =
  process.env.VET_RUN_DB_TESTS === '1' &&
  process.env.VET_TEST_DATABASE_CONFIRM === 'DISPOSABLE';
const describeDatabase = enabled ? describe : describe.skip;
const testKey = randomBytes(32);
// Deliberately synthetic bcrypt-shaped data: no real doctor or login is seeded.
const testHash = '$2b$12$' + 'a'.repeat(53);
type RowId = { id: string };
type SlotFixture = {
  doctorId: string;
  windowId: string;
  slotId: string;
  userId: string;
};

describeDatabase('Vet Day 1 real PostgreSQL foundation', () => {
  let source: DataSource;
  let migration: string;
  let migrationBody: string;
  let disposableConfirmed = false;

  beforeAll(async () => {
    const url = requireDisposableDatabaseUrl();
    source = new DataSource({
      type: 'postgres',
      url,
      entities: VET_TEST_ENTITIES,
      synchronize: false,
      logging: false,
      extra: { max: 12 },
    });
    await source.initialize();
    const [identity] = await source.query<Array<{ database: string }>>(
      'SELECT current_database() AS database',
    );
    if (identity?.database !== new URL(url).pathname.slice(1))
      throw new Error('Disposable database identity mismatch');
    disposableConfirmed = true;
    // This suite owns only the nine vet tables in a separately named disposable DB.
    await dropVetObjects();
    await source.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await source.query(
      'CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY)',
    );
    await source.query(
      'CREATE TABLE IF NOT EXISTS public.bird_passports (id uuid PRIMARY KEY)',
    );
    migration = (
      await readFile(
        resolve(
          process.cwd(),
          'scripts/migrations/20260907-create-vet-appointments-v1.sql',
        ),
        'utf8',
      )
    ).replace(/^\\set[^\r\n]*(?:\r?\n)?/, '');
    // Allows drift tests to use a real outer transaction/savepoint and roll back
    // their deliberate DDL mutations, without changing the production SQL.
    migrationBody = migration
      .replace(/^BEGIN;\s*$/m, '')
      .replace(/^COMMIT;\s*$/m, '');
    await applyMigration();
  }, 60_000);

  afterAll(async () => {
    if (!source?.isInitialized) return;
    try {
      if (disposableConfirmed) await dropVetObjects();
    } finally {
      await source.destroy();
    }
  });

  it('applies twice and contains exactly the required nine tables with no doctor/availability seeds', async () => {
    await applyMigration();
    const rows = await source.query<Array<{ name: string }>>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'vet_%' ORDER BY tablename`,
    );
    expect(rows.map((r) => r.name)).toEqual(
      VET_ENTITIES.map((e) => source.getMetadata(e).tableName).sort(),
    );
    expect(await source.getRepository(VetDoctor).count()).toBe(0);
    const [windows] = await source.query<Array<{ count: string }>>(
      'SELECT count(*) FROM public.vet_availability_windows',
    );
    expect(windows.count).toBe('0');
  });

  it('matches every TypeORM column, FK, CHECK, unique and exclusion to the migrated catalog', async () => {
    for (const entity of VET_ENTITIES) {
      const metadata = source.getMetadata(entity);
      const columns = await source.query<
        Array<{ name: string; nullable: boolean; type: string }>
      >(
        `SELECT a.attname AS name, NOT a.attnotnull AS nullable, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
        ['public.' + metadata.tableName],
      );
      expect(columns.map((c) => c.name).sort()).toEqual(
        metadata.columns.map((c) => c.databaseName).sort(),
      );
      for (const column of metadata.columns) {
        const stored = columns.find((c) => c.name === column.databaseName)!;
        expect(stored.nullable).toBe(column.isNullable);
        const expected =
          column.type === 'varchar'
            ? `character varying(${column.length})`
            : column.type === 'timestamptz'
              ? 'timestamp with time zone'
              : column.type;
        expect(stored.type).toBe(expected);
      }
      const constraints = await source.query<Array<{ name: string }>>(
        'SELECT conname AS name FROM pg_constraint WHERE conrelid = $1::regclass',
        ['public.' + metadata.tableName],
      );
      const names = constraints.map((c) => c.name);
      for (const item of [
        ...metadata.foreignKeys,
        ...metadata.checks,
        ...metadata.uniques,
        ...metadata.exclusions,
      ])
        expect(names).toContain(item.name);
      const indexes = await source.query<Array<{ name: string }>>(
        'SELECT indexname AS name FROM pg_indexes WHERE schemaname = $1 AND tablename = $2',
        ['public', metadata.tableName],
      );
      for (const item of metadata.indices)
        expect(indexes.map((i) => i.name)).toContain(item.name);
    }
  });

  it('matches TypeORM CHECK/exclusion expressions and FK column mappings, not just object names', async () => {
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"';
    try {
      for (const entity of VET_ENTITIES) {
        const metadata = source.getMetadata(entity);
        const table = 'public.' + quote(metadata.tableName);
        const temporary = 'pg_temp.' + quote('entity_' + metadata.tableName);
        await runner.query(
          `CREATE TEMP TABLE ${temporary} (LIKE ${table}) ON COMMIT DROP`,
        );
        for (const check of metadata.checks) {
          await runner.query(
            `ALTER TABLE ${temporary} ADD CONSTRAINT ${quote(check.name)} CHECK (${check.expression})`,
          );
        }
        for (const exclusion of metadata.exclusions) {
          await runner.query(
            `ALTER TABLE ${temporary} ADD CONSTRAINT ${quote(exclusion.name)} EXCLUDE ${exclusion.expression}`,
          );
        }
        const definitions = (target: string) =>
          runner.query(
            "SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN ('c','x') ORDER BY conname",
            [target],
          ) as Promise<Array<{ conname: string; definition: string }>>;
        expect(await definitions(temporary)).toEqual(await definitions(table));
        const fks = (await runner.query(
          `SELECT con.conname AS name, parent.relname AS target, con.confdeltype AS action,
          ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(num, seq)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.seq) AS columns,
          ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(num, seq)
            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.seq) AS referenced
          FROM pg_constraint con JOIN pg_class parent ON parent.oid = con.confrelid
          WHERE con.conrelid = $1::regclass AND con.contype = 'f' ORDER BY con.conname`,
          [table],
        )) as Array<{
          name: string;
          target: string;
          action: string;
          columns: string[];
          referenced: string[];
        }>;
        expect(fks).toEqual(
          metadata.foreignKeys
            .map((fk) => ({
              name: fk.name,
              target: fk.referencedEntityMetadata.tableName,
              action: 'r',
              columns: fk.columns.map((c) => c.databaseName),
              referenced: fk.referencedColumns.map((c) => c.databaseName),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      }
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it.each([
    [
      'column nullability',
      'ALTER TABLE public.vet_doctors ALTER COLUMN mobile DROP NOT NULL',
    ],
    [
      'column type',
      'ALTER TABLE public.vet_doctors ALTER COLUMN "displayName" TYPE varchar(200)',
    ],
    [
      'column default',
      'ALTER TABLE public.vet_doctors ALTER COLUMN active SET DEFAULT false',
    ],
    [
      'extra column',
      'ALTER TABLE public.vet_doctors ADD COLUMN unexpected text',
    ],
    [
      'weakened check',
      'ALTER TABLE public.vet_doctors DROP CONSTRAINT "CHK_vet_doctors_fee"; ALTER TABLE public.vet_doctors ADD CONSTRAINT "CHK_vet_doctors_fee" CHECK (true)',
    ],
    ['missing index', 'DROP INDEX public."UQ_vet_doctors_username_ci"'],
    [
      'case-sensitive replacement',
      'DROP INDEX public."UQ_vet_doctors_username_ci"; CREATE UNIQUE INDEX "UQ_vet_doctors_username_ci" ON public.vet_doctors (username)',
    ],
    [
      'partial predicate',
      'DROP INDEX public."UQ_vet_appointments_slot_occupant"; CREATE UNIQUE INDEX "UQ_vet_appointments_slot_occupant" ON public.vet_appointments ("slotId") WHERE false',
    ],
    [
      'extra index',
      'CREATE INDEX vet_unexpected ON public.vet_doctors ("displayName")',
    ],
    [
      'FK target/action',
      'ALTER TABLE public.vet_appointments DROP CONSTRAINT "FK_vet_appointments_customer"; ALTER TABLE public.vet_appointments ADD CONSTRAINT "FK_vet_appointments_customer" FOREIGN KEY ("customerUserId") REFERENCES public.users(id) ON DELETE CASCADE',
    ],
    [
      'disabled trigger',
      'ALTER TABLE public.vet_free_consultation_claims DISABLE TRIGGER "TRG_vet_claims_append_only"',
    ],
    [
      'disabled internal FK triggers',
      'ALTER TABLE public.vet_doctors DISABLE TRIGGER ALL',
    ],
    [
      'missing trigger',
      'DROP TRIGGER "TRG_vet_video_confirmed_only" ON public.vet_video_rooms',
    ],
    [
      'function body',
      `CREATE OR REPLACE FUNCTION public.vet_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS 'BEGIN RETURN NEW; END;'`,
    ],
  ])('rejects %s drift without repairing it', async (_name, mutation) => {
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(mutation);
      await expect(runner.query(migrationBody)).rejects.toThrow(/drift/);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('rejects overlapping ACTIVE windows, permits adjacency and overlap after cancellation', async () => {
    const f = await fixture();
    await expect(
      insertWindow(f.doctorId, '2030-01-02T10:30:00Z', '2030-01-02T11:30:00Z'),
    ).rejects.toMatchObject({ driverError: { code: '23P01' } });
    await expect(
      insertWindow(f.doctorId, '2030-01-02T11:00:00Z', '2030-01-02T12:00:00Z'),
    ).resolves.toBeDefined();
    await source.query(
      `UPDATE public.vet_appointment_slots SET status = 'CANCELLED' WHERE id = $1`,
      [f.slotId],
    );
    await source.query(
      `UPDATE public.vet_availability_windows SET status = 'CANCELLED' WHERE id = $1`,
      [f.windowId],
    );
    await expect(insertWindow(f.doctorId)).resolves.toBeDefined();
  });

  it('has one winner for concurrent overlapping windows across database connections', async () => {
    const doctor = await insertDoctor();
    const results = await Promise.allSettled([
      insertWindow(doctor),
      insertWindow(doctor),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('rejects invalid duration, nondivisible windows, reversed times and non-Tehran timezone', async () => {
    const doctor = await insertDoctor();
    for (const duration of [0, -1, 1441, 7]) {
      await expect(
        insertWindow(doctor, undefined, undefined, duration),
      ).rejects.toBeDefined();
    }
    await expect(
      insertWindow(doctor, '2030-01-02T11:00:00Z', '2030-01-02T10:00:00Z'),
    ).rejects.toBeDefined();
    await expect(
      source.query(
        `INSERT INTO public.vet_availability_windows ("doctorId","startsAt","endsAt","slotDurationMinutes","createdByAdmin","timeZone") VALUES ($1,'2030-01-02T10:00:00Z','2030-01-02T11:00:00Z',15,'test-admin','UTC')`,
        [doctor],
      ),
    ).rejects.toBeDefined();
  });

  it('enforces case-insensitive doctor username, unique valid mobile, hash-only credentials and fee', async () => {
    const doctor = await insertDoctor();
    const [row] = await source.query<
      Array<{ username: string; mobile: string }>
    >('SELECT username, mobile FROM public.vet_doctors WHERE id = $1', [
      doctor,
    ]);
    await expect(
      insertDoctor({ username: row.username.toUpperCase() }),
    ).rejects.toBeDefined();
    await expect(insertDoctor({ mobile: row.mobile })).rejects.toBeDefined();
    await expect(insertDoctor({ mobile: '08123456789' })).rejects.toBeDefined();
    await expect(
      insertDoctor({ passwordHash: 'plaintext-is-not-a-hash' }),
    ).rejects.toBeDefined();
    await expect(insertDoctor({ fee: -1 })).rejects.toBeDefined();
    const selected = await source
      .getRepository(VetDoctor)
      .findOneByOrFail({ id: doctor });
    expect(selected.passwordHash).toBeUndefined();
    expect(selected.consultationFeeMinor).toBe('100000');
  });

  it('rejects duplicate doctor slot times, wrong doctor/window, off-grid and overlong slots', async () => {
    const f = await fixture();
    await expect(insertSlot(f.windowId, f.doctorId)).rejects.toBeDefined();
    const otherDoctor = await insertDoctor();
    await expect(
      insertSlot(f.windowId, otherDoctor, '10:15', '10:30'),
    ).rejects.toBeDefined();
    await expect(
      insertSlot(f.windowId, f.doctorId, '10:01', '10:16'),
    ).rejects.toBeDefined();
    await expect(
      insertSlot(f.windowId, f.doctorId, '10:15', '10:45'),
    ).rejects.toBeDefined();
    await expect(
      insertSlot(f.windowId, f.doctorId, '11:00', '11:15'),
    ).rejects.toBeDefined();
    await expect(
      source.query(
        'UPDATE public.vet_availability_windows SET "slotDurationMinutes" = 10 WHERE id = $1',
        [f.windowId],
      ),
    ).rejects.toBeDefined();
  });

  it('enforces composite appointment slot/doctor ownership and blocks booking blocked slots', async () => {
    const f = await fixture();
    await expect(
      confirmFree({ ...f, doctorId: await insertDoctor() }),
    ).rejects.toBeDefined();
    await source.query(
      `UPDATE public.vet_appointment_slots SET status = 'BLOCKED' WHERE id = $1`,
      [f.slotId],
    );
    await expect(confirmFree(f)).rejects.toThrow('available slot');
  });

  it('allows exactly one of two concurrent live occupants for one slot and rolls back losing claim', async () => {
    const f = await fixture();
    const anotherOwner = await insertUser();
    const results = await Promise.allSettled([
      confirmFree(f),
      confirmFree({ ...f, userId: anotherOwner }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [count] = await source.query<Array<{ count: string }>>(
      'SELECT count(*) FROM public.vet_appointments WHERE "slotId" = $1',
      [f.slotId],
    );
    expect(count.count).toBe('1');
  });

  it('allows only one OWNER claim for the same policy under concurrent different-slot attempts', async () => {
    const f = await fixture();
    const secondSlot = await insertSlot(
      f.windowId,
      f.doctorId,
      '10:15',
      '10:30',
    );
    const results = await Promise.allSettled([
      confirmFree(f),
      confirmFree({ ...f, slotId: secondSlot }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [count] = await source.query<Array<{ count: string }>>(
      'SELECT count(*) FROM public.vet_appointments WHERE "customerUserId" = $1',
      [f.userId],
    );
    expect(count.count).toBe('1');
    const loserSlot = results[0].status === 'rejected' ? f.slotId : secondSlot;
    await expect(
      confirmFree({ ...f, slotId: loserSlot, userId: await insertUser() }),
    ).resolves.toBeDefined();
  });

  it('protects booking retry identity even across different slots and policy versions', async () => {
    const f = await fixture();
    const requestId = randomUUID();
    await confirmFree(f, { requestId });
    const slot = await insertSlot(f.windowId, f.doctorId, '10:15', '10:30');
    await expect(
      confirmFree(
        { ...f, slotId: slot },
        { requestId, policy: 'other-policy' },
      ),
    ).rejects.toBeDefined();
  });

  it('requires free appointment and correctly matching claim in the same committed transaction', async () => {
    const f = await fixture();
    await expect(
      source.transaction((m) => insertAppointment(m, f)),
    ).rejects.toThrow('commit atomically');
    await expect(
      confirmFree(f, { claimOwner: await insertUser() }),
    ).rejects.toThrow('commit atomically');
    await expect(
      confirmFree(f, { claimPolicy: 'wrong-policy' }),
    ).rejects.toThrow('commit atomically');
    await expect(confirmFree(f)).resolves.toBeDefined();
  });

  it('retains free entitlement after cancellation and no-show, and forbids claim mutation/deletion', async () => {
    const f = await fixture();
    const appointment = await confirmFree(f);
    await expect(
      source.query(
        `UPDATE public.vet_appointment_slots SET status = 'BLOCKED' WHERE id = $1`,
        [f.slotId],
      ),
    ).rejects.toBeDefined();
    await source.query(
      `UPDATE public.vet_appointments SET status = 'CANCELLED', "cancelledAt" = now(), "cancelledByType" = 'ADMIN', "cancelledById" = 'test-admin', "cancellationReason" = 'test cancellation' WHERE id = $1`,
      [appointment],
    );
    await expect(confirmFree(f)).rejects.toBeDefined();
    await expect(
      source.query(
        'DELETE FROM public.vet_free_consultation_claims WHERE "appointmentId" = $1',
        [appointment],
      ),
    ).rejects.toThrow('append-only');
    await expect(
      source.query(
        'UPDATE public.vet_free_consultation_claims SET "policyVersion" = $2 WHERE "appointmentId" = $1',
        [appointment, 'new-policy'],
      ),
    ).rejects.toThrow('append-only');
    const nextOwner = await insertUser();
    const nextAppointment = await confirmFree({ ...f, userId: nextOwner });
    await source.query(
      `UPDATE public.vet_appointments SET status = 'NO_SHOW' WHERE id = $1`,
      [nextAppointment],
    );
    const nextSlot = await insertSlot(f.windowId, f.doctorId, '10:15', '10:30');
    await expect(
      confirmFree({ ...f, slotId: nextSlot, userId: nextOwner }),
    ).rejects.toBeDefined();
  });

  it('supports PASSPORT uniqueness and requires the claim to match the appointment passport', async () => {
    const f = await fixture();
    const passport = randomUUID();
    await source.query('INSERT INTO public.bird_passports (id) VALUES ($1)', [
      passport,
    ]);
    await confirmFree(f, { passport, scope: 'PASSPORT' });
    const slot = await insertSlot(f.windowId, f.doctorId, '10:15', '10:30');
    await expect(
      confirmFree(
        { ...f, slotId: slot, userId: await insertUser() },
        { passport, scope: 'PASSPORT' },
      ),
    ).rejects.toBeDefined();
  });

  it('permits only a slotless payment-unavailable record and rejects all paid holds/confirmations/side effects', async () => {
    const f = await fixture();
    const unavailable = new VetBookingPolicy(
      new ConfigService(),
    ).paymentUnavailableResult();
    expect(unavailable.appointmentId).toBeNull();
    // Optional future interest/reconciliation record. Day 2 should simply return
    // the above result and do no writes when payment is unavailable.
    const id = await source.transaction((m) =>
      insertAppointment(m, f, { paid: true }),
    );
    const row = await source
      .getRepository(VetAppointment)
      .findOneByOrFail({ id });
    expect(row.slotId).toBeNull();
    expect(row.holdExpiresAt).toBeNull();
    expect(row.confirmedAt).toBeNull();
    expect(row.nationalIdCiphertext).toBeUndefined();
    await expect(
      source.transaction((m) =>
        insertAppointment(m, f, { paid: true, paidSlot: true }),
      ),
    ).rejects.toBeDefined();
    await expect(
      source.transaction((m) =>
        insertAppointment(m, f, { paid: true, status: 'CONFIRMED' }),
      ),
    ).rejects.toBeDefined();
    await expect(
      source.transaction((m) =>
        insertAppointment(m, f, { paid: true, status: 'PAYMENT_PENDING' }),
      ),
    ).rejects.toBeDefined();
    await expect(
      source.query(
        'UPDATE public.vet_appointments SET "holdExpiresAt" = now() WHERE id = $1',
        [id],
      ),
    ).rejects.toBeDefined();
    await expect(insertVideo(id)).rejects.toBeDefined();
    await expect(insertNotification(id)).rejects.toBeDefined();
    await expect(
      source.query(
        `INSERT INTO public.vet_appointment_payments ("appointmentId","clientRequestId",provider,"amountMinor",currency) VALUES ($1,$2,'UNCONFIGURED',100000,'IRR')`,
        [id, randomUUID()],
      ),
    ).rejects.toThrow('VET_PAYMENT_COMING_SOON');
    await expect(confirmFree(f)).resolves.toBeDefined();
    const [sideEffects] = await source.query<
      Array<{ payments: string; video: string; notifications: string }>
    >(
      `SELECT (SELECT count(*) FROM public.vet_appointment_payments WHERE "appointmentId" = $1) AS payments, (SELECT count(*) FROM public.vet_video_rooms WHERE "appointmentId" = $1) AS video, (SELECT count(*) FROM public.vet_notification_outbox WHERE "appointmentId" = $1) AS notifications`,
      [id],
    );
    expect(sideEffects).toEqual({
      payments: '0',
      video: '0',
      notifications: '0',
    });
  });

  it('permits one video room and one confirmation per recipient, including distinct admin recipients', async () => {
    const appointment = await confirmFree(await fixture());
    await insertVideo(appointment);
    await expect(insertVideo(appointment)).rejects.toBeDefined();
    await insertNotification(appointment);
    await expect(insertNotification(appointment)).rejects.toBeDefined();
    await insertNotification(appointment, 'ADMIN', '09111111111');
    await insertNotification(appointment, 'ADMIN', '09222222222');
    await expect(
      source.query(
        `INSERT INTO public.vet_notification_outbox ("appointmentId","recipientType","recipientPhoneSnapshot","notificationType",template,payload) VALUES ($1,'DOCTOR','09333333333','CONFIRMED','vet.confirmed','{"nationalId":"0012345678"}'::jsonb)`,
        [appointment],
      ),
    ).rejects.toBeDefined();
  });

  it('protects audit uniqueness and append-only events at the database', async () => {
    const appointment = await confirmFree(await fixture());
    const insert = () =>
      source.query(
        `INSERT INTO public.vet_appointment_events ("appointmentId","eventType","eventKey","actorType") VALUES ($1,'CONFIRMED','confirmation','SYSTEM')`,
        [appointment],
      );
    await insert();
    await expect(insert()).rejects.toBeDefined();
    await expect(
      source.query(
        'UPDATE public.vet_appointment_events SET metadata = $2 WHERE "appointmentId" = $1',
        [appointment, {}],
      ),
    ).rejects.toThrow('append-only');
    await expect(
      source.query(
        'DELETE FROM public.vet_appointment_events WHERE "appointmentId" = $1',
        [appointment],
      ),
    ).rejects.toThrow('append-only');
    await expect(
      source.query('TRUNCATE public.vet_appointment_events'),
    ).rejects.toThrow('append-only');
    await expect(
      source.query('TRUNCATE public.vet_free_consultation_claims'),
    ).rejects.toThrow('append-only');
  });

  it('stores identical instants across DB session timezones', async () => {
    const f = await fixture();
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`SET LOCAL TIME ZONE 'America/New_York'`);
      const [row] = (await runner.query(
        `SELECT extract(epoch FROM "startsAt")::text AS epoch, to_char("startsAt" AT TIME ZONE 'Asia/Tehran', 'YYYY-MM-DD HH24:MI') AS tehran FROM public.vet_appointment_slots WHERE id = $1`,
        [f.slotId],
      )) as Array<{ epoch: string; tehran: string }>;
      expect(Number(row.epoch)).toBe(Date.parse('2030-01-02T10:00:00Z') / 1000);
      expect(row.tehran).toBe('2030-01-02 13:30');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  async function applyMigration(): Promise<void> {
    const runner = source.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(migration);
    } catch (error) {
      // An explicit SQL BEGIN must never return an aborted connection to the pool.
      await runner.query('ROLLBACK');
      throw error;
    } finally {
      await runner.release();
    }
  }

  async function insertUser(): Promise<string> {
    const id = randomUUID();
    await source.query('INSERT INTO public.users (id) VALUES ($1)', [id]);
    return id;
  }
  async function insertDoctor(
    overrides: {
      username?: string;
      mobile?: string;
      passwordHash?: string;
      fee?: number;
    } = {},
  ): Promise<string> {
    const rows = await source.query<RowId[]>(
      `INSERT INTO public.vet_doctors (username,"passwordHash","displayName",mobile,"consultationFeeMinor",currency) VALUES ($1,$2,'Test Doctor',$3,$4,'IRR') RETURNING id`,
      [
        overrides.username ?? 'test_' + randomUUID().replace(/-/g, ''),
        overrides.passwordHash ?? testHash,
        overrides.mobile ??
          '09' +
            String(
              BigInt('0x' + randomBytes(6).toString('hex')) % 1000000000n,
            ).padStart(9, '0'),
        overrides.fee ?? 100000,
      ],
    );
    return rows[0].id;
  }
  async function insertWindow(
    doctorId: string,
    start = '2030-01-02T10:00:00Z',
    end = '2030-01-02T11:00:00Z',
    duration = 15,
  ): Promise<string> {
    const rows = await source.query<RowId[]>(
      `INSERT INTO public.vet_availability_windows ("doctorId","startsAt","endsAt","slotDurationMinutes","createdByAdmin") VALUES ($1,$2,$3,$4,'test-admin') RETURNING id`,
      [doctorId, start, end, duration],
    );
    return rows[0].id;
  }
  async function insertSlot(
    windowId: string,
    doctorId: string,
    start = '10:00',
    end = '10:15',
  ): Promise<string> {
    const rows = await source.query<RowId[]>(
      `INSERT INTO public.vet_appointment_slots ("availabilityWindowId","doctorId","startsAt","endsAt") VALUES ($1,$2,$3,$4) RETURNING id`,
      [windowId, doctorId, `2030-01-02T${start}:00Z`, `2030-01-02T${end}:00Z`],
    );
    return rows[0].id;
  }
  async function fixture(): Promise<SlotFixture> {
    const doctorId = await insertDoctor();
    const windowId = await insertWindow(doctorId);
    return {
      doctorId,
      windowId,
      slotId: await insertSlot(windowId, doctorId),
      userId: await insertUser(),
    };
  }
  async function insertAppointment(
    manager: EntityManager,
    f: SlotFixture,
    options: {
      requestId?: string;
      policy?: string;
      passport?: string;
      paid?: boolean;
      paidSlot?: boolean;
      status?: string;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await manager.query(
      `INSERT INTO public.vet_appointments (id,"publicReference","bookingRequestId","customerUserId","slotId","doctorId","birdPassportId",status,"pricingKind","feeAmountMinor",currency,"pricingRuleVersion","ownerFullNameSnapshot","ownerMobileSnapshot","doctorNameSnapshot","nationalIdCiphertext","nationalIdLast4","confirmedAt","passportCodeSnapshot","birdNameSnapshot","birdSpeciesSnapshot","passportOwnerFullNameSnapshot") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'IRR',$11,'Test Owner','09111111111','Test Doctor',$12,'5678',$13,$14,$15,$16,$17)`,
      [
        id,
        'V' + id.replace(/-/g, '').toUpperCase(),
        options.requestId ?? randomUUID(),
        f.userId,
        options.paid && !options.paidSlot ? null : f.slotId,
        f.doctorId,
        options.passport ?? null,
        options.status ?? (options.paid ? 'PAYMENT_UNAVAILABLE' : 'CONFIRMED'),
        options.paid ? 'PAID' : 'FREE',
        options.paid ? '100000' : '0',
        options.policy ?? 'vet-first-free-v1',
        encryptVetField('0012345678', testKey, id + ':nationalId'),
        options.paid ? null : new Date(),
        options.passport ? 'B12345678' : null,
        options.passport ? 'Test Bird' : null,
        options.passport ? 'Test Species' : null,
        options.passport ? 'Passport Owner' : null,
      ],
    );
    return id;
  }
  async function confirmFree(
    f: SlotFixture,
    options: {
      requestId?: string;
      policy?: string;
      claimPolicy?: string;
      claimOwner?: string;
      passport?: string;
      scope?: 'OWNER' | 'PASSPORT';
    } = {},
  ): Promise<string> {
    // Test-only transaction. Deliberately no application lock: verifies that the
    // database's uniqueness/deferred invariants alone reject racing writers.
    return source.transaction(async (manager) => {
      const id = await insertAppointment(manager, f, options);
      await manager.query(
        `INSERT INTO public.vet_free_consultation_claims ("policyVersion","subjectType","ownerUserId","birdPassportId","appointmentId") VALUES ($1,$2,$3,$4,$5)`,
        [
          options.claimPolicy ?? options.policy ?? 'vet-first-free-v1',
          options.scope ?? 'OWNER',
          options.scope === 'PASSPORT'
            ? null
            : (options.claimOwner ?? f.userId),
          options.scope === 'PASSPORT' ? options.passport : null,
          id,
        ],
      );
      return id;
    });
  }
  function insertVideo(appointmentId: string) {
    return source.query(
      'INSERT INTO public.vet_video_rooms ("appointmentId") VALUES ($1)',
      [appointmentId],
    );
  }
  function insertNotification(
    appointmentId: string,
    type = 'CUSTOMER',
    phone = '09111111111',
  ) {
    return source.query(
      `INSERT INTO public.vet_notification_outbox ("appointmentId","recipientType","recipientPhoneSnapshot","notificationType",template) VALUES ($1,$2,$3,'CONFIRMED','vet.confirmed')`,
      [appointmentId, type, phone],
    );
  }
  async function dropVetObjects() {
    if (!disposableConfirmed)
      throw new Error('Disposable database not verified');
    for (const entity of [...VET_ENTITIES].reverse()) {
      const table = source.getMetadata(entity).tableName;
      if (!/^vet_[a-z_]+$/.test(table))
        throw new Error('Unsafe fixture table name');
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

function requireDisposableDatabaseUrl(): string {
  const value = process.env.VET_TEST_DATABASE_URL?.trim();
  if (!value) throw new Error('VET_TEST_DATABASE_URL is required');
  const url = new URL(value);
  if (
    !/^vet_[a-z0-9_]*(test|disposable)[a-z0-9_]*$/i.test(url.pathname.slice(1))
  )
    throw new Error('Dedicated vet test/disposable database required');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Vet tests require a local disposable PostgreSQL server');
  return value;
}
