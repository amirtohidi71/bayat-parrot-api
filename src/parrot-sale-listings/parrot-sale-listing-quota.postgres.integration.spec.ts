import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { ParrotSaleListingsController } from './parrot-sale-listings.controller';
import { ReapplicationIntent } from '../seller-onboarding/seller-lifecycle';
import { SellerOnboardingService } from '../seller-onboarding/seller-onboarding.service';
import { AdminSellerOnboardingController } from '../seller-onboarding/admin-seller-onboarding.controller';
import { SellerOnboardingController } from '../seller-onboarding/seller-onboarding.controller';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import {
  sellerUserResponse,
  breederUserResponse,
} from '../seller-onboarding/seller-onboarding.responses';
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DataSource, In } from 'typeorm';
import { VET_TEST_ENTITIES } from '../../test/vet-test-entities';
import {
  BreederApplication,
  BreederApplicationStatus,
  BreederCallOutcome,
} from '../seller-onboarding/entities/breeder-application.entity';
import {
  SellerVerification,
  SellerVerificationStatus,
} from '../seller-onboarding/entities/seller-verification.entity';
import { SellerEligibilityPolicy } from '../seller-onboarding/seller-eligibility.policy';
import { User, UserRole } from '../users/entities/user.entity';
import { ParrotSaleListingImage } from './entities/parrot-sale-listing-image.entity';
import { ParrotSaleListingCreationLedger } from './entities/parrot-sale-listing-creation-ledger.entity';
import {
  ParrotSaleListing,
  ParrotSaleListingStatus,
} from './entities/parrot-sale-listing.entity';
import { ParrotSaleListingErrorCode } from './parrot-sale-listing.errors';
import {
  ParrotSaleListingCleanupWorker,
  PARROT_LISTING_CLEANUP_LOCK_NAME,
} from './parrot-sale-listing-cleanup.worker';
import { ParrotSaleListingImageStorageService } from './images/parrot-sale-listing-image-storage.service';
import { tehranWeekBounds } from './parrot-sale-listing-week';
import { ParrotSaleListingsService } from './parrot-sale-listings.service';

const DATABASE_NAME = 'parrot_listing_disposable_test';
const enabled =
  process.env.PARROT_LISTING_RUN_DB_TESTS === '1' &&
  process.env.PARROT_LISTING_TEST_DATABASE_CONFIRM === 'DISPOSABLE' &&
  Boolean(process.env.PARROT_LISTING_TEST_DATABASE_URL?.trim());
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase('Parrot listing weekly quota on real PostgreSQL', () => {
  let administrator: DataSource;
  let source: DataSource;
  let databaseCreated = false;
  let runtimeRoleCreated = false;
  let backfilledListingId: string;
  let backfilledSellerUserId: string;
  let backfilledCreatedAt: Date;

  beforeAll(async () => {
    const target = disposableUrl();
    const adminUrl = new URL(target.toString());
    adminUrl.pathname = '/postgres';
    administrator = new DataSource({
      type: 'postgres',
      url: adminUrl.toString(),
      synchronize: false,
      logging: false,
    });
    await administrator.initialize();
    await assertLoopback(administrator, 'postgres');
    const [runtimeRole] = await administrator.query<Array<{ exists: boolean }>>(
      "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bayat_app') AS exists",
    );
    if (runtimeRole.exists)
      throw new Error('Isolated runtime role already exists; refusing reuse');

    const [existing] = await administrator.query<Array<{ exists: boolean }>>(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [DATABASE_NAME],
    );
    if (existing.exists)
      throw new Error('Disposable listing database already exists');
    await administrator.query(
      'CREATE DATABASE "parrot_listing_disposable_test"',
    );
    databaseCreated = true;
    await administrator.query(
      'CREATE ROLE bayat_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
    );
    runtimeRoleCreated = true;

    source = new DataSource({
      type: 'postgres',
      url: target.toString(),
      entities: [
        ...VET_TEST_ENTITIES,
        SellerVerification,
        BreederApplication,
        ParrotSaleListing,
        ParrotSaleListingImage,
        ParrotSaleListingCreationLedger,
      ],
      synchronize: false,
      logging: false,
      extra: { max: 8 },
    });
    await source.initialize();
    await assertLoopback(source, DATABASE_NAME);
    await createFoundation();
    for (const filename of [
      '20260926-create-seller-onboarding-v1.sql',
      '20261003-create-parrot-sale-listings-v1.sql',
      '20261009-add-parrot-sale-listing-lifecycle-v1.sql',
    ]) {
      const sql = await readFile(
        resolve(process.cwd(), 'scripts/migrations', filename),
        'utf8',
      );
      await source.query(sql.replace(/^\\set[^\r\n]*(?:\r?\n)?/, ''));
    }
    const seedUser = await source.getRepository(User).save({
      phone: '09333333333',
      role: UserRole.CUSTOMER,
    });
    backfilledSellerUserId = seedUser.id;
    const [seedListing] = await source.query<
      Array<{ id: string; createdAt: Date }>
    >(
      `INSERT INTO public.parrot_sale_listings
        ("sellerUserId", name, species, "requestedPrice")
       VALUES ($1, 'Historical bird', 'African Grey', 100)
       RETURNING id, "createdAt"`,
      [seedUser.id],
    );
    backfilledListingId = seedListing.id;
    backfilledCreatedAt = seedListing.createdAt;
    await applyLedgerMigration();
    await applyLedgerMigration();
    await applyCleanupMigration();
    // Seed a pre-migration revocation using the old schema. Its history and
    // default BLOCKED intent must survive without granting reapplication.
    const [legacy] = await source.query<Array<{ id: string }>>(
      `INSERT INTO public.seller_verifications
       ("userId", "firstName", "lastName", "birthDate", "consentAcceptedAt", "consentVersion",
        status, "reviewedBy", "reviewedAt", "revokedAt", "revokedBy", "revocationReason")
       VALUES ($1, 'Test', 'Seller', '2000-01-01', CURRENT_TIMESTAMP, 'v1',
        'APPROVED', 'original-admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        'revoking-admin', 'Legacy block') RETURNING id`,
      [seedUser.id],
    );
    await applyReverificationMigration();
    expect(
      await source
        .getRepository(SellerVerification)
        .findOneByOrFail({ id: legacy.id }),
    ).toMatchObject({
      reviewedBy: 'original-admin',
      revokedBy: 'revoking-admin',
      revocationReason: 'Legacy block',
      reapplicationIntent: ReapplicationIntent.BLOCKED,
    });
    // Current entities include the additive foundation columns. Apply these
    // only after the legacy migration/backfill checks above have completed.
    for (const migration of [
      '20261020-create-breeder-taxon-permissions-v1.sql',
      '20261020-add-parrot-listing-submission-kind-v1.sql',
      '20261022-add-breeder-listing-publication-hold-v1.sql',
    ]) {
      const sql = await readFile(
        resolve('scripts/migrations', migration),
        'utf8',
      );
      await source.query(sql.replace(/^\\set[^\r\n]*(?:\r?\n)?/, ''));
    }
  }, 60_000);

  afterAll(async () => {
    if (source?.isInitialized) await source.destroy();
    try {
      if (administrator?.isInitialized && databaseCreated) {
        await administrator.query(
          'DROP DATABASE "parrot_listing_disposable_test"',
        );
        const [remaining] = await administrator.query<
          Array<{ exists: boolean }>
        >(
          'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
          [DATABASE_NAME],
        );
        if (remaining.exists)
          throw new Error('Disposable listing database cleanup failed');
      }
    } finally {
      try {
        if (administrator?.isInitialized && runtimeRoleCreated)
          await administrator.query('DROP ROLE bayat_app');
      } finally {
        if (administrator?.isInitialized) await administrator.destroy();
      }
    }
  }, 60_000);

  beforeEach(async () => {
    await source.query(
      'TRUNCATE public.parrot_sale_listings, public.breeder_applications, public.seller_verifications, public.users CASCADE',
    );
  });

  it('backfills original listing identity and time exactly once, including on migration rerun', async () => {
    const ledger = source.getRepository(ParrotSaleListingCreationLedger);
    const first = await ledger.findOneByOrFail({
      listingId: backfilledListingId,
    });
    expect(first.sellerUserId).toBe(backfilledSellerUserId);
    expect(first.createdAt).toEqual(backfilledCreatedAt);
    expect(first.deletedAt).toBeNull();
    await applyCleanupMigration();
    expect(
      await ledger.count({ where: { listingId: backfilledListingId } }),
    ).toBe(1);
    const user = await eligibleUser(
      '09333333333',
      UserRole.CUSTOMER,
      backfilledSellerUserId,
    );
    const input = {
      name: 'Test parrot',
      species: 'African Grey',
      requestedPrice: 100,
    };
    await listingService().create(user.id, input);
    try {
      await listingService().create(user.id, input);
      throw new Error('Expected the backfilled quota to reject this create');
    } catch (error) {
      expectQuotaError(error);
    }
  });

  it('accepts the clean cleanup migration and a compatible pre-existing schema', async () => {
    const [column] = await source.query<
      Array<{ data_type: string; is_nullable: string }>
    >(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'parrot_sale_listing_creation_ledger'
         AND column_name = 'cleanupCompletedAt'`,
    );
    expect(column).toEqual({
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
    });
    await expect(applyCleanupMigration()).resolves.toBeUndefined();
  });

  it('rejects an incompatible same-name cleanup column', async () => {
    await source.query(`ALTER TABLE public.parrot_sale_listing_creation_ledger
      ALTER COLUMN "cleanupCompletedAt" SET DEFAULT CURRENT_TIMESTAMP`);
    try {
      await expect(applyCleanupMigration()).rejects.toThrow(
        'Parrot listing cleanup column differs from the expected contract',
      );
    } finally {
      await source.query(`ALTER TABLE public.parrot_sale_listing_creation_ledger
        ALTER COLUMN "cleanupCompletedAt" DROP DEFAULT`);
    }
    await expect(applyCleanupMigration()).resolves.toBeUndefined();
  });

  it('rejects an incompatible same-name cleanup CHECK', async () => {
    await source.query(`ALTER TABLE public.parrot_sale_listing_creation_ledger
      DROP CONSTRAINT "CHK_parrot_listing_cleanup_after_delete"`);
    await source.query(`ALTER TABLE public.parrot_sale_listing_creation_ledger
      ADD CONSTRAINT "CHK_parrot_listing_cleanup_after_delete"
      CHECK ("cleanupCompletedAt" IS NULL OR "createdAt" IS NOT NULL)`);
    try {
      await expect(applyCleanupMigration()).rejects.toThrow(
        'Parrot listing cleanup constraint differs from the expected contract',
      );
    } finally {
      await source.query(`ALTER TABLE public.parrot_sale_listing_creation_ledger
        DROP CONSTRAINT "CHK_parrot_listing_cleanup_after_delete"`);
    }
    await expect(applyCleanupMigration()).resolves.toBeUndefined();
  });

  it.each([
    [
      'reversed columns',
      '("listingId", "deletedAt") WHERE "deletedAt" IS NOT NULL AND "cleanupCompletedAt" IS NULL',
    ],
    [
      'descending direction',
      '("deletedAt" DESC, "listingId") WHERE "deletedAt" IS NOT NULL AND "cleanupCompletedAt" IS NULL',
    ],
    [
      'first column NULLS FIRST',
      '("deletedAt" ASC NULLS FIRST, "listingId") WHERE "deletedAt" IS NOT NULL AND "cleanupCompletedAt" IS NULL',
    ],
    [
      'second column NULLS FIRST',
      '("deletedAt", "listingId" ASC NULLS FIRST) WHERE "deletedAt" IS NOT NULL AND "cleanupCompletedAt" IS NULL',
    ],
    [
      'unexpected predicate',
      '("deletedAt", "listingId") WHERE "deletedAt" IS NOT NULL',
    ],
    ['missing predicate', '("deletedAt", "listingId")'],
    [
      'unique index',
      'UNIQUE ("deletedAt", "listingId") WHERE "deletedAt" IS NOT NULL AND "cleanupCompletedAt" IS NULL',
    ],
  ])(
    'rejects an incompatible same-name cleanup index: %s',
    async (_label, definition) => {
      await source.query(
        'DROP INDEX public."IDX_parrot_listing_cleanup_pending"',
      );
      await source.query(
        `CREATE ${definition.startsWith('UNIQUE ') ? 'UNIQUE ' : ''}INDEX
         "IDX_parrot_listing_cleanup_pending"
         ON public.parrot_sale_listing_creation_ledger
         ${definition.replace(/^UNIQUE /, '')}`,
      );
      try {
        await expect(applyCleanupMigration()).rejects.toThrow(
          'Parrot listing cleanup index differs from the expected contract',
        );
      } finally {
        await source.query(
          'DROP INDEX public."IDX_parrot_listing_cleanup_pending"',
        );
      }
      await expect(applyCleanupMigration()).resolves.toBeUndefined();
    },
  );

  it('uses Tehran Saturday boundaries as UTC instants, with an exclusive next Saturday', async () => {
    const friday = await tehranWeekBounds(
      source.manager,
      new Date('2026-10-09T20:29:59.999Z'),
    );
    expect(friday.start.toISOString()).toBe('2026-10-02T20:30:00.000Z');
    expect(friday.end.toISOString()).toBe('2026-10-09T20:30:00.000Z');

    const saturday = await tehranWeekBounds(
      source.manager,
      new Date('2026-10-09T20:30:00.000Z'),
    );
    expect(saturday.start.toISOString()).toBe('2026-10-09T20:30:00.000Z');
    expect(saturday.end.toISOString()).toBe('2026-10-16T20:30:00.000Z');
  });

  it('permits only two concurrent customer creates and keeps deleted listings in the quota', async () => {
    const user = await eligibleUser();
    const service = listingService();
    const input = {
      name: 'Test parrot',
      species: 'African Grey',
      requestedPrice: 100,
    };
    const results = await Promise.allSettled([
      service.create(user.id, input),
      service.create(user.id, input),
      service.create(user.id, input),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(2);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expectQuotaError(rejected?.reason);
    const listings = await source.getRepository(ParrotSaleListing).find({
      where: { sellerUserId: user.id },
    });
    expect(listings).toHaveLength(2);
    const ledger = source.getRepository(ParrotSaleListingCreationLedger);
    expect(await ledger.count({ where: { sellerUserId: user.id } })).toBe(2);
    expect(
      listings.every(
        (listing) => listing.status === ParrotSaleListingStatus.DRAFT,
      ),
    ).toBe(true);

    await service.delete(user.id, listings[0].id);
    await source.getRepository(ParrotSaleListing).update(listings[1].id, {
      status: ParrotSaleListingStatus.PENDING_REVIEW,
    });
    try {
      await service.create(user.id, input);
      throw new Error('Expected the weekly quota to reject this create');
    } catch (error) {
      expectQuotaError(error);
    }
    expect(await ledger.count({ where: { sellerUserId: user.id } })).toBe(2);
    expect(
      await source
        .getRepository(ParrotSaleListing)
        .count({ where: { sellerUserId: user.id } }),
    ).toBe(1);
  });

  it('limits ordinary creates for approved and unapproved BREEDER roles', async () => {
    const approved = await eligibleUser('09111111111', UserRole.BREEDER);
    const unapproved = await eligibleUser('09222222222', UserRole.BREEDER);
    await source.getRepository(BreederApplication).save({
      userId: approved.id,
      breederName: 'Test breeder',
      city: 'Tehran',
      species: ['African Grey'],
      experienceYears: 1,
      approximateBirdCount: 1,
      preferredContactTime: 'Morning',
      status: BreederApplicationStatus.APPROVED,
      callOutcome: BreederCallOutcome.SUCCESSFUL,
      contactedAt: new Date(),
      reviewedBy: 'test-admin',
      reviewedAt: new Date(),
    });
    const service = listingService();
    const input = {
      name: 'Test parrot',
      species: 'African Grey',
      requestedPrice: 100,
    };
    await Promise.all(
      Array.from({ length: 2 }, () => service.create(approved.id, input)),
    );
    await expect(service.create(approved.id, input)).rejects.toMatchObject({
      status: 409,
      response: { code: ParrotSaleListingErrorCode.WEEKLY_LIMIT_REACHED },
    });
    expect(
      await source
        .getRepository(ParrotSaleListing)
        .count({ where: { sellerUserId: approved.id } }),
    ).toBe(2);
    expect(
      await source.getRepository(ParrotSaleListingCreationLedger).count({
        where: { sellerUserId: approved.id },
      }),
    ).toBe(2);

    await service.create(unapproved.id, input);
    await service.create(unapproved.id, input);
    try {
      await service.create(unapproved.id, input);
      throw new Error('Expected the weekly quota to reject this create');
    } catch (error) {
      expectQuotaError(error);
    }
  });

  it('rejects a duplicate creation ledger identity', async () => {
    const user = await eligibleUser();
    const saved = await listingService().create(user.id, {
      name: 'Test parrot',
      species: 'African Grey',
      requestedPrice: 100,
    });
    await expect(
      source.getRepository(ParrotSaleListingCreationLedger).insert({
        listingId: saved.id,
        sellerUserId: user.id,
        createdAt: saved.createdAt,
        deletedAt: null,
      }),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('keeps creation identity immutable and allows deletion time only once', async () => {
    const user = await eligibleUser();
    const saved = await listingService().create(user.id, {
      name: 'Test parrot',
      species: 'African Grey',
      requestedPrice: 100,
    });
    await expect(
      source.query(
        'UPDATE public.parrot_sale_listing_creation_ledger SET "createdAt" = now() - interval \'1 day\' WHERE "listingId" = $1',
        [saved.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    await expect(
      source.query(
        'DELETE FROM public.parrot_sale_listing_creation_ledger WHERE "listingId" = $1',
        [saved.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    await source.query(
      'UPDATE public.parrot_sale_listing_creation_ledger SET "deletedAt" = now() WHERE "listingId" = $1',
      [saved.id],
    );
    await expect(
      source.query(
        'UPDATE public.parrot_sale_listing_creation_ledger SET "deletedAt" = now() WHERE "listingId" = $1',
        [saved.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });

  it('rolls back the listing when its ledger insert fails', async () => {
    const user = await eligibleUser();
    await source.query(`CREATE FUNCTION public.test_reject_listing_ledger_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Test ledger insert failure' USING ERRCODE = '23514'; END
      $$`);
    await source.query(`CREATE TRIGGER test_reject_listing_ledger_insert
      BEFORE INSERT ON public.parrot_sale_listing_creation_ledger
      FOR EACH ROW EXECUTE FUNCTION public.test_reject_listing_ledger_insert()`);
    try {
      await expect(
        listingService().create(user.id, {
          name: 'Test parrot',
          species: 'African Grey',
          requestedPrice: 100,
        }),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
      expect(
        await source.getRepository(ParrotSaleListing).count({
          where: { sellerUserId: user.id },
        }),
      ).toBe(0);
      expect(
        await source.getRepository(ParrotSaleListingCreationLedger).count({
          where: { sellerUserId: user.id },
        }),
      ).toBe(0);
    } finally {
      await source.query(
        'DROP TRIGGER test_reject_listing_ledger_insert ON public.parrot_sale_listing_creation_ledger',
      );
      await source.query(
        'DROP FUNCTION public.test_reject_listing_ledger_insert()',
      );
    }
  });

  it('removes private files, image rows and an unreferenced listing without freeing quota', async () => {
    await withPrivateStorage(async (storage, root) => {
      const user = await eligibleUser();
      const service = listingService(storage);
      const input = {
        name: 'Test parrot',
        species: 'African Grey',
        requestedPrice: 100,
      };
      const first = await service.create(user.id, input);
      const storageKey = `${randomUUID()}.webp`;
      const privatePath = join(root, storageKey);
      const publicPath = join(root, 'public-product-image.webp');
      await writeFile(privatePath, Buffer.from('private-image'));
      await writeFile(publicPath, Buffer.from('public-image'));
      await source.getRepository(ParrotSaleListingImage).save({
        listingId: first.id,
        storageKey,
        position: 0,
      });

      const deleted = await service.delete(user.id, first.id);
      expect(deleted?.status).toBe(ParrotSaleListingStatus.DELETED_BY_USER);
      expect(deleted?.images).toEqual([]);
      await expect(stat(privatePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(publicPath, 'utf8')).toBe('public-image');
      expect(
        await source.getRepository(ParrotSaleListingImage).count({
          where: { listingId: first.id },
        }),
      ).toBe(0);
      expect(
        await source.getRepository(ParrotSaleListing).count({
          where: { id: first.id },
        }),
      ).toBe(0);
      const ledger = await source
        .getRepository(ParrotSaleListingCreationLedger)
        .findOneByOrFail({ listingId: first.id });
      expect(ledger.deletedAt).toBeInstanceOf(Date);
      expect(ledger.cleanupCompletedAt).toBeInstanceOf(Date);
      expect(ledger.createdAt).toEqual(first.createdAt);
      expect(await service.delete(user.id, first.id)).toBeNull();
      expect(
        (
          await source
            .getRepository(ParrotSaleListingCreationLedger)
            .findOneByOrFail({ listingId: first.id })
        ).deletedAt,
      ).toEqual(ledger.deletedAt);
      await service.create(user.id, input);
      await expect(service.create(user.id, input)).rejects.toMatchObject({
        status: 409,
      });
    });
  });

  it('treats an already missing private file as a successful deletion retry', async () => {
    await withPrivateStorage(async (storage) => {
      const user = await eligibleUser();
      const listing = await listingService(storage).create(user.id, {
        name: 'Test parrot',
        species: 'African Grey',
        requestedPrice: 100,
      });
      await source.getRepository(ParrotSaleListingImage).save({
        listingId: listing.id,
        storageKey: `${randomUUID()}.webp`,
        position: 0,
      });
      await expect(
        listingService(storage).delete(user.id, listing.id),
      ).resolves.toMatchObject({
        status: ParrotSaleListingStatus.DELETED_BY_USER,
      });
      expect(
        await source.getRepository(ParrotSaleListingImage).count({
          where: { listingId: listing.id },
        }),
      ).toBe(0);
    });
  });

  it('retains deleted image rows after filesystem failure and completes on retry', async () => {
    await withPrivateStorage(async (storage, root) => {
      const user = await eligibleUser();
      const listing = await listingService(storage).create(user.id, {
        name: 'Test parrot',
        species: 'African Grey',
        requestedPrice: 100,
      });
      const storageKey = `${randomUUID()}.webp`;
      const privatePath = join(root, storageKey);
      await writeFile(privatePath, Buffer.from('private-image'));
      await source.getRepository(ParrotSaleListingImage).save({
        listingId: listing.id,
        storageKey,
        position: 0,
      });
      const failingStorage = {
        delete: () => Promise.reject(new Error('test filesystem failure')),
      } as never;
      await expect(
        listingService(failingStorage).delete(user.id, listing.id),
      ).rejects.toThrow('test filesystem failure');
      expect(await readFile(privatePath, 'utf8')).toBe('private-image');
      expect(
        await source.getRepository(ParrotSaleListing).findOneByOrFail({
          id: listing.id,
        }),
      ).toMatchObject({ status: ParrotSaleListingStatus.DELETED_BY_USER });
      expect(
        await source.getRepository(ParrotSaleListingImage).count({
          where: { listingId: listing.id },
        }),
      ).toBe(1);
      expect(
        (
          await source
            .getRepository(ParrotSaleListingCreationLedger)
            .findOneByOrFail({ listingId: listing.id })
        ).deletedAt,
      ).toBeInstanceOf(Date);
      expect(
        (
          await source
            .getRepository(ParrotSaleListingCreationLedger)
            .findOneByOrFail({ listingId: listing.id })
        ).cleanupCompletedAt,
      ).toBeNull();
      await new ParrotSaleListingCleanupWorker(
        source,
        listingService(storage),
      ).runOnce();
      expect(
        (
          await source
            .getRepository(ParrotSaleListingCreationLedger)
            .findOneByOrFail({ listingId: listing.id })
        ).cleanupCompletedAt,
      ).toBeInstanceOf(Date);
      await expect(stat(privatePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        await source.getRepository(ParrotSaleListingImage).count({
          where: { listingId: listing.id },
        }),
      ).toBe(0);
    });
  });

  it('retries after a crash between private file deletion and image-row deletion', async () => {
    await withPrivateStorage(async (storage, root) => {
      const user = await eligibleUser();
      const listing = await listingService(storage).create(user.id, {
        name: 'Test parrot',
        species: 'African Grey',
        requestedPrice: 100,
      });
      const storageKey = `${randomUUID()}.webp`;
      const privatePath = join(root, storageKey);
      await writeFile(privatePath, Buffer.from('private-image'));
      await source.getRepository(ParrotSaleListingImage).save({
        listingId: listing.id,
        storageKey,
        position: 0,
      });
      await source.query(`CREATE FUNCTION public.test_fail_listing_image_delete()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Test image-row delete failure' USING ERRCODE = '23514'; END
        $$`);
      await source.query(`CREATE TRIGGER test_fail_listing_image_delete
        BEFORE DELETE ON public.parrot_sale_listing_images
        FOR EACH ROW EXECUTE FUNCTION public.test_fail_listing_image_delete()`);
      try {
        await expect(
          listingService(storage).delete(user.id, listing.id),
        ).rejects.toMatchObject({ driverError: { code: '23514' } });
        await expect(stat(privatePath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(
          await source.getRepository(ParrotSaleListingImage).count({
            where: { listingId: listing.id },
          }),
        ).toBe(1);
      } finally {
        await source.query(
          'DROP TRIGGER test_fail_listing_image_delete ON public.parrot_sale_listing_images',
        );
        await source.query(
          'DROP FUNCTION public.test_fail_listing_image_delete()',
        );
      }
      await new ParrotSaleListingCleanupWorker(
        source,
        listingService(storage),
      ).runOnce();
      expect(
        await source.getRepository(ParrotSaleListingImage).count({
          where: { listingId: listing.id },
        }),
      ).toBe(0);
      expect(
        await source.getRepository(ParrotSaleListing).count({
          where: { id: listing.id },
        }),
      ).toBe(0);
    });
  });

  it('keeps a deleted tombstone when another listing references it', async () => {
    const user = await eligibleUser();
    const service = listingService();
    const input = {
      name: 'Test parrot',
      species: 'African Grey',
      requestedPrice: 100,
    };
    const parent = await service.create(user.id, input);
    const child = await service.create(user.id, input);
    await source.getRepository(ParrotSaleListing).update(child.id, {
      resubmissionOfId: parent.id,
    });
    await service.delete(user.id, parent.id);
    expect(
      await source.getRepository(ParrotSaleListing).findOneByOrFail({
        id: parent.id,
      }),
    ).toMatchObject({ status: ParrotSaleListingStatus.DELETED_BY_USER });
    expect(
      await source.getRepository(ParrotSaleListing).findOneByOrFail({
        id: child.id,
      }),
    ).toMatchObject({ resubmissionOfId: parent.id });
    expect(
      (
        await source
          .getRepository(ParrotSaleListingCreationLedger)
          .findOneByOrFail({ listingId: parent.id })
      ).deletedAt,
    ).toBeInstanceOf(Date);
    expect(
      (
        await source
          .getRepository(ParrotSaleListingCreationLedger)
          .findOneByOrFail({ listingId: parent.id })
      ).cleanupCompletedAt,
    ).toBeInstanceOf(Date);
  });

  it('automatically reconciles a committed deletion after a crash before file cleanup', async () => {
    await withPrivateStorage(async (storage, root) => {
      const user = await eligibleUser();
      const service = listingService(storage);
      const listing = await service.create(user.id, {
        name: 'Test parrot',
        species: 'African Grey',
        requestedPrice: 100,
      });
      const storageKey = `${randomUUID()}.webp`;
      const path = join(root, storageKey);
      await writeFile(path, Buffer.from('private-image'));
      await source
        .getRepository(ParrotSaleListingImage)
        .save({ listingId: listing.id, storageKey, position: 0 });
      await source.getRepository(ParrotSaleListing).update(listing.id, {
        status: ParrotSaleListingStatus.DELETED_BY_USER,
      });
      await source
        .getRepository(ParrotSaleListingCreationLedger)
        .update(listing.id, { deletedAt: new Date() });
      await new ParrotSaleListingCleanupWorker(source, service).runOnce();
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        await source
          .getRepository(ParrotSaleListingImage)
          .count({ where: { listingId: listing.id } }),
      ).toBe(0);
      expect(
        await source
          .getRepository(ParrotSaleListing)
          .count({ where: { id: listing.id } }),
      ).toBe(0);
      const history = await source
        .getRepository(ParrotSaleListingCreationLedger)
        .findOneByOrFail({ listingId: listing.id });
      expect(history.cleanupCompletedAt).toBeInstanceOf(Date);
      expect(history.createdAt).toEqual(listing.createdAt);
      expect(
        await source
          .getRepository(ParrotSaleListingCreationLedger)
          .count({ where: { sellerUserId: user.id } }),
      ).toBe(1);
    });
  });

  it('reconciles a missing private file and a retained resubmission tombstone', async () => {
    await withPrivateStorage(async (storage) => {
      const user = await eligibleUser();
      const service = listingService(storage);
      const parent = await service.create(user.id, {
        name: 'Parent',
        species: 'African Grey',
        requestedPrice: 100,
      });
      const child = await service.create(user.id, {
        name: 'Child',
        species: 'African Grey',
        requestedPrice: 100,
      });
      await source
        .getRepository(ParrotSaleListing)
        .update(child.id, { resubmissionOfId: parent.id });
      await source.getRepository(ParrotSaleListingImage).save({
        listingId: parent.id,
        storageKey: `${randomUUID()}.webp`,
        position: 0,
      });
      await source
        .getRepository(ParrotSaleListing)
        .update(parent.id, { status: ParrotSaleListingStatus.DELETED_BY_USER });
      await source
        .getRepository(ParrotSaleListingCreationLedger)
        .update(parent.id, { deletedAt: new Date() });
      await new ParrotSaleListingCleanupWorker(source, service).runOnce();
      expect(
        await source
          .getRepository(ParrotSaleListing)
          .findOneByOrFail({ id: parent.id }),
      ).toMatchObject({ status: ParrotSaleListingStatus.DELETED_BY_USER });
      expect(
        (
          await source
            .getRepository(ParrotSaleListingCreationLedger)
            .findOneByOrFail({ listingId: parent.id })
        ).cleanupCompletedAt,
      ).toBeInstanceOf(Date);
      expect(
        await source
          .getRepository(ParrotSaleListingImage)
          .count({ where: { listingId: parent.id } }),
      ).toBe(0);
    });
  });

  it('completes a pending ledger whose operational listing was already hard-deleted', async () => {
    const listingId = randomUUID();
    const userId = randomUUID();
    await source.getRepository(ParrotSaleListingCreationLedger).insert({
      listingId,
      sellerUserId: userId,
      createdAt: new Date(),
      deletedAt: new Date(),
      cleanupCompletedAt: null,
    });
    await new ParrotSaleListingCleanupWorker(
      source,
      listingService(),
    ).runOnce();
    const history = await source
      .getRepository(ParrotSaleListingCreationLedger)
      .findOneByOrFail({ listingId });
    expect(history.cleanupCompletedAt).toBeInstanceOf(Date);
  });

  it('processes at most one bounded batch and never touches an active listing', async () => {
    const user = await eligibleUser();
    const active = await listingService().create(user.id, {
      name: 'Active',
      species: 'African Grey',
      requestedPrice: 100,
    });
    // Even inconsistent ledger metadata must never make the worker delete an active row.
    await source
      .getRepository(ParrotSaleListingCreationLedger)
      .update(active.id, {
        deletedAt: new Date('2000-01-01T00:00:00Z'),
      });
    const pendingIds = Array.from({ length: 11 }, () => randomUUID());
    for (const listingId of pendingIds)
      await source.getRepository(ParrotSaleListingCreationLedger).insert({
        listingId,
        sellerUserId: randomUUID(),
        createdAt: new Date('1999-01-01T00:00:00Z'),
        deletedAt: new Date('2000-01-01T00:00:00Z'),
        cleanupCompletedAt: null,
      });
    const worker = new ParrotSaleListingCleanupWorker(source, listingService());
    await expect(worker.runOnce()).resolves.toBe(10);
    const histories = await source
      .getRepository(ParrotSaleListingCreationLedger)
      .findBy({ listingId: In(pendingIds) });
    expect(
      histories.filter((entry) => entry.cleanupCompletedAt !== null),
    ).toHaveLength(10);
    expect(
      await source
        .getRepository(ParrotSaleListing)
        .findOneByOrFail({ id: active.id }),
    ).toMatchObject({ status: ParrotSaleListingStatus.DRAFT });
    expect(
      (
        await source
          .getRepository(ParrotSaleListingCreationLedger)
          .findOneByOrFail({ listingId: active.id })
      ).cleanupCompletedAt,
    ).toBeNull();
    await worker.runOnce();
    const final = await source
      .getRepository(ParrotSaleListingCreationLedger)
      .findBy({ listingId: In(pendingIds) });
    expect(
      final.every((entry) => entry.cleanupCompletedAt instanceof Date),
    ).toBe(true);
  });

  it('defers recovery while another API instance holds the PostgreSQL advisory lock', async () => {
    const listingId = randomUUID();
    await source.getRepository(ParrotSaleListingCreationLedger).insert({
      listingId,
      sellerUserId: randomUUID(),
      createdAt: new Date(),
      deletedAt: new Date(),
      cleanupCompletedAt: null,
    });
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const [claim] = (await runner.query(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
        [PARROT_LISTING_CLEANUP_LOCK_NAME],
      )) as Array<{ acquired: boolean }>;
      expect(claim.acquired).toBe(true);
      await expect(
        new ParrotSaleListingCleanupWorker(source, listingService()).runOnce(),
      ).resolves.toBe(0);
      expect(
        (
          await source
            .getRepository(ParrotSaleListingCreationLedger)
            .findOneByOrFail({ listingId })
        ).cleanupCompletedAt,
      ).toBeNull();
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    await new ParrotSaleListingCleanupWorker(
      source,
      listingService(),
    ).runOnce();
    expect(
      (
        await source
          .getRepository(ParrotSaleListingCreationLedger)
          .findOneByOrFail({ listingId })
      ).cleanupCompletedAt,
    ).toBeInstanceOf(Date);
  });

  function onboardingService() {
    return new SellerOnboardingService(
      source,
      source.getRepository(SellerVerification),
      source.getRepository(BreederApplication),
      new SellerEligibilityPolicy(
        source.getRepository(User),
        source.getRepository(SellerVerification),
      ),
    );
  }
  const sellerInput = {
    firstName: 'Test',
    lastName: 'Seller',
    birthDate: '2000-01-01',
    consent: true,
  };
  const breederInput = {
    breederName: 'Breeder',
    city: 'Tehran',
    species: ['African Grey'],
    experienceYears: 1,
    approximateBirdCount: 2,
    preferredContactTime: 'Morning',
  };
  const listingInput = {
    name: 'Test bird',
    species: 'African Grey',
    requestedPrice: 100,
  };

  async function approvedBreeder() {
    const user = await eligibleUser('09333333333', UserRole.BREEDER);
    const application = await source.getRepository(BreederApplication).save({
      ...breederInput,
      userId: user.id,
      status: BreederApplicationStatus.APPROVED,
      callOutcome: BreederCallOutcome.SUCCESSFUL,
      contactedAt: new Date(),
      reviewedBy: 'first-admin',
      reviewedAt: new Date(),
    });
    return { user, application };
  }

  async function applyReverificationMigration(connection = source) {
    const sql = await readFile(
      resolve(
        'scripts/migrations/20261019-add-seller-breeder-reverification-v1.sql',
      ),
      'utf8',
    );
    const runner = connection.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(sql.replace(/^\\set[^\r\n]*(?:\r?\n)?/, ''));
    } catch (error) {
      await runner.query('ROLLBACK');
      throw error;
    } finally {
      await runner.release();
    }
  }

  it('reverification migration reruns with compatible schema and preserves legacy blocked revocations', async () => {
    const user = await eligibleUser();
    const service = onboardingService();
    const original = (await service.ownSeller(user.id))!;
    await service.revokeSellerAccess(original.id, 'admin', {
      reason: 'Legacy block',
    });
    await applyReverificationMigration();
    await applyReverificationMigration();
    const value = (await service.ownSeller(user.id))!;
    expect(value.reapplicationIntent).toBe(ReapplicationIntent.BLOCKED);
    await expect(
      service.submitSeller(user.id, sellerInput),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'SELLER_ACCESS_REVOKED' },
    });
    expect(
      await source
        .getRepository(SellerVerification)
        .count({ where: { userId: user.id } }),
    ).toBe(1);
  });

  it.each(['column', 'CHECK', 'index', 'grant column', 'grant CHECK'])(
    'reverification migration fails closed for an incompatible %s',
    async (kind) => {
      const runner = source.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        if (kind === 'grant column')
          await runner.query(
            'ALTER TABLE seller_verifications ALTER COLUMN "reapplicationGrantedBy" TYPE varchar(99)',
          );
        if (kind === 'grant CHECK') {
          await runner.query(
            'ALTER TABLE seller_verifications DROP CONSTRAINT "CHK_seller_reapplication_grant"',
          );
          await runner.query(
            'ALTER TABLE seller_verifications ADD CONSTRAINT "CHK_seller_reapplication_grant" CHECK (true)',
          );
        }
        if (kind === 'column')
          await runner.query(
            'ALTER TABLE seller_verifications ALTER COLUMN "reapplicationIntent" DROP NOT NULL',
          );
        if (kind === 'CHECK') {
          await runner.query(
            'ALTER TABLE seller_verifications DROP CONSTRAINT "CHK_seller_verifications_reverification"',
          );
          await runner.query(
            'ALTER TABLE seller_verifications ADD CONSTRAINT "CHK_seller_verifications_reverification" CHECK (true)',
          );
        }
        if (kind === 'index') {
          await runner.query(
            'DROP INDEX "UQ_seller_verifications_active_user"',
          );
          await runner.query(
            `CREATE UNIQUE INDEX "UQ_seller_verifications_active_user" ON seller_verifications ("userId" NULLS FIRST) WHERE status='PENDING'`,
          );
        }
        const sql = await readFile(
          resolve(
            'scripts/migrations/20261019-add-seller-breeder-reverification-v1.sql',
          ),
          'utf8',
        );
        await expect(
          runner.query(sql.replace(/^\\set[^\r\n]*(?:\r?\n)?/, '')),
        ).rejects.toThrow(/Incompatible/);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
      await applyReverificationMigration();
    },
  );

  it('reverification creates a new seller row and a new approval supersedes revoked history', async () => {
    const user = await eligibleUser();
    const service = onboardingService();
    const original = (await service.ownSeller(user.id))!;
    await service.revokeSellerAccess(original.id, 'admin', {
      reason: 'Renew identity',
      intent: ReapplicationIntent.REQUIRE_REVERIFICATION,
    });
    expect(
      sellerUserResponse((await service.ownSeller(user.id))!),
    ).toMatchObject({
      effectiveStatus: 'REVERIFICATION_REQUIRED',
      canReapply: true,
    });
    const fresh = await service.submitSeller(user.id, sellerInput);
    expect(fresh.id).not.toBe(original.id);
    await expect(
      listingService().create(user.id, listingInput),
    ).rejects.toMatchObject({ status: 403 });
    await service.approveSeller(fresh.id, 'second-admin', {});
    await expect(
      listingService().create(user.id, listingInput),
    ).resolves.toBeDefined();
    const historical = await source
      .getRepository(SellerVerification)
      .findOneByOrFail({ id: original.id });
    expect(historical).toMatchObject({
      status: 'APPROVED',
      reviewedBy: original.reviewedBy,
      revocationReason: 'Renew identity',
    });
    expect(
      sellerUserResponse(await service.sellerDetail(original.id)).canReapply,
    ).toBe(false);
    await expect(
      source
        .getRepository(SellerVerification)
        .update(original.id, { revocationReason: 'rewrite' }),
    ).rejects.toThrow('immutable');
  });

  it('reverification breeder revocation demotes atomically and preserves ordinary ledger quota even after reapproval', async () => {
    const { user, application } = await approvedBreeder();
    const service = onboardingService();
    await listingService().create(user.id, listingInput);
    await listingService().create(user.id, listingInput);
    await service.revokeBreeder(application.id, 'admin', {
      reason: 'Renew breeder evidence',
      intent: ReapplicationIntent.REQUIRE_REVERIFICATION,
    });
    expect(
      (await source.getRepository(User).findOneByOrFail({ id: user.id })).role,
    ).toBe(UserRole.CUSTOMER);
    // A stale JWT can still say BREEDER: creation receives only its user ID and reads live DB state.
    await expect(
      listingService().create(user.id, listingInput),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'PARROT_LISTING_WEEKLY_LIMIT_REACHED' },
    });
    expect(
      breederUserResponse((await service.ownBreeder(user.id))!),
    ).toMatchObject({
      effectiveStatus: 'REVERIFICATION_REQUIRED',
      canReapply: true,
    });
    const fresh = await service.submitBreeder(user.id, breederInput);
    await service.recordBreederCall(fresh.id, 'admin', {
      outcome: BreederCallOutcome.SUCCESSFUL,
    });
    await service.approveBreeder(fresh.id, 'admin');
    await expect(
      listingService().create(user.id, listingInput),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'PARROT_LISTING_WEEKLY_LIMIT_REACHED' },
    });
    expect(
      await source
        .getRepository(ParrotSaleListingCreationLedger)
        .count({ where: { sellerUserId: user.id } }),
    ).toBe(2);
    expect(
      await source
        .getRepository(BreederApplication)
        .findOneByOrFail({ id: application.id }),
    ).toMatchObject({
      status: 'APPROVED',
      reviewedBy: 'first-admin',
      revocationReason: 'Renew breeder evidence',
    });
  });

  it('reverification breeder-only block preserves seller eligibility but forbids another breeder application', async () => {
    const { user, application } = await approvedBreeder();
    const service = onboardingService();
    await service.revokeBreeder(application.id, 'admin', {
      reason: 'Breeder blocked',
    });
    await expect(
      service.submitBreeder(user.id, breederInput),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'BREEDER_ACCESS_REVOKED' },
    });
    await expect(
      listingService().create(user.id, listingInput),
    ).resolves.toBeDefined();
    await expect(
      service.revokeBreeder(application.id, 'admin', { reason: 'Again' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('reverification seller revocation blocks a live breeder and pending breeder promotion', async () => {
    const { user } = await approvedBreeder();
    const service = onboardingService();
    const seller = (await service.ownSeller(user.id))!;
    await service.revokeSellerAccess(seller.id, 'admin', {
      reason: 'Seller blocked',
    });
    await expect(
      listingService().create(user.id, listingInput),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'SELLER_ACCESS_REVOKED' },
    });
    expect(
      (await source.getRepository(User).findOneByOrFail({ id: user.id })).role,
    ).toBe(UserRole.BREEDER);
    const second = await eligibleUser('09444444444');
    const pending = await service.submitBreeder(second.id, breederInput);
    await service.recordBreederCall(pending.id, 'admin', {
      outcome: BreederCallOutcome.SUCCESSFUL,
    });
    await service.revokeSellerAccess(
      (await service.ownSeller(second.id))!.id,
      'admin',
      { reason: 'Seller blocked' },
    );
    await expect(
      service.approveBreeder(pending.id, 'admin'),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await source.getRepository(User).findOneByOrFail({ id: second.id }))
        .role,
    ).toBe(UserRole.CUSTOMER);
  });

  it('reverification inactive accounts cannot reapply or regain breeder privileges', async () => {
    const { user, application } = await approvedBreeder();
    const service = onboardingService();
    await service.revokeBreeder(application.id, 'admin', {
      reason: 'Reapply',
      intent: ReapplicationIntent.REQUIRE_REVERIFICATION,
    });
    await source.getRepository(User).update(user.id, { isActive: false });
    expect(
      breederUserResponse((await service.ownBreeder(user.id))!).canReapply,
    ).toBe(false);
    await expect(
      service.submitBreeder(user.id, breederInput),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.submitSeller(user.id, sellerInput),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('reverification concurrent seller reapplications allow only one new pending row', async () => {
    const user = await eligibleUser();
    const service = onboardingService();
    await service.revokeSellerAccess(
      (await service.ownSeller(user.id))!.id,
      'admin',
      { reason: 'Reapply', intent: ReapplicationIntent.REQUIRE_REVERIFICATION },
    );
    const results = await Promise.allSettled([
      service.submitSeller(user.id, sellerInput),
      service.submitSeller(user.id, sellerInput),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await source.getRepository(SellerVerification).count({
        where: { userId: user.id, status: SellerVerificationStatus.PENDING },
      }),
    ).toBe(1);
  });

  it('reverification concurrent breeder revocations and reapplications cannot duplicate approvals or promotion', async () => {
    const { user, application } = await approvedBreeder();
    const service = onboardingService();
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        service.revokeBreeder(application.id, 'admin', {
          reason: 'Renew',
          intent: ReapplicationIntent.REQUIRE_REVERIFICATION,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const attempts = await Promise.allSettled([
      service.submitBreeder(user.id, breederInput),
      service.submitBreeder(user.id, breederInput),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await source.getRepository(User).findOneByOrFail({ id: user.id })).role,
    ).toBe(UserRole.CUSTOMER);
  });

  it('reverification revocation failure rolls back both application and role', async () => {
    const { user, application } = await approvedBreeder();
    await source.query(
      `CREATE FUNCTION public.test_fail_breeder_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."revokedAt" IS NOT NULL THEN RAISE EXCEPTION 'intentional revocation failure'; END IF; RETURN NEW; END $$`,
    );
    await source.query(
      `CREATE TRIGGER test_fail_breeder_revoke BEFORE UPDATE ON breeder_applications FOR EACH ROW EXECUTE FUNCTION public.test_fail_breeder_revoke()`,
    );
    try {
      await expect(
        onboardingService().revokeBreeder(application.id, 'admin', {
          reason: 'Renew',
        }),
      ).rejects.toThrow('intentional revocation failure');
      expect(
        (await source.getRepository(User).findOneByOrFail({ id: user.id }))
          .role,
      ).toBe(UserRole.BREEDER);
      expect(
        (
          await source
            .getRepository(BreederApplication)
            .findOneByOrFail({ id: application.id })
        ).revokedAt,
      ).toBeNull();
    } finally {
      await source.query(
        'DROP TRIGGER test_fail_breeder_revoke ON breeder_applications',
      );
      await source.query('DROP FUNCTION public.test_fail_breeder_revoke()');
    }
  });

  it('reverification enforces live DB quota and seller block over a real HTTP request with an old BREEDER JWT', async () => {
    const { user, application } = await approvedBreeder();
    const secret = randomUUID() + randomUUID();
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret }),
        PassportModule.register({ defaultStrategy: 'jwt' }),
      ],
      controllers: [ParrotSaleListingsController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { get: () => secret } },
        { provide: ParrotSaleListingsService, useValue: listingService() },
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    try {
      const token = moduleRef
        .get(JwtService)
        .sign({ sub: user.id, phone: user.phone, role: 'breeder' });
      const call = () =>
        request(app.getHttpServer() as Server)
          .post('/parrot-sale-listings')
          .set('Authorization', `Bearer ${token}`)
          .send(listingInput);
      await call().expect(201);
      await onboardingService().revokeBreeder(application.id, 'admin', {
        reason: 'Renew',
        intent: ReapplicationIntent.REQUIRE_REVERIFICATION,
      });
      await call().expect(201);
      const quota = await call().expect(409);
      expect((quota.body as { code: string }).code).toBe(
        'PARROT_LISTING_WEEKLY_LIMIT_REACHED',
      );
      await onboardingService().revokeSellerAccess(
        (await onboardingService().ownSeller(user.id))!.id,
        'admin',
        { reason: 'Block' },
      );
      const blocked = await call().expect(403);
      expect((blocked.body as { code: string }).code).toBe(
        'SELLER_ACCESS_REVOKED',
      );
    } finally {
      await app.close();
    }
  });

  it('reverification concurrent creation and breeder revocation share the seller lock without overselling quota', async () => {
    const { user, application } = await approvedBreeder();
    await listingService().create(user.id, listingInput);
    const results = await Promise.allSettled([
      onboardingService().revokeBreeder(application.id, 'admin', {
        reason: 'Renew',
      }),
      listingService().create(user.id, listingInput),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    await expect(
      listingService().create(user.id, listingInput),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await source
        .getRepository(ParrotSaleListingCreationLedger)
        .count({ where: { sellerUserId: user.id } }),
    ).toBe(2);
  });

  async function blockedSeller() {
    const user = await eligibleUser();
    const service = onboardingService();
    const original = (await service.ownSeller(user.id))!;
    await service.revokeSellerAccess(original.id, 'blocking-admin', {
      reason: 'Original blocking decision',
    });
    return { user, service, original: (await service.ownSeller(user.id))! };
  }

  it('blocked recovery preserves immutable audit, never restores access, and permits exactly one concurrent new pending request', async () => {
    const { user, service, original } = await blockedSeller();
    const granted = await service.grantSellerReapplication(
      original.id,
      'recovery-admin',
      { reason: 'Evidence checked' },
    );
    expect(granted).toMatchObject({
      status: 'APPROVED',
      revokedAt: original.revokedAt,
      revokedBy: original.revokedBy,
      revocationReason: original.revocationReason,
      reapplicationIntent: 'BLOCKED',
      reviewedAt: original.reviewedAt,
      createdAt: original.createdAt,
      reapplicationGrantedBy: 'recovery-admin',
      reapplicationGrantReason: 'Evidence checked',
    });
    expect(granted.reapplicationGrantedAt).toBeInstanceOf(Date);
    expect(sellerUserResponse(granted)).toMatchObject({
      effectiveStatus: 'REVERIFICATION_REQUIRED',
      canReapply: true,
      reapplicationIntent: 'REQUIRE_REVERIFICATION',
    });
    expect(sellerUserResponse(granted)).not.toHaveProperty(
      'reapplicationGrantedBy',
    );
    await expect(
      listingService().create(user.id, listingInput),
    ).rejects.toMatchObject({ status: 403 });
    const results = await Promise.allSettled([
      service.submitSeller(user.id, sellerInput),
      service.submitSeller(user.id, sellerInput),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { status: 409 } });
    expect(
      await source
        .getRepository(SellerVerification)
        .countBy({ userId: user.id, status: SellerVerificationStatus.PENDING }),
    ).toBe(1);
    expect(
      await source
        .getRepository(SellerVerification)
        .findOneByOrFail({ id: original.id }),
    ).toMatchObject({
      revokedAt: original.revokedAt,
      revocationReason: original.revocationReason,
      reapplicationIntent: 'BLOCKED',
    });
    await expect(
      listingService().create(user.id, listingInput),
    ).rejects.toMatchObject({ status: 403 });
    await service.approveSeller(
      (await service.ownSeller(user.id))!.id,
      'approval-admin',
      {},
    );
    await expect(
      listingService().create(user.id, listingInput),
    ).resolves.toBeDefined();
    await applyReverificationMigration();
  });

  it('blocked recovery concurrent grants are append-once and SQL cannot rewrite original or recovery audit', async () => {
    const { service, original } = await blockedSeller();
    const results = await Promise.allSettled(
      ['admin-a', 'admin-b'].map((actor) =>
        service.grantSellerReapplication(original.id, actor, { reason: actor }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { status: 409 } });
    const saved = await source
      .getRepository(SellerVerification)
      .findOneByOrFail({ id: original.id });
    for (const column of ['revocationReason', 'reapplicationGrantReason']) {
      await expect(
        source.query(
          `UPDATE seller_verifications SET "${column}"='rewritten' WHERE id=$1`,
          [original.id],
        ),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
    }
    await expect(
      service.grantSellerReapplication(original.id, 'admin-c', {
        reason: 'Duplicate',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await source
        .getRepository(SellerVerification)
        .findOneByOrFail({ id: original.id }),
    ).toMatchObject({
      reapplicationGrantedAt: saved.reapplicationGrantedAt,
      reapplicationGrantedBy: saved.reapplicationGrantedBy,
    });
  });

  it('blocked recovery never bypasses inactive accounts, current approval, or a later new block', async () => {
    const { user, service, original } = await blockedSeller();
    await source.getRepository(User).update(user.id, { isActive: false });
    await expect(
      service.grantSellerReapplication(original.id, 'admin', {
        reason: 'Inactive',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await service.ownSeller(user.id))!.reapplicationGrantedAt,
    ).toBeNull();
    await source.getRepository(User).update(user.id, { isActive: true });
    await service.grantSellerReapplication(original.id, 'admin', {
      reason: 'Reviewed',
    });
    const fresh = await service.submitSeller(user.id, sellerInput);
    await expect(
      service.grantSellerReapplication(fresh.id, 'admin', {
        reason: 'Pending',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await service.approveSeller(fresh.id, 'admin', {});
    await expect(
      service.grantSellerReapplication(fresh.id, 'admin', { reason: 'Active' }),
    ).rejects.toMatchObject({ status: 409 });
    await service.revokeSellerAccess(fresh.id, 'admin', {
      reason: 'New block',
    });
    await expect(
      service.grantSellerReapplication(original.id, 'admin', {
        reason: 'Stale',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.submitSeller(user.id, sellerInput),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'SELLER_ACCESS_REVOKED' },
    });
  });

  it('blocked recovery rollback leaves original block and no grant when save fails', async () => {
    const { user, service, original } = await blockedSeller();
    await source.query(`CREATE FUNCTION test_fail_seller_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."reapplicationGrantedAt" IS NOT NULL THEN RAISE EXCEPTION 'Deliberate grant failure'; END IF; RETURN NEW; END $$`);
    await source.query(
      'CREATE TRIGGER test_fail_seller_grant BEFORE UPDATE ON seller_verifications FOR EACH ROW EXECUTE FUNCTION test_fail_seller_grant()',
    );
    try {
      await expect(
        service.grantSellerReapplication(original.id, 'admin', {
          reason: 'Reviewed',
        }),
      ).rejects.toThrow('Deliberate grant failure');
      expect(
        (await service.ownSeller(user.id))!.reapplicationGrantedAt,
      ).toBeNull();
      await expect(
        service.submitSeller(user.id, sellerInput),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await source.query(
        'DROP TRIGGER test_fail_seller_grant ON seller_verifications',
      );
      await source.query('DROP FUNCTION test_fail_seller_grant()');
    }
    await expect(
      service.grantSellerReapplication(original.id, 'admin', {
        reason: 'Retry',
      }),
    ).resolves.toBeDefined();
  });

  it('blocked recovery serializes reapply and reblock races without restoring seller privileges', async () => {
    const { user, service, original } = await blockedSeller();
    const results = await Promise.allSettled([
      service.grantSellerReapplication(original.id, 'recovery-admin', {
        reason: 'Reviewed',
      }),
      service.revokeSellerAccess(original.id, 'blocking-admin', {
        reason: 'Duplicate block',
      }),
      service.submitSeller(user.id, sellerInput),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { status: 409 },
    });
    expect(
      await source
        .getRepository(SellerVerification)
        .countBy({ userId: user.id, status: SellerVerificationStatus.PENDING }),
    ).toBeLessThanOrEqual(1);
    await expect(
      listingService().create(user.id, listingInput),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('blocked recovery real HTTP denies forged customer grants and authorizes only registered Admin', async () => {
    const { user, service, original } = await blockedSeller();
    const secret = randomUUID() + randomUUID();
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret }),
        PassportModule.register({ defaultStrategy: 'jwt' }),
      ],
      controllers: [
        AdminSellerOnboardingController,
        SellerOnboardingController,
      ],
      providers: [
        JwtStrategy,
        AdminAuthGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'ADMIN_USERS'
                ? 'test-admin'
                : key === 'GOD_ADMIN_USERNAME'
                  ? 'test-owner'
                  : secret,
          },
        },
        { provide: SellerOnboardingService, useValue: service },
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    try {
      const jwt = moduleRef.get(JwtService);
      const customer = jwt.sign({
        sub: user.id,
        phone: user.phone,
        role: 'customer',
      });
      const admin = jwt.sign({ scope: 'admin-panel', username: 'test-admin' });
      const server = app.getHttpServer() as Server;
      const path = `/admin-panel/seller-onboarding/verifications/${original.id}/grant-reapplication`;
      await request(server)
        .post('/seller-onboarding/verification')
        .set('Authorization', `Bearer ${customer}`)
        .send({
          ...sellerInput,
          reapplicationGrantedAt: new Date().toISOString(),
          reapplicationIntent: 'REQUIRE_REVERIFICATION',
        })
        .expect(403);
      for (const token of [
        customer,
        jwt.sign({ scope: 'god-admin-panel', username: 'test-owner' }),
        jwt.sign({ scope: 'admin-panel', username: 'unregistered' }),
      ]) {
        await request(server)
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .send({ reason: 'Bypass' })
          .expect(401);
      }
      await request(server)
        .post(path)
        .set('Authorization', `Bearer ${admin}`)
        .send({ reason: ' ' })
        .expect(400);
      await request(server)
        .post(path)
        .set('Authorization', `Bearer ${admin}`)
        .send({
          reason: 'Valid recovery',
          userId: randomUUID(),
          reapplicationGrantedBy: 'spoofed',
        })
        .expect(201);
      expect((await service.ownSeller(user.id))!.reapplicationGrantedBy).toBe(
        'test-admin',
      );
      const results = await Promise.all(
        [1, 2].map(() =>
          request(server)
            .post('/seller-onboarding/verification')
            .set('Authorization', `Bearer ${customer}`)
            .send(sellerInput),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    } finally {
      await app.close();
    }
  });

  async function withPrivateStorage<T>(
    action: (
      storage: ParrotSaleListingImageStorageService,
      root: string,
    ) => Promise<T>,
  ): Promise<T> {
    const parent = await mkdtemp(join(tmpdir(), 'parrot-listing-delete-'));
    if (!resolve(parent).startsWith(`${resolve(tmpdir())}${sep}`))
      throw new Error('Unsafe disposable private image path');
    const root = join(parent, 'private');
    await mkdir(root);
    const previous = process.env.PARROT_SALE_LISTING_PRIVATE_STORAGE_DIR;
    process.env.PARROT_SALE_LISTING_PRIVATE_STORAGE_DIR = root;
    const storage = new ParrotSaleListingImageStorageService();
    if (previous === undefined)
      delete process.env.PARROT_SALE_LISTING_PRIVATE_STORAGE_DIR;
    else process.env.PARROT_SALE_LISTING_PRIVATE_STORAGE_DIR = previous;
    try {
      return await action(storage, root);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }

  async function applyLedgerMigration() {
    const sql = await readFile(
      resolve(
        process.cwd(),
        'scripts/migrations',
        '20261017-create-parrot-sale-listing-creation-ledger-v1.sql',
      ),
      'utf8',
    );
    await source.query(sql.replace(/^\\set[^\r\n]*(?:\r?\n)?/, ''));
  }

  async function applyCleanupMigration() {
    const sql = await readFile(
      resolve(
        process.cwd(),
        'scripts/migrations',
        '20261017-add-parrot-listing-cleanup-completed-v1.sql',
      ),
      'utf8',
    );
    const runner = source.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(sql.replace(/^\\set[^\r\n]*(?:\r?\n)?/, ''));
    } catch (error) {
      await runner.query('ROLLBACK');
      throw error;
    } finally {
      await runner.release();
    }
  }

  function listingService(storage?: ParrotSaleListingImageStorageService) {
    return new ParrotSaleListingsService(
      source,
      source.getRepository(ParrotSaleListing),
      new SellerEligibilityPolicy(
        source.getRepository(User),
        source.getRepository(SellerVerification),
      ),
      (storage ?? {}) as never,
      { assertValidSelection: () => Promise.resolve() } as never,
    );
  }

  async function eligibleUser(
    phone = '09000000000',
    role = UserRole.CUSTOMER,
    id?: string,
  ) {
    const user = await source.getRepository(User).save({
      ...(id ? { id } : {}),
      phone,
      firstName: 'Test',
      lastName: 'Seller',
      role,
      phoneVerifiedAt: new Date(),
      isActive: true,
    });
    await source.getRepository(SellerVerification).save({
      userId: user.id,
      firstName: 'Test',
      lastName: 'Seller',
      birthDate: '2000-01-01',
      consentAcceptedAt: new Date(),
      consentVersion: 'seller-consent-v1',
      status: SellerVerificationStatus.APPROVED,
      reviewedBy: 'test-admin',
      reviewedAt: new Date(),
    });
    return user;
  }

  async function createFoundation() {
    await source.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await source.query(
      "CREATE TYPE public.users_role_enum AS ENUM ('admin', 'customer')",
    );
    await source.query(`CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
      phone varchar NOT NULL UNIQUE, "firstName" varchar, "lastName" varchar,
      email varchar UNIQUE, "nationalId" varchar,
      "profileCompleted" boolean NOT NULL DEFAULT false,
      "loyaltyPoints" integer NOT NULL DEFAULT 0,
      role public.users_role_enum NOT NULL DEFAULT 'customer',
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await source.query(`CREATE TABLE public.otps (
      id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
      phone varchar NOT NULL, "codeHash" varchar NOT NULL,
      "expiresAt" timestamptz NOT NULL, consumed boolean NOT NULL DEFAULT false,
      attempts integer NOT NULL DEFAULT 0,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await source.query(
      'CREATE TABLE public.products (id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4())',
    );
  }

  async function assertLoopback(connection: DataSource, database: string) {
    const [identity] = await connection.query<
      Array<{ database: string; address: string }>
    >(
      'SELECT current_database() AS database, host(inet_server_addr()) AS address',
    );
    if (
      identity.database !== database ||
      !['127.0.0.1', '::1'].includes(identity.address)
    )
      throw new Error('Disposable listing database identity mismatch');
  }
});

function expectQuotaError(error: unknown) {
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  expect(exception.getStatus()).toBe(409);
  expect(exception.getResponse()).toMatchObject({
    code: ParrotSaleListingErrorCode.WEEKLY_LIMIT_REACHED,
  });
}

function disposableUrl(): URL {
  if (process.env.PARROT_LISTING_RUN_DB_TESTS !== '1')
    throw new Error('PARROT_LISTING_RUN_DB_TESTS must equal 1');
  if (process.env.PARROT_LISTING_TEST_DATABASE_CONFIRM !== 'DISPOSABLE')
    throw new Error(
      'PARROT_LISTING_TEST_DATABASE_CONFIRM must equal DISPOSABLE',
    );
  const raw = process.env.PARROT_LISTING_TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('PARROT_LISTING_TEST_DATABASE_URL is required');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('PostgreSQL URL required');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Listing integration tests require a loopback host');
  if (url.pathname.slice(1) !== DATABASE_NAME || url.search || url.hash)
    throw new Error('Exact disposable listing database URL required');
  return url;
}
