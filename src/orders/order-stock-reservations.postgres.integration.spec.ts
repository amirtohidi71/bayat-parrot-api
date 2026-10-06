import { ConflictException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { VET_TEST_ENTITIES } from '../../test/vet-test-entities';
import { ProductStatus } from '../products/entities/product.entity';
import {
  ProductStockReservation,
  ProductStockReservationStatus,
} from '../stock-reservations/entities/product-stock-reservation.entity';
import { StockReservationsService } from '../stock-reservations/stock-reservations.service';
import { Order, PaymentStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import {
  ORDER_RESERVATION_EXPIRED_ERROR_CODE,
  OrdersService,
} from './orders.service';

const DATABASE_NAME = 'seller_onboarding_disposable_test';
const enabled =
  process.env.STOCK_RESERVATION_RUN_DB_TESTS === '1' &&
  process.env.STOCK_RESERVATION_TEST_DATABASE_CONFIRM === 'DISPOSABLE' &&
  Boolean(process.env.STOCK_RESERVATION_TEST_DATABASE_URL?.trim());
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase('Order stock reservation real PostgreSQL integration', () => {
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
      entities: [
        ...VET_TEST_ENTITIES,
        Order,
        OrderItem,
        ProductStockReservation,
      ],
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
            'Disposable order reservation database cleanup failed',
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

  it('rolls back the order and reservation together when reservation persistence fails', async () => {
    const userId = await insertUser('09111111111');
    const productId = await insertProduct(true, 1, 'seller');
    await source.query(`CREATE FUNCTION public.test_fail_reservation_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'intentional reservation failure';
      END $$`);
    await source.query(`CREATE TRIGGER test_fail_reservation_insert
      BEFORE INSERT ON public.product_stock_reservations
      FOR EACH ROW EXECUTE FUNCTION public.test_fail_reservation_insert()`);
    await expect(createOrder(userId, [productId])).rejects.toThrow(
      'intentional reservation failure',
    );
    expect(await source.getRepository(Order).count()).toBe(0);
    expect(await source.getRepository(OrderItem).count()).toBe(0);
    expect(await source.getRepository(ProductStockReservation).count()).toBe(0);
    expect(await storedStock(productId)).toBe(1);
  });

  it('keeps mixed-cart line order, decrements regular stock and reserves seller stock', async () => {
    const userId = await insertUser('09111111111');
    const sellerId = await insertProduct(true, 1, 'seller');
    const regularId = await insertProduct(false, 3, 'regular');
    const order = await createOrder(userId, [sellerId, regularId], [1, 2]);
    expect(order.items.map((item) => item.productId)).toEqual([
      sellerId,
      regularId,
    ]);
    expect(await storedStock(sellerId)).toBe(1);
    expect(await storedStock(regularId)).toBe(1);
    const reservation = await source
      .getRepository(ProductStockReservation)
      .findOneByOrFail({ orderId: order.id });
    expect(reservation).toMatchObject({
      productId: sellerId,
      quantity: 1,
      status: ProductStockReservationStatus.ACTIVE,
      idempotencyKey: `order:${order.id}`,
    });
  });

  it('makes an expired seller reservation non-payable without decrementing stock', async () => {
    const userId = await insertUser('09111111111');
    const productId = await insertProduct(true, 1, 'seller');
    const order = await createOrder(userId, [productId]);
    await source.query(
      `UPDATE public.product_stock_reservations
          SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE "orderId" = $1`,
      [order.id],
    );
    try {
      await ordersService().fulfillPaymentSuccess(order.id);
      throw new Error('Expected payment fulfillment to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: ORDER_RESERVATION_EXPIRED_ERROR_CODE,
      });
    }
    expect(await storedStock(productId)).toBe(1);
    expect(
      (
        await source
          .getRepository(ProductStockReservation)
          .findOneByOrFail({ orderId: order.id })
      ).status,
    ).toBe(ProductStockReservationStatus.EXPIRED);
    expect(
      (await source.getRepository(Order).findOneByOrFail({ id: order.id }))
        .paymentStatus,
    ).toBe(PaymentStatus.PENDING);
  });

  it('releases active reservations when payment fails', async () => {
    const userId = await insertUser('09111111111');
    const productId = await insertProduct(true, 1, 'seller');
    const order = await createOrder(userId, [productId]);
    await expect(
      ordersService().markPaymentFailed(order.id),
    ).resolves.toMatchObject({
      paymentStatus: PaymentStatus.FAILED,
    });
    expect(
      (
        await source
          .getRepository(ProductStockReservation)
          .findOneByOrFail({ orderId: order.id })
      ).status,
    ).toBe(ProductStockReservationStatus.RELEASED);
    expect(await storedStock(productId)).toBe(1);
  });

  it('allows only one concurrent order reservation for the final unit', async () => {
    const firstUser = await insertUser('09111111111');
    const secondUser = await insertUser('09222222222');
    const productId = await insertProduct(true, 1, 'seller');
    const results = await Promise.allSettled([
      createOrder(firstUser, [productId]),
      createOrder(secondUser, [productId]),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(await source.getRepository(Order).count()).toBe(1);
    expect(await source.getRepository(ProductStockReservation).count()).toBe(1);
    expect(await storedStock(productId)).toBe(1);
  });

  it('consumes payment-success stock exactly once under concurrent callbacks', async () => {
    const userId = await insertUser('09111111111');
    const productId = await insertProduct(true, 1, 'seller');
    const order = await createOrder(userId, [productId]);
    const results = await Promise.all([
      ordersService().fulfillPaymentSuccess(order.id),
      ordersService().fulfillPaymentSuccess(order.id),
    ]);
    expect(results).toHaveLength(2);
    expect(
      results.every((value) => value.paymentStatus === PaymentStatus.SUCCESS),
    ).toBe(true);
    expect(await storedStock(productId)).toBe(0);
    expect(
      (
        await source
          .getRepository(ProductStockReservation)
          .findOneByOrFail({ orderId: order.id })
      ).status,
    ).toBe(ProductStockReservationStatus.CONSUMED);
  });

  function ordersService(): OrdersService {
    return new OrdersService(
      source.getRepository(Order),
      source.getRepository(OrderItem),
      { sendText: jest.fn().mockResolvedValue(undefined) } as never,
      source,
      new StockReservationsService(source),
    );
  }

  async function createOrder(
    userId: string,
    productIds: string[],
    quantities = productIds.map(() => 1),
  ): Promise<Order> {
    return ordersService().create(userId, '09120000000', {
      items: productIds.map((productId, index) => ({
        productId,
        quantity: quantities[index],
      })),
      address: 'Address',
      postalCode: '1234567890',
    });
  }

  async function resetFoundation(): Promise<void> {
    await assertLoopbackServer(source, DATABASE_NAME);
    await source.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await source.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await source.query(`CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
      phone varchar NOT NULL UNIQUE
    )`);
    await source.query(`CREATE TABLE public.products (
      id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
      sku varchar UNIQUE,
      name varchar NOT NULL,
      price numeric(15,2) NOT NULL,
      "discountPrice" numeric(15,2),
      stock integer NOT NULL DEFAULT 0,
      "colorVariants" jsonb,
      status varchar NOT NULL,
      "isSellerListing" boolean NOT NULL DEFAULT false,
      "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "deletedAt" timestamptz
    )`);
    await source.query(`CREATE TABLE public.orders (
      id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
      "userId" uuid NOT NULL REFERENCES public.users(id),
      status varchar NOT NULL DEFAULT 'pending',
      total numeric(10,2) NOT NULL DEFAULT 0,
      address varchar,
      "recipientName" varchar,
      "recipientMobile" varchar,
      "postalCode" varchar,
      "paymentStatus" varchar NOT NULL DEFAULT 'pending',
      "paymentDate" timestamptz,
      "orderNumber" varchar UNIQUE,
      "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await source.query(`CREATE TABLE public.order_items (
      id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
      "orderId" uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
      "productId" uuid NOT NULL REFERENCES public.products(id),
      "colorCode" varchar,
      "colorName" varchar,
      quantity integer NOT NULL,
      price numeric(15,2) NOT NULL
    )`);
  }

  async function insertUser(phone: string): Promise<string> {
    const [row] = await source.query<Array<{ id: string }>>(
      'INSERT INTO public.users (phone) VALUES ($1) RETURNING id',
      [phone],
    );
    return row.id;
  }

  async function insertProduct(
    sellerListing: boolean,
    stock: number,
    suffix: string,
  ): Promise<string> {
    const [row] = await source.query<Array<{ id: string }>>(
      `INSERT INTO public.products
         (sku, name, price, stock, status, "isSellerListing")
       VALUES ($1, $2, 100, $3, $4, $5) RETURNING id`,
      [
        `SKU-${suffix}`,
        `Product ${suffix}`,
        stock,
        ProductStatus.PUBLISHED,
        sellerListing,
      ],
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
      'Order reservation tests require a loopback PostgreSQL host',
    );
  if (url.pathname.slice(1) !== DATABASE_NAME || url.search || url.hash)
    throw new Error('Exact disposable order reservation database URL required');
  return url;
}

function stripPsqlDirective(sql: string): string {
  return sql.replace(/^\\set[^\r\n]*(?:\r?\n)?/, '');
}
