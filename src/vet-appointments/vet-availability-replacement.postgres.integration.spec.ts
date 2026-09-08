import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
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

describeDatabase('Vet forward availability replacement real PostgreSQL', () => {
  let source: DataSource;
  let migration: string;
  let migrationBody: string;
  let baseline: string;
  let disposableConfirmed = false;
  let suiteLock: QueryRunner | undefined;

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
    const [identity] = await source.query<
      Array<{ database: string; address: string }>
    >(
      'SELECT current_database() AS database, host(inet_server_addr()) AS address',
    );
    if (
      identity?.database !== 'vet_appointments_disposable_test' ||
      !['127.0.0.1', '::1'].includes(identity.address)
    )
      throw new Error('Disposable database identity mismatch');
    suiteLock = source.createQueryRunner();
    await suiteLock.connect();
    await suiteLock.query(
      "SELECT pg_advisory_lock(hashtextextended('test:vet-postgres-suites', 0))",
    );
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
    baseline = migration;
    await applyMigration();
    await applyMigration();
    migration = (
      await readFile(
        resolve(
          process.cwd(),
          'scripts/migrations/20260907-enable-vet-availability-replacement.sql',
        ),
        'utf8',
      )
    ).replace(/^\\set[^\r\n]*(?:\r?\n)?/, '');
    migrationBody = migration
      .replace(/^BEGIN;\s*$/m, '')
      .replace(/^COMMIT;\s*$/m, '');
  }, 60_000);

  afterAll(async () => {
    if (!source?.isInitialized) return;
    try {
      if (disposableConfirmed) await dropVetObjects();
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

  it('verifies the exact immutable Day 1 baseline and rejects altered/mixed baseline states', async () => {
    const [unique] = await source.query<Array<{ definition: string }>>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'UQ_vet_slots_doctor_start' AND conrelid = 'public.vet_appointment_slots'::regclass",
    );
    expect(unique.definition).toBe('UNIQUE ("doctorId", "startsAt")');
    const [status] = await source.query<Array<{ definition: string }>>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'CHK_vet_windows_status' AND conrelid = 'public.vet_availability_windows'::regclass",
    );
    expect(status.definition).not.toContain('RETIRED');
    expect(await catalogFunctions()).toEqual(
      functionBodies(baseline, 'baseline'),
    );
    for (const mutation of [
      'ALTER TABLE public.vet_appointment_slots DROP CONSTRAINT "UQ_vet_slots_doctor_start"; ALTER TABLE public.vet_appointment_slots ADD CONSTRAINT "UQ_vet_slots_doctor_start" UNIQUE ("startsAt", "doctorId")',
      "ALTER TABLE public.vet_availability_windows DROP CONSTRAINT \"CHK_vet_windows_status\"; ALTER TABLE public.vet_availability_windows ADD CONSTRAINT \"CHK_vet_windows_status\" CHECK (status IN ('ACTIVE', 'CANCELLED', 'RETIRED'))",
    ]) {
      await rejectsDrift(mutation);
    }
  });

  it('upgrades populated baseline history without rewriting any business rows (rollback-only probe)', async () => {
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const f: SlotFixture = {
        doctorId: randomUUID(),
        windowId: randomUUID(),
        slotId: randomUUID(),
        userId: randomUUID(),
      };
      await runner.query('INSERT INTO public.users (id) VALUES ($1)', [
        f.userId,
      ]);
      await runner.query(
        'INSERT INTO public.vet_doctors (id,username,"passwordHash","displayName",mobile,"consultationFeeMinor",currency) VALUES ($1,$2,$3,\'Test Doctor\',\'09120000000\',100000,\'IRR\')',
        [f.doctorId, 'test_' + f.doctorId.replace(/-/g, ''), testHash],
      );
      await runner.query(
        'INSERT INTO public.vet_availability_windows (id,"doctorId","startsAt","endsAt","slotDurationMinutes","createdByAdmin") VALUES ($1,$2,\'2030-01-02T10:00:00Z\',\'2030-01-02T11:00:00Z\',15,\'test-admin\')',
        [f.windowId, f.doctorId],
      );
      await runner.query(
        'INSERT INTO public.vet_appointment_slots (id,"availabilityWindowId","doctorId","startsAt","endsAt") VALUES ($1,$2,$3,\'2030-01-02T10:00:00Z\',\'2030-01-02T10:15:00Z\')',
        [f.slotId, f.windowId, f.doctorId],
      );
      const appointment = await insertClaim(runner.manager, f);
      await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
      await runner.query(
        'INSERT INTO public.vet_appointment_events ("appointmentId","eventType","eventKey","actorType") VALUES ($1,\'CONFIRMED\',\'baseline-history\',\'SYSTEM\')',
        [appointment],
      );
      const rows = async () => {
        const result: unknown[] = [];
        for (const entity of VET_ENTITIES) {
          const table = source.getMetadata(entity).tableName;
          result.push(
            await runner.query(
              `SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY id`,
            ),
          );
        }
        return result;
      };
      const before = await rows();
      await runner.query(migrationBody);
      expect(await rows()).toEqual(before);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('upgrades, reruns without replacing objects, and verifies exact current function/index/trigger contracts', async () => {
    const exclusions = () =>
      source.query<Array<{ name: string; oid: string; definition: string }>>(
        "SELECT conname AS name, oid::text AS oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('public.vet_availability_windows'::regclass,'public.vet_appointment_slots'::regclass) AND contype='x' ORDER BY conname",
      );
    const baselineExclusions = await exclusions();
    expect(baselineExclusions).toHaveLength(2);
    await applyMigration();
    expect(await exclusions()).toEqual(baselineExclusions);
    const snapshot = await catalogIdentity();
    await applyMigration();
    expect(await catalogIdentity()).toEqual(snapshot);
    expect(await catalogFunctions()).toEqual(
      functionBodies(migration, 'upgraded'),
    );
    const baselineBodies = functionBodies(baseline, 'baseline');
    const currentBodies = functionBodies(migration, 'upgraded');
    expect(baselineBodies).toHaveLength(6);
    expect(currentBodies).toHaveLength(6);
    for (const original of baselineBodies) {
      const current = currentBodies.find((f) => f.name === original.name)!;
      if (original.name === 'vet_assert_free_claim') {
        const outsideEligibility = (body: string) =>
          body.slice(
            0,
            body.indexOf(
              "    IF TG_TABLE_NAME = 'vet_appointments' AND TG_OP = 'INSERT' THEN",
            ),
          ) + body.slice(body.indexOf('  ELSIF FOUND THEN'));
        expect(outsideEligibility(current.body)).toBe(
          outsideEligibility(original.body),
        );
      } else if (
        !['vet_guard_window', 'vet_guard_slot'].includes(original.name)
      ) {
        expect(current).toEqual(original);
      }
    }
    const [index] = await source.query<
      Array<{ definition: string; predicate: string; valid: boolean }>
    >(
      'SELECT pg_get_indexdef(i.indexrelid) AS definition, pg_get_expr(i.indpred,i.indrelid) AS predicate, i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = \'public."UQ_vet_slots_doctor_start_non_cancelled"\'::regclass',
    );
    expect(index).toEqual({
      definition:
        'CREATE UNIQUE INDEX "UQ_vet_slots_doctor_start_non_cancelled" ON public.vet_appointment_slots USING btree ("doctorId", "startsAt") WHERE ((status)::text <> \'CANCELLED\'::text)',
      predicate: "((status)::text <> 'CANCELLED'::text)",
      valid: true,
    });
    const [trigger] = await source.query<
      Array<{ type: number; enabled: string }>
    >(
      "SELECT tgtype::int AS type, tgenabled AS enabled FROM pg_trigger WHERE tgrelid='public.vet_availability_windows'::regclass AND tgname='TRG_vet_windows_geometry'",
    );
    expect(trigger).toEqual({ type: 23, enabled: 'O' });
    const [old] = await source.query<Array<{ count: string }>>(
      "SELECT count(*) FROM pg_constraint WHERE conrelid='public.vet_appointment_slots'::regclass AND conname='UQ_vet_slots_doctor_start'",
    );
    expect(old.count).toBe('0');
  });

  it('accepts CRLF-distributed SQL without hiding function body drift', async () => {
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(migrationBody.replace(/\r?\n/g, '\r\n'));
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it.each([
    [
      'changed partial predicate',
      'DROP INDEX public."UQ_vet_slots_doctor_start_non_cancelled"; CREATE UNIQUE INDEX "UQ_vet_slots_doctor_start_non_cancelled" ON public.vet_appointment_slots ("doctorId","startsAt") WHERE status = \'AVAILABLE\'',
    ],
    [
      'changed RETIRED check',
      "ALTER TABLE public.vet_availability_windows DROP CONSTRAINT \"CHK_vet_windows_status\"; ALTER TABLE public.vet_availability_windows ADD CONSTRAINT \"CHK_vet_windows_status\" CHECK (status IN ('ACTIVE','CANCELLED','RETIRED','UNKNOWN'))",
    ],
    ...['vet_availability_windows', 'vet_appointment_slots'].flatMap(
      (table) => {
        const trigger =
          table === 'vet_availability_windows'
            ? 'TRG_vet_windows_geometry'
            : 'TRG_vet_slots_geometry';
        return [
          [
            table + ' disabled trigger',
            'ALTER TABLE public.' +
              table +
              ' DISABLE TRIGGER "' +
              trigger +
              '"',
          ],
          [
            table + ' missing trigger',
            'DROP TRIGGER "' + trigger + '" ON public.' + table,
          ],
        ];
      },
    ),
    ...['vet_guard_window', 'vet_guard_slot', 'vet_assert_free_claim'].map(
      (name) => [
        name + ' body',
        'CREATE OR REPLACE FUNCTION public.' +
          name +
          "() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS 'BEGIN RETURN NEW; END;'",
      ],
    ),
    [
      'mixed old unique in upgraded state',
      'ALTER TABLE public.vet_appointment_slots ADD CONSTRAINT "UQ_vet_slots_doctor_start" UNIQUE ("doctorId","startsAt")',
    ],
    [
      'missing new unique',
      'DROP INDEX public."UQ_vet_slots_doctor_start_non_cancelled"',
    ],
  ])(
    'rejects forward %s without silently repairing it',
    async (_name, mutation) => {
      await rejectsDrift(mutation);
    },
  );

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

  it('allows multiple cancelled starts, one usable start, adjacency, and preserves both exclusions', async () => {
    const f = await fixture();
    await cancelSlot(f.slotId);
    const second = await insertSlot(f.windowId, f.doctorId);
    await cancelSlot(second);
    await insertSlot(f.windowId, f.doctorId);
    await expect(insertSlot(f.windowId, f.doctorId)).rejects.toMatchObject({
      driverError: { code: expect.stringMatching(/23505|23P01/) as unknown },
    });
    await insertSlot(f.windowId, f.doctorId, '10:15', '10:30');
    await expect(
      source.query(
        "UPDATE public.vet_availability_windows SET status = 'CANCELLED' WHERE id = $1",
        [f.windowId],
      ),
    ).rejects.toThrow('Cancel all unused slots');
  });

  it.each([15, 30])(
    'replaces unused same-range availability with %s-minute slots and reused starts',
    async (duration) => {
      const f = await fixture();
      await cancelSlot(f.slotId);
      await source.query(
        "UPDATE public.vet_availability_windows SET status = 'CANCELLED' WHERE id = $1",
        [f.windowId],
      );
      const replacement = await insertWindow(
        f.doctorId,
        undefined,
        undefined,
        duration,
      );
      const slot = await insertSlot(
        replacement,
        f.doctorId,
        '10:00',
        duration === 15 ? '10:15' : '10:30',
      );
      expect(slot).not.toBe(f.slotId);
      const [old] = await source.query<
        Array<{ status: string; windowId: string }>
      >(
        'SELECT status, "availabilityWindowId" AS "windowId" FROM public.vet_appointment_slots WHERE id=$1',
        [f.slotId],
      );
      expect(old).toEqual({ status: 'CANCELLED', windowId: f.windowId });
    },
  );

  it('requires cancellation of future AVAILABLE/BLOCKED slots, including slots with only cancelled appointment history', async () => {
    const f = await fixture();
    const appointment = await confirmFree(f);
    await cancelAppointment(appointment);
    await expect(retire(f.windowId)).rejects.toThrow(
      'Cancel future unoccupied slots',
    );
    await source.query(
      "UPDATE public.vet_appointment_slots SET status = 'BLOCKED' WHERE id=$1",
      [f.slotId],
    );
    await expect(retire(f.windowId)).rejects.toThrow(
      'Cancel future unoccupied slots',
    );
    await cancelSlot(f.slotId);
    await expect(retire(f.windowId)).resolves.toBeDefined();
  });

  it('conservatively treats an in-progress unoccupied slot as future scheduling', async () => {
    const doctor = await insertDoctor();
    const [window] = await source.query<RowId[]>(
      'INSERT INTO public.vet_availability_windows ("doctorId","startsAt","endsAt","slotDurationMinutes","createdByAdmin") VALUES ($1,date_trunc(\'minute\',now())-interval \'1 minute\',date_trunc(\'minute\',now())+interval \'1 minute\',2,\'test-admin\') RETURNING id',
      [doctor],
    );
    const [slot] = await source.query<RowId[]>(
      'INSERT INTO public.vet_appointment_slots ("availabilityWindowId","doctorId","startsAt","endsAt") SELECT id,"doctorId","startsAt","endsAt" FROM public.vet_availability_windows WHERE id=$1 RETURNING id',
      [window.id],
    );
    await expect(retire(window.id)).rejects.toThrow(
      'Cancel future unoccupied slots',
    );
    await cancelSlot(slot.id);
    await retire(window.id);
  });

  it.each(['CANCELLED', 'RETIRED'])(
    'requires ACTIVE insertion and makes %s terminal',
    async (status) => {
      const doctor = await insertDoctor();
      await expect(
        source.query(
          'INSERT INTO public.vet_availability_windows ("doctorId","startsAt","endsAt","slotDurationMinutes","createdByAdmin",status) VALUES ($1,\'2030-01-02T10:00:00Z\',\'2030-01-02T11:00:00Z\',15,\'test-admin\',$2)',
          [doctor, status],
        ),
      ).rejects.toThrow('must be active');
      const window = await insertWindow(doctor);
      await source.query(
        'UPDATE public.vet_availability_windows SET status=$2 WHERE id=$1',
        [window, status],
      );
      for (const next of [
        'ACTIVE',
        status === 'RETIRED' ? 'CANCELLED' : 'RETIRED',
      ]) {
        await expect(
          source.query(
            'UPDATE public.vet_availability_windows SET status=$2 WHERE id=$1',
            [window, next],
          ),
        ).rejects.toThrow('terminal');
      }
    },
  );

  it.each(['CANCELLED', 'RETIRED'])(
    'rejects new/restored AVAILABLE and BLOCKED slots under %s',
    async (status) => {
      const f = await fixture();
      await cancelSlot(f.slotId);
      await source.query(
        'UPDATE public.vet_availability_windows SET status=$2 WHERE id=$1',
        [f.windowId, status],
      );
      for (const slotStatus of ['AVAILABLE', 'BLOCKED']) {
        await expect(
          source.query(
            'INSERT INTO public.vet_appointment_slots ("availabilityWindowId","doctorId","startsAt","endsAt",status) VALUES ($1,$2,\'2030-01-02T10:00:00Z\',\'2030-01-02T10:15:00Z\',$3)',
            [f.windowId, f.doctorId, slotStatus],
          ),
        ).rejects.toThrow('active window');
        await expect(
          source.query(
            'UPDATE public.vet_appointment_slots SET status=$2 WHERE id=$1',
            [f.slotId, slotStatus],
          ),
        ).rejects.toThrow();
      }
    },
  );

  it('retains occupied geometry while allowing a replacement envelope, but not overlapping slots with different starts', async () => {
    const f = await fixture();
    const appointment = await confirmFree(f);
    const [before] = await source.query<
      Array<{ slot: unknown; appointment: unknown }>
    >(
      'SELECT to_jsonb(s) AS slot, to_jsonb(a) AS appointment FROM public.vet_appointment_slots s JOIN public.vet_appointments a ON a."slotId"=s.id WHERE a.id=$1',
      [appointment],
    );
    await retire(f.windowId);
    const replacement = await insertWindow(
      f.doctorId,
      '2030-01-02T10:05:00Z',
      '2030-01-02T11:05:00Z',
      10,
    );
    await expect(
      insertSlot(replacement, f.doctorId, '10:05', '10:15'),
    ).rejects.toMatchObject({
      driverError: { code: '23P01', constraint: 'EX_vet_slots_doctor_overlap' },
    });
    await insertSlot(replacement, f.doctorId, '10:15', '10:25');
    const [after] = await source.query<
      Array<{ slot: unknown; appointment: unknown }>
    >(
      'SELECT to_jsonb(s) AS slot, to_jsonb(a) AS appointment FROM public.vet_appointment_slots s JOIN public.vet_appointments a ON a."slotId"=s.id WHERE a.id=$1',
      [appointment],
    );
    expect(after).toEqual(before);
    await expect(cancelSlot(f.slotId)).rejects.toThrow('occupied');
    await expect(
      source.query(
        "UPDATE public.vet_appointment_slots SET status='BLOCKED' WHERE id=$1",
        [f.slotId],
      ),
    ).rejects.toThrow();
    // Re-running the forward migration must also accept populated replacement data.
    await applyMigration();
  });

  it('rejects new bookings on a retained AVAILABLE slot under RETIRED, without consuming another claim', async () => {
    const f = await pastFixture();
    await retire(f.windowId);
    await expect(confirmFree(f)).rejects.toThrow('active window');
    const [counts] = await source.query<
      Array<{ appointments: string; claims: string }>
    >(
      'SELECT (SELECT count(*) FROM public.vet_appointments WHERE "slotId"=$1) AS appointments, (SELECT count(*) FROM public.vet_free_consultation_claims WHERE "ownerUserId"=$2) AS claims',
      [f.slotId, f.userId],
    );
    expect(counts).toEqual({ appointments: '0', claims: '0' });
  });

  it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'])(
    'permits existing %s lifecycle after retirement and never restores entitlement',
    async (status) => {
      const f = await fixture();
      const appointment = await confirmFree(f);
      await retire(f.windowId);
      if (status === 'CANCELLED') {
        await cancelAppointment(appointment);
        await cancelSlot(f.slotId);
        const replacement = await insertWindow(f.doctorId);
        const slotId = await insertSlot(replacement, f.doctorId);
        await expect(
          confirmFree({ ...f, windowId: replacement, slotId }),
        ).rejects.toMatchObject({ driverError: { code: '23505' } });
        await expect(
          confirmFree({
            ...f,
            windowId: replacement,
            slotId,
            userId: await insertUser(),
          }),
        ).resolves.toBeDefined();
      } else {
        await source.query(
          'UPDATE public.vet_appointments SET status=$2::varchar, "completedAt"=CASE WHEN $2::varchar=\'COMPLETED\' THEN now() ELSE NULL END WHERE id=$1',
          [appointment, status],
        );
        await expect(cancelSlot(f.slotId)).rejects.toThrow('occupied');
      }
      const [history] = await source.query<
        Array<{ status: string; slotId: string; claims: string }>
      >(
        'SELECT status,"slotId",(SELECT count(*) FROM public.vet_free_consultation_claims WHERE "appointmentId"=a.id) AS claims FROM public.vet_appointments a WHERE id=$1',
        [appointment],
      );
      expect(history).toEqual({ status, slotId: f.slotId, claims: '1' });
    },
  );

  it('preserves history identity, ownership, FKs and append-only rows after retirement', async () => {
    const f = await fixture();
    const appointment = await confirmFree(f);
    await retire(f.windowId);
    for (const mutation of [
      'UPDATE public.vet_appointment_slots SET id=uuid_generate_v4() WHERE id=$1',
      'UPDATE public.vet_appointment_slots SET "startsAt"="startsAt"+interval \'1 minute\' WHERE id=$1',
      'UPDATE public.vet_appointment_slots SET "availabilityWindowId"=uuid_generate_v4() WHERE id=$1',
      'UPDATE public.vet_appointment_slots SET "doctorId"=uuid_generate_v4() WHERE id=$1',
    ])
      await expect(source.query(mutation, [f.slotId])).rejects.toThrow(
        'immutable',
      );
    for (const mutation of [
      'UPDATE public.vet_availability_windows SET id=uuid_generate_v4() WHERE id=$1',
      'UPDATE public.vet_availability_windows SET "startsAt"="startsAt"+interval \'1 minute\' WHERE id=$1',
      'UPDATE public.vet_availability_windows SET "doctorId"=uuid_generate_v4() WHERE id=$1',
    ])
      await expect(source.query(mutation, [f.windowId])).rejects.toThrow(
        'immutable',
      );
    await expect(
      source.query(
        'UPDATE public.vet_appointments SET "slotId"=NULL WHERE id=$1',
        [appointment],
      ),
    ).rejects.toThrow('immutable');
    await expect(
      source.query('DELETE FROM public.vet_appointments WHERE id=$1', [
        appointment,
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await expect(
      source.query('DELETE FROM public.vet_appointment_slots WHERE id=$1', [
        f.slotId,
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await expect(
      source.query('DELETE FROM public.vet_availability_windows WHERE id=$1', [
        f.windowId,
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await expect(
      source.query('DELETE FROM public.vet_doctors WHERE id=$1', [f.doctorId]),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    for (const sql of [
      'UPDATE public.vet_free_consultation_claims SET "policyVersion"=\'changed\' WHERE "appointmentId"=$1',
      'DELETE FROM public.vet_free_consultation_claims WHERE "appointmentId"=$1',
    ])
      await expect(source.query(sql, [appointment])).rejects.toThrow(
        'append-only',
      );
    await source.query(
      'INSERT INTO public.vet_appointment_events ("appointmentId","eventType","eventKey","actorType") VALUES ($1,\'RETIRED\',\'retirement-test\',\'SYSTEM\')',
      [appointment],
    );
    await expect(
      source.query(
        'DELETE FROM public.vet_appointment_events WHERE "appointmentId"=$1',
        [appointment],
      ),
    ).rejects.toThrow('append-only');
  });

  it('rolls back retirement, cancelled slots, replacement window and generated slots when generation fails', async () => {
    const f = await fixture();
    await confirmFree(f);
    const unused = await insertSlot(f.windowId, f.doctorId, '10:15', '10:30');
    const replacementId = randomUUID();
    await expect(
      source.transaction(async (manager) => {
        await cancelSlot(unused, manager);
        await retire(f.windowId, manager);
        await manager.query(
          'INSERT INTO public.vet_availability_windows (id,"doctorId","startsAt","endsAt","slotDurationMinutes","createdByAdmin") VALUES ($1,$2,\'2030-01-02T10:00:00Z\',\'2030-01-02T11:00:00Z\',15,\'test-admin\')',
          [replacementId, f.doctorId],
        );
        await manager.query(
          'INSERT INTO public.vet_appointment_slots ("availabilityWindowId","doctorId","startsAt","endsAt") VALUES ($1,$2,\'2030-01-02T10:15:00Z\',\'2030-01-02T10:30:00Z\')',
          [replacementId, f.doctorId],
        );
        await manager.query(
          'INSERT INTO public.vet_appointment_slots ("availabilityWindowId","doctorId","startsAt","endsAt") VALUES ($1,$2,\'2030-01-02T10:00:00Z\',\'2030-01-02T10:15:00Z\')',
          [replacementId, f.doctorId],
        );
      }),
    ).rejects.toMatchObject({
      driverError: { code: expect.stringMatching(/23505|23P01/) as unknown },
    });
    const [state] = await source.query<
      Array<{ status: string; slot: string; replacements: string }>
    >(
      'SELECT status,(SELECT status FROM public.vet_appointment_slots WHERE id=$2) AS slot,(SELECT count(*) FROM public.vet_availability_windows WHERE id=$3) AS replacements FROM public.vet_availability_windows WHERE id=$1',
      [f.windowId, unused, replacementId],
    );
    expect(state).toEqual({
      status: 'ACTIVE',
      slot: 'AVAILABLE',
      replacements: '0',
    });
  });

  it.each(['REPEATABLE READ', 'SERIALIZABLE'] as const)(
    'fails closed on unsupported %s scheduling writes',
    async (isolation) => {
      const f = await fixture();
      await expect(
        source.transaction(isolation, (manager) =>
          cancelSlot(f.slotId, manager),
        ),
      ).rejects.toThrow('READ COMMITTED');
      await expect(
        source.transaction(isolation, (manager) => retire(f.windowId, manager)),
      ).rejects.toThrow('READ COMMITTED');
      await expect(
        source.transaction(isolation, (manager) => insertClaim(manager, f)),
      ).rejects.toThrow('READ COMMITTED');
    },
  );

  it('concurrent replacement transactions have exactly one winner and one usable generated start', async () => {
    const f = await fixture();
    const replace = () =>
      source.transaction(async (manager) => {
        await manager.query("SET LOCAL lock_timeout = '3s'");
        await cancelSlot(f.slotId, manager);
        await retire(f.windowId, manager);
        const [window] = await manager.query<RowId[]>(
          'INSERT INTO public.vet_availability_windows ("doctorId","startsAt","endsAt","slotDurationMinutes","createdByAdmin") VALUES ($1,\'2030-01-02T10:00:00Z\',\'2030-01-02T11:00:00Z\',15,\'test-admin\') RETURNING id',
          [f.doctorId],
        );
        await manager.query(
          'INSERT INTO public.vet_appointment_slots ("availabilityWindowId","doctorId","startsAt","endsAt") VALUES ($1,$2,\'2030-01-02T10:00:00Z\',\'2030-01-02T10:15:00Z\')',
          [window.id, f.doctorId],
        );
        return window.id;
      });
    const results = await Promise.allSettled([replace(), replace()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({
          driverError: expect.objectContaining({ code: '23P01' }) as unknown,
        }) as unknown,
      },
    ]);
    const [counts] = await source.query<
      Array<{ windows: string; slots: string }>
    >(
      'SELECT (SELECT count(*) FROM public.vet_availability_windows WHERE "doctorId"=$1 AND status=\'ACTIVE\') AS windows, (SELECT count(*) FROM public.vet_appointment_slots WHERE "doctorId"=$1 AND status<>\'CANCELLED\') AS slots',
      [f.doctorId],
    );
    expect(counts).toEqual({ windows: '1', slots: '1' });
  });

  it('concurrent retirement wins before deferred booking eligibility and rolls the booking/claim back', async () => {
    const f = await pastFixture();
    await withRace(async (first, second, firstPid, secondPid) => {
      await retire(f.windowId, first.manager);
      await insertClaim(second.manager, f);
      const pending = outcome(second.query('SET CONSTRAINTS ALL IMMEDIATE'));
      await waitForBlock(secondPid, firstPid);
      await first.commitTransaction();
      expect(await pending).toMatchObject({
        ok: false,
        error: { driverError: { code: '23514' } },
      });
      await second.rollbackTransaction();
    });
    const [row] = await source.query<Array<{ count: string }>>(
      'SELECT count(*) FROM public.vet_appointments WHERE "slotId"=$1',
      [f.slotId],
    );
    expect(row.count).toBe('0');
  });

  it('concurrent booking wins its eligibility lock; retirement then retains that committed appointment safely', async () => {
    const f = await fixture();
    await withRace(async (first, second, firstPid, secondPid) => {
      await insertClaim(first.manager, f);
      await first.query('SET CONSTRAINTS ALL IMMEDIATE');
      const pending = outcome(retire(f.windowId, second.manager));
      await waitForBlock(secondPid, firstPid);
      await first.commitTransaction();
      expect(await pending).toMatchObject({ ok: true });
      await second.commitTransaction();
    });
    const [row] = await source.query<
      Array<{ status: string; occupants: string }>
    >(
      'SELECT status,(SELECT count(*) FROM public.vet_appointments WHERE "slotId"=$2 AND status=\'CONFIRMED\') AS occupants FROM public.vet_availability_windows WHERE id=$1',
      [f.windowId, f.slotId],
    );
    expect(row).toEqual({ status: 'RETIRED', occupants: '1' });
  });

  it('concurrent slot cancellation wins before deferred booking eligibility', async () => {
    const f = await fixture();
    await withRace(async (first, second, firstPid, secondPid) => {
      await cancelSlot(f.slotId, first.manager);
      await insertClaim(second.manager, f);
      const pending = outcome(second.query('SET CONSTRAINTS ALL IMMEDIATE'));
      await waitForBlock(secondPid, firstPid);
      await first.commitTransaction();
      expect(await pending).toMatchObject({
        ok: false,
        error: { driverError: { code: '23514' } },
      });
      await second.rollbackTransaction();
    });
    const [row] = await source.query<Array<{ count: string }>>(
      'SELECT count(*) FROM public.vet_appointments WHERE "slotId"=$1',
      [f.slotId],
    );
    expect(row.count).toBe('0');
  });

  it('concurrent booking wins before slot cancellation and the occupied slot stays AVAILABLE', async () => {
    const f = await fixture();
    await withRace(async (first, second, firstPid, secondPid) => {
      await insertClaim(first.manager, f);
      await first.query('SET CONSTRAINTS ALL IMMEDIATE');
      const pending = outcome(cancelSlot(f.slotId, second.manager));
      await waitForBlock(secondPid, firstPid);
      await first.commitTransaction();
      expect(await pending).toMatchObject({
        ok: false,
        error: { driverError: { code: '23514' } },
      });
      await second.rollbackTransaction();
    });
    const [row] = await source.query<Array<{ status: string }>>(
      'SELECT status FROM public.vet_appointment_slots WHERE id=$1',
      [f.slotId],
    );
    expect(row.status).toBe('AVAILABLE');
  });

  async function withRace(
    run: (
      first: QueryRunner,
      second: QueryRunner,
      firstPid: number,
      secondPid: number,
    ) => Promise<void>,
  ) {
    const first = source.createQueryRunner();
    const second = source.createQueryRunner();
    try {
      await first.connect();
      await second.connect();
      await first.startTransaction();
      await second.startTransaction();
      await first.query(
        "SET LOCAL lock_timeout = '3s'; SET LOCAL statement_timeout = '5s'",
      );
      await second.query(
        "SET LOCAL lock_timeout = '3s'; SET LOCAL statement_timeout = '5s'",
      );
      const [a] = (await first.query(
        'SELECT pg_backend_pid() AS pid',
      )) as Array<{ pid: number }>;
      const [b] = (await second.query(
        'SELECT pg_backend_pid() AS pid',
      )) as Array<{ pid: number }>;
      expect(a.pid).not.toBe(b.pid);
      await run(first, second, a.pid, b.pid);
    } finally {
      if (first.isTransactionActive) await first.rollbackTransaction();
      if (second.isTransactionActive) await second.rollbackTransaction();
      await first.release();
      await second.release();
    }
  }
  async function waitForBlock(blocked: number, blocker: number) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const [row] = await source.query<Array<{ blocked: boolean }>>(
        'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked',
        [blocked, blocker],
      );
      if (row.blocked) return;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error(
      'Expected deterministic PostgreSQL lock wait was not observed',
    );
  }
  function outcome(promise: Promise<unknown>) {
    return promise.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  }

  async function rejectsDrift(mutation: string) {
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(mutation);
      await runner.query('SAVEPOINT before_forward');
      await expect(runner.query(migrationBody)).rejects.toThrow(/drift/);
      await runner.query('ROLLBACK TO SAVEPOINT before_forward');
      // A second attempt must still reject the same mutation: no silent repair.
      await expect(runner.query(migrationBody)).rejects.toThrow(/drift/);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  function functionBodies(sql: string, phase: 'baseline' | 'upgraded') {
    const normalized = sql.replace(/\r\n/g, '\n');
    const pattern =
      phase === 'baseline'
        ? /DECLARE expected_body text := \$body\$([\s\S]*?)\$body\$; actual record;[\s\S]*?p\.proname = '([^']+)'/g
        : /INSERT INTO vet_replacement_functions VALUES \('([^']+)', \$baseline\$[\s\S]*?\$baseline\$, \$upgraded\$([\s\S]*?)\$upgraded\$\);/g;
    return [...normalized.matchAll(pattern)]
      .map((m) => ({
        name: phase === 'baseline' ? m[2] : m[1],
        body: (phase === 'baseline' ? m[1] : m[2]).trim(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function catalogFunctions() {
    const rows = await source.query<Array<{ name: string; body: string }>>(
      "SELECT proname AS name, btrim(replace(prosrc, E'\\r\\n', E'\\n')) AS body FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'vet_%' ORDER BY proname",
    );
    return rows.map((row) => ({ ...row, body: row.body.trim() }));
  }

  async function catalogIdentity() {
    return source.query<Array<{ name: string; oid: string }>>(
      "SELECT relname AS name, oid::text AS oid FROM pg_class WHERE relnamespace='public'::regnamespace AND (relname LIKE 'vet_%' OR relname LIKE '%vet_%') ORDER BY relname",
    );
  }

  function retire(windowId: string, manager = source.manager) {
    return manager.query(
      "UPDATE public.vet_availability_windows SET status = 'RETIRED' WHERE id = $1",
      [windowId],
    );
  }
  function cancelSlot(slotId: string, manager = source.manager) {
    return manager.query(
      "UPDATE public.vet_appointment_slots SET status = 'CANCELLED' WHERE id = $1",
      [slotId],
    );
  }
  function cancelAppointment(appointmentId: string, manager = source.manager) {
    return manager.query(
      'UPDATE public.vet_appointments SET status = \'CANCELLED\', "cancelledAt" = now(), "cancelledByType" = \'CUSTOMER\', "cancelledById" = \'test-owner\', "cancellationReason" = \'test cancellation\' WHERE id = $1',
      [appointmentId],
    );
  }
  async function insertClaim(manager: EntityManager, f: SlotFixture) {
    const id = await insertAppointment(manager, f);
    await manager.query(
      'INSERT INTO public.vet_free_consultation_claims ("policyVersion","subjectType","ownerUserId","appointmentId") VALUES (\'vet-first-free-v1\',\'OWNER\',$1,$2)',
      [f.userId, id],
    );
    return id;
  }
  async function pastFixture() {
    const doctorId = await insertDoctor();
    const windowId = await insertWindow(
      doctorId,
      '2000-01-02T10:00:00Z',
      '2000-01-02T11:00:00Z',
    );
    const [slot] = await source.query<RowId[]>(
      'INSERT INTO public.vet_appointment_slots ("availabilityWindowId","doctorId","startsAt","endsAt") VALUES ($1,$2,\'2000-01-02T10:00:00Z\',\'2000-01-02T10:15:00Z\') RETURNING id',
      [windowId, doctorId],
    );
    return { doctorId, windowId, slotId: slot.id, userId: await insertUser() };
  }
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
  if (url.pathname.slice(1) !== 'vet_appointments_disposable_test')
    throw new Error('Dedicated vet test/disposable database required');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Vet tests require a local disposable PostgreSQL server');
  return value;
}
