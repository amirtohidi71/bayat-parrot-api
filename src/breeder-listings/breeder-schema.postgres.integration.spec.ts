import { SellerListingProductPublisherService } from '../products/seller-listing-product-publisher.service';
import { ProductsService } from '../products/products.service';
import { StockReservationsService } from '../stock-reservations/stock-reservations.service';
import { ProductStockReservation } from '../stock-reservations/entities/product-stock-reservation.entity';
import { Order } from '../orders/entities/order.entity';
import { OrderItem } from '../orders/entities/order-item.entity';
import { OrdersService } from '../orders/orders.service';
import { ParrotSaleListingApprovalService } from '../parrot-sale-listings/parrot-sale-listing-approval.service';
import { Product } from '../products/entities/product.entity';
import { ListingSubmissionKind } from '../parrot-sale-listings/entities/listing-submission-kind';
import { ParrotSaleListingStatus } from '../parrot-sale-listings/entities/parrot-sale-listing.entity';
import { readFile } from 'node:fs/promises';
import { ValidationPipe } from '@nestjs/common';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DataSource,
  EntityManager,
  In,
  QueryFailedError,
  QueryRunner,
} from 'typeorm';
import { VET_TEST_ENTITIES } from '../../test/vet-test-entities';
import { BREEDER_SCHEMA_ENTITIES } from './breeder-schema.entities';
import { BirdSpecies } from './entities/bird-species.entity';
import { BirdSubspecies } from './entities/bird-subspecies.entity';
import {
  BreederSpeciesPermission,
  BreederPermissionState,
} from './entities/breeder-species-permission.entity';
import { BreederSubspeciesPermission } from './entities/breeder-subspecies-permission.entity';
import {
  BreederPermissionAction,
  BreederPermissionEvent,
} from './entities/breeder-permission-event.entity';
import { SellerVerification } from '../seller-onboarding/entities/seller-verification.entity';
import { BreederApplication } from '../seller-onboarding/entities/breeder-application.entity';
import { SellerEligibilityPolicy } from '../seller-onboarding/seller-eligibility.policy';
import { ParrotSaleListing } from '../parrot-sale-listings/entities/parrot-sale-listing.entity';
import { ParrotSaleListingImage } from '../parrot-sale-listings/entities/parrot-sale-listing-image.entity';
import { ParrotSaleListingCreationLedger } from '../parrot-sale-listings/entities/parrot-sale-listing-creation-ledger.entity';
import { ParrotSaleListingsService } from '../parrot-sale-listings/parrot-sale-listings.service';
import { User } from '../users/entities/user.entity';
import { SellerOnboardingService } from '../seller-onboarding/seller-onboarding.service';
import { ReapplicationIntent } from '../seller-onboarding/seller-lifecycle';
import { BreederTaxonService } from './breeder-taxon.service';
import {
  BreederPermissionDecision as Decision,
  BreederPermissionKind as Kind,
  RequestBreederTaxaDto,
  DecideBreederPermissionDto,
} from './breeder-taxon.dto';

const DATABASE = 'parrot_listing_disposable_test';
const enabled =
  process.env.PARROT_LISTING_RUN_DB_TESTS === '1' &&
  process.env.PARROT_LISTING_TEST_DATABASE_CONFIRM === 'DISPOSABLE' &&
  Boolean(process.env.PARROT_LISTING_TEST_DATABASE_URL?.trim());
const TAXON = '20261020-create-breeder-taxon-permissions-v1.sql';
const KIND = '20261020-add-parrot-listing-submission-kind-v1.sql';
const PRIVILEGES =
  '20261020-grant-breeder-foundation-runtime-privileges-v1.sql';

(enabled ? describe : describe.skip)(
  'Breeder schema foundation on disposable PostgreSQL',
  () => {
    let admin: DataSource;
    let source: DataSource;
    let databaseCreated = false;
    let roleCreated = false;
    const legacyListing = randomUUID(),
      legacyProduct = randomUUID(),
      ledgerOnly = randomUUID(),
      legacyUser = randomUUID();
    const originalTime = '2026-01-03T01:02:03.000Z';

    async function assertIdentity(connection: DataSource, database: string) {
      const [row] = await connection.query<
        Array<{ database: string; host: string }>
      >(
        'SELECT current_database() AS database, host(inet_server_addr()) AS host',
      );
      if (row.database !== database || !['127.0.0.1', '::1'].includes(row.host))
        throw new Error('Disposable database identity mismatch');
    }

    async function migrate(name: string, runner?: QueryRunner) {
      const connection = runner ?? source.createQueryRunner();
      if (!runner) await connection.connect();
      try {
        const sql = await readFile(resolve('scripts/migrations', name), 'utf8');
        await connection.query(sql.replace(/^\\set[^\r\n]*(?:\r?\n)?/, ''));
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        if (!runner) await connection.release();
      }
    }

    beforeAll(async () => {
      const url = new URL(process.env.PARROT_LISTING_TEST_DATABASE_URL!);
      if (
        process.env.PARROT_LISTING_RUN_DB_TESTS !== '1' ||
        process.env.PARROT_LISTING_TEST_DATABASE_CONFIRM !== 'DISPOSABLE' ||
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.pathname !== '/' + DATABASE ||
        url.search ||
        url.hash
      )
        throw new Error('Exact loopback disposable configuration required');
      const adminUrl = new URL(url);
      adminUrl.pathname = '/postgres';
      admin = new DataSource({
        type: 'postgres',
        url: adminUrl.toString(),
        synchronize: false,
        logging: false,
        extra: { max: 1 },
      });
      await admin.initialize();
      await assertIdentity(admin, 'postgres');
      const [existing] = await admin.query<
        Array<{ database: boolean; role: boolean }>
      >(
        "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS database, EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bayat_app') AS role",
        [DATABASE],
      );
      if (existing.database || existing.role)
        throw new Error(
          'Disposable database or isolated runtime role already exists; refusing reuse',
        );
      await admin.query('CREATE DATABASE "parrot_listing_disposable_test"');
      databaseCreated = true;
      source = new DataSource({
        type: 'postgres',
        url: url.toString(),
        synchronize: false,
        logging: false,
        extra: { max: 8 },
        entities: [
          ...VET_TEST_ENTITIES,
          SellerVerification,
          BreederApplication,
          ParrotSaleListing,
          ParrotSaleListingImage,
          ParrotSaleListingCreationLedger,
          ...BREEDER_SCHEMA_ENTITIES,
          ProductStockReservation,
          Order,
          OrderItem,
        ],
      });
      await source.initialize();
      await assertIdentity(source, DATABASE);
      await admin.query(
        'CREATE ROLE bayat_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
      );
      roleCreated = true;
      await source.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await source.query(
        "CREATE TYPE public.users_role_enum AS ENUM ('admin','customer')",
      );
      await source.query(`CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(), phone varchar UNIQUE NOT NULL,
      "firstName" varchar, "lastName" varchar, email varchar UNIQUE, "nationalId" varchar,
      "profileCompleted" boolean NOT NULL DEFAULT false, "loyaltyPoints" integer NOT NULL DEFAULT 0,
      role public.users_role_enum NOT NULL DEFAULT 'customer', "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`);
      await source.query(`CREATE TABLE public.otps (
        id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(), phone varchar NOT NULL,
        "codeHash" varchar NOT NULL, "expiresAt" timestamptz NOT NULL,
        consumed boolean NOT NULL DEFAULT false, attempts integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now())`);
      await source.query(`CREATE TABLE public.products (id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
      name varchar, status varchar, stock integer, images text[], "updatedAt" timestamptz DEFAULT now(), "deletedAt" timestamptz)`);
      for (const name of [
        '20260926-create-seller-onboarding-v1.sql',
        '20261003-create-parrot-sale-listings-v1.sql',
        '20261009-add-parrot-sale-listing-lifecycle-v1.sql',
        '20261017-create-parrot-sale-listing-creation-ledger-v1.sql',
        '20261017-add-parrot-listing-cleanup-completed-v1.sql',
        '20261019-add-seller-breeder-reverification-v1.sql',
      ])
        await migrate(name);
      await source.query('INSERT INTO users(id,phone) VALUES ($1,$2)', [
        legacyUser,
        '09000000000',
      ]);
      await source.query(
        `INSERT INTO products(id,name,status,stock,images,"isSellerListing") VALUES ($1,'Historical bird','published',3,ARRAY['/uploads/existing.webp'],true)`,
        [legacyProduct],
      );
      await source.query(
        `INSERT INTO parrot_sale_listings(id,"sellerUserId",name,species,"requestedPrice","approvedPrice",status,"reviewedBy","reviewedAt","productId","createdAt")
      VALUES ($1,$2,'Historical bird','Historical unclassified label',100,100,'APPROVED','fixture-admin',now(),$3,$4)`,
        [legacyListing, legacyUser, legacyProduct, originalTime],
      );
      await source.query(
        `INSERT INTO parrot_sale_listing_creation_ledger("listingId","sellerUserId","createdAt")
      SELECT id,"sellerUserId","createdAt" FROM parrot_sale_listings WHERE id=$1`,
        [legacyListing],
      );
      await source.query(
        `INSERT INTO parrot_sale_listing_creation_ledger("listingId","sellerUserId","createdAt","deletedAt","cleanupCompletedAt")
      VALUES ($1,$2,$3,$3,$3)`,
        [ledgerOnly, legacyUser, originalTime],
      );
      await source.query(
        'CREATE TABLE foundation_order_items(id uuid PRIMARY KEY, "productId" uuid REFERENCES products(id) ON DELETE RESTRICT, quantity integer)',
      );
      await source.query(
        'INSERT INTO foundation_order_items VALUES ($1,$2,1)',
        [randomUUID(), legacyProduct],
      );
      await migrate(TAXON);
      await migrate(KIND);
      await migrate(PRIVILEGES);
      await migrate('20261022-add-breeder-listing-publication-hold-v1.sql');
      // Extend only this disposable fixture to support the real publisher and
      // public Product reads, with actual order/reservation records below.
      await source.query(`ALTER TABLE products
        ADD COLUMN sku varchar UNIQUE, ADD COLUMN description varchar,
        ADD COLUMN "shortDescription" varchar, ADD COLUMN specifications jsonb,
        ADD COLUMN "boughtTogetherProductIds" uuid[] NOT NULL DEFAULT '{}',
        ADD COLUMN "lastEditedByName" varchar, ADD COLUMN price numeric(15,2) DEFAULT 100,
        ADD COLUMN "discountPercent" integer, ADD COLUMN "discountPrice" numeric(15,2),
        ADD COLUMN "colorVariants" jsonb, ADD COLUMN "categorySlug" varchar DEFAULT 'buy-parrot',
        ADD COLUMN "subCategory" varchar, ADD COLUMN species varchar, ADD COLUMN subspecies varchar,
        ADD COLUMN gender varchar, ADD COLUMN "ageStage" varchar, ADD COLUMN colors text[],
        ADD COLUMN brand varchar, ADD COLUMN weight varchar, ADD COLUMN "productType" varchar,
        ADD COLUMN size varchar, ADD COLUMN material varchar,
        ADD COLUMN "tagPair" boolean DEFAULT false, ADD COLUMN "tagHandTame" boolean DEFAULT false,
        ADD COLUMN "tagCustom" boolean DEFAULT false, ADD COLUMN "tagLuxury" boolean DEFAULT false,
        ADD COLUMN "tagHealthGuarantee" boolean DEFAULT false, ADD COLUMN "tagFastShipping" boolean DEFAULT false,
        ADD COLUMN "tagFreeShipping" boolean DEFAULT false, ADD COLUMN "tagCarryCage" boolean DEFAULT false,
        ADD COLUMN "isAmazingOffer" boolean DEFAULT false, ADD COLUMN "amazingOfferEndsAt" timestamptz,
        ADD COLUMN "createdAt" timestamp DEFAULT now()`);
      await source.query(`CREATE TABLE orders (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid REFERENCES users(id),
        status varchar DEFAULT 'pending',total numeric DEFAULT 100,address varchar,
        "recipientName" varchar,"recipientMobile" varchar,"postalCode" varchar,
        "paymentStatus" varchar DEFAULT 'pending',"paymentDate" timestamptz,"orderNumber" varchar UNIQUE,
        "createdAt" timestamptz DEFAULT now(),"updatedAt" timestamptz DEFAULT now())`);
      await source.query(`CREATE TABLE order_items (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"orderId" uuid REFERENCES orders(id),
        "productId" uuid REFERENCES products(id),quantity integer,price numeric,
        "colorCode" varchar,"colorName" varchar)`);
      await migrate('20261004-create-product-stock-reservations-v1.sql');
    }, 60_000);

    afterAll(async () => {
      try {
        if (source?.isInitialized) await source.destroy();
        if (admin?.isInitialized && databaseCreated) {
          await assertIdentity(admin, 'postgres');
          await admin.query('DROP DATABASE "parrot_listing_disposable_test"');
          const [remaining] = await admin.query<Array<{ exists: boolean }>>(
            'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS exists',
            [DATABASE],
          );
          expect(remaining.exists).toBe(false);
        }
      } finally {
        try {
          if (admin?.isInitialized && roleCreated)
            await admin.query('DROP ROLE bayat_app');
        } finally {
          if (admin?.isInitialized) await admin.destroy();
        }
      }
    }, 60_000);

    async function transaction(work: (runner: QueryRunner) => Promise<void>) {
      const runner = source.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await work(runner);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    }

    async function rejects(
      runner: QueryRunner,
      sql: string,
      params: unknown[] = [],
      code = '23514',
    ) {
      await runner.query('SAVEPOINT expected_failure');
      let failure: unknown;
      try {
        await runner.query(sql, params);
        await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
      } catch (error) {
        failure = error;
      } finally {
        await runner.query('ROLLBACK TO SAVEPOINT expected_failure');
        await runner.query('RELEASE SAVEPOINT expected_failure');
      }
      expect(failure).toBeInstanceOf(QueryFailedError);
      expect(
        (failure as QueryFailedError<{ code: string }>).driverError.code,
      ).toBe(code);
    }

    async function fixture(runner: QueryRunner) {
      const user = randomUUID(),
        application = randomUUID(),
        species = randomUUID(),
        subspecies = randomUUID();
      await runner.query(
        `INSERT INTO users(id,phone,"firstName","lastName","phoneVerifiedAt") VALUES ($1,$2,'Test','Seller',now())`,
        [user, '09' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0')],
      );
      await runner.query(
        `INSERT INTO breeder_applications(id,"userId","breederName",city,species,"experienceYears","approximateBirdCount","preferredContactTime",status,"reviewedAt","reviewedBy","callOutcome","contactedAt")
      VALUES ($1,$2,'Test breeder','City','["Fixture"]',1,1,'Morning','APPROVED',now(),'fixture-admin','SUCCESSFUL',now())`,
        [application, user],
      );
      await runner.query(
        `INSERT INTO bird_species(id,key,"displayName") VALUES ($1,$2,'Fixture species')`,
        [species, randomUUID()],
      );
      await runner.query(
        `INSERT INTO bird_subspecies(id,"speciesId",key,"displayName") VALUES ($1,$2,$3,'Fixture subspecies')`,
        [subspecies, species, randomUUID()],
      );
      return { user, application, species, subspecies };
    }

    async function event(
      runner: QueryRunner,
      application: string,
      permission: string,
      child: boolean,
      revision = 1,
      action = 'REQUEST',
      from: string | null = null,
      to = 'REQUESTED',
    ) {
      await runner.query(
        `INSERT INTO breeder_permission_events("applicationId","speciesPermissionId","subspeciesPermissionId",revision,action,"fromState","toState","actorType","actorId",reason,"requestId","requestHash")
      VALUES ($1,$2,$3,$4,$5,$6,$7,'ADMIN','fixture-admin','Fixture decision',$8,$9)`,
        [
          application,
          child ? null : permission,
          child ? permission : null,
          revision,
          action,
          from,
          to,
          randomUUID(),
          '0'.repeat(64),
        ],
      );
    }

    async function permissions(
      runner: QueryRunner,
      value: Awaited<ReturnType<typeof fixture>>,
    ) {
      const parent = randomUUID(),
        child = randomUUID();
      await runner.query(
        `INSERT INTO breeder_species_permissions(id,"applicationId","speciesId") VALUES ($1,$2,$3)`,
        [parent, value.application, value.species],
      );
      await event(runner, value.application, parent, false);
      await runner.query(
        `INSERT INTO breeder_subspecies_permissions(id,"applicationId","speciesId","subspeciesId","speciesPermissionId") VALUES ($1,$2,$3,$4,$5)`,
        [child, value.application, value.species, value.subspecies, parent],
      );
      await event(runner, value.application, child, true);
      return { parent, child };
    }

    async function approve(
      runner: QueryRunner,
      application: string,
      id: string,
      child: boolean,
    ) {
      const table = child
        ? 'breeder_subspecies_permissions'
        : 'breeder_species_permissions';
      await runner.query(
        `UPDATE ${table} SET state='APPROVED',revision=2 WHERE id=$1`,
        [id],
      );
      await event(
        runner,
        application,
        id,
        child,
        2,
        'APPROVE',
        'REQUESTED',
        'APPROVED',
      );
    }

    async function breederListing(
      runner: QueryRunner,
      v: Awaited<ReturnType<typeof fixture>>,
      permission: string,
    ) {
      const id = randomUUID();
      await runner.query(
        `INSERT INTO parrot_sale_listings(id,"sellerUserId",name,species,"requestedPrice","submissionKind","speciesId","subspeciesId","breederApplicationId","breederSubspeciesPermissionId")
      VALUES ($1,$2,'Fixture bird','Fixture species',100,'BREEDER',$3,$4,$5,$6)`,
        [id, v.user, v.species, v.subspecies, v.application, permission],
      );
      await runner.query(
        `INSERT INTO parrot_sale_listing_creation_ledger("listingId","sellerUserId","createdAt","submissionKind")
      SELECT id,"sellerUserId","createdAt","submissionKind" FROM parrot_sale_listings WHERE id=$1`,
        [id],
      );
      return id;
    }

    it('first run preserves legacy and ledger-only history as ORDINARY without taxonomy seeds or inferred grants', async () => {
      const [listing] = await source.query<
        Array<{
          submissionKind: string;
          productId: string;
          species: string;
          createdAt: Date;
        }>
      >('SELECT * FROM parrot_sale_listings WHERE id=$1', [legacyListing]);
      expect(listing).toMatchObject({
        submissionKind: 'ORDINARY',
        productId: legacyProduct,
        species: 'Historical unclassified label',
      });
      expect(listing.createdAt.toISOString()).toBe(originalTime);
      const history = await source.query<
        Array<{ submissionKind: string; createdAt: Date }>
      >(
        'SELECT * FROM parrot_sale_listing_creation_ledger WHERE "listingId" IN ($1,$2)',
        [legacyListing, ledgerOnly],
      );
      expect(history).toHaveLength(2);
      for (const row of history) {
        expect(row.submissionKind).toBe('ORDINARY');
        expect(row.createdAt.toISOString()).toBe(originalTime);
      }
      for (const table of [
        'bird_species',
        'bird_subspecies',
        'breeder_species_permissions',
        'breeder_subspecies_permissions',
        'breeder_permission_events',
      ]) {
        const [row] = await source.query<Array<{ count: number }>>(
          `SELECT count(*)::integer AS count FROM ${table}`,
        );
        expect(row.count).toBe(0);
      }
      const [product] = await source.query<
        Array<{ status: string; stock: number; images: string[] }>
      >('SELECT * FROM products WHERE id=$1', [legacyProduct]);
      expect(product).toMatchObject({
        status: 'published',
        stock: 3,
        images: ['/uploads/existing.webp'],
      });
      expect(
        await source.query('SELECT * FROM foundation_order_items'),
      ).toHaveLength(1);
    });

    it('reruns all three forward migrations idempotently', async () => {
      for (const name of [TAXON, KIND, PRIVILEGES]) await migrate(name);
      expect(
        await source.query('SELECT * FROM parrot_sale_listing_creation_ledger'),
      ).toHaveLength(2);
    });

    it('aligns entity columns and SQL types/nullability without synchronize', async () => {
      const runner = source.createQueryRunner();
      try {
        for (const entity of [
          BirdSpecies,
          BirdSubspecies,
          BreederSpeciesPermission,
          BreederSubspeciesPermission,
          BreederPermissionEvent,
          ParrotSaleListing,
          ParrotSaleListingCreationLedger,
        ]) {
          const metadata = source.getMetadata(entity);
          expect(metadata.synchronize).toBe(false);
          const table = await runner.getTable(metadata.tableName);
          expect(table).toBeDefined();
          for (const column of metadata.columns) {
            const actual = table!.findColumnByName(column.databaseName);
            expect(actual).toBeDefined();
            expect(actual!.type).toBe(source.driver.normalizeType(column));
            expect(actual!.isNullable).toBe(column.isNullable);
            if (column.length) expect(actual!.length).toBe(column.length);
          }
        }
      } finally {
        await runner.release();
      }
    });

    it('enforces stable unique keys and prevents key/parent rewriting', async () =>
      transaction(async (runner) => {
        const v = await fixture(runner);
        await rejects(runner, 'UPDATE bird_species SET key=$1 WHERE id=$2', [
          randomUUID(),
          v.species,
        ]);
        await rejects(
          runner,
          'UPDATE bird_subspecies SET "speciesId"=$1 WHERE id=$2',
          [randomUUID(), v.subspecies],
        );
        await rejects(
          runner,
          'INSERT INTO bird_subspecies("speciesId",key,"displayName") SELECT "speciesId",key,"displayName" FROM bird_subspecies WHERE id=$1',
          [v.subspecies],
          '23505',
        );
        await rejects(
          runner,
          'INSERT INTO bird_subspecies("speciesId",key,"displayName") VALUES ($1,$2,$3)',
          [randomUUID(), 'fixture', 'Fixture'],
          '23503',
        );
      }));

    it('parent approval never approves children; child approval requires the exact approved parent', async () =>
      transaction(async (runner) => {
        const v = await fixture(runner),
          p = await permissions(runner, v);
        await rejects(
          runner,
          "UPDATE breeder_subspecies_permissions SET state='APPROVED',revision=2 WHERE id=$1",
          [p.child],
        );
        await approve(runner, v.application, p.parent, false);
        const [child] = (await runner.query(
          'SELECT state FROM breeder_subspecies_permissions WHERE id=$1',
          [p.child],
        )) as Array<{ state: string }>;
        expect(child.state).toBe('REQUESTED');
        await approve(runner, v.application, p.child, true);
        await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
      }));

    it('rejects cross-species/cross-application child permissions and owner-spoofed BREEDER listings', async () =>
      transaction(async (runner) => {
        const v = await fixture(runner),
          other = await fixture(runner),
          p = await permissions(runner, v);
        await rejects(
          runner,
          `INSERT INTO breeder_subspecies_permissions("applicationId","speciesId","subspeciesId","speciesPermissionId") VALUES ($1,$2,$3,$4)`,
          [other.application, v.species, v.subspecies, p.parent],
          '23503',
        );
        await rejects(
          runner,
          `INSERT INTO breeder_subspecies_permissions("applicationId","speciesId","subspeciesId","speciesPermissionId") VALUES ($1,$2,$3,$4)`,
          [v.application, v.species, other.subspecies, p.parent],
          '23503',
        );
        const id = await breederListing(runner, v, p.child);
        await rejects(
          runner,
          'UPDATE parrot_sale_listings SET "breederApplicationId"=$1 WHERE id=$2',
          [other.application, id],
          '23503',
        );
      }));

    it('requires matching append-only audit for every revision and rejects actor/reason/chain corruption', async () =>
      transaction(async (runner) => {
        const v = await fixture(runner),
          p = await permissions(runner, v);
        await rejects(
          runner,
          "UPDATE breeder_species_permissions SET state='APPROVED',revision=2 WHERE id=$1",
          [p.parent],
        );
        await rejects(
          runner,
          'UPDATE breeder_permission_events SET reason=$1 WHERE "speciesPermissionId"=$2',
          ['Rewrite', p.parent],
        );
        await rejects(
          runner,
          'DELETE FROM breeder_permission_events WHERE "speciesPermissionId"=$1',
          [p.parent],
        );
        await rejects(
          runner,
          `INSERT INTO breeder_permission_events("applicationId","speciesPermissionId",revision,action,"fromState","toState","actorType","actorId","requestId","requestHash")
      VALUES ($1,$2,2,'APPROVE','REQUESTED','APPROVED','CUSTOMER','fixture',$3,$4)`,
          [v.application, p.parent, randomUUID(), '0'.repeat(64)],
        );
        await rejects(
          runner,
          `INSERT INTO breeder_permission_events("applicationId","speciesPermissionId",revision,action,"fromState","toState","actorType","actorId",reason,"requestId","requestHash")
      VALUES ($1,$2,9,'REVOKE','APPROVED','REVOKED','ADMIN','fixture','Reason',$3,$4)`,
          [v.application, p.parent, randomUUID(), '0'.repeat(64)],
        );
        await approve(runner, v.application, p.parent, false);
        await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
        await rejects(
          runner,
          "UPDATE breeder_species_permissions SET state='REVOKED',revision=9 WHERE id=$1",
          [p.parent],
        );
      }));

    it('cannot revoke a parent while retaining approved children; atomic child revocation retains history', async () =>
      transaction(async (runner) => {
        const v = await fixture(runner),
          p = await permissions(runner, v);
        await approve(runner, v.application, p.parent, false);
        await approve(runner, v.application, p.child, true);
        await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
        await runner.query('SET CONSTRAINTS ALL DEFERRED');
        await runner.query('SAVEPOINT parent_only');
        await runner.query(
          "UPDATE breeder_species_permissions SET state='REVOKED',revision=3 WHERE id=$1",
          [p.parent],
        );
        await event(
          runner,
          v.application,
          p.parent,
          false,
          3,
          'REVOKE',
          'APPROVED',
          'REVOKED',
        );
        await expect(
          runner.query('SET CONSTRAINTS ALL IMMEDIATE'),
        ).rejects.toBeDefined();
        await runner.query('ROLLBACK TO SAVEPOINT parent_only');
        await runner.query(
          "UPDATE breeder_species_permissions SET state='REVOKED',revision=3 WHERE id=$1",
          [p.parent],
        );
        await event(
          runner,
          v.application,
          p.parent,
          false,
          3,
          'REVOKE',
          'APPROVED',
          'REVOKED',
        );
        await runner.query(
          "UPDATE breeder_subspecies_permissions SET state='REVOKED',revision=3 WHERE id=$1",
          [p.child],
        );
        await event(
          runner,
          v.application,
          p.child,
          true,
          3,
          'REVOKE',
          'APPROVED',
          'REVOKED',
        );
        await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
        expect(
          await runner.query(
            'SELECT * FROM breeder_permission_events WHERE "applicationId"=$1',
            [v.application],
          ),
        ).toHaveLength(6);
      }));

    it('rejects missing BREEDER linkage, ordinary privilege linkage, mutable kind and ledger mismatches', async () =>
      transaction(async (runner) => {
        const v = await fixture(runner),
          p = await permissions(runner, v);
        await rejects(
          runner,
          `INSERT INTO parrot_sale_listings("sellerUserId",name,species,"requestedPrice","submissionKind") VALUES ($1,'Bird','Fixture',100,'BREEDER')`,
          [v.user],
        );
        const id = await breederListing(runner, v, p.child);
        await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
        await rejects(
          runner,
          'UPDATE parrot_sale_listings SET "submissionKind"=\'ORDINARY\' WHERE id=$1',
          [id],
        );
        await rejects(
          runner,
          'UPDATE parrot_sale_listing_creation_ledger SET "submissionKind"=\'ORDINARY\' WHERE "listingId"=$1',
          [id],
        );
        await rejects(
          runner,
          `INSERT INTO parrot_sale_listings("sellerUserId",name,species,"requestedPrice","breederApplicationId") VALUES ($1,'Bird','Fixture',100,$2)`,
          [v.user, v.application],
        );
        await rejects(
          runner,
          'UPDATE parrot_sale_listing_creation_ledger SET "sellerUserId"=$1 WHERE "listingId"=$2',
          [randomUUID(), id],
        );
      }));

    it('keeps FK-free permanent creation history after an operational BREEDER listing is removed', async () =>
      transaction(async (runner) => {
        const v = await fixture(runner),
          p = await permissions(runner, v),
          id = await breederListing(runner, v, p.child);
        await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
        await runner.query('DELETE FROM parrot_sale_listings WHERE id=$1', [
          id,
        ]);
        const [row] = (await runner.query(
          'SELECT "submissionKind" FROM parrot_sale_listing_creation_ledger WHERE "listingId"=$1',
          [id],
        )) as Array<{ submissionKind: string }>;
        expect(row.submissionKind).toBe('BREEDER');
        expect(
          await runner.query(
            "SELECT 1 FROM pg_constraint WHERE conrelid='public.parrot_sale_listing_creation_ledger'::regclass AND contype='f'",
          ),
        ).toHaveLength(0);
      }));

    it.each(['child-first', 'parent-first'])(
      'serializes parent revocation versus child approval (%s)',
      async (order) => {
        const first = source.createQueryRunner();
        const second = source.createQueryRunner();
        await first.connect();
        await second.connect();
        try {
          await first.startTransaction();
          const v = await fixture(first);
          const p = await permissions(first, v);
          await approve(first, v.application, p.parent, false);
          await first.commitTransaction();
          await first.startTransaction();
          await second.startTransaction();
          await second.query("SET LOCAL lock_timeout='5s'");
          const [{ pid }] = await second.query<Array<{ pid: number }>>(
            'SELECT pg_backend_pid() AS pid',
          );
          const revoke = async (runner: QueryRunner) => {
            await runner.query(
              "UPDATE breeder_species_permissions SET state='REVOKED',revision=3 WHERE id=$1",
              [p.parent],
            );
            await event(
              runner,
              v.application,
              p.parent,
              false,
              3,
              'REVOKE',
              'APPROVED',
              'REVOKED',
            );
          };
          if (order === 'child-first')
            await approve(first, v.application, p.child, true);
          else await revoke(first);
          // Capture failure immediately; the second transaction must genuinely
          // block on the parent lock, not merely run after the first finishes.
          const competing = (async () => {
            try {
              if (order === 'child-first') await revoke(second);
              else await approve(second, v.application, p.child, true);
              await second.commitTransaction();
              return null;
            } catch (error) {
              return error as QueryFailedError<{ code: string }>;
            }
          })();
          let blocked = false;
          const deadline = Date.now() + 3000;
          while (!blocked && Date.now() < deadline) {
            const [row] = await source.query<Array<{ blocked: boolean }>>(
              'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',
              [pid],
            );
            blocked = row.blocked;
            if (!blocked)
              await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          await first.commitTransaction();
          const error = await competing;
          expect(error?.driverError.code).toBe('23514');
          await second.rollbackTransaction();
          const [states] = await source.query<
            Array<{ parent: string; child: string }>
          >(
            `SELECT p.state AS parent,c.state AS child FROM breeder_species_permissions p
             JOIN breeder_subspecies_permissions c ON c."speciesPermissionId"=p.id WHERE p.id=$1`,
            [p.parent],
          );
          expect(states).toEqual(
            order === 'child-first'
              ? { parent: 'APPROVED', child: 'APPROVED' }
              : { parent: 'REVOKED', child: 'REQUESTED' },
          );
        } finally {
          if (first.isTransactionActive) await first.rollbackTransaction();
          if (second.isTransactionActive) await second.rollbackTransaction();
          await first.release();
          await second.release();
        }
      },
    );

    it.each([
      'column',
      'CHECK',
      'index',
      'trigger',
      'trigger columns',
      'unexpected trigger',
      'function',
    ])('fails closed on incompatible same-name taxonomy %s', async (kind) => {
      const runner = source.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        if (kind === 'column')
          await runner.query(
            'ALTER TABLE bird_species ALTER COLUMN "displayName" TYPE varchar(99)',
          );
        if (kind === 'CHECK') {
          await runner.query(
            'ALTER TABLE bird_species DROP CONSTRAINT "CHK_bird_species_text"',
          );
          await runner.query(
            'ALTER TABLE bird_species ADD CONSTRAINT "CHK_bird_species_text" CHECK(true)',
          );
        }
        if (kind === 'index') {
          await runner.query(
            'DROP INDEX "IDX_breeder_species_application_state"',
          );
          await runner.query(
            'CREATE INDEX "IDX_breeder_species_application_state" ON breeder_species_permissions("applicationId" NULLS FIRST,state)',
          );
        }
        if (kind === 'trigger')
          await runner.query(
            'ALTER TABLE bird_species DISABLE TRIGGER "TRG_breeder_identity"',
          );
        if (kind === 'trigger columns') {
          await runner.query(
            'DROP TRIGGER "TRG_breeder_identity" ON bird_species',
          );
          await runner.query(`CREATE TRIGGER "TRG_breeder_identity" BEFORE INSERT OR UPDATE OF "displayName" OR DELETE
              ON bird_species FOR EACH ROW EXECUTE FUNCTION public.guard_breeder_identity_v1()`);
        }
        if (kind === 'unexpected trigger')
          await runner.query(`CREATE TRIGGER "TRG_breeder_event_chain" BEFORE INSERT OR UPDATE OR DELETE
              ON bird_species FOR EACH ROW EXECUTE FUNCTION public.guard_breeder_identity_v1()`);
        if (kind === 'function')
          await runner.query(
            'CREATE OR REPLACE FUNCTION public.guard_breeder_identity_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
          );
        await expect(migrate(TAXON, runner)).rejects.toThrow(
          /Incompatible|Unexpected/,
        );
      } finally {
        await runner.query('ROLLBACK');
        await runner.release();
      }
      await migrate(TAXON);
    });

    it.each(['column', 'CHECK', 'index'])(
      'fails closed on incompatible same-name listing-kind %s',
      async (kind) => {
        const runner = source.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
          if (kind === 'column')
            await runner.query(
              'ALTER TABLE parrot_sale_listings ALTER COLUMN "submissionKind" DROP NOT NULL',
            );
          if (kind === 'CHECK') {
            await runner.query(
              'ALTER TABLE parrot_sale_listings DROP CONSTRAINT "CHK_parrot_listing_kind"',
            );
            await runner.query(
              'ALTER TABLE parrot_sale_listings ADD CONSTRAINT "CHK_parrot_listing_kind" CHECK(true)',
            );
          }
          if (kind === 'index') {
            await runner.query(
              'DROP INDEX "IDX_parrot_listing_creation_kind_week"',
            );
            await runner.query(
              'CREATE INDEX "IDX_parrot_listing_creation_kind_week" ON parrot_sale_listing_creation_ledger("sellerUserId","submissionKind","createdAt" DESC NULLS LAST)',
            );
          }
          await expect(migrate(KIND, runner)).rejects.toThrow(/Incompatible/);
        } finally {
          await runner.query('ROLLBACK');
          await runner.release();
        }
        await migrate(KIND);
      },
    );

    it('runtime privileges are non-destructive and audit is insert-only, without table ownership', async () => {
      for (const table of [
        'bird_species',
        'bird_subspecies',
        'breeder_species_permissions',
        'breeder_subspecies_permissions',
        'breeder_permission_events',
      ]) {
        for (const privilege of [
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE',
          'TRUNCATE',
          'REFERENCES',
          'TRIGGER',
        ]) {
          const [row] = await source.query<Array<{ allowed: boolean }>>(
            "SELECT has_table_privilege('bayat_app',$1,$2) AS allowed",
            ['public.' + table, privilege],
          );
          expect(row.allowed).toBe(
            [
              'SELECT',
              'INSERT',
              ...(table === 'breeder_permission_events' ? [] : ['UPDATE']),
            ].includes(privilege),
          );
        }
        const [owner] = await source.query<Array<{ owned: boolean }>>(
          "SELECT pg_has_role('bayat_app',relowner,'MEMBER') AS owned FROM pg_class WHERE oid=to_regclass($1)",
          ['public.' + table],
        );
        expect(owner.owned).toBe(false);
      }
    });

    it.each(['OWNER', 'TRUNCATE', 'UPDATE'])(
      'rejects non-inherited runtime membership carrying audit-table %s authority',
      async (authority) => {
        const runner = source.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        let failure: unknown;
        try {
          // This role and ownership change exist only inside this rolled-back
          // transaction in the disposable database; never reuse an existing role.
          await runner.query(
            'CREATE ROLE breeder_foundation_test_owner NOLOGIN',
          );
          await runner.query(
            'GRANT breeder_foundation_test_owner TO bayat_app',
          );
          if (authority === 'OWNER') {
            await runner.query(
              'ALTER TABLE public.breeder_permission_events OWNER TO breeder_foundation_test_owner',
            );
          } else {
            // authority comes only from the fixed test cases above.
            await runner.query(
              `GRANT ${authority} ON public.breeder_permission_events TO breeder_foundation_test_owner`,
            );
          }
          const [membership] = (await runner.query(`SELECT
          pg_has_role('bayat_app','breeder_foundation_test_owner','MEMBER') AS member,
          pg_has_role('bayat_app','breeder_foundation_test_owner','USAGE') AS inherited,
          has_table_privilege('bayat_app','public.breeder_permission_events','DELETE') AS destructive`)) as Array<{
            member: boolean;
            inherited: boolean;
            destructive: boolean;
          }>;
          expect(membership).toEqual({
            member: true,
            inherited: false,
            destructive: false,
          });
          const sql = await readFile(
            resolve('scripts/migrations', PRIVILEGES),
            'utf8',
          );
          // Keep the migration inside this test transaction even if the unsafe
          // preflight unexpectedly accepts it; ownership must always roll back.
          try {
            await runner.query(
              sql
                .replace(/^\\set[^\r\n]*(?:\r?\n)?/, '')
                .replace(/^(?:BEGIN|COMMIT);\r?$/gm, ''),
            );
          } catch (error) {
            failure = error;
          }
        } finally {
          await runner.rollbackTransaction();
          await runner.release();
        }
        expect(failure).toBeInstanceOf(QueryFailedError);
        expect((failure as Error).message).toMatch(
          /Unexpected destructive breeder runtime privileges/,
        );
      },
    );

    it('existing ordinary create remains atomic and quota behavior is unchanged', async () => {
      const user = await source.getRepository(User).save({
        phone: '09111111111',
        firstName: 'Test',
        lastName: 'Seller',
        phoneVerifiedAt: new Date(),
        isActive: true,
      });
      await source.getRepository(SellerVerification).save({
        userId: user.id,
        firstName: 'Test',
        lastName: 'Seller',
        birthDate: '2000-01-01',
        consentAcceptedAt: new Date(),
        consentVersion: 'v1',
        status: 'APPROVED' as never,
        reviewedAt: new Date(),
        reviewedBy: 'fixture-admin',
      });
      const service = new ParrotSaleListingsService(
        source,
        source.getRepository(ParrotSaleListing),
        new SellerEligibilityPolicy(
          source.getRepository(User),
          source.getRepository(SellerVerification),
        ),
        {} as never,
        { assertValidSelection: () => Promise.resolve() } as never,
      );
      const input = {
        name: 'Fixture bird',
        species: 'Fixture',
        requestedPrice: 100,
      };
      const listing = await service.create(user.id, input);
      await service.create(user.id, input);
      expect(listing.submissionKind).toBe('ORDINARY');
      expect(
        (
          await source
            .getRepository(ParrotSaleListingCreationLedger)
            .findOneByOrFail({ listingId: listing.id })
        ).submissionKind,
      ).toBe('ORDINARY');
      await expect(service.create(user.id, input)).rejects.toMatchObject({
        status: 409,
        response: { code: 'PARROT_LISTING_WEEKLY_LIMIT_REACHED' },
      });
    });

    describe('application-level taxon APIs against PostgreSQL', () => {
      const policy = () =>
        new SellerEligibilityPolicy(
          source.getRepository(User),
          source.getRepository(SellerVerification),
        );
      const api = () => new BreederTaxonService(source, policy());
      const onboarding = (taxa = api()) =>
        new SellerOnboardingService(
          source,
          source.getRepository(SellerVerification),
          source.getRepository(BreederApplication),
          policy(),
          taxa,
        );
      const requestInput = (v: { species: string; subspecies: string }) => ({
        requestId: randomUUID(),
        selections: [{ speciesId: v.species, subspeciesIds: [v.subspecies] }],
      });
      const decision = (expectedRevision = 1) => ({
        requestId: randomUUID(),
        expectedRevision,
        reason: 'Explicit fixture decision',
      });
      async function eligible() {
        return source.transaction(async (manager) => {
          const v = await fixture(manager.queryRunner!);
          await manager.query("UPDATE users SET role='breeder' WHERE id=$1", [
            v.user,
          ]);
          await manager.query(
            `INSERT INTO seller_verifications("userId","firstName","lastName","birthDate","consentAcceptedAt","consentVersion",status,"reviewedBy","reviewedAt")
            VALUES ($1,'Test','Seller','2000-01-01',now(),'v1','APPROVED','fixture-admin',now())`,
            [v.user],
          );
          return v;
        });
      }
      async function requested(v: Awaited<ReturnType<typeof eligible>>) {
        const result = await api().request(
          v.application,
          v.user,
          requestInput(v),
        );
        const parent = result.speciesPermissions[0],
          child = parent.subspeciesPermissions[0];
        return { parent, child };
      }
      async function approved(v: Awaited<ReturnType<typeof eligible>>) {
        const p = await requested(v);
        await api().decide(
          v.application,
          p.parent.id,
          Kind.SPECIES,
          Decision.APPROVE,
          'fixture-admin',
          decision(),
        );
        await api().decide(
          v.application,
          p.child.id,
          Kind.SUBSPECIES,
          Decision.APPROVE,
          'fixture-admin',
          decision(),
        );
        return p;
      }

      // Run the real services inside a caller-owned test transaction so its
      // lifecycle lock can be held until the competing session is proven blocked.
      const connectionFor = (runner: QueryRunner) => ({
        transaction: <T>(work: (manager: EntityManager) => Promise<T>) =>
          work(runner.manager),
      });
      const listingService = (runner?: QueryRunner) =>
        new ParrotSaleListingsService(
          runner ? (connectionFor(runner) as never) : source,
          source.getRepository(ParrotSaleListing),
          policy(),
          {
            delete: () => Promise.resolve(),
            save: () => Promise.resolve(randomUUID() + '.webp'),
          } as never,
          {
            assertValidSelection: () => Promise.resolve(),
            assertValidColors: () => Promise.resolve(),
          } as never,
        );
      const breederInput = (v: { species: string; subspecies: string }) => ({
        name: 'Fixture bird',
        speciesId: v.species,
        subspeciesId: v.subspecies,
        requestedPrice: 100,
      });
      const ordinaryInput = {
        name: 'Fixture ordinary',
        species: 'Existing option',
        requestedPrice: 100,
      };
      async function pendingBreeder(v: Awaited<ReturnType<typeof eligible>>) {
        const listing = await listingService().createBreeder(
          v.user,
          breederInput(v),
        );
        await source.getRepository(ParrotSaleListingImage).insert({
          listingId: listing.id,
          storageKey: randomUUID() + '.webp',
          position: 0,
        });
        return listingService().submit(v.user, listing.id);
      }
      const approval = (runner?: QueryRunner) =>
        new ParrotSaleListingApprovalService(
          runner ? (connectionFor(runner) as never) : source,
          policy(),
          {
            read: () =>
              Promise.resolve({ buffer: Buffer.from('sanitized fixture') }),
          } as never,
          {
            publish: () =>
              Promise.resolve(['/uploads/parrot-sale-listings/fixture.webp']),
            remove: () => Promise.resolve(),
          } as never,
          new SellerListingProductPublisherService(),
        );

      describe('separate ordinary and breeder listing flows', () => {
        it('ordinary third create fails for approved breeder; dedicated flow exceeds two with exact ledger kinds', async () => {
          const v = await eligible();
          await approved(v);
          const service = listingService();
          await service.create(v.user, ordinaryInput);
          await service.create(v.user, ordinaryInput);
          await expect(
            service.create(v.user, ordinaryInput),
          ).rejects.toMatchObject({
            status: 409,
            response: { code: 'PARROT_LISTING_WEEKLY_LIMIT_REACHED' },
          });
          const birds = await Promise.all(
            Array.from({ length: 4 }, () =>
              service.createBreeder(v.user, breederInput(v)),
            ),
          );
          expect(
            birds.every(
              (l) =>
                l.species === 'Fixture species' &&
                l.subspecies === 'Fixture subspecies' &&
                l.submissionKind === ListingSubmissionKind.BREEDER,
            ),
          ).toBe(true);
          const history = await source
            .getRepository(ParrotSaleListingCreationLedger)
            .find({ where: { sellerUserId: v.user } });
          expect(
            history.filter(
              (h) => h.submissionKind === ListingSubmissionKind.ORDINARY,
            ),
          ).toHaveLength(2);
          expect(
            history.filter(
              (h) => h.submissionKind === ListingSubmissionKind.BREEDER,
            ),
          ).toHaveLength(4);
          for (const bird of birds) {
            expect(bird.breederApplicationId).toBe(v.application);
            expect(
              history.find((h) => h.listingId === bird.id)?.submissionKind,
            ).toBe('BREEDER');
          }
        });
        it('concurrent mixed creates serialize without ordinary quota leakage or missing ledger rows', async () => {
          const v = await eligible();
          await approved(v);
          const service = listingService();
          const results = await Promise.allSettled([
            ...Array.from({ length: 4 }, () =>
              service.create(v.user, ordinaryInput),
            ),
            ...Array.from({ length: 4 }, () =>
              service.createBreeder(v.user, breederInput(v)),
            ),
          ]);
          expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
            6,
          );
          for (const result of results.filter((r) => r.status === 'rejected')) {
            expect(result.reason).toMatchObject({
              status: 409,
              response: { code: 'PARROT_LISTING_WEEKLY_LIMIT_REACHED' },
            });
          }
          const listings = await source
            .getRepository(ParrotSaleListing)
            .find({ where: { sellerUserId: v.user } });
          const history = await source
            .getRepository(ParrotSaleListingCreationLedger)
            .find({ where: { sellerUserId: v.user } });
          expect(listings).toHaveLength(6);
          expect(history).toHaveLength(6);
          for (const row of listings)
            expect(
              history.find((h) => h.listingId === row.id)?.submissionKind,
            ).toBe(row.submissionKind);
        });
        it('parent approval alone and mismatched child never authorize a breeder listing', async () => {
          const v = await eligible(),
            other = await eligible(),
            p = await requested(v);
          await api().decide(
            v.application,
            p.parent.id,
            Kind.SPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          );
          await expect(
            listingService().createBreeder(v.user, breederInput(v)),
          ).rejects.toMatchObject({ status: 403 });
          await api().decide(
            v.application,
            p.child.id,
            Kind.SUBSPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          );
          await expect(
            listingService().createBreeder(v.user, {
              ...breederInput(v),
              subspeciesId: other.subspecies,
            }),
          ).rejects.toMatchObject({ status: 403 });
          expect(
            await source
              .getRepository(ParrotSaleListingCreationLedger)
              .count({ where: { sellerUserId: v.user } }),
          ).toBe(0);
        });
        it.each([
          'demoted',
          'inactive',
          'seller-revoked',
          'application-revoked',
        ] as const)(
          'denies live %s despite previous grants',
          async (change) => {
            const v = await eligible();
            await approved(v);
            if (change === 'demoted')
              await source.query(
                "UPDATE users SET role='customer' WHERE id=$1",
                [v.user],
              );
            if (change === 'inactive')
              await source.query(
                'UPDATE users SET "isActive"=false WHERE id=$1',
                [v.user],
              );
            if (change === 'seller-revoked') {
              const verification = await source
                .getRepository(SellerVerification)
                .findOneByOrFail({ userId: v.user });
              await onboarding().revokeSellerAccess(
                verification.id,
                'fixture-admin',
                { reason: 'Fixture block' },
              );
            }
            if (change === 'application-revoked')
              await onboarding().revokeBreeder(v.application, 'fixture-admin', {
                reason: 'Fixture revoke',
              });
            await expect(
              listingService().createBreeder(v.user, breederInput(v)),
            ).rejects.toMatchObject({ status: 403 });
            expect(
              await source
                .getRepository(ParrotSaleListingCreationLedger)
                .count({ where: { sellerUserId: v.user } }),
            ).toBe(0);
          },
        );
        it('stale breeder draft cannot edit, upload, remove images, submit or publish after grant revoke; delete still recovers', async () => {
          const v = await eligible(),
            p = await approved(v);
          const listing = await pendingBreeder(v);
          const draft = await listingService().createBreeder(
            v.user,
            breederInput(v),
          );
          await api().decide(
            v.application,
            p.child.id,
            Kind.SUBSPECIES,
            Decision.REVOKE,
            'fixture-admin',
            decision(2),
          );
          const service = listingService();
          await expect(
            service.update(v.user, listing.id, { name: 'Changed' }),
          ).rejects.toMatchObject({ status: 403 });
          await expect(
            service.addImage(v.user, listing.id, Buffer.from('fixture')),
          ).rejects.toMatchObject({ status: 403 });
          await expect(
            service.deleteImage(v.user, listing.id, listing.images[0].id),
          ).rejects.toMatchObject({ status: 403 });
          await expect(
            service.update(v.user, draft.id, { name: 'Changed' }),
          ).rejects.toMatchObject({ status: 403 });
          await expect(service.submit(v.user, draft.id)).rejects.toMatchObject({
            status: 403,
          });
          await expect(
            approval().approve(listing.id, 'fixture-admin', {
              publicPrice: 100,
            }),
          ).rejects.toMatchObject({ status: 403 });
          await service.delete(v.user, listing.id);
          expect(
            await source
              .getRepository(ParrotSaleListing)
              .exists({ where: { id: listing.id } }),
          ).toBe(false);
          const ledger = await source
            .getRepository(ParrotSaleListingCreationLedger)
            .findOneByOrFail({ listingId: listing.id });
          expect(ledger.submissionKind).toBe('BREEDER');
          expect(ledger.deletedAt).not.toBeNull();
          expect(ledger.cleanupCompletedAt).not.toBeNull();
        });
        it('stable-ID edits require exact grants and cannot spoof display labels or cross application linkage', async () => {
          const v = await eligible(),
            other = await eligible();
          await approved(v);
          await approved(other);
          const listing = await listingService().createBreeder(
            v.user,
            breederInput(v),
          );
          await expect(
            listingService().update(v.user, listing.id, { species: 'Spoof' }),
          ).rejects.toMatchObject({ status: 400 });
          await expect(
            listingService().update(v.user, listing.id, {
              speciesId: other.species,
              subspeciesId: other.subspecies,
            }),
          ).rejects.toMatchObject({ status: 403 });
          await expect(
            listingService().update(other.user, listing.id, { name: 'Steal' }),
          ).rejects.toMatchObject({ status: 404 });
          const updated = await listingService().update(v.user, listing.id, {
            speciesId: v.species,
            subspeciesId: v.subspecies,
            name: 'Updated',
          });
          expect(updated.species).toBe('Fixture species');
          expect(updated.breederApplicationId).toBe(v.application);
          const extra = await source.getRepository(BirdSubspecies).save({
            speciesId: v.species,
            key: randomUUID(),
            displayName: 'Another explicit fixture child',
          });
          const requestedExtra = await api().request(v.application, v.user, {
            requestId: randomUUID(),
            selections: [{ speciesId: v.species, subspeciesIds: [extra.id] }],
          });
          const newPermission =
            requestedExtra.speciesPermissions[0].subspeciesPermissions.find(
              (c) => c.subspeciesId === extra.id,
            )!;
          await api().decide(
            v.application,
            newPermission.id,
            Kind.SUBSPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          );
          const changed = await listingService().update(v.user, listing.id, {
            speciesId: v.species,
            subspeciesId: extra.id,
          });
          expect(changed.subspecies).toBe(extra.displayName);
          expect(changed.breederSubspeciesPermissionId).toBe(newPermission.id);
          await api().decide(
            v.application,
            newPermission.id,
            Kind.SUBSPECIES,
            Decision.REVOKE,
            'fixture-admin',
            decision(2),
          );
          // An allowed destination cannot be used to escape the revoked source grant.
          await expect(
            listingService().update(v.user, listing.id, {
              speciesId: v.species,
              subspeciesId: v.subspecies,
            }),
          ).rejects.toMatchObject({ status: 403 });
        });
        it('publication versus permission revocation is serialized; published product can never outlive a successful revoke', async () => {
          const v = await eligible(),
            p = await approved(v),
            listing = await pendingBreeder(v);
          const results = await Promise.allSettled([
            approval().approve(listing.id, 'fixture-admin', {
              publicPrice: 100,
            }),
            api().decide(
              v.application,
              p.child.id,
              Kind.SUBSPECIES,
              Decision.REVOKE,
              'fixture-admin',
              decision(2),
            ),
          ]);
          expect(results[1].status).toBe('fulfilled');
          const row = await source
            .getRepository(ParrotSaleListing)
            .findOneByOrFail({ id: listing.id });
          const permission = await source
            .getRepository(BreederSubspeciesPermission)
            .findOneByOrFail({ id: p.child.id });
          expect(permission.state).toBe('REVOKED');
          expect(row.publicationHeldAt).not.toBeNull();
          if (row.productId) {
            expect(
              (
                await source.query<Array<{ status: string }>>(
                  'SELECT status FROM products WHERE id=$1',
                  [row.productId],
                )
              )[0].status,
            ).toBe('draft');
          } else
            expect(results[0]).toMatchObject({
              status: 'rejected',
              reason: { status: 403 },
            });
        });

        it('canonicalizes uppercase v5 IDs on real create/update while retaining permission enforcement', async () => {
          const v = await eligible();
          const version5 = () => {
            const id = randomUUID();
            return id.slice(0, 14) + '5' + id.slice(15);
          };
          const species = await source.getRepository(BirdSpecies).save({
            id: version5(),
            key: randomUUID(),
            displayName: 'UUID fixture species',
          });
          const child = await source.getRepository(BirdSubspecies).save({
            id: version5(),
            speciesId: species.id,
            key: randomUUID(),
            displayName: 'UUID fixture child',
          });
          const response = await api().request(v.application, v.user, {
            requestId: randomUUID(),
            selections: [{ speciesId: species.id, subspeciesIds: [child.id] }],
          });
          const parentPermission = response.speciesPermissions[0];
          const childPermission = parentPermission.subspeciesPermissions[0];
          await api().decide(
            v.application,
            parentPermission.id,
            Kind.SPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          );
          await api().decide(
            v.application,
            childPermission.id,
            Kind.SUBSPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          );
          const ids = {
            speciesId: ' ' + species.id.toUpperCase() + ' ',
            subspeciesId: child.id.toUpperCase(),
          };
          const listing = await listingService().createBreeder(v.user, {
            name: 'UUID fixture',
            requestedPrice: 100,
            ...ids,
          });
          expect(listing).toMatchObject({
            speciesId: species.id,
            subspeciesId: child.id,
            breederSubspeciesPermissionId: childPermission.id,
          });
          expect(
            await listingService().update(v.user, listing.id, ids),
          ).toMatchObject({ speciesId: species.id, subspeciesId: child.id });
          await api().decide(
            v.application,
            childPermission.id,
            Kind.SUBSPECIES,
            Decision.REVOKE,
            'fixture-admin',
            decision(2),
          );
          await expect(
            listingService().createBreeder(v.user, {
              name: 'UUID fixture',
              requestedPrice: 100,
              ...ids,
            }),
          ).rejects.toMatchObject({ status: 403 });
          await expect(
            listingService().createBreeder(v.user, {
              name: 'Invalid',
              requestedPrice: 100,
              ...ids,
              speciesId: 'invalid',
            }),
          ).rejects.toMatchObject({
            status: 400,
            response: { code: 'BREEDER_TAXON_INVALID_SELECTION' },
          });
          expect(
            await source
              .getRepository(ParrotSaleListingCreationLedger)
              .count({ where: { sellerUserId: v.user } }),
          ).toBe(1);
        });

        it.each([
          ['create-first', 'commit'],
          ['revoke-first', 'commit'],
          ['create-first', 'rollback'],
          ['revoke-first', 'rollback'],
        ] as const)(
          'deterministic breeder create/revoke: %s, first transaction %s',
          async (order, finish) => {
            const v = await eligible(),
              p = await approved(v);
            const originalEvents = await source
              .getRepository(BreederPermissionEvent)
              .find({
                where: { applicationId: v.application },
                order: { id: 'ASC' },
              });
            const input = decision(2);
            const first = source.createQueryRunner(),
              second = source.createQueryRunner();
            let competing:
              | Promise<{ value?: unknown; error?: unknown }>
              | undefined;
            let created: ParrotSaleListing | undefined;
            const taxonOn = (runner: QueryRunner) =>
              new BreederTaxonService(connectionFor(runner) as never, policy());
            try {
              await first.connect();
              await second.connect();
              await first.startTransaction();
              await second.startTransaction();
              await second.query("SET LOCAL lock_timeout='5s'");
              const [{ pid: firstPid }] = await first.query<
                Array<{ pid: number }>
              >('SELECT pg_backend_pid() AS pid');
              const [{ pid: secondPid }] = await second.query<
                Array<{ pid: number }>
              >('SELECT pg_backend_pid() AS pid');
              if (order === 'create-first') {
                created = await listingService(first).createBreeder(
                  v.user,
                  breederInput(v),
                );
                await first.manager
                  .getRepository(ParrotSaleListingImage)
                  .insert({
                    listingId: created.id,
                    storageKey: randomUUID() + '.webp',
                    position: 0,
                  });
                await listingService(first).submit(v.user, created.id);
              } else {
                await taxonOn(first).decide(
                  v.application,
                  p.child.id,
                  Kind.SUBSPECIES,
                  Decision.REVOKE,
                  'fixture-admin',
                  input,
                );
              }
              const work: Promise<unknown> =
                order === 'create-first'
                  ? taxonOn(second).decide(
                      v.application,
                      p.child.id,
                      Kind.SUBSPECIES,
                      Decision.REVOKE,
                      'fixture-admin',
                      input,
                    )
                  : listingService(second).createBreeder(
                      v.user,
                      breederInput(v),
                    );
              competing = work.then(
                (value) => ({ value }),
                (error: unknown) => ({ error }),
              );
              let blocked = false;
              const deadline = Date.now() + 3000;
              while (!blocked && Date.now() < deadline) {
                const [row] = await source.query<Array<{ blocked: boolean }>>(
                  'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked',
                  [firstPid, secondPid],
                );
                blocked = row.blocked;
                if (!blocked)
                  await new Promise((resolve) => setTimeout(resolve, 10));
              }
              expect(blocked).toBe(true);
              // The uncommitted create and ledger are invisible together; pending
              // permission audit changes are likewise not visible to other sessions.
              expect(
                await source
                  .getRepository(ParrotSaleListing)
                  .count({ where: { sellerUserId: v.user } }),
              ).toBe(0);
              expect(
                await source
                  .getRepository(ParrotSaleListingCreationLedger)
                  .count({ where: { sellerUserId: v.user } }),
              ).toBe(0);
              expect(
                await source.getRepository(BreederPermissionEvent).find({
                  where: { applicationId: v.application },
                  order: { id: 'ASC' },
                }),
              ).toEqual(originalEvents);
              if (finish === 'commit') await first.commitTransaction();
              else await first.rollbackTransaction();
              const result = await competing;
              const denied = order === 'revoke-first' && finish === 'commit';
              if (denied) {
                expect(result.error).toMatchObject({
                  status: 403,
                  response: { code: 'BREEDER_LISTING_NOT_ELIGIBLE' },
                });
                await second.rollbackTransaction();
              } else {
                expect(result.error).toBeUndefined();
                await second.commitTransaction();
              }
              const revoked = order === 'create-first' || finish === 'commit';
              const survives =
                order === 'create-first'
                  ? finish === 'commit'
                  : finish === 'rollback';
              const rows = await source
                .getRepository(ParrotSaleListing)
                .find({ where: { sellerUserId: v.user } });
              const ledger = await source
                .getRepository(ParrotSaleListingCreationLedger)
                .find({ where: { sellerUserId: v.user } });
              expect(rows).toHaveLength(survives ? 1 : 0);
              expect(ledger).toHaveLength(survives ? 1 : 0);
              if (survives) {
                expect(ledger[0]).toMatchObject({
                  listingId: rows[0].id,
                  sellerUserId: v.user,
                  submissionKind: ListingSubmissionKind.BREEDER,
                  createdAt: rows[0].createdAt,
                  deletedAt: null,
                });
                expect(rows[0].productId).toBeNull();
              }
              const permission = await source
                .getRepository(BreederSubspeciesPermission)
                .findOneByOrFail({ id: p.child.id });
              expect(permission.state).toBe(revoked ? 'REVOKED' : 'APPROVED');
              expect(permission.revision).toBe(revoked ? 3 : 2);
              const finalEvents = await source
                .getRepository(BreederPermissionEvent)
                .find({
                  where: { applicationId: v.application },
                  order: { id: 'ASC' },
                });
              expect(
                finalEvents.filter((e) =>
                  originalEvents.some((original) => original.id === e.id),
                ),
              ).toEqual(originalEvents);
              expect(finalEvents).toHaveLength(
                originalEvents.length + (revoked ? 1 : 0),
              );
              if (revoked) {
                const revokeEvent = finalEvents.find(
                  (e) =>
                    !originalEvents.some((original) => original.id === e.id),
                );
                expect(revokeEvent).toMatchObject({
                  action: 'REVOKE',
                  actorType: 'ADMIN',
                  actorId: 'fixture-admin',
                  revision: 3,
                  requestId: input.requestId,
                });
                await api().decide(
                  v.application,
                  p.child.id,
                  Kind.SUBSPECIES,
                  Decision.REVOKE,
                  'fixture-admin',
                  input,
                );
                expect(
                  await source
                    .getRepository(BreederPermissionEvent)
                    .count({ where: { applicationId: v.application } }),
                ).toBe(finalEvents.length);
                await expect(
                  listingService().createBreeder(v.user, breederInput(v)),
                ).rejects.toMatchObject({ status: 403 });
                if (survives && created) {
                  // Create committed before revoke, but remained private. The
                  // later publication must recheck the now-revoked grant.
                  await expect(
                    approval().approve(created.id, 'fixture-admin', {
                      publicPrice: 100,
                    }),
                  ).rejects.toMatchObject({
                    status: 403,
                    response: { code: 'BREEDER_LISTING_NOT_ELIGIBLE' },
                  });
                  const current = await source
                    .getRepository(ParrotSaleListing)
                    .findOneByOrFail({ id: created.id });
                  expect(current.productId).toBeNull();
                  expect(current.status).toBe(
                    ParrotSaleListingStatus.PENDING_REVIEW,
                  );
                }
              }
              expect(
                await source
                  .getRepository(ParrotSaleListingCreationLedger)
                  .count({ where: { sellerUserId: v.user } }),
              ).toBe(survives ? 1 : 0);
            } finally {
              // Release the blocking transaction first, then settle any waiter,
              // rollback its uncommitted work, and release both real sessions.
              if (first.isTransactionActive) await first.rollbackTransaction();
              if (competing) await competing;
              if (second.isTransactionActive)
                await second.rollbackTransaction();
              await second.release();
              await first.release();
            }
          },
        );
        it('ledger INSERT failure rolls back listing creation atomically', async () => {
          const v = await eligible();
          await approved(v);
          await source.query(
            `CREATE FUNCTION test_fail_flow_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."sellerUserId"='${v.user}'::uuid THEN RAISE EXCEPTION 'intentional test failure'; END IF; RETURN NEW; END $$`,
          );
          await source.query(
            'CREATE TRIGGER test_fail_flow_ledger BEFORE INSERT ON parrot_sale_listing_creation_ledger FOR EACH ROW EXECUTE FUNCTION test_fail_flow_ledger()',
          );
          try {
            await expect(
              listingService().createBreeder(v.user, breederInput(v)),
            ).rejects.toBeDefined();
            expect(
              await source
                .getRepository(ParrotSaleListing)
                .count({ where: { sellerUserId: v.user } }),
            ).toBe(0);
            expect(
              await source
                .getRepository(ParrotSaleListingCreationLedger)
                .count({ where: { sellerUserId: v.user } }),
            ).toBe(0);
          } finally {
            await source.query(
              'DROP TRIGGER test_fail_flow_ledger ON parrot_sale_listing_creation_ledger',
            );
            await source.query('DROP FUNCTION test_fail_flow_ledger()');
          }
        });
      });

      describe('safe breeder revocation and unpublication', () => {
        const publicProducts = () =>
          new ProductsService(
            source.getRepository(Product),
            {} as never,
            source,
          );
        async function published(v: Awaited<ReturnType<typeof eligible>>) {
          const listing = await pendingBreeder(v);
          return (
            await approval().approve(listing.id, 'fixture-admin', {
              publicPrice: 100,
            })
          ).listing;
        }
        async function snapshot(
          table:
            | 'orders'
            | 'order_items'
            | 'product_stock_reservations'
            | 'parrot_sale_listing_images'
            | 'parrot_sale_listing_creation_ledger',
        ) {
          // Fixed test table names only; no environment/input identifiers.
          return source.query<unknown[]>(
            `SELECT * FROM "${table}" ORDER BY id`.replace(
              table === 'parrot_sale_listing_creation_ledger'
                ? 'ORDER BY id'
                : '__unused__',
              'ORDER BY "listingId"',
            ),
          );
        }
        it('hold migration first run/rerun and compatible schema are safe; mismatched column/check fail closed', async () => {
          const name = '20261022-add-breeder-listing-publication-hold-v1.sql';
          await migrate(name);
          await migrate(name);
          for (const incompatible of [
            'ALTER TABLE parrot_sale_listings ALTER COLUMN "publicationHeldAt" SET DEFAULT now()',
            'ALTER TABLE parrot_sale_listings DROP CONSTRAINT "CHK_breeder_listing_publication_hold"; ALTER TABLE parrot_sale_listings ADD CONSTRAINT "CHK_breeder_listing_publication_hold" CHECK (true)',
          ]) {
            const runner = source.createQueryRunner();
            await runner.connect();
            await runner.startTransaction();
            try {
              await runner.query(incompatible);
              const sql = await readFile(
                resolve('scripts/migrations', name),
                'utf8',
              );
              // Preserve the outer transaction: strip only transaction commands
              // for this incompatible-object preflight test, then always rollback.
              await expect(
                runner.query(
                  sql
                    .replace(/^\\set[^\r\n]*(?:\r?\n)?/, '')
                    .replace(/^BEGIN;$/m, '')
                    .replace(/^COMMIT;$/m, ''),
                ),
              ).rejects.toThrow(/Incompatible breeder publication hold/);
            } finally {
              await runner.rollbackTransaction();
              await runner.release();
            }
          }
        });
        it('atomically holds multiple listings, hides fresh public reads, preserves commercial/images/ledger, and requires explicit stock-preserving reapproval', async () => {
          const v = await eligible(),
            p = await approved(v);
          const first = await published(v),
            second = await published(v);
          await source
            .getRepository(Product)
            .update(first.productId!, { stock: 0 });
          const order = randomUUID(),
            item = randomUUID(),
            reservation = randomUUID();
          await source.query(
            'INSERT INTO orders(id,"userId","orderNumber") VALUES ($1,$2,$3)',
            [order, v.user, randomUUID()],
          );
          await source.query(
            'INSERT INTO order_items(id,"orderId","productId",quantity,price) VALUES ($1,$2,$3,1,100)',
            [item, order, second.productId],
          );
          await source.query(
            'INSERT INTO product_stock_reservations(id,"productId","userId","orderId",quantity,"idempotencyKey") VALUES ($1,$2,$3,$4,1,$5)',
            [reservation, second.productId, v.user, order, randomUUID()],
          );
          const paidOrder = randomUUID();
          await source.query(
            `INSERT INTO orders(id,"userId","orderNumber","paymentStatus","paymentDate") VALUES ($1,$2,$3,'success',now())`,
            [paidOrder, v.user, randomUUID()],
          );
          await source.query(
            `INSERT INTO product_stock_reservations("productId","userId","orderId",quantity,"idempotencyKey",status) VALUES ($1,$2,$3,1,$4,'CONSUMED')`,
            [first.productId, v.user, paidOrder, randomUUID()],
          );
          const before = await Promise.all([
            snapshot('orders'),
            snapshot('order_items'),
            snapshot('product_stock_reservations'),
            snapshot('parrot_sale_listing_images'),
            snapshot('parrot_sale_listing_creation_ledger'),
          ]);
          const productsBefore = await source.getRepository(Product).find({
            where: { id: In([first.productId!, second.productId!]) },
            order: { id: 'ASC' },
          });
          const input = decision(2);
          const result = await api().decide(
            v.application,
            p.child.id,
            Kind.SUBSPECIES,
            Decision.REVOKE,
            'fixture-admin',
            input,
          );
          expect(
            result.events?.find(
              (e) =>
                e.subspeciesPermissionId === p.child.id &&
                e.action === BreederPermissionAction.REVOKE,
            ),
          ).toMatchObject({
            affectedListingCount: 2,
            affectedProductCount: 2,
            actorId: 'fixture-admin',
            reason: input.reason,
          });
          const held = await source
            .getRepository(ParrotSaleListing)
            .find({ where: { sellerUserId: v.user } });
          expect(held.every((l) => Boolean(l.publicationHeldAt))).toBe(true);
          for (const previous of productsBefore) {
            const current = await source
              .getRepository(Product)
              .findOneByOrFail({ id: previous.id });
            expect(current.status).toBe('draft');
            expect({
              ...current,
              status: previous.status,
              updatedAt: previous.updatedAt,
            }).toEqual(previous);
            await expect(
              publicProducts().findOnePublished(previous.id),
            ).rejects.toMatchObject({ status: 404 });
          }
          const [list, search] = await Promise.all([
            publicProducts().findAllPublished({ limit: 1000 }),
            publicProducts().searchPublished({
              q: 'Fixture bird',
              limit: 1000,
            }),
          ]);
          expect(
            list.items.some(
              (row) =>
                row.id === first.productId || row.id === second.productId,
            ),
          ).toBe(false);
          expect(
            search.items.some(
              (row) =>
                row.id === first.productId || row.id === second.productId,
            ),
          ).toBe(false);
          await api().decide(
            v.application,
            p.child.id,
            Kind.SUBSPECIES,
            Decision.REVOKE,
            'fixture-admin',
            input,
          );
          expect(
            (
              await source
                .getRepository(ParrotSaleListing)
                .findOneByOrFail({ id: first.id })
            ).publicationHeldAt,
          ).toEqual(held.find((l) => l.id === first.id)!.publicationHeldAt);
          const reservations = new StockReservationsService(source);
          await expect(reservations.consume(reservation)).rejects.toMatchObject(
            { status: 409 },
          );
          const orders = new OrdersService(
            source.getRepository(Order),
            source.getRepository(OrderItem),
            {} as never,
            source,
            reservations,
          );
          await expect(
            orders.fulfillPaymentSuccess(order),
          ).rejects.toMatchObject({ status: 409 });
          await expect(
            orders.fulfillPaymentSuccess(paidOrder),
          ).resolves.toMatchObject({ paymentStatus: 'success' });
          expect(
            await Promise.all([
              snapshot('orders'),
              snapshot('order_items'),
              snapshot('product_stock_reservations'),
              snapshot('parrot_sale_listing_images'),
              snapshot('parrot_sale_listing_creation_ledger'),
            ]),
          ).toEqual(before);
          await api().decide(
            v.application,
            p.child.id,
            Kind.SUBSPECIES,
            Decision.REGRANT,
            'fixture-admin',
            decision(3),
          );
          expect(
            (
              await source
                .getRepository(Product)
                .findOneByOrFail({ id: first.productId! })
            ).status,
          ).toBe('draft');
          const reapproved = await approval().approve(
            first.id,
            'fixture-admin',
            { publicPrice: 120 },
          );
          expect(reapproved.product.stock).toBe(0);
          expect(reapproved.listing.publicationHeldAt).toBeNull();
          expect(
            (
              await source
                .getRepository(Product)
                .findOneByOrFail({ id: second.productId! })
            ).status,
          ).toBe('draft');
          // Active reservation and order were never cancelled/consumed by regrant/reapproval.
          expect(await snapshot('product_stock_reservations')).toEqual(
            before[2],
          );
        });
        it('generic image upload cannot restore a stale published seller Product after revocation', async () => {
          const v = await eligible(),
            permission = await approved(v),
            listing = await published(v);
          const stale = await source
            .getRepository(Product)
            .findOneByOrFail({ id: listing.productId! });
          const service = publicProducts();
          // Capture the real published row as an upload could before revoke commits.
          jest.spyOn(service, 'findOne').mockResolvedValue(stale);
          await api().decide(
            v.application,
            permission.child.id,
            Kind.SUBSPECIES,
            Decision.REVOKE,
            'fixture-admin',
            decision(2),
          );
          await expect(
            service.addImage(stale.id, '/uploads/late-upload.webp'),
          ).rejects.toMatchObject({ status: 400 });
          const current = await source
            .getRepository(Product)
            .findOneByOrFail({ id: stale.id });
          expect(current.status).toBe('draft');
          expect(current.images).toEqual(stale.images);
          expect(current.stock).toBe(stale.stock);
        });
        it('child-only revocation isolates approved siblings in the same application and preserves commercial history', async () => {
          const v = await eligible(),
            p = await approved(v);
          const siblingTaxon = await source.getRepository(BirdSubspecies).save({
            speciesId: v.species,
            key: randomUUID(),
            displayName: 'Same-application sibling',
          });
          const requested = await api().request(v.application, v.user, {
            requestId: randomUUID(),
            selections: [
              { speciesId: v.species, subspeciesIds: [siblingTaxon.id] },
            ],
          });
          const siblingPermission =
            requested.speciesPermissions[0].subspeciesPermissions.find(
              (child) => child.subspeciesId === siblingTaxon.id,
            )!;
          await api().decide(
            v.application,
            siblingPermission.id,
            Kind.SUBSPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          );
          const target = await published(v),
            secondTarget = await published(v);
          const sibling = await published({
            ...v,
            subspecies: siblingTaxon.id,
          });
          const ordinary = await listingService().create(v.user, {
            ...ordinaryInput,
            species: target.species,
            subspecies: target.subspecies ?? undefined,
          });
          await source.getRepository(ParrotSaleListingImage).insert({
            listingId: ordinary.id,
            storageKey: randomUUID() + '.webp',
            position: 0,
          });
          await listingService().submit(v.user, ordinary.id);
          const ordinaryPublished = (
            await approval().approve(ordinary.id, 'fixture-admin', {
              publicPrice: 100,
            })
          ).listing;
          const listingIds = [
            target.id,
            secondTarget.id,
            sibling.id,
            ordinaryPublished.id,
          ];
          const productIds = [
            target.productId!,
            secondTarget.productId!,
            sibling.productId!,
            ordinaryPublished.productId!,
          ];
          // Distinct remaining stocks make any accidental stock reset observable.
          for (const [index, productId] of productIds.entries()) {
            await source
              .getRepository(Product)
              .update(productId, { stock: index + 2 });
            const order = randomUUID();
            await source.query(
              'INSERT INTO orders(id,"userId","orderNumber") VALUES ($1,$2,$3)',
              [order, v.user, randomUUID()],
            );
            await source.query(
              'INSERT INTO order_items("orderId","productId",quantity,price) VALUES ($1,$2,1,100)',
              [order, productId],
            );
            await source.query(
              'INSERT INTO product_stock_reservations("productId","userId","orderId",quantity,"idempotencyKey") VALUES ($1,$2,$3,1,$4)',
              [productId, v.user, order, randomUUID()],
            );
          }
          const readProducts = () =>
            source
              .getRepository(Product)
              .find({ where: { id: In(productIds) }, order: { id: 'ASC' } });
          const readListings = () =>
            source
              .getRepository(ParrotSaleListing)
              .find({ where: { id: In(listingIds) }, order: { id: 'ASC' } });
          const readEvents = () =>
            source.getRepository(BreederPermissionEvent).find({
              where: { applicationId: v.application },
              order: { id: 'ASC' },
            });
          const commercial = () =>
            Promise.all([
              snapshot('orders'),
              snapshot('order_items'),
              snapshot('product_stock_reservations'),
              snapshot('parrot_sale_listing_images'),
              snapshot('parrot_sale_listing_creation_ledger'),
            ]);
          const productsBefore = await readProducts(),
            listingsBefore = await readListings();
          const eventsBefore = await readEvents(),
            commercialBefore = await commercial();
          const parentBefore = await source
            .getRepository(BreederSpeciesPermission)
            .findOneByOrFail({ id: p.parent.id });
          const siblingBefore = await source
            .getRepository(BreederSubspeciesPermission)
            .findOneByOrFail({ id: siblingPermission.id });
          expect(siblingBefore.applicationId).toBe(v.application);
          expect(siblingBefore.speciesPermissionId).toBe(parentBefore.id);
          expect(siblingBefore.state).toBe(BreederPermissionState.APPROVED);
          const input = decision(2);
          await api().decide(
            v.application,
            p.child.id,
            Kind.SUBSPECIES,
            Decision.REVOKE,
            'fixture-admin',
            input,
          );
          const held = await readListings();
          for (const before of listingsBefore) {
            const current = held.find((listing) => listing.id === before.id)!;
            if ([target.id, secondTarget.id].includes(before.id)) {
              expect(current.publicationHeldAt).toBeInstanceOf(Date);
              expect({
                ...current,
                publicationHeldAt: before.publicationHeldAt,
                updatedAt: before.updatedAt,
              }).toEqual(before);
            } else expect(current).toEqual(before);
          }
          const verifyProducts = async () => {
            for (const before of productsBefore) {
              const current = await source
                .getRepository(Product)
                .findOneByOrFail({ id: before.id });
              if (
                [target.productId, secondTarget.productId].includes(before.id)
              ) {
                expect(current.status).toBe('draft');
                expect({
                  ...current,
                  status: before.status,
                  updatedAt: before.updatedAt,
                }).toEqual(before);
              } else {
                expect(current).toEqual(before);
                await expect(
                  publicProducts().findOnePublished(current.id),
                ).resolves.toMatchObject({ id: current.id });
              }
            }
          };
          await verifyProducts();
          expect(
            await source
              .getRepository(BreederSpeciesPermission)
              .findOneByOrFail({ id: p.parent.id }),
          ).toEqual(parentBefore);
          expect(
            await source
              .getRepository(BreederSubspeciesPermission)
              .findOneByOrFail({ id: siblingPermission.id }),
          ).toEqual(siblingBefore);
          expect(
            await source
              .getRepository(BreederSubspeciesPermission)
              .findOneByOrFail({ id: p.child.id }),
          ).toMatchObject({
            state: BreederPermissionState.REVOKED,
            revision: 3,
          });
          const eventsAfter = await readEvents();
          const historicIds = new Set(eventsBefore.map((event) => event.id));
          expect(
            eventsAfter.filter((event) => historicIds.has(event.id)),
          ).toEqual(eventsBefore);
          const added = eventsAfter.filter(
            (event) => !historicIds.has(event.id),
          );
          expect(added).toHaveLength(1);
          expect(added[0]).toMatchObject({
            applicationId: v.application,
            subspeciesPermissionId: p.child.id,
            speciesPermissionId: null,
            action: BreederPermissionAction.REVOKE,
            fromState: BreederPermissionState.APPROVED,
            toState: BreederPermissionState.REVOKED,
            revision: 3,
            actorType: 'ADMIN',
            actorId: 'fixture-admin',
            reason: input.reason,
            requestId: input.requestId,
            affectedListingCount: 2,
            affectedProductCount: 2,
          });
          expect(await commercial()).toEqual(commercialBefore);
          // Same request is a replay, not another revocation/history mutation.
          await api().decide(
            v.application,
            p.child.id,
            Kind.SUBSPECIES,
            Decision.REVOKE,
            'fixture-admin',
            input,
          );
          expect(await readEvents()).toEqual(eventsAfter);
          await api().decide(
            v.application,
            p.child.id,
            Kind.SUBSPECIES,
            Decision.REGRANT,
            'fixture-admin',
            decision(3),
          );
          expect(
            await source
              .getRepository(BreederSubspeciesPermission)
              .findOneByOrFail({ id: p.child.id }),
          ).toMatchObject({
            state: BreederPermissionState.APPROVED,
            revision: 4,
          });
          expect(await readListings()).toEqual(held);
          await verifyProducts();
          expect(await commercial()).toEqual(commercialBefore);
          expect(
            await source
              .getRepository(BreederSubspeciesPermission)
              .findOneByOrFail({ id: siblingPermission.id }),
          ).toEqual(siblingBefore);
          const finalEvents = await readEvents();
          expect(
            finalEvents.filter((event) =>
              eventsAfter.some((previous) => previous.id === event.id),
            ),
          ).toEqual(eventsAfter);
          expect(finalEvents).toHaveLength(eventsBefore.length + 2);
          expect(
            finalEvents.find(
              (event) => event.action === BreederPermissionAction.REGRANT,
            ),
          ).toMatchObject({
            subspeciesPermissionId: p.child.id,
            revision: 4,
            affectedListingCount: 0,
            affectedProductCount: 0,
          });
        });
        it('parent revoke holds all its children; independent subspecies and ORDINARY rows remain untouched', async () => {
          const v = await eligible(),
            p = await approved(v);
          const extra = await source.getRepository(BirdSubspecies).save({
            speciesId: v.species,
            key: randomUUID(),
            displayName: 'Explicit extra child',
          });
          const request = await api().request(v.application, v.user, {
            requestId: randomUUID(),
            selections: [{ speciesId: v.species, subspeciesIds: [extra.id] }],
          });
          const child =
            request.speciesPermissions[0].subspeciesPermissions.find(
              (c) => c.subspeciesId === extra.id,
            )!;
          await api().decide(
            v.application,
            child.id,
            Kind.SUBSPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          );
          const one = await published(v),
            two = await published({ ...v, subspecies: extra.id });
          const other = await eligible();
          await approved(other);
          const untouched = await published(other);
          const ordinary = await listingService().create(v.user, ordinaryInput);
          const result = await api().decide(
            v.application,
            p.parent.id,
            Kind.SPECIES,
            Decision.REVOKE,
            'fixture-admin',
            decision(2),
          );
          expect(
            result.speciesPermissions[0].subspeciesPermissions.every(
              (c) => c.state === BreederPermissionState.REVOKED,
            ),
          ).toBe(true);
          expect(
            result.events?.find(
              (e) =>
                e.speciesPermissionId === p.parent.id &&
                e.action === BreederPermissionAction.REVOKE,
            ),
          ).toMatchObject({ affectedListingCount: 2, affectedProductCount: 2 });
          for (const row of [one, two])
            expect(
              (
                await source
                  .getRepository(Product)
                  .findOneByOrFail({ id: row.productId! })
              ).status,
            ).toBe('draft');
          expect(
            (
              await source
                .getRepository(Product)
                .findOneByOrFail({ id: untouched.productId! })
            ).status,
          ).toBe('published');
          expect(
            (
              await source
                .getRepository(ParrotSaleListing)
                .findOneByOrFail({ id: ordinary.id })
            ).publicationHeldAt,
          ).toBeNull();
        });

        it.each(['approve-first', 'revoke-first'] as const)(
          'serializes Admin approval versus revocation with verified DB blocking: %s',
          async (order) => {
            const v = await eligible(),
              p = await approved(v),
              listing = await pendingBreeder(v);
            const first = source.createQueryRunner(),
              second = source.createQueryRunner();
            let competing: Promise<{ error?: unknown }> | undefined;
            const revoke = (runner: QueryRunner) =>
              new BreederTaxonService(
                connectionFor(runner) as never,
                policy(),
              ).decide(
                v.application,
                p.child.id,
                Kind.SUBSPECIES,
                Decision.REVOKE,
                'fixture-admin',
                decision(2),
              );
            try {
              await first.connect();
              await second.connect();
              await first.startTransaction();
              await second.startTransaction();
              await second.query("SET LOCAL lock_timeout='5s'");
              const [{ pid: firstPid }] = await first.query<
                Array<{ pid: number }>
              >('SELECT pg_backend_pid() AS pid');
              const [{ pid: secondPid }] = await second.query<
                Array<{ pid: number }>
              >('SELECT pg_backend_pid() AS pid');
              if (order === 'approve-first')
                await approval(first).approve(listing.id, 'fixture-admin', {
                  publicPrice: 100,
                });
              else await revoke(first);
              const work: Promise<unknown> =
                order === 'approve-first'
                  ? revoke(second)
                  : approval(second).approve(listing.id, 'fixture-admin', {
                      publicPrice: 100,
                    });
              competing = work.then(
                () => ({}),
                (error: unknown) => ({ error }),
              );
              let blocked = false;
              const deadline = Date.now() + 3000;
              while (!blocked && Date.now() < deadline) {
                const [row] = await source.query<Array<{ blocked: boolean }>>(
                  'SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked',
                  [firstPid, secondPid],
                );
                blocked = row.blocked;
                if (!blocked)
                  await new Promise((resolve) => setTimeout(resolve, 10));
              }
              expect(blocked).toBe(true);
              await first.commitTransaction();
              const result = await competing;
              if (order === 'approve-first') {
                expect(result.error).toBeUndefined();
                await second.commitTransaction();
              } else {
                expect(result.error).toMatchObject({ status: 403 });
                await second.rollbackTransaction();
              }
              const current = await source
                .getRepository(ParrotSaleListing)
                .findOneByOrFail({ id: listing.id });
              expect(current.publicationHeldAt).not.toBeNull();
              expect(
                (
                  await source
                    .getRepository(BreederSubspeciesPermission)
                    .findOneByOrFail({ id: p.child.id })
                ).state,
              ).toBe('REVOKED');
              if (current.productId) {
                expect(
                  (
                    await source
                      .getRepository(Product)
                      .findOneByOrFail({ id: current.productId })
                  ).status,
                ).toBe('draft');
                await expect(
                  publicProducts().findOnePublished(current.productId),
                ).rejects.toMatchObject({ status: 404 });
              } else expect(order).toBe('revoke-first');
              expect(
                await source
                  .getRepository(ParrotSaleListingCreationLedger)
                  .count({ where: { sellerUserId: v.user } }),
              ).toBe(1);
            } finally {
              if (first.isTransactionActive) await first.rollbackTransaction();
              if (competing) await competing;
              if (second.isTransactionActive)
                await second.rollbackTransaction();
              await second.release();
              await first.release();
            }
          },
        );
        it.each(['product', 'audit'])(
          'a %s write failure rolls back holds, Products and grant/audit atomically',
          async (failure) => {
            const v = await eligible(),
              p = await approved(v);
            const listing = await published(v);
            const count = await source
              .getRepository(BreederPermissionEvent)
              .count({ where: { applicationId: v.application } });
            const table =
              failure === 'product' ? 'products' : 'breeder_permission_events';
            await source.query(
              `CREATE FUNCTION test_fail_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional hold failure'; END $$`,
            );
            await source.query(
              `CREATE TRIGGER test_fail_hold BEFORE ${failure === 'product' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION test_fail_hold()`,
            );
            try {
              await expect(
                api().decide(
                  v.application,
                  p.child.id,
                  Kind.SUBSPECIES,
                  Decision.REVOKE,
                  'fixture-admin',
                  decision(2),
                ),
              ).rejects.toThrow('intentional hold failure');
            } finally {
              await source.query(`DROP TRIGGER test_fail_hold ON ${table}`);
              await source.query('DROP FUNCTION test_fail_hold()');
            }
            expect(
              (
                await source
                  .getRepository(Product)
                  .findOneByOrFail({ id: listing.productId! })
              ).status,
            ).toBe('published');
            expect(
              (
                await source
                  .getRepository(ParrotSaleListing)
                  .findOneByOrFail({ id: listing.id })
              ).publicationHeldAt,
            ).toBeNull();
            expect(
              (
                await source
                  .getRepository(BreederSubspeciesPermission)
                  .findOneByOrFail({ id: p.child.id })
              ).state,
            ).toBe('APPROVED');
            expect(
              await source
                .getRepository(BreederPermissionEvent)
                .count({ where: { applicationId: v.application } }),
            ).toBe(count);
            await api().decide(
              v.application,
              p.child.id,
              Kind.SUBSPECIES,
              Decision.REVOKE,
              'fixture-admin',
              decision(2),
            );
          },
        );
      });
      const eventCount = (id: string) =>
        source
          .getRepository(BreederPermissionEvent)
          .count({ where: { applicationId: id } });

      it('reads stable hierarchical taxonomy, never Product-derived authorization', async () => {
        const v = await eligible(),
          tree = await api().taxonomy();
        expect(
          tree.find((s) => s.id === v.species)?.subspecies.map((c) => c.id),
        ).toContain(v.subspecies);
        expect(
          tree.some((s) => s.key === 'Historical unclassified label'),
        ).toBe(false);
        expect(Object.keys(tree[0]).sort()).toEqual([
          'displayName',
          'id',
          'key',
          'subspecies',
        ]);
      });
      it('persists structured REQUESTED projections and append-only events without changing approved application history', async () => {
        const v = await eligible(),
          before = await source
            .getRepository(BreederApplication)
            .findOneByOrFail({ id: v.application });
        const result = await api().request(
          v.application,
          v.user,
          requestInput(v),
        );
        expect(result.speciesPermissions[0]).toMatchObject({
          state: 'REQUESTED',
          revision: 1,
          effectiveApproved: false,
        });
        expect(
          result.speciesPermissions[0].subspeciesPermissions[0].state,
        ).toBe('REQUESTED');
        expect(await eventCount(v.application)).toBe(2);
        expect(
          await source
            .getRepository(BreederApplication)
            .findOneByOrFail({ id: v.application }),
        ).toEqual(before);
        const audit = await source
          .getRepository(BreederPermissionEvent)
          .find({ where: { applicationId: v.application } });
        expect(
          audit.every(
            (e) => e.actorType === 'CUSTOMER' && e.actorId === v.user,
          ),
        ).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(
          /actorId|requestHash|privateCallNote|phone/,
        );
      });
      it('rejects mismatched taxonomy and customer cross-application access before any writes', async () => {
        const a = await eligible(),
          b = await eligible();
        await expect(
          api().request(
            a.application,
            a.user,
            requestInput({ species: a.species, subspecies: b.subspecies }),
          ),
        ).rejects.toMatchObject({
          status: 400,
          response: { code: 'BREEDER_TAXON_INVALID_SELECTION' },
        });
        await expect(
          api().request(a.application, b.user, requestInput(a)),
        ).rejects.toMatchObject({ status: 404 });
        await expect(api().read(a.application, b.user)).rejects.toMatchObject({
          status: 404,
        });
        expect(await eventCount(a.application)).toBe(0);
      });
      it('adds later children without rewriting parent approval or the application', async () => {
        const v = await eligible(),
          p = await approved(v);
        const child = await source.getRepository(BirdSubspecies).save({
          speciesId: v.species,
          key: randomUUID(),
          displayName: 'Additional fixture',
        });
        const result = await api().request(
          v.application,
          v.user,
          requestInput({ species: v.species, subspecies: child.id }),
        );
        expect(result.speciesPermissions[0]).toMatchObject({
          id: p.parent.id,
          revision: 2,
          state: 'APPROVED',
        });
        expect(
          result.speciesPermissions[0].subspeciesPermissions.find(
            (c) => c.subspeciesId === child.id,
          )?.state,
        ).toBe('REQUESTED');
        expect(await eventCount(v.application)).toBe(5);
      });
      it('parent approval grants no child; child approval requires explicit approved parent', async () => {
        const v = await eligible(),
          p = await requested(v);
        await expect(
          api().decide(
            v.application,
            p.child.id,
            Kind.SUBSPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          ),
        ).rejects.toMatchObject({ status: 409 });
        const result = await api().decide(
          v.application,
          p.parent.id,
          Kind.SPECIES,
          Decision.APPROVE,
          'fixture-admin',
          decision(),
        );
        expect(result.speciesPermissions[0]).toMatchObject({
          state: 'APPROVED',
          effectiveApproved: true,
        });
        expect(
          result.speciesPermissions[0].subspeciesPermissions[0],
        ).toMatchObject({ state: 'REQUESTED', effectiveApproved: false });
      });
      it('rejects stale revisions and cross-application permission IDs', async () => {
        const v = await eligible(),
          other = await eligible(),
          p = await requested(v);
        await expect(
          api().decide(
            other.application,
            p.parent.id,
            Kind.SPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          ),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          api().decide(
            v.application,
            p.parent.id,
            Kind.SPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(2),
          ),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'BREEDER_TAXON_REVISION_CONFLICT' },
        });
        expect(await eventCount(v.application)).toBe(2);
      });
      it('serializes concurrent identical requests and rejects reusing a request ID for a changed payload', async () => {
        const v = await eligible(),
          input = requestInput(v);
        await Promise.all([
          api().request(v.application, v.user, input),
          api().request(v.application, v.user, input),
        ]);
        expect(await eventCount(v.application)).toBe(2);
        const another = await source.getRepository(BirdSubspecies).save({
          speciesId: v.species,
          key: randomUUID(),
          displayName: 'Changed fixture',
        });
        await expect(
          api().request(v.application, v.user, {
            ...input,
            selections: [{ speciesId: v.species, subspeciesIds: [another.id] }],
          }),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'BREEDER_TAXON_IDEMPOTENCY_CONFLICT' },
        });
      });
      it('approve versus reject at one revision permits exactly one mutation/audit', async () => {
        const v = await eligible(),
          p = await requested(v);
        const results = await Promise.allSettled([
          api().decide(
            v.application,
            p.parent.id,
            Kind.SPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          ),
          api().decide(
            v.application,
            p.parent.id,
            Kind.SPECIES,
            Decision.REJECT,
            'fixture-admin',
            decision(),
          ),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect(await eventCount(v.application)).toBe(3);
      });
      it('replays admin requests without duplicating revisions; changed actor/reason conflicts', async () => {
        const v = await eligible(),
          p = await requested(v),
          input = decision();
        await Promise.all([
          api().decide(
            v.application,
            p.parent.id,
            Kind.SPECIES,
            Decision.APPROVE,
            'fixture-admin',
            input,
          ),
          api().decide(
            v.application,
            p.parent.id,
            Kind.SPECIES,
            Decision.APPROVE,
            'fixture-admin',
            input,
          ),
        ]);
        expect(await eventCount(v.application)).toBe(3);
        for (const [actor, body] of [
          ['other-admin', input],
          ['fixture-admin', { ...input, reason: 'Changed' }],
        ] as const)
          await expect(
            api().decide(
              v.application,
              p.parent.id,
              Kind.SPECIES,
              Decision.APPROVE,
              actor,
              body,
            ),
          ).rejects.toMatchObject({
            status: 409,
            response: { code: 'BREEDER_TAXON_IDEMPOTENCY_CONFLICT' },
          });
      });
      it('revokes approved children atomically, and parent regrant never regrants children', async () => {
        const v = await eligible(),
          p = await approved(v),
          input = decision(2);
        const revoked = await api().decide(
          v.application,
          p.parent.id,
          Kind.SPECIES,
          Decision.REVOKE,
          'fixture-admin',
          input,
        );
        expect(revoked.speciesPermissions[0]).toMatchObject({
          state: 'REVOKED',
          revision: 3,
        });
        expect(
          revoked.speciesPermissions[0].subspeciesPermissions[0],
        ).toMatchObject({ state: 'REVOKED', revision: 3 });
        await api().decide(
          v.application,
          p.parent.id,
          Kind.SPECIES,
          Decision.REVOKE,
          'fixture-admin',
          input,
        );
        expect(await eventCount(v.application)).toBe(6);
        const regranted = await api().decide(
          v.application,
          p.parent.id,
          Kind.SPECIES,
          Decision.REGRANT,
          'fixture-admin',
          decision(3),
        );
        expect(
          regranted.speciesPermissions[0].subspeciesPermissions[0].state,
        ).toBe('REVOKED');
        const final = await api().decide(
          v.application,
          p.child.id,
          Kind.SUBSPECIES,
          Decision.REGRANT,
          'fixture-admin',
          decision(3),
        );
        expect(
          final.speciesPermissions[0].subspeciesPermissions[0],
        ).toMatchObject({
          state: 'APPROVED',
          effectiveApproved: true,
          revision: 4,
        });
      });
      it('rejects individual taxa with history and allows only explicit admin regrant', async () => {
        const v = await eligible(),
          p = await requested(v);
        await api().decide(
          v.application,
          p.parent.id,
          Kind.SPECIES,
          Decision.APPROVE,
          'fixture-admin',
          decision(),
        );
        await api().decide(
          v.application,
          p.child.id,
          Kind.SUBSPECIES,
          Decision.REJECT,
          'fixture-admin',
          decision(),
        );
        await expect(
          api().request(v.application, v.user, requestInput(v)),
        ).rejects.toMatchObject({ status: 409 });
        const result = await api().decide(
          v.application,
          p.child.id,
          Kind.SUBSPECIES,
          Decision.REGRANT,
          'fixture-admin',
          decision(2),
        );
        expect(
          result.speciesPermissions[0].subspeciesPermissions[0].state,
        ).toBe('APPROVED');
        expect(result.events?.map((e) => e.action)).toContain('REJECT');
      });
      it('parent revoke versus child approve cannot leave an approved child beneath a revoked parent', async () => {
        const v = await eligible(),
          p = await requested(v);
        await api().decide(
          v.application,
          p.parent.id,
          Kind.SPECIES,
          Decision.APPROVE,
          'fixture-admin',
          decision(),
        );
        const result = await Promise.allSettled([
          api().decide(
            v.application,
            p.parent.id,
            Kind.SPECIES,
            Decision.REVOKE,
            'fixture-admin',
            decision(2),
          ),
          api().decide(
            v.application,
            p.child.id,
            Kind.SUBSPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          ),
        ]);
        expect(result[0].status).toBe('fulfilled');
        const final = await api().read(v.application, v.user);
        expect(final.speciesPermissions[0].state).toBe('REVOKED');
        expect(
          final.speciesPermissions[0].subspeciesPermissions[0].state,
        ).not.toBe('APPROVED');
      });
      it('inactive accounts, revoked seller access and demoted DB roles cannot gain permissions', async () => {
        for (const change of ['inactive', 'seller-revoked', 'demoted']) {
          const v = await eligible(),
            p = await requested(v);
          if (change === 'inactive')
            await source.query(
              'UPDATE users SET "isActive"=false WHERE id=$1',
              [v.user],
            );
          if (change === 'demoted')
            await source.query("UPDATE users SET role='customer' WHERE id=$1", [
              v.user,
            ]);
          if (change === 'seller-revoked') {
            const verification = await source
              .getRepository(SellerVerification)
              .findOneByOrFail({ userId: v.user });
            await onboarding().revokeSellerAccess(
              verification.id,
              'fixture-admin',
              { reason: 'Fixture block' },
            );
          }
          await expect(
            api().request(v.application, v.user, requestInput(v)),
          ).rejects.toMatchObject({ status: 403 });
          await expect(
            api().decide(
              v.application,
              p.parent.id,
              Kind.SPECIES,
              Decision.APPROVE,
              'fixture-admin',
              decision(),
            ),
          ).rejects.toMatchObject({ status: 403 });
          expect((await api().read(v.application, v.user)).canRequestTaxa).toBe(
            false,
          );
          expect(await eventCount(v.application)).toBe(2);
        }
      });
      it('application revocation races serialize, retain history and immediately invalidate effective permissions', async () => {
        const v = await eligible(),
          p = await requested(v);
        await Promise.allSettled([
          onboarding().revokeBreeder(v.application, 'fixture-admin', {
            reason: 'Reverify',
            intent: ReapplicationIntent.REQUIRE_REVERIFICATION,
          }),
          api().decide(
            v.application,
            p.parent.id,
            Kind.SPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          ),
        ]);
        const final = await api().read(v.application, v.user);
        expect(final.revoked).toBe(true);
        expect(final.canRequestTaxa).toBe(false);
        expect(final.speciesPermissions[0].effectiveApproved).toBe(false);
        expect(
          (await source.getRepository(User).findOneByOrFail({ id: v.user }))
            .role,
        ).toBe('customer');
      });
      it('initial structured submission and authorized reapplication are atomic; pending/contact rules remain intact', async () => {
        const v = await eligible();
        await onboarding().revokeBreeder(v.application, 'fixture-admin', {
          reason: 'Reverify',
          intent: ReapplicationIntent.REQUIRE_REVERIFICATION,
        });
        const result = await onboarding().submitBreeder(v.user, {
          breederName: 'New application',
          city: 'City',
          experienceYears: 1,
          approximateBirdCount: 1,
          preferredContactTime: 'Morning',
          taxonRequest: requestInput(v),
        });
        expect(result.status).toBe('PENDING_CALL');
        expect(result.species).toEqual(['Fixture species']);
        const permissions = await api().read(result.id, v.user);
        expect(permissions.speciesPermissions[0].state).toBe('REQUESTED');
        await expect(
          api().decide(
            result.id,
            permissions.speciesPermissions[0].id,
            Kind.SPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          ),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          onboarding().approveBreeder(result.id, 'fixture-admin'),
        ).rejects.toMatchObject({ status: 409 });
        await expect(
          api().request(v.application, v.user, requestInput(v)),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'BREEDER_TAXON_APPLICATION_NOT_CURRENT' },
        });
      });
      it('a DB audit-write failure rolls back a permission transition and leaves retry possible', async () => {
        const v = await eligible(),
          p = await requested(v),
          input = decision();
        await source.query(
          `CREATE FUNCTION public.foundation_fixture_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture failure' USING ERRCODE='23514'; END $$`,
        );
        await source.query(
          `CREATE TRIGGER foundation_fixture_fail_audit BEFORE INSERT ON breeder_permission_events FOR EACH ROW EXECUTE FUNCTION public.foundation_fixture_fail_audit()`,
        );
        try {
          await expect(
            api().decide(
              v.application,
              p.parent.id,
              Kind.SPECIES,
              Decision.APPROVE,
              'fixture-admin',
              input,
            ),
          ).rejects.toMatchObject({ status: 409 });
          expect(
            (await api().read(v.application, v.user)).speciesPermissions[0],
          ).toMatchObject({ state: 'REQUESTED', revision: 1 });
          expect(await eventCount(v.application)).toBe(2);
        } finally {
          await source.query(
            'DROP TRIGGER foundation_fixture_fail_audit ON breeder_permission_events',
          );
          await source.query(
            'DROP FUNCTION public.foundation_fixture_fail_audit()',
          );
        }
        await api().decide(
          v.application,
          p.parent.id,
          Kind.SPECIES,
          Decision.APPROVE,
          'fixture-admin',
          input,
        );
        expect(await eventCount(v.application)).toBe(3);
      });
      it('revokes with atomic Product unpublication while preserving images and commercial references', async () => {
        const v = await eligible(),
          p = await approved(v);
        const listing = await source.transaction((manager) =>
          breederListing(manager.queryRunner!, v, p.child.id),
        );
        const product = randomUUID();
        await source.query(
          `INSERT INTO products(id,name,status,stock,images,"isSellerListing") VALUES ($1,'Published fixture','published',3,ARRAY['/uploads/preserved.webp'],true)`,
          [product],
        );
        await source.query(
          'INSERT INTO foundation_order_items VALUES ($1,$2,1)',
          [randomUUID(), product],
        );
        await source.query(
          `UPDATE parrot_sale_listings SET status='APPROVED',"productId"=$1,"approvedPrice"=100,"reviewedBy"='fixture-admin',"reviewedAt"=now() WHERE id=$2`,
          [product, listing],
        );
        const revoked = await api().decide(
          v.application,
          p.parent.id,
          Kind.SPECIES,
          Decision.REVOKE,
          'fixture-admin',
          decision(2),
        );
        expect(revoked.speciesPermissions[0].state).toBe('REVOKED');
        expect(
          revoked.events?.find(
            (e) =>
              e.speciesPermissionId === p.parent.id &&
              e.action === BreederPermissionAction.REVOKE,
          ),
        ).toMatchObject({
          affectedListingCount: 1,
          affectedProductCount: 1,
        });
        const [stored] = await source.query<
          Array<{ status: string; stock: number; images: string[] }>
        >('SELECT status,stock,images FROM products WHERE id=$1', [product]);
        expect(stored).toEqual({
          status: 'draft',
          stock: 3,
          images: ['/uploads/preserved.webp'],
        });
        expect(
          await source.query(
            'SELECT 1 FROM foundation_order_items WHERE "productId"=$1',
            [product],
          ),
        ).toHaveLength(1);
        expect(await eventCount(v.application)).toBe(6);
      });
      it('permission revocation does not affect ordinary Products, listing rows or weekly ledger history', async () => {
        const v = await eligible(),
          p = await approved(v),
          product = randomUUID();
        await source.query(
          `INSERT INTO products(id,name,status,stock,images,"isSellerListing") VALUES ($1,'Ordinary fixture','published',2,ARRAY['/uploads/ordinary.webp'],true)`,
          [product],
        );
        const listingId = randomUUID();
        await source.transaction(async (manager) => {
          await manager.query(
            `INSERT INTO parrot_sale_listings(id,"sellerUserId",name,species,"requestedPrice","approvedPrice",status,"reviewedBy","reviewedAt","productId")
            VALUES ($1,$2,'Ordinary fixture','Legacy label',100,100,'APPROVED','fixture-admin',now(),$3)`,
            [listingId, v.user, product],
          );
          await manager.query(
            `INSERT INTO parrot_sale_listing_creation_ledger("listingId","sellerUserId","createdAt") SELECT id,"sellerUserId","createdAt" FROM parrot_sale_listings WHERE id=$1`,
            [listingId],
          );
        });
        const ledger = await source
          .getRepository(ParrotSaleListingCreationLedger)
          .findOneByOrFail({ listingId });
        await api().decide(
          v.application,
          p.parent.id,
          Kind.SPECIES,
          Decision.REVOKE,
          'fixture-admin',
          decision(2),
        );
        expect(
          await source
            .getRepository(ParrotSaleListingCreationLedger)
            .findOneByOrFail({ listingId }),
        ).toEqual(ledger);
        const [stored] = await source.query<
          Array<{ status: string; stock: number; images: string[] }>
        >('SELECT status,stock,images FROM products WHERE id=$1', [product]);
        expect(stored).toEqual({
          status: 'published',
          stock: 2,
          images: ['/uploads/ordinary.webp'],
        });
        expect(
          await source
            .getRepository(ParrotSaleListing)
            .countBy({ id: listingId }),
        ).toBe(1);
      });
      it('initial application plus all projections/audit roll back on a database write failure, and retry succeeds', async () => {
        const v = await eligible();
        await onboarding().revokeBreeder(v.application, 'fixture-admin', {
          reason: 'Reverify',
          intent: ReapplicationIntent.REQUIRE_REVERIFICATION,
        });
        const input = {
          breederName: 'New application',
          city: 'City',
          experienceYears: 1,
          approximateBirdCount: 1,
          preferredContactTime: 'Morning',
          taxonRequest: requestInput(v),
        };
        await source.query(
          `CREATE FUNCTION public.foundation_fixture_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture failure' USING ERRCODE='23514'; END $$`,
        );
        await source.query(
          'CREATE TRIGGER foundation_fixture_fail_audit BEFORE INSERT ON breeder_permission_events FOR EACH ROW EXECUTE FUNCTION public.foundation_fixture_fail_audit()',
        );
        try {
          await expect(
            onboarding().submitBreeder(v.user, input),
          ).rejects.toMatchObject({
            status: 409,
            response: { code: 'BREEDER_TAXON_INVALID_TRANSITION' },
          });
          expect(
            await source
              .getRepository(BreederApplication)
              .countBy({ userId: v.user }),
          ).toBe(1);
          expect(
            await source
              .getRepository(BreederSpeciesPermission)
              .countBy({ applicationId: v.application }),
          ).toBe(0);
          expect(await eventCount(v.application)).toBe(0);
        } finally {
          await source.query(
            'DROP TRIGGER foundation_fixture_fail_audit ON breeder_permission_events',
          );
          await source.query(
            'DROP FUNCTION public.foundation_fixture_fail_audit()',
          );
        }
        const saved = await onboarding().submitBreeder(v.user, input);
        expect(await eventCount(saved.id)).toBe(2);
        expect(
          (await api().read(saved.id, v.user)).speciesPermissions[0].state,
        ).toBe('REQUESTED');
      });
      it('runs requests, hierarchical approvals and revocation with the non-owner runtime role', async () => {
        const v = await eligible();
        // Existing onboarding/Product privileges are fixture prerequisites;
        // foundation privileges come exclusively from its committed migration.
        await source.query(
          'GRANT SELECT, UPDATE ON users, breeder_applications, seller_verifications TO bayat_app',
        );
        await source.query(
          'GRANT SELECT ON parrot_sale_listings, products TO bayat_app',
        );
        const runtime = new DataSource({
          type: 'postgres',
          url: process.env.PARROT_LISTING_TEST_DATABASE_URL!,
          entities: source.entityMetadatas.map((metadata) => metadata.target),
          synchronize: false,
          logging: false,
          extra: { max: 2, options: '-c role=bayat_app' },
        });
        try {
          await runtime.initialize();
          await assertIdentity(runtime, DATABASE);
          const [role] = await runtime.query<Array<{ current_user: string }>>(
            'SELECT current_user',
          );
          expect(role.current_user).toBe('bayat_app');
          const service = new BreederTaxonService(
            runtime,
            new SellerEligibilityPolicy(
              runtime.getRepository(User),
              runtime.getRepository(SellerVerification),
            ),
          );
          const requested = await service.request(
            v.application,
            v.user,
            requestInput(v),
          );
          const parent = requested.speciesPermissions[0],
            child = parent.subspeciesPermissions[0];
          await service.decide(
            v.application,
            parent.id,
            Kind.SPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          );
          await service.decide(
            v.application,
            child.id,
            Kind.SUBSPECIES,
            Decision.APPROVE,
            'fixture-admin',
            decision(),
          );
          const pending = await pendingBreeder(v);
          const publication = await approval().approve(
            pending.id,
            'fixture-admin',
            { publicPrice: 100 },
          );
          const result = await service.decide(
            v.application,
            parent.id,
            Kind.SPECIES,
            Decision.REVOKE,
            'fixture-admin',
            decision(2),
          );
          expect(
            result.speciesPermissions[0].subspeciesPermissions[0].state,
          ).toBe('REVOKED');
          expect(
            (
              await source
                .getRepository(Product)
                .findOneByOrFail({ id: publication.product.id })
            ).status,
          ).toBe('draft');
          expect(
            (
              await source
                .getRepository(ParrotSaleListing)
                .findOneByOrFail({ id: pending.id })
            ).publicationHeldAt,
          ).not.toBeNull();
          expect(await eventCount(v.application)).toBe(6);
        } finally {
          if (runtime.isInitialized) await runtime.destroy();
        }
      });
      it('production whitelisting cannot forge ownership, actor, revisions or grants in real permission/audit rows', async () => {
        const v = await eligible();
        const pipe = new ValidationPipe({
          transform: true,
          whitelist: true,
          validationError: { target: false, value: false },
        });
        const clean = requestInput(v);
        const input = (await pipe.transform(
          {
            ...clean,
            actorId: 'forged',
            userId: randomUUID(),
            applicationId: randomUUID(),
            state: 'APPROVED',
            selections: clean.selections.map((s) => ({
              ...s,
              state: 'APPROVED',
              revision: 500,
              actorId: 'forged',
            })),
          },
          { type: 'body', metatype: RequestBreederTaxaDto },
        )) as RequestBreederTaxaDto;
        expect(input).toEqual(clean);
        const result = await api().request(v.application, v.user, input);
        const parent = result.speciesPermissions[0];
        expect(parent).toMatchObject({ state: 'REQUESTED', revision: 1 });
        expect(parent.subspeciesPermissions[0]).toMatchObject({
          state: 'REQUESTED',
          revision: 1,
        });
        const before = await source
          .getRepository(BreederPermissionEvent)
          .find({ where: { applicationId: v.application } });
        expect(before).toHaveLength(2);
        expect(
          before.every(
            (e) => e.actorType === 'CUSTOMER' && e.actorId === v.user,
          ),
        ).toBe(true);
        const cleanDecision = decision();
        const adminInput = (await pipe.transform(
          {
            ...cleanDecision,
            actorId: 'forged',
            username: 'forged',
            state: 'APPROVED',
            revision: 500,
            action: 'approve',
            applicationId: randomUUID(),
          },
          { type: 'body', metatype: DecideBreederPermissionDto },
        )) as DecideBreederPermissionDto;
        expect(adminInput).toEqual(cleanDecision);
        const rejected = await api().decide(
          v.application,
          parent.id,
          Kind.SPECIES,
          Decision.REJECT,
          'review-fixture',
          adminInput,
        );
        expect(rejected.speciesPermissions[0]).toMatchObject({
          state: 'REJECTED',
          revision: 2,
        });
        expect(
          rejected.speciesPermissions[0].subspeciesPermissions[0].state,
        ).toBe('REQUESTED');
        const after = await source.getRepository(BreederPermissionEvent).find({
          where: {
            applicationId: v.application,
            action: BreederPermissionAction.REJECT,
          },
        });
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({
          actorType: 'ADMIN',
          actorId: 'review-fixture',
          action: 'REJECT',
          revision: 2,
        });
      });
    });
  },
);
