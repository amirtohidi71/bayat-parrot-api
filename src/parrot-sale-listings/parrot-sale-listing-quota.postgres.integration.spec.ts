import { HttpException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
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
      if (administrator?.isInitialized) await administrator.destroy();
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
    await applyLedgerMigration();
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
    ).toBe(2);
  });

  it('exempts an approved BREEDER but not a breeder role without an approved application', async () => {
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
      Array.from({ length: 3 }, () => service.create(approved.id, input)),
    );
    expect(
      await source
        .getRepository(ParrotSaleListing)
        .count({ where: { sellerUserId: approved.id } }),
    ).toBe(3);
    expect(
      await source.getRepository(ParrotSaleListingCreationLedger).count({
        where: { sellerUserId: approved.id },
      }),
    ).toBe(3);

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

  function listingService() {
    return new ParrotSaleListingsService(
      source,
      source.getRepository(ParrotSaleListing),
      new SellerEligibilityPolicy(
        source.getRepository(User),
        source.getRepository(SellerVerification),
      ),
      {} as never,
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
