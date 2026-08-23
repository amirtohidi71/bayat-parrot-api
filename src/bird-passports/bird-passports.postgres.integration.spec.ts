import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource, QueryRunner } from 'typeorm';
import { BirdPassportsService } from './bird-passports.service';
import { BirdFeedingRecord } from './entities/bird-feeding-record.entity';
import {
  BIRD_PASSPORT_OTP_PURPOSE,
  BirdPassportOtp,
} from './entities/bird-passport-otp.entity';
import {
  BirdPassport,
  BirdPassportStatus,
} from './entities/bird-passport.entity';
import { BirdVaccineRecord } from './entities/bird-vaccine-record.entity';
import { BirdVeterinaryVisit } from './entities/bird-veterinary-visit.entity';
import { createPublicBirdPassportOtpCandidate } from './public-bird-passport-otp-candidate';
import {
  PublicBirdPassportSmsDispatch,
  PublicBirdPassportSmsDispatchService,
} from './public-bird-passport-sms-dispatch.service';
import {
  PUBLIC_OTP_OWNER_MOBILE_MISMATCH_CODE,
  PUBLIC_OTP_OWNER_MOBILE_MISMATCH_MESSAGE,
  PublicBirdPassportsService,
} from './public-bird-passports.service';

const enabled =
  process.env.BIRD_PASSPORT_RUN_DB_TESTS === '1' &&
  process.env.BIRD_PASSPORT_TEST_DATABASE_CONFIRM === 'DISPOSABLE';
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase('Bird Passport PostgreSQL integration', () => {
  let dataSource: DataSource;
  let migrationSql: string;
  let namesMigrationSql: string;
  let passports: BirdPassportsService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: requireDisposableDatabaseUrl(),
      entities: [
        BirdPassport,
        BirdVaccineRecord,
        BirdFeedingRecord,
        BirdVeterinaryVisit,
        BirdPassportOtp,
      ],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    const [identity] = await dataSource.query<
      Array<{ database: string; server: string | null }>
    >(
      'SELECT current_database() AS database, inet_server_addr()::text AS server',
    );
    if (!identity?.database || !/(test|disposable)/i.test(identity.database)) {
      throw new Error('Refusing to use a database not named test/disposable');
    }

    await dropBirdPassportObjects();
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    migrationSql = await readFile(
      resolve(
        process.cwd(),
        'scripts',
        'migrations',
        '20260810-create-bird-passports.sql',
      ),
      'utf8',
    );
    namesMigrationSql = await readFile(
      resolve(
        process.cwd(),
        'scripts',
        'migrations',
        '20260819-add-bird-passport-names.sql',
      ),
      'utf8',
    );
    await runMigration();
    await runMigration();
    await runMigration(namesMigrationSql);
    await runMigration(namesMigrationSql);
    passports = new BirdPassportsService(
      dataSource.getRepository(BirdPassport),
      dataSource,
    );
  }, 60_000);

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE public.bird_passports CASCADE');
    await dataSource.query(
      'ALTER SEQUENCE public.bird_passport_code_seq RESTART WITH 25543210',
    );
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dropBirdPassportObjects();
    await dataSource.destroy();
  });

  it('runs twice and exposes the exact entity-compatible schema', async () => {
    const tables = await dataSource.query<Array<{ table_name: string }>>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'bird_%'
       ORDER BY table_name COLLATE "C"`,
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      'bird_feeding_records',
      'bird_passport_otps',
      'bird_passports',
      'bird_vaccine_records',
      'bird_veterinary_visits',
    ]);

    const columns = await dataSource.query<
      Array<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: 'YES' | 'NO';
      }>
    >(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name LIKE 'bird_%'
       ORDER BY table_name COLLATE "C", ordinal_position`,
    );
    expect(columns).toEqual(expectedColumns());

    const nameColumns = await dataSource.query<
      Array<{
        column_name: string;
        character_maximum_length: number;
        is_nullable: 'YES' | 'NO';
        column_default: string | null;
      }>
    >(
      `SELECT column_name, character_maximum_length, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'bird_passports'
         AND column_name IN ('ownerFullName', 'birdName')
       ORDER BY column_name COLLATE "C"`,
    );
    expect(nameColumns).toEqual([
      {
        column_name: 'birdName',
        character_maximum_length: 100,
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'ownerFullName',
        character_maximum_length: 150,
        is_nullable: 'YES',
        column_default: null,
      },
    ]);

    const enumLabels = await dataSource.query<Array<{ enumlabel: string }>>(
      `SELECT e.enumlabel
       FROM pg_catalog.pg_enum e
       WHERE e.enumtypid = 'public.bird_passports_status_enum'::regtype
       ORDER BY e.enumsortorder`,
    );
    expect(enumLabels.map((row) => row.enumlabel)).toEqual([
      'draft',
      'active',
      'archived',
    ]);

    const constraints = await dataSource.query<Array<{ conname: string }>>(
      `SELECT c.conname
       FROM pg_catalog.pg_constraint c
       WHERE c.conrelid IN (
         'public.bird_passports'::regclass,
         'public.bird_vaccine_records'::regclass,
         'public.bird_feeding_records'::regclass,
         'public.bird_veterinary_visits'::regclass,
         'public.bird_passport_otps'::regclass
       )
       ORDER BY c.conname COLLATE "C"`,
    );
    expect(constraints.map((row) => row.conname)).toEqual(
      expectedConstraintNames().sort(),
    );

    const indexes = await dataSource.query<
      Array<{
        name: string;
        valid: boolean;
        ready: boolean;
        live: boolean;
      }>
    >(
      `SELECT ic.relname AS name, i.indisvalid AS valid,
              i.indisready AS ready, i.indislive AS live
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
       WHERE i.indrelid IN (
         'public.bird_passports'::regclass,
         'public.bird_vaccine_records'::regclass,
         'public.bird_feeding_records'::regclass,
         'public.bird_veterinary_visits'::regclass,
         'public.bird_passport_otps'::regclass
       )
       ORDER BY ic.relname COLLATE "C"`,
    );
    expect(indexes.map((row) => row.name)).toEqual(expectedIndexNames().sort());
    expect(
      indexes.every((index) => index.valid && index.ready && index.live),
    ).toBe(true);

    const triggers = await dataSource.query<Array<{ name: string }>>(
      `SELECT tgname AS name
       FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'public.bird_passports'::regclass
         AND NOT tgisinternal`,
    );
    expect(triggers).toEqual([{ name: 'TRG_bird_passports_code_immutable' }]);

    const [sequence] = await dataSource.query<
      Array<{
        start_value: string;
        increment_by: string;
        min_value: string;
        max_value: string;
        cycle: boolean;
      }>
    >(
      `SELECT start_value::text, increment_by::text, min_value::text,
              max_value::text, cycle
       FROM pg_catalog.pg_sequences
       WHERE schemaname = 'public'
         AND sequencename = 'bird_passport_code_seq'`,
    );
    expect(sequence).toEqual({
      start_value: '25543210',
      increment_by: '1',
      min_value: '25543210',
      max_value: '99999999',
      cycle: false,
    });
    const [position] = await dataSource.query<
      Array<{ last_value: string; is_called: boolean }>
    >(
      `SELECT last_value::text, is_called
       FROM public.bird_passport_code_seq`,
    );
    expect(position).toEqual({ last_value: '25543210', is_called: false });
  });

  it('allocates the first code and keeps concurrent codes unique', async () => {
    const first = await passports.create(passportDto('Macaw'));
    expect(first.code).toBe('B25543210');

    const created = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        passports.create(passportDto(`Species ${index}`)),
      ),
    );
    const codes = [first.code, ...created.map((row) => row.code)];
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('B25543210');
    const [{ duplicates }] = await dataSource.query<
      Array<{ duplicates: number }>
    >(
      `SELECT count(*)::int AS duplicates
       FROM (
         SELECT code FROM public.bird_passports
         GROUP BY code HAVING count(*) > 1
       ) duplicate_codes`,
    );
    expect(duplicates).toBe(0);
  });

  it('accepts rollback gaps without resetting or reusing an allocation', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const allocation: unknown = await runner.query(
        `SELECT nextval('public.bird_passport_code_seq')::text AS value`,
      );
      expect(readFirstTextColumn(allocation, 'value')).toBe('25543210');
      await runner.rollbackTransaction();
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }

    const firstCommitted = await passports.create(passportDto('After gap'));
    const secondCommitted = await passports.create(passportDto('Next'));
    expect(firstCommitted.code).toBe('B25543211');
    expect(secondCommitted.code).toBe('B25543212');
    expect(
      await dataSource.getRepository(BirdPassport).exists({
        where: { code: 'B25543210' },
      }),
    ).toBe(false);
  });

  it.each([
    ['vaccine', 10],
    ['feeding', 10],
    ['veterinary', 10],
  ] as const)(
    'serializes concurrent %s inserts with sequential server order',
    async (recordType, count) => {
      const passport = await passports.create(passportDto(recordType));
      if (recordType === 'vaccine') {
        await Promise.all(
          Array.from({ length: count }, (_, index) =>
            passports.addVaccine(passport.id, {
              vaccineName: `Vaccine ${index}`,
              vaccinationDate: '2026-01-01',
            }),
          ),
        );
      } else if (recordType === 'feeding') {
        await Promise.all(
          Array.from({ length: count }, (_, index) =>
            passports.addFeeding(passport.id, {
              ageRange: `Range ${index}`,
              description: `Food ${index}`,
            }),
          ),
        );
      } else {
        await Promise.all(
          Array.from({ length: count }, (_, index) =>
            passports.addVeterinaryVisit(passport.id, {
              visitDate: '2026-01-01',
              clinicalNotes: `Notes ${index}`,
              veterinaryActions: `Actions ${index}`,
            }),
          ),
        );
      }

      const entity =
        recordType === 'vaccine'
          ? BirdVaccineRecord
          : recordType === 'feeding'
            ? BirdFeedingRecord
            : BirdVeterinaryVisit;
      const rows = await dataSource.getRepository(entity).find({
        where: { passportId: passport.id },
        order: { sortOrder: 'ASC' },
      });
      expect(rows.map((row) => row.sortOrder)).toEqual(
        Array.from({ length: count }, (_, index) => index),
      );
    },
  );

  it('serializes OTP request/verify and enforces the fifth failed attempt', async () => {
    const passport = await passports.create(passportDto('OTP'));
    await dataSource
      .getRepository(BirdPassport)
      .update({ id: passport.id }, { status: BirdPassportStatus.ACTIVE });
    const deliveries: PublicBirdPassportSmsDispatch[] = [];
    const service = publicOtpService(deliveries);
    const dto = { code: passport.code, ownerMobile: '09123456789' };

    await Promise.all([service.requestOtp(dto), service.requestOtp(dto)]);
    expect(deliveries).toHaveLength(1);
    const usable = await dataSource.getRepository(BirdPassportOtp).find({
      where: {
        birdPassportId: passport.id,
        phone: dto.ownerMobile,
        consumed: false,
      },
    });
    expect(usable).toHaveLength(1);

    const verifications = await Promise.allSettled([
      service.verifyOtp({ ...dto, otp: deliveries[0].rawCode }),
      service.verifyOtp({ ...dto, otp: deliveries[0].rawCode }),
    ]);
    expect(
      verifications.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failedVerification = verifications.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(failedVerification?.reason).toBeInstanceOf(UnauthorizedException);

    await dataSource
      .getRepository(BirdPassportOtp)
      .update({ birdPassportId: passport.id }, { consumed: true });
    const attemptOtp = await dataSource.getRepository(BirdPassportOtp).save({
      birdPassportId: passport.id,
      phone: dto.ownerMobile,
      purpose: BIRD_PASSPORT_OTP_PURPOSE,
      codeHash: await bcrypt.hash('12345', 10),
      expiresAt: new Date(Date.now() + 120_000),
      attempts: 0,
      consumed: false,
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(
        service.verifyOtp({ ...dto, otp: '99999' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    const exhausted = await dataSource
      .getRepository(BirdPassportOtp)
      .findOneByOrFail({ id: attemptOtp.id });
    expect(exhausted).toMatchObject({ attempts: 5, consumed: true });
  }, 30_000);

  it('rejects an active passport mobile mismatch without OTP persistence or SMS', async () => {
    const passport = await passports.create(passportDto('OTP mismatch'));
    await dataSource
      .getRepository(BirdPassport)
      .update({ id: passport.id }, { status: BirdPassportStatus.ACTIVE });
    const deliveries: PublicBirdPassportSmsDispatch[] = [];
    const service = publicOtpService(deliveries);

    const error = await service
      .requestOtp({ code: passport.code, ownerMobile: '09999999999' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual({
      code: PUBLIC_OTP_OWNER_MOBILE_MISMATCH_CODE,
      message: PUBLIC_OTP_OWNER_MOBILE_MISMATCH_MESSAGE,
    });
    expect(deliveries).toHaveLength(0);
    await expect(
      dataSource.getRepository(BirdPassportOtp).count({
        where: { birdPassportId: passport.id },
      }),
    ).resolves.toBe(0);
  });

  it('rejects a same-named invalid index during rerun', async () => {
    await dataSource.query(
      `INSERT INTO public.bird_passports
         (code, "ownerMobile", "birthDate", species, subspecies)
       VALUES
         ('B25543210', '09123456789', '2025-01-01', 'A', 'A'),
         ('B25543211', '09123456789', '2025-01-01', 'B', 'B')`,
    );
    await dataSource.query('DROP INDEX public."IDX_bird_passports_status"');
    await expect(
      dataSource.query(
        `CREATE UNIQUE INDEX CONCURRENTLY "IDX_bird_passports_status"
         ON public.bird_passports USING btree (status)`,
      ),
    ).rejects.toThrow();
    try {
      const [state] = await dataSource.query<Array<{ valid: boolean }>>(
        `SELECT indisvalid AS valid
         FROM pg_catalog.pg_index
         WHERE indexrelid =
           'public."IDX_bird_passports_status"'::regclass`,
      );
      expect(state.valid).toBe(false);
      await expect(runMigration()).rejects.toThrow();
    } finally {
      await dataSource.query(
        'DROP INDEX IF EXISTS public."IDX_bird_passports_status"',
      );
      await dataSource.query(
        'CREATE INDEX "IDX_bird_passports_status" ON public.bird_passports USING btree (status)',
      );
    }
  });

  it('rejects an unexpected extra non-internal trigger during rerun', async () => {
    await dataSource.query(
      `CREATE FUNCTION public.unexpected_bird_passport_trigger()
       RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
    );
    await dataSource.query(
      `CREATE TRIGGER "TRG_bird_passports_unexpected"
       BEFORE UPDATE ON public.bird_passports
       FOR EACH ROW EXECUTE FUNCTION public.unexpected_bird_passport_trigger()`,
    );
    try {
      await expect(runMigration()).rejects.toThrow('user trigger set mismatch');
    } finally {
      await dataSource.query(
        'DROP TRIGGER IF EXISTS "TRG_bird_passports_unexpected" ON public.bird_passports',
      );
      await dataSource.query(
        'DROP FUNCTION IF EXISTS public.unexpected_bird_passport_trigger()',
      );
    }
  });

  function publicOtpService(
    deliveries: PublicBirdPassportSmsDispatch[],
  ): PublicBirdPassportsService {
    const dispatch: Pick<PublicBirdPassportSmsDispatchService, 'dispatch'> = {
      dispatch: (delivery) => {
        deliveries.push(delivery);
      },
    };
    return new PublicBirdPassportsService(
      dataSource.getRepository(BirdPassport),
      dataSource,
      {} as never,
      { create: () => createPublicBirdPassportOtpCandidate() },
      {
        start: () => 0,
        waitForFloor: () => Promise.resolve(),
      } as never,
      dispatch as PublicBirdPassportSmsDispatchService,
      { schedule: () => undefined } as never,
    );
  }

  async function runMigration(sql: string = migrationSql): Promise<void> {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(sql);
    } catch (error) {
      await rollbackFailedMigration(runner);
      throw error;
    } finally {
      await runner.release();
    }
  }

  async function rollbackFailedMigration(runner: QueryRunner): Promise<void> {
    await runner.query('ROLLBACK').catch(() => undefined);
  }

  async function dropBirdPassportObjects(): Promise<void> {
    await dataSource.query(
      `DROP TABLE IF EXISTS public.bird_passport_otps CASCADE;
       DROP TABLE IF EXISTS public.bird_veterinary_visits CASCADE;
       DROP TABLE IF EXISTS public.bird_feeding_records CASCADE;
       DROP TABLE IF EXISTS public.bird_vaccine_records CASCADE;
       DROP TABLE IF EXISTS public.bird_passports CASCADE;
       DROP SEQUENCE IF EXISTS public.bird_passport_code_seq;
       DROP FUNCTION IF EXISTS public.reject_bird_passport_code_update();
       DROP FUNCTION IF EXISTS public.unexpected_bird_passport_trigger();
       DROP TYPE IF EXISTS public.bird_passports_status_enum;`,
    );
  }
});

function requireDisposableDatabaseUrl(): string {
  const url = process.env.BIRD_PASSPORT_TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('BIRD_PASSPORT_TEST_DATABASE_URL is required');
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!/(test|disposable)/i.test(databaseName)) {
    throw new Error('Test database name must contain test or disposable');
  }
  return url;
}

function passportDto(species: string) {
  return {
    ownerFullName: 'Integration Owner',
    ownerMobile: '09123456789',
    birdName: 'Integration Bird',
    birthDate: '2025-01-01',
    species,
    subspecies: 'Integration',
  };
}

function readFirstTextColumn(rows: unknown, columnName: string): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Expected query column ${columnName}`);
  }
  const first: unknown = rows[0];
  if (typeof first !== 'object' || first === null || !(columnName in first)) {
    throw new Error(`Expected query column ${columnName}`);
  }
  const value = (first as Record<string, unknown>)[columnName];
  if (typeof value !== 'string') {
    throw new Error(`Expected text query column ${columnName}`);
  }
  return value;
}

function expectedColumns() {
  const notNull = 'NO' as const;
  const nullable = 'YES' as const;
  return [
    column('bird_feeding_records', 'id', 'uuid', notNull),
    column('bird_feeding_records', 'passportId', 'uuid', notNull),
    column('bird_feeding_records', 'ageRange', 'character varying', notNull),
    column('bird_feeding_records', 'description', 'text', notNull),
    column('bird_feeding_records', 'sortOrder', 'integer', notNull),
    column(
      'bird_feeding_records',
      'createdAt',
      'timestamp with time zone',
      notNull,
    ),
    column(
      'bird_feeding_records',
      'updatedAt',
      'timestamp with time zone',
      notNull,
    ),
    column('bird_passport_otps', 'id', 'uuid', notNull),
    column('bird_passport_otps', 'birdPassportId', 'uuid', notNull),
    column('bird_passport_otps', 'phone', 'character varying', notNull),
    column('bird_passport_otps', 'purpose', 'character varying', notNull),
    column('bird_passport_otps', 'codeHash', 'character varying', notNull),
    column(
      'bird_passport_otps',
      'expiresAt',
      'timestamp with time zone',
      notNull,
    ),
    column('bird_passport_otps', 'attempts', 'integer', notNull),
    column('bird_passport_otps', 'consumed', 'boolean', notNull),
    column(
      'bird_passport_otps',
      'createdAt',
      'timestamp with time zone',
      notNull,
    ),
    column('bird_passports', 'id', 'uuid', notNull),
    column('bird_passports', 'code', 'character varying', notNull),
    column('bird_passports', 'ownerMobile', 'character varying', notNull),
    column('bird_passports', 'ownerFullName', 'character varying', nullable),
    column('bird_passports', 'birdName', 'character varying', nullable),
    column('bird_passports', 'imagePath', 'text', nullable),
    column('bird_passports', 'birthDate', 'date', notNull),
    column('bird_passports', 'species', 'character varying', notNull),
    column('bird_passports', 'subspecies', 'character varying', notNull),
    column('bird_passports', 'status', 'USER-DEFINED', notNull),
    column('bird_passports', 'createdAt', 'timestamp with time zone', notNull),
    column('bird_passports', 'updatedAt', 'timestamp with time zone', notNull),
    column('bird_vaccine_records', 'id', 'uuid', notNull),
    column('bird_vaccine_records', 'passportId', 'uuid', notNull),
    column('bird_vaccine_records', 'vaccineName', 'character varying', notNull),
    column('bird_vaccine_records', 'vaccinationDate', 'date', notNull),
    column('bird_vaccine_records', 'sortOrder', 'integer', notNull),
    column(
      'bird_vaccine_records',
      'createdAt',
      'timestamp with time zone',
      notNull,
    ),
    column(
      'bird_vaccine_records',
      'updatedAt',
      'timestamp with time zone',
      notNull,
    ),
    column('bird_veterinary_visits', 'id', 'uuid', notNull),
    column('bird_veterinary_visits', 'passportId', 'uuid', notNull),
    column('bird_veterinary_visits', 'visitDate', 'date', notNull),
    column('bird_veterinary_visits', 'clinicalNotes', 'text', notNull),
    column('bird_veterinary_visits', 'veterinaryActions', 'text', notNull),
    column('bird_veterinary_visits', 'sortOrder', 'integer', notNull),
    column(
      'bird_veterinary_visits',
      'createdAt',
      'timestamp with time zone',
      notNull,
    ),
    column(
      'bird_veterinary_visits',
      'updatedAt',
      'timestamp with time zone',
      notNull,
    ),
  ];
}

function column(
  table_name: string,
  column_name: string,
  data_type: string,
  is_nullable: 'YES' | 'NO',
) {
  return { table_name, column_name, data_type, is_nullable };
}

function expectedConstraintNames(): string[] {
  return [
    'bird_passports_pkey',
    'UQ_bird_passports_code',
    'CHK_bird_passports_code_format',
    'CHK_bird_passports_owner_mobile_format',
    'bird_vaccine_records_pkey',
    'FK_bird_vaccine_records_passport',
    'CHK_bird_vaccine_records_sort_order',
    'bird_feeding_records_pkey',
    'FK_bird_feeding_records_passport',
    'CHK_bird_feeding_records_sort_order',
    'bird_veterinary_visits_pkey',
    'FK_bird_veterinary_visits_passport',
    'CHK_bird_veterinary_visits_sort_order',
    'bird_passport_otps_pkey',
    'FK_bird_passport_otps_passport',
    'CHK_bird_passport_otps_phone_format',
    'CHK_bird_passport_otps_attempts',
    'CHK_bird_passport_otps_purpose',
  ];
}

function expectedIndexNames(): string[] {
  return [
    'bird_passports_pkey',
    'UQ_bird_passports_code',
    'IDX_bird_passports_status',
    'bird_vaccine_records_pkey',
    'IDX_bird_vaccine_records_passport_sort',
    'bird_feeding_records_pkey',
    'IDX_bird_feeding_records_passport_sort',
    'bird_veterinary_visits_pkey',
    'IDX_bird_veterinary_visits_passport_sort',
    'IDX_bird_veterinary_visits_passport_date',
    'bird_passport_otps_pkey',
    'IDX_bird_passport_otps_lookup',
    'IDX_bird_passport_otps_expiry',
  ];
}
