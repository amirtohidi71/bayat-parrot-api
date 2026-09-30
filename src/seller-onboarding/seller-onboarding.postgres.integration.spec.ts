import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { VET_TEST_ENTITIES } from '../../test/vet-test-entities';
import { AuthService } from '../auth/auth.service';
import { Otp } from '../auth/entities/otp.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  BreederApplication,
  BreederApplicationStatus,
  BreederCallOutcome,
} from './entities/breeder-application.entity';
import {
  SellerVerification,
  SellerVerificationStatus,
} from './entities/seller-verification.entity';
import { SellerEligibilityPolicy } from './seller-eligibility.policy';
import { SellerErrorCode } from './seller-onboarding.constants';
import { SellerOnboardingService } from './seller-onboarding.service';

const DATABASE_NAME = 'seller_onboarding_disposable_test';
const enabled =
  process.env.SELLER_ONBOARDING_RUN_DB_TESTS === '1' &&
  process.env.SELLER_ONBOARDING_TEST_DATABASE_CONFIRM === 'DISPOSABLE' &&
  Boolean(process.env.SELLER_ONBOARDING_TEST_DATABASE_URL?.trim());
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase('Seller onboarding real PostgreSQL integration', () => {
  let administrator: DataSource;
  let source: DataSource;
  let forwardMigration: string;
  let rollbackMigration: string;
  let databaseCreated = false;

  beforeAll(async () => {
    const target = requireDisposableConfiguration();
    const adminUrl = new URL(target.toString());
    adminUrl.pathname = '/postgres';
    administrator = new DataSource({
      type: 'postgres',
      url: adminUrl.toString(),
      synchronize: false,
      logging: false,
    });
    await administrator.initialize();
    await assertLoopbackServer(administrator, 'postgres');

    await terminateTargetConnections();
    await administrator.query(
      `DROP DATABASE IF EXISTS "seller_onboarding_disposable_test"`,
    );
    await administrator.query(
      `CREATE DATABASE "seller_onboarding_disposable_test"`,
    );
    databaseCreated = true;

    source = new DataSource({
      type: 'postgres',
      url: target.toString(),
      entities: [
        ...VET_TEST_ENTITIES,
        Otp,
        SellerVerification,
        BreederApplication,
      ],
      synchronize: false,
      logging: false,
      extra: { max: 12 },
    });
    await source.initialize();
    await assertLoopbackServer(source, DATABASE_NAME);

    forwardMigration = stripPsqlDirective(
      await readFile(
        resolve(
          process.cwd(),
          'scripts/migrations/20260926-create-seller-onboarding-v1.sql',
        ),
        'utf8',
      ),
    );
    rollbackMigration = stripPsqlDirective(
      await readFile(
        resolve(
          process.cwd(),
          'scripts/migrations/20260926-rollback-seller-onboarding-v1.sql',
        ),
        'utf8',
      ),
    );
  }, 60_000);

  afterAll(async () => {
    if (source?.isInitialized) await source.destroy();
    let cleanupError: Error | undefined;
    try {
      if (administrator?.isInitialized && databaseCreated) {
        await terminateTargetConnections();
        await administrator.query(
          `DROP DATABASE IF EXISTS "seller_onboarding_disposable_test"`,
        );
        const [remaining] = await administrator.query<
          Array<{ exists: boolean }>
        >('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)', [
          DATABASE_NAME,
        ]);
        if (remaining.exists)
          cleanupError = new Error(
            'Disposable seller onboarding database cleanup failed',
          );
      }
    } finally {
      if (administrator?.isInitialized) await administrator.destroy();
    }
    if (cleanupError) throw cleanupError;
  }, 60_000);

  beforeEach(async () => resetFoundation());

  it('applies the migration to an empty foundation and matches the entity contract', async () => {
    await applyForward();

    const enumRows = await source.query<Array<{ name: string; label: string }>>(
      `SELECT t.typname AS name, e.enumlabel AS label
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typname IN (
            'users_role_enum',
            'seller_verifications_status_enum',
            'breeder_applications_status_enum',
            'breeder_applications_call_outcome_enum'
          )
        ORDER BY t.typname, e.enumsortorder`,
    );
    const labels = (name: string) =>
      enumRows.filter((row) => row.name === name).map((row) => row.label);
    expect(labels('users_role_enum')).toEqual(['admin', 'customer', 'breeder']);
    expect(labels('seller_verifications_status_enum')).toEqual([
      'PENDING',
      'APPROVED',
      'REJECTED',
    ]);
    expect(labels('breeder_applications_status_enum')).toEqual([
      'PENDING_CALL',
      'FOLLOW_UP',
      'APPROVED',
      'REJECTED',
    ]);
    expect(labels('breeder_applications_call_outcome_enum')).toEqual([
      'SUCCESSFUL',
      'NO_ANSWER',
      'FOLLOW_UP_REQUIRED',
      'NOT_ELIGIBLE',
    ]);

    await expectEntityColumns(SellerVerification);
    await expectEntityColumns(BreederApplication);
    await expectUserSecurityColumns();
    await expectDatabaseObjects();
  });

  it('preserves existing users and gives them compatible security defaults', async () => {
    const id = await insertFoundationUser();
    await applyForward();
    const [user] = await source.query<
      Array<{ id: string; active: boolean; verified: Date | null }>
    >(
      `SELECT id, "isActive" AS active, "phoneVerifiedAt" AS verified
         FROM public.users WHERE id = $1`,
      [id],
    );
    expect(user).toEqual({ id, active: true, verified: null });
  });

  it('fails closed when the migration is partially applied', async () => {
    await source.query(
      'ALTER TABLE public.users ADD COLUMN "isActive" boolean NOT NULL DEFAULT true',
    );
    await expect(applyForward()).rejects.toThrow(
      'Seller onboarding migration is already or partially applied',
    );
    const [tables] = await source.query<Array<{ count: string }>>(
      `SELECT count(*) FROM pg_tables
        WHERE schemaname='public'
          AND tablename IN ('seller_verifications','breeder_applications')`,
    );
    expect(tables.count).toBe('0');
  });

  it('ignores a same-named enum in another schema during preflight', async () => {
    await source.query('CREATE SCHEMA seller_shadow');
    try {
      await source.query(
        "CREATE TYPE seller_shadow.users_role_enum AS ENUM ('breeder')",
      );
      await expect(applyForward()).resolves.toBeUndefined();
      expect(await source.getRepository(SellerVerification).count()).toBe(0);
    } finally {
      await source.query('DROP SCHEMA IF EXISTS seller_shadow CASCADE');
    }
  });

  it('rolls back a pristine onboarding schema safely', async () => {
    await applyForward();
    await executeMigration(rollbackMigration);
    const [state] = await source.query<
      Array<{
        sellers: string | null;
        breeders: string | null;
        breederEnum: boolean;
      }>
    >(
      `SELECT to_regclass('public.seller_verifications')::text AS sellers,
              to_regclass('public.breeder_applications')::text AS breeders,
              EXISTS(
                SELECT 1
                  FROM pg_enum e
                  JOIN pg_type t ON t.oid=e.enumtypid
                  JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE n.nspname='public' AND t.typname='users_role_enum'
                   AND e.enumlabel='breeder'
              ) AS "breederEnum"`,
    );
    expect(state).toEqual({
      sellers: null,
      breeders: null,
      breederEnum: false,
    });
  });

  it('refuses rollback when verification history exists and preserves it', async () => {
    await applyForward();
    const user = await insertUser();
    await insertSeller(user.id, SellerVerificationStatus.PENDING);
    await expect(executeMigration(rollbackMigration)).rejects.toThrow(
      'Rollback refused: seller verification history exists',
    );
    expect(await source.getRepository(SellerVerification).count()).toBe(1);
  });

  it('refuses rollback for a breeder user and preserves the role', async () => {
    await applyForward();
    const user = await insertUser(UserRole.BREEDER);
    await expect(executeMigration(rollbackMigration)).rejects.toThrow(
      'Rollback refused: BREEDER users exist',
    );
    expect(
      (await source.getRepository(User).findOneByOrFail({ id: user.id })).role,
    ).toBe(UserRole.BREEDER);
  });

  it('allows only one concurrent active seller verification and supports resubmit after rejection', async () => {
    await applyForward();
    const user = await insertUser();
    const service = onboardingService();
    const results = await Promise.allSettled([
      service.submitSeller(user.id, sellerInput('First')),
      service.submitSeller(user.id, sellerInput('Second')),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expectStableConflict(results);
    const repository = source.getRepository(SellerVerification);
    expect(
      await repository.count({
        where: { userId: user.id, status: SellerVerificationStatus.PENDING },
      }),
    ).toBe(1);
    const pending = await repository.findOneByOrFail({ userId: user.id });
    pending.status = SellerVerificationStatus.REJECTED;
    pending.reviewedBy = 'test-admin';
    pending.reviewedAt = new Date();
    pending.rejectionReason = 'retry allowed';
    await repository.save(pending);
    await expect(
      service.submitSeller(user.id, sellerInput('Retry')),
    ).resolves.toMatchObject({
      status: SellerVerificationStatus.PENDING,
    });
  });

  it('allows only one concurrent active breeder application and supports resubmit after rejection', async () => {
    await applyForward();
    const user = await verifiedUser();
    const service = onboardingService();
    const results = await Promise.allSettled([
      service.submitBreeder(user.id, breederInput('First')),
      service.submitBreeder(user.id, breederInput('Second')),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await source.getRepository(BreederApplication).count({
        where: { userId: user.id },
      }),
    ).toBe(1);
    const application = await source
      .getRepository(BreederApplication)
      .findOneByOrFail({
        userId: user.id,
      });
    application.status = BreederApplicationStatus.REJECTED;
    application.reviewedBy = 'test-admin';
    application.reviewedAt = new Date();
    application.rejectionReason = 'retry allowed';
    await source.getRepository(BreederApplication).save(application);
    await expect(
      service.submitBreeder(user.id, breederInput('Retry')),
    ).resolves.toMatchObject({ status: BreederApplicationStatus.PENDING_CALL });
  });

  it('serializes seller approve and reject so exactly one transition wins', async () => {
    await applyForward();
    const user = await insertUser();
    const verification = await insertSeller(
      user.id,
      SellerVerificationStatus.PENDING,
    );
    const service = onboardingService();
    const results = await Promise.allSettled([
      service.approveSeller(verification.id, 'admin-one', {}),
      service.rejectSeller(verification.id, 'admin-two', {
        rejectionReason: 'rejected',
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const stored = await source
      .getRepository(SellerVerification)
      .findOneByOrFail({ id: verification.id });
    expect([
      SellerVerificationStatus.APPROVED,
      SellerVerificationStatus.REJECTED,
    ]).toContain(stored.status);
  });

  it.each([
    ['approve/reject', 'reject'],
    ['approve/contact', 'contact'],
    ['contact/reject', 'contact-reject'],
  ] as const)(
    'keeps breeder role and status consistent during %s race',
    async (_name, race) => {
      await applyForward();
      const user = await verifiedUser();
      const application = await insertBreeder(
        user.id,
        BreederApplicationStatus.FOLLOW_UP,
        BreederCallOutcome.SUCCESSFUL,
      );
      const service = onboardingService();
      const first =
        race === 'contact-reject'
          ? service.recordBreederCall(application.id, 'admin-one', {
              outcome: BreederCallOutcome.NO_ANSWER,
            })
          : service.approveBreeder(application.id, 'admin-one');
      const second =
        race === 'reject' || race === 'contact-reject'
          ? service.rejectBreeder(application.id, 'admin-two', {
              rejectionReason: 'rejected',
            })
          : service.recordBreederCall(application.id, 'admin-two', {
              outcome: BreederCallOutcome.NO_ANSWER,
            });
      const results = await Promise.allSettled([first, second]);
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      if (race === 'contact-reject') {
        expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      } else {
        expect(fulfilled).toHaveLength(1);
      }
      const storedUser = await source
        .getRepository(User)
        .findOneByOrFail({ id: user.id });
      const storedApplication = await source
        .getRepository(BreederApplication)
        .findOneByOrFail({ id: application.id });
      expect(
        storedUser.role !== UserRole.BREEDER ||
          storedApplication.status === BreederApplicationStatus.APPROVED,
      ).toBe(true);
      expect(
        storedApplication.status !== BreederApplicationStatus.APPROVED ||
          storedUser.role === UserRole.BREEDER,
      ).toBe(true);
      if (race === 'contact-reject')
        expect(storedApplication.status).toBe(
          BreederApplicationStatus.REJECTED,
        );
    },
  );

  it('rolls back breeder role when persistence fails after the user update', async () => {
    await applyForward();
    const user = await verifiedUser();
    const application = await insertBreeder(
      user.id,
      BreederApplicationStatus.FOLLOW_UP,
      BreederCallOutcome.SUCCESSFUL,
    );
    await source.query(`CREATE FUNCTION public.test_fail_breeder_approval()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.status = 'APPROVED' THEN RAISE EXCEPTION 'intentional approval failure'; END IF;
        RETURN NEW;
      END $$`);
    await source.query(`CREATE TRIGGER test_fail_breeder_approval
      BEFORE UPDATE ON public.breeder_applications
      FOR EACH ROW EXECUTE FUNCTION public.test_fail_breeder_approval()`);
    await expect(
      onboardingService().approveBreeder(application.id, 'test-admin'),
    ).rejects.toThrow('intentional approval failure');
    expect(
      (await source.getRepository(User).findOneByOrFail({ id: user.id })).role,
    ).toBe(UserRole.CUSTOMER);
    expect(
      (
        await source
          .getRepository(BreederApplication)
          .findOneByOrFail({ id: application.id })
      ).status,
    ).toBe(BreederApplicationStatus.FOLLOW_UP);
  });

  it.each([UserRole.ADMIN, UserRole.BREEDER])(
    'never promotes an existing %s user',
    async (role) => {
      await applyForward();
      const user = await verifiedUser(role);
      const application = await insertBreeder(
        user.id,
        BreederApplicationStatus.FOLLOW_UP,
        BreederCallOutcome.SUCCESSFUL,
      );
      await expect(
        onboardingService().approveBreeder(application.id, 'test-admin'),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await source.getRepository(User).findOneByOrFail({ id: user.id }))
          .role,
      ).toBe(role);
      expect(
        (
          await source
            .getRepository(BreederApplication)
            .findOneByOrFail({ id: application.id })
        ).status,
      ).toBe(BreederApplicationStatus.FOLLOW_UP);
    },
  );

  it('rolls back the user name when seller verification insertion fails', async () => {
    await applyForward();
    const user = await insertUser();
    await source.query(`CREATE FUNCTION public.test_fail_seller_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'intentional seller insert failure';
      END $$`);
    await source.query(`CREATE TRIGGER test_fail_seller_insert
      BEFORE INSERT ON public.seller_verifications
      FOR EACH ROW EXECUTE FUNCTION public.test_fail_seller_insert()`);
    await expect(
      onboardingService().submitSeller(user.id, sellerInput('Changed')),
    ).rejects.toThrow('intentional seller insert failure');
    const stored = await source
      .getRepository(User)
      .findOneByOrFail({ id: user.id });
    expect(stored.firstName).toBe('Test');
    expect(stored.lastName).toBe('User');
    expect(await source.getRepository(SellerVerification).count()).toBe(0);
  });

  it('atomically rolls back OTP consumption, permits retry, and serializes concurrent verification', async () => {
    await applyForward();
    const user = await insertUser(UserRole.CUSTOMER, '09111111111', null);
    const code = '12345';
    await insertOtp(user.phone, code);
    const jwt = { sign: jest.fn(() => 'integration-token') };
    const auth = authService(jwt);
    await source.query(`CREATE FUNCTION public.test_fail_phone_verification()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."phoneVerifiedAt" IS NOT NULL THEN
          RAISE EXCEPTION 'intentional phone verification failure';
        END IF;
        RETURN NEW;
      END $$`);
    await source.query(`CREATE TRIGGER test_fail_phone_verification
      BEFORE UPDATE ON public.users
      FOR EACH ROW EXECUTE FUNCTION public.test_fail_phone_verification()`);
    await expect(auth.verifyOtp({ phone: user.phone, code })).rejects.toThrow(
      'intentional phone verification failure',
    );
    let otp = await source
      .getRepository(Otp)
      .findOneByOrFail({ phone: user.phone });
    expect(otp.consumed).toBe(false);
    expect(
      (await source.getRepository(User).findOneByOrFail({ id: user.id }))
        .phoneVerifiedAt,
    ).toBeNull();
    expect(jwt.sign).not.toHaveBeenCalled();

    await source.query(
      'DROP TRIGGER test_fail_phone_verification ON public.users',
    );
    await source.query('DROP FUNCTION public.test_fail_phone_verification()');
    await expect(
      auth.verifyOtp({ phone: user.phone, code }),
    ).resolves.toMatchObject({
      accessToken: 'integration-token',
    });
    otp = await source
      .getRepository(Otp)
      .findOneByOrFail({ phone: user.phone });
    expect(otp.consumed).toBe(true);

    const second = await insertUser(UserRole.CUSTOMER, '09222222222', null);
    await insertOtp(second.phone, code);
    const concurrentJwt = { sign: jest.fn(() => 'concurrent-token') };
    const concurrentAuth = authService(concurrentJwt);
    const results = await Promise.allSettled([
      concurrentAuth.verifyOtp({ phone: second.phone, code }),
      concurrentAuth.verifyOtp({ phone: second.phone, code }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(concurrentJwt.sign).toHaveBeenCalledTimes(1);
  });

  async function resetFoundation() {
    await assertLoopbackServer(source, DATABASE_NAME);
    await source.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await source.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await source.query(
      "CREATE TYPE public.users_role_enum AS ENUM ('admin','customer')",
    );
    await source.query(`CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
      phone varchar NOT NULL UNIQUE,
      "firstName" varchar NULL,
      "lastName" varchar NULL,
      email varchar NULL UNIQUE,
      "nationalId" varchar NULL,
      "profileCompleted" boolean NOT NULL DEFAULT false,
      "loyaltyPoints" integer NOT NULL DEFAULT 0,
      role public.users_role_enum NOT NULL DEFAULT 'customer',
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await source.query(`CREATE TABLE public.otps (
      id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
      phone varchar NOT NULL,
      "codeHash" varchar NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      consumed boolean NOT NULL DEFAULT false,
      attempts integer NOT NULL DEFAULT 0,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )`);
  }

  async function applyForward() {
    await executeMigration(forwardMigration);
  }

  async function executeMigration(sql: string) {
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

  async function expectEntityColumns(
    entity: typeof SellerVerification | typeof BreederApplication,
  ) {
    const metadata = source.getMetadata(entity);
    const columns = await source.query<
      Array<{ name: string; nullable: boolean; type: string }>
    >(
      `SELECT a.attname AS name, NOT a.attnotnull AS nullable,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
      [`public.${metadata.tableName}`],
    );
    expect(columns.map((column) => column.name).sort()).toEqual(
      metadata.columns.map((column) => column.databaseName).sort(),
    );
    for (const column of metadata.columns) {
      const stored = columns.find(
        (value) => value.name === column.databaseName,
      );
      expect(stored?.nullable).toBe(column.isNullable);
    }
  }

  async function expectUserSecurityColumns() {
    const rows = await source.query<
      Array<{ name: string; nullable: boolean; defaultValue: string | null }>
    >(
      `SELECT column_name AS name, is_nullable='YES' AS nullable,
              column_default AS "defaultValue"
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='users'
          AND column_name IN ('isActive','phoneVerifiedAt')
        ORDER BY column_name`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.name === 'isActive')).toMatchObject({
      nullable: false,
      defaultValue: 'true',
    });
    expect(rows.find((row) => row.name === 'phoneVerifiedAt')).toMatchObject({
      nullable: true,
      defaultValue: null,
    });
  }

  async function expectDatabaseObjects() {
    const constraints = await source.query<
      Array<{ name: string; kind: string }>
    >(
      `SELECT conname AS name, contype AS kind FROM pg_constraint
        WHERE conrelid IN (
          'public.seller_verifications'::regclass,
          'public.breeder_applications'::regclass
        )`,
    );
    for (const name of [
      'CHK_seller_verifications_names',
      'CHK_seller_verifications_birth',
      'CHK_seller_verifications_review',
      'CHK_breeder_applications_text',
      'CHK_breeder_applications_numbers',
      'CHK_breeder_applications_species',
      'CHK_breeder_applications_contact',
      'CHK_breeder_applications_review',
    ])
      expect(constraints).toContainEqual({ name, kind: 'c' });
    const foreignKeys = constraints.filter((item) => item.kind === 'f');
    expect(foreignKeys).toHaveLength(2);
    const indexes = await source.query<
      Array<{ name: string; definition: string }>
    >(
      `SELECT indexname AS name, indexdef AS definition FROM pg_indexes
        WHERE schemaname='public'
          AND tablename IN ('seller_verifications','breeder_applications')`,
    );
    for (const name of [
      'IDX_seller_verifications_user_created',
      'IDX_seller_verifications_status_created',
      'UQ_seller_verifications_active_user',
      'IDX_breeder_applications_user_created',
      'IDX_breeder_applications_status_created',
      'UQ_breeder_applications_active_user',
    ])
      expect(indexes.some((index) => index.name === name)).toBe(true);
    expect(
      indexes.find(
        (index) => index.name === 'UQ_seller_verifications_active_user',
      )?.definition,
    ).toContain('WHERE (status = ANY');
    expect(
      indexes.find(
        (index) => index.name === 'UQ_breeder_applications_active_user',
      )?.definition,
    ).toContain('WHERE (status = ANY');
  }

  function onboardingService() {
    const users = source.getRepository(User);
    const sellers = source.getRepository(SellerVerification);
    const breeders = source.getRepository(BreederApplication);
    return new SellerOnboardingService(
      source,
      sellers,
      breeders,
      new SellerEligibilityPolicy(users, sellers),
    );
  }

  function authService(jwt: { sign: jest.Mock }) {
    return new AuthService(
      source,
      {} as UsersService,
      jwt as unknown as JwtService,
      { sendOtp: jest.fn() } as never,
    );
  }

  async function insertFoundationUser() {
    const [row] = await source.query<Array<{ id: string }>>(
      `INSERT INTO public.users (phone, "firstName", "lastName")
       VALUES ('09111111111','Existing','User') RETURNING id`,
    );
    return row.id;
  }

  async function insertUser(
    role = UserRole.CUSTOMER,
    phone = '09111111111',
    phoneVerifiedAt: Date | null = new Date(),
  ) {
    return source.getRepository(User).save(
      source.getRepository(User).create({
        phone,
        firstName: 'Test',
        lastName: 'User',
        profileCompleted: true,
        loyaltyPoints: 0,
        isActive: true,
        phoneVerifiedAt,
        role,
      }),
    );
  }

  async function verifiedUser(role = UserRole.CUSTOMER) {
    const user = await insertUser(role);
    user.phoneVerifiedAt = new Date();
    await source.getRepository(User).save(user);
    await insertSeller(user.id, SellerVerificationStatus.APPROVED);
    return user;
  }

  async function insertSeller(
    userId: string,
    status: SellerVerificationStatus,
  ) {
    const reviewed = status !== SellerVerificationStatus.PENDING;
    return source.getRepository(SellerVerification).save(
      source.getRepository(SellerVerification).create({
        userId,
        firstName: 'Test',
        lastName: 'User',
        birthDate: '2000-01-01',
        consentAcceptedAt: new Date(),
        consentVersion: 'seller-consent-v1',
        status,
        rejectionReason:
          status === SellerVerificationStatus.REJECTED ? 'rejected' : null,
        internalAdminNote: null,
        reviewedBy: reviewed ? 'test-admin' : null,
        reviewedAt: reviewed ? new Date() : null,
      }),
    );
  }

  async function insertBreeder(
    userId: string,
    status: BreederApplicationStatus,
    outcome: BreederCallOutcome,
  ) {
    return source.getRepository(BreederApplication).save(
      source.getRepository(BreederApplication).create({
        userId,
        breederName: 'Test breeder',
        city: 'Tehran',
        species: ['Cockatiel'],
        experienceYears: 5,
        approximateBirdCount: 10,
        preferredContactTime: 'Morning',
        instagramUrl: null,
        websiteUrl: null,
        description: null,
        status,
        callOutcome: outcome,
        contactedAt: new Date(),
        privateCallNote: null,
        rejectionReason: null,
        reviewedBy: null,
        reviewedAt: null,
      }),
    );
  }

  async function insertOtp(phone: string, code: string) {
    return source.getRepository(Otp).save(
      source.getRepository(Otp).create({
        phone,
        codeHash: await bcrypt.hash(code, 4),
        expiresAt: new Date(Date.now() + 120_000),
        consumed: false,
        attempts: 0,
      }),
    );
  }

  function sellerInput(name: string) {
    return {
      firstName: name,
      lastName: 'User',
      birthDate: '2000-01-01',
      consent: true,
    };
  }

  function breederInput(name: string) {
    return {
      breederName: `${name} breeder`,
      city: 'Tehran',
      species: ['Cockatiel'],
      experienceYears: 5,
      approximateBirdCount: 10,
      preferredContactTime: 'Morning',
    };
  }

  function expectStableConflict(results: PromiseSettledResult<unknown>[]) {
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(HttpException);
    expect((rejected?.reason as HttpException).getStatus()).toBe(409);
    expect((rejected?.reason as HttpException).getResponse()).toMatchObject({
      code: SellerErrorCode.ACTIVE_REQUEST_EXISTS,
    });
  }

  async function assertLoopbackServer(
    connection: DataSource,
    database: string,
  ) {
    const [identity] = await connection.query<
      Array<{ database: string; address: string }>
    >(
      'SELECT current_database() AS database, host(inet_server_addr()) AS address',
    );
    if (
      identity.database !== database ||
      !['127.0.0.1', '::1'].includes(identity.address)
    )
      throw new Error('Disposable database identity mismatch');
  }

  async function terminateTargetConnections() {
    await administrator.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DATABASE_NAME],
    );
  }
});

function requireDisposableConfiguration(): URL {
  if (process.env.SELLER_ONBOARDING_RUN_DB_TESTS !== '1')
    throw new Error('SELLER_ONBOARDING_RUN_DB_TESTS must equal 1');
  if (process.env.SELLER_ONBOARDING_TEST_DATABASE_CONFIRM !== 'DISPOSABLE')
    throw new Error(
      'SELLER_ONBOARDING_TEST_DATABASE_CONFIRM must equal DISPOSABLE',
    );
  const raw = process.env.SELLER_ONBOARDING_TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('SELLER_ONBOARDING_TEST_DATABASE_URL is required');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('PostgreSQL URL required');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error(
      'Seller onboarding tests require a loopback PostgreSQL host',
    );
  if (url.pathname.slice(1) !== DATABASE_NAME || url.search || url.hash)
    throw new Error('Exact disposable seller onboarding database URL required');
  return url;
}

function stripPsqlDirective(sql: string): string {
  return sql.replace(/^\\set[^\r\n]*(?:\r?\n)?/, '');
}
