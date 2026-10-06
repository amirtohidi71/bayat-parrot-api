import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProductStatus } from '../products/entities/product.entity';
import {
  ProductStockReservation,
  ProductStockReservationStatus,
} from './entities/product-stock-reservation.entity';
import { StockReservationErrorCode } from './stock-reservation.errors';
import { StockReservationsService } from './stock-reservations.service';

describe('StockReservationsService', () => {
  const productQuery = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };
  const activeQuery = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(),
  };
  const reservations = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((value: object) => value),
    save: jest.fn(),
    createQueryBuilder: jest.fn(() => activeQuery),
  };
  const products = {
    createQueryBuilder: jest.fn(() => productQuery),
    update: jest.fn(),
  };
  const manager = {
    getRepository: jest.fn((entity: unknown) =>
      entity === ProductStockReservation ? reservations : products,
    ),
    query: jest.fn(),
  };
  const dataSource = {
    transaction: jest.fn((work: (value: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const service = new StockReservationsService(
    dataSource as unknown as DataSource,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    productQuery.select.mockReturnThis();
    productQuery.where.mockReturnThis();
    productQuery.setLock.mockReturnThis();
    activeQuery.select.mockReturnThis();
    activeQuery.addSelect.mockReturnThis();
    activeQuery.where.mockReturnThis();
    activeQuery.andWhere.mockReturnThis();
    activeQuery.groupBy.mockReturnThis();
    reservations.create.mockImplementation((value: object) => value);
  });

  it('locks products in deterministic order and subtracts active reservations', async () => {
    productQuery.getOne
      .mockResolvedValueOnce({
        id: 'a',
        stock: 2,
        status: ProductStatus.PUBLISHED,
      })
      .mockResolvedValueOnce({
        id: 'b',
        stock: 3,
        status: ProductStatus.PUBLISHED,
      });
    reservations.find.mockResolvedValue([]);
    activeQuery.getRawMany.mockResolvedValue([
      { productId: 'b', quantity: '2' },
    ]);
    manager.query.mockResolvedValue([
      { now: new Date('2026-10-04T00:00:00Z') },
    ]);
    reservations.save.mockImplementation((values: unknown) =>
      Promise.resolve(values),
    );

    await expect(
      service.reserve('user', ' key ', [
        { productId: 'b', quantity: 1 },
        { productId: 'a', quantity: 2 },
      ]),
    ).resolves.toHaveLength(2);
    expect(productQuery.where).toHaveBeenNthCalledWith(
      1,
      'product.id = :productId',
      { productId: 'a' },
    );
    expect(productQuery.where).toHaveBeenNthCalledWith(
      2,
      'product.id = :productId',
      { productId: 'b' },
    );
    expect(productQuery.setLock).toHaveBeenCalledTimes(2);
    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('pg_advisory_xact_lock'),
      ['stock-reservation:user:key'],
    );
    expect(reservations.save).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ idempotencyKey: 'key', productId: 'a' }),
        expect.objectContaining({ idempotencyKey: 'key', productId: 'b' }),
      ]),
    );
  });

  it('rejects insufficient availability with a stable conflict', async () => {
    productQuery.getOne.mockResolvedValue({
      id: 'product',
      stock: 2,
      status: ProductStatus.PUBLISHED,
    });
    reservations.find.mockResolvedValue([]);
    activeQuery.getRawMany.mockResolvedValue([
      { productId: 'product', quantity: '2' },
    ]);
    await expect(
      service.reserve('user', 'key', [{ productId: 'product', quantity: 1 }]),
    ).rejects.toMatchObject({ status: 409 });
    try {
      await service.reserve('user', 'key', [
        { productId: 'product', quantity: 1 },
      ]);
    } catch (error) {
      expect((error as HttpException).getResponse()).toMatchObject({
        code: StockReservationErrorCode.INSUFFICIENT_AVAILABILITY,
      });
    }
  });

  it('returns an identical idempotent reservation set without inserting', async () => {
    productQuery.getOne.mockResolvedValue({
      id: 'product',
      stock: 2,
      status: ProductStatus.PUBLISHED,
    });
    const existing = [{ productId: 'product', quantity: 1, orderId: null }];
    reservations.find.mockResolvedValue(existing);
    await expect(
      service.reserve('user', 'key', [{ productId: 'product', quantity: 1 }]),
    ).resolves.toBe(existing);
    expect(reservations.save).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key for different items', async () => {
    productQuery.getOne.mockResolvedValue({
      id: 'product',
      stock: 2,
      status: ProductStatus.PUBLISHED,
    });
    reservations.find.mockResolvedValue([
      { productId: 'product', quantity: 2, orderId: null },
    ]);
    await expect(
      service.reserve('user', 'key', [{ productId: 'product', quantity: 1 }]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('consumes an active reservation and decrements physical stock once', async () => {
    const reservation = {
      id: 'reservation',
      productId: 'product',
      status: ProductStockReservationStatus.ACTIVE,
      quantity: 2,
      expiresAt: new Date('2026-10-04T00:20:00Z'),
      orderId: null,
    };
    reservations.findOne.mockResolvedValue(reservation);
    manager.query.mockResolvedValue([
      { now: new Date('2026-10-04T00:00:00Z') },
    ]);
    productQuery.getOne.mockResolvedValue({
      id: 'product',
      stock: 3,
      status: ProductStatus.PUBLISHED,
    });
    products.update.mockResolvedValue({ affected: 1 });
    reservations.save.mockImplementation((value: unknown) =>
      Promise.resolve(value),
    );
    await expect(
      service.consume('reservation', 'order'),
    ).resolves.toMatchObject({
      status: ProductStockReservationStatus.CONSUMED,
      orderId: 'order',
    });
    expect(products.update).toHaveBeenCalledWith('product', { stock: 1 });
  });

  it('uses a bounded SKIP LOCKED expiry batch', async () => {
    manager.query.mockResolvedValue([]);
    await expect(service.expireBatch(25)).resolves.toEqual([]);
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE SKIP LOCKED'),
      [25],
    );
    await expect(service.expireBatch(0)).rejects.toMatchObject({ status: 400 });
  });
});
