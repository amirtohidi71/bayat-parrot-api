import { HttpException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { VET_TEST_ENTITIES } from '../../test/vet-test-entities';
import { ProductStatus } from '../products/entities/product.entity';
import {
  ProductStockReservation,
  ProductStockReservationStatus,
} from './entities/product-stock-reservation.entity';
import { StockReservationErrorCode } from './stock-reservation.errors';
import { StockReservationsService } from './stock-reservations.service';

const DATABASE_NAME = 'seller_onboarding_disposable_test';
const enabled =
  process.env.STOCK_RESERVATION_RUN_DB_TESTS === '1' &&
  process.env.STOCK_RESERVATION_TEST_DATABASE_CONFIRM === 'DISPOSABLE' &&
  Boolean(process.env.STOCK_RESERVATION_TEST_DATABASE_URL?.trim());
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase('Stock reservation real PostgreSQL integration', () => {
  let administrator: DataSource;
  let source: DataSource;
  let migration: string;
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
      'DROP DATABASE IF EXISTS "seller_onboarding_disposable_test"',
    );
    await administrator.query(
      'CREATE DATABASE "seller_onboarding_disposable_test"',
    );
    databaseCreated = true;

    source = new DataSource({
      type: 'postgres',
      url: target.toString(),
      entities: [...VET_TEST_ENTITIES, ProductStockReservation],
      synchronize: false,
      logging: false,
      extra: { max: 12 },
    });
    await source.initialize();
    await assertLoopbackServer(source, DATABASE_NAME);
    migration = stripPsqlDirective(
      await readFile(
        resolve(
          process.cwd(),
          'scripts/migrations/20261004-create-product-stock-reservations-v1.sql',
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
          'DROP DATABASE IF EXISTS "seller_onboarding_disposable_test"',
        );
        const [remaining] = await administrator.query<
          Array<{ exists: boolean }>
        >('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)', [
          DATABASE_NAME,
        ]);
        if (remaining.exists)
          cleanupError = new Error(
            'Disposable stock reservation database cleanup failed',
          );
      }
    } finally {
      if (administrator?.isInitialized) await administrator.destroy();
    }
    if (cleanupError) throw cleanupError;
  }, 60_000);

  beforeEach(async () => {
    await resetFoundation();
    await executeMigration(migration);
  });

  it('prevents concurrent reservations from over-reserving one unit', async () => {
    const productId = await insertProduct(1);
    const firstUser = await insertUser('09111111111');
    const secondUser = await insertUser('09222222222');
    const results = await Promise.allSettled([
      service().reserve(firstUser, 'first', [{ productId, quantity: 1 }]),
      service().reserve(secondUser, 'second', [{ productId, quantity: 1 }]),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expectStableError(
      rejected?.reason,
      StockReservationErrorCode.INSUFFICIENT_AVAILABILITY,
    );
    expect(await activeCount(productId)).toBe(1);
    expect(await storedStock(productId)).toBe(1);
  });

  it('returns one reservation for concurrent retries with the same idempotency key', async () => {
    const productId = await insertProduct(2);
    const userId = await insertUser('09111111111');
    const results = await Promise.all([
      service().reserve(userId, 'same-key', [{ productId, quantity: 1 }]),
      service().reserve(userId, 'same-key', [{ productId, quantity: 1 }]),
    ]);
    expect(results[0][0].id).toBe(results[1][0].id);
    expect(await source.getRepository(ProductStockReservation).count()).toBe(1);
    const lifetime =
      results[0][0].expiresAt.getTime() - results[0][0].createdAt.getTime();
    expect(lifetime).toBeGreaterThanOrEqual(14 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(16 * 60_000);
  });

  it('serializes conflicting payloads that reuse one user idempotency key', async () => {
    const firstProductId = await insertProduct(1);
    const secondProductId = await insertProduct(1);
    const userId = await insertUser('09111111111');
    const results = await Promise.allSettled([
      service().reserve(userId, 'conflict-key', [
        { productId: firstProductId, quantity: 1 },
      ]),
      service().reserve(userId, 'conflict-key', [
        { productId: secondProductId, quantity: 1 },
      ]),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expectStableError(
      rejected?.reason,
      StockReservationErrorCode.IDEMPOTENCY_CONFLICT,
    );
    expect(await source.getRepository(ProductStockReservation).count()).toBe(1);
  });

  it('serializes expiry against consume without decrementing expired stock', async () => {
    const productId = await insertProduct(1);
    const userId = await insertUser('09111111111');
    const [reservation] = await service().reserve(userId, 'expiry', [
      { productId, quantity: 1 },
    ]);
    await source.query(
      `UPDATE public.product_stock_reservations
          SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE id = $1`,
      [reservation.id],
    );
    await Promise.allSettled([
      service().consume(reservation.id),
      service().expireBatch(10),
    ]);
    const stored = await source
      .getRepository(ProductStockReservation)
      .findOneByOrFail({ id: reservation.id });
    expect(stored.status).toBe(ProductStockReservationStatus.EXPIRED);
    expect(await storedStock(productId)).toBe(1);
  });

  it('consumes exactly once under concurrent calls', async () => {
    const productId = await insertProduct(2);
    const userId = await insertUser('09111111111');
    const [reservation] = await service().reserve(userId, 'consume', [
      { productId, quantity: 1 },
    ]);
    const results = await Promise.allSettled([
      service().consume(reservation.id),
      service().consume(reservation.id),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expectStableError(
      rejected?.reason,
      StockReservationErrorCode.INVALID_STATE,
    );
    expect(await storedStock(productId)).toBe(1);
    expect(
      (
        await source
          .getRepository(ProductStockReservation)
          .findOneByOrFail({ id: reservation.id })
      ).status,
    ).toBe(ProductStockReservationStatus.CONSUMED);
  });

  it('releases active stock without decrementing and never consumes it later', async () => {
    const productId = await insertProduct(1);
    const userId = await insertUser('09111111111');
    const [reservation] = await service().reserve(userId, 'release', [
      { productId, quantity: 1 },
    ]);
    await expect(
      service().release(reservation.id, userId),
    ).resolves.toMatchObject({
      status: ProductStockReservationStatus.RELEASED,
    });
    await expect(service().consume(reservation.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(await storedStock(productId)).toBe(1);
  });

  function service(): StockReservationsService {
    return new StockReservationsService(source);
  }

  async function resetFoundation(): Promise<void> {
    await assertLoopbackServer(source, DATABASE_NAME);
    await source.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await source.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await source.query(`CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
      phone varchar NOT NULL UNIQUE
    )`);
    await source.query(`CREATE TABLE public.orders (
      id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4()
    )`);
    await source.query(`CREATE TABLE public.products (
      id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
      stock integer NOT NULL DEFAULT 0,
      status varchar NOT NULL,
      "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "deletedAt" timestamptz
    )`);
  }

  async function insertUser(phone: string): Promise<string> {
    const [row] = await source.query<Array<{ id: string }>>(
      'INSERT INTO public.users (phone) VALUES ($1) RETURNING id',
      [phone],
    );
    return row.id;
  }

  async function insertProduct(stock: number): Promise<string> {
    const [row] = await source.query<Array<{ id: string }>>(
      'INSERT INTO public.products (stock, status) VALUES ($1, $2) RETURNING id',
      [stock, ProductStatus.PUBLISHED],
    );
    return row.id;
  }

  async function storedStock(productId: string): Promise<number> {
    const [row] = await source.query<Array<{ stock: number }>>(
      'SELECT stock FROM public.products WHERE id = $1',
      [productId],
    );
    return row.stock;
  }

  async function activeCount(productId: string): Promise<number> {
    const [row] = await source.query<Array<{ count: string }>>(
      `SELECT count(*) FROM public.product_stock_reservations
        WHERE "productId" = $1 AND status = 'ACTIVE'
          AND "expiresAt" > CURRENT_TIMESTAMP`,
      [productId],
    );
    return Number(row.count);
  }

  async function executeMigration(sql: string): Promise<void> {
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

  function expectStableError(error: unknown, code: string): void {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(409);
    expect((error as HttpException).getResponse()).toMatchObject({ code });
  }

  async function assertLoopbackServer(
    connection: DataSource,
    database: string,
  ): Promise<void> {
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

  async function terminateTargetConnections(): Promise<void> {
    await administrator.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DATABASE_NAME],
    );
  }
});

function requireDisposableConfiguration(): URL {
  if (process.env.STOCK_RESERVATION_RUN_DB_TESTS !== '1')
    throw new Error('STOCK_RESERVATION_RUN_DB_TESTS must equal 1');
  if (process.env.STOCK_RESERVATION_TEST_DATABASE_CONFIRM !== 'DISPOSABLE')
    throw new Error(
      'STOCK_RESERVATION_TEST_DATABASE_CONFIRM must equal DISPOSABLE',
    );
  const raw = process.env.STOCK_RESERVATION_TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('STOCK_RESERVATION_TEST_DATABASE_URL is required');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('PostgreSQL URL required');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error(
      'Stock reservation tests require a loopback PostgreSQL host',
    );
  if (url.pathname.slice(1) !== DATABASE_NAME || url.search || url.hash)
    throw new Error('Exact disposable stock reservation database URL required');
  return url;
}

function stripPsqlDirective(sql: string): string {
  return sql.replace(/^\\set[^\r\n]*(?:\r?\n)?/, '');
}
