import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { Product, ProductStatus } from '../products/entities/product.entity';
import {
  ProductStockReservation,
  ProductStockReservationStatus,
} from './entities/product-stock-reservation.entity';
import {
  StockReservationErrorCode,
  stockReservationError,
} from './stock-reservation.errors';

export interface StockReservationItem {
  productId: string;
  quantity: number;
}

interface DatabaseNow {
  now: Date;
}

interface ReservedQuantity {
  productId: string;
  quantity: string;
}

export interface OrderReservationTransition {
  reservations: ProductStockReservation[];
  expired: boolean;
}

@Injectable()
export class StockReservationsService {
  static readonly DEFAULT_HOLD_MINUTES = 15;
  private static readonly MAX_REAPER_BATCH = 500;

  constructor(private readonly dataSource: DataSource) {}

  async reserve(
    userId: string,
    idempotencyKey: string,
    requestedItems: readonly StockReservationItem[],
  ): Promise<ProductStockReservation[]> {
    const key = this.normalizeIdempotencyKey(idempotencyKey);
    const items = this.normalizeItems(requestedItems);
    try {
      return await this.dataSource.transaction((manager) =>
        this.reserveInTransaction(manager, userId, key, items),
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (this.isUniqueViolation(error))
        throw stockReservationError(
          HttpStatus.CONFLICT,
          StockReservationErrorCode.IDEMPOTENCY_CONFLICT,
          'Idempotency key is already in use',
        );
      throw error;
    }
  }

  async reserveInTransaction(
    manager: EntityManager,
    userId: string,
    idempotencyKey: string,
    requestedItems: readonly StockReservationItem[],
    orderId: string | null = null,
  ): Promise<ProductStockReservation[]> {
    const key = this.normalizeIdempotencyKey(idempotencyKey);
    const items = this.normalizeItems(requestedItems);
    await this.lockIdempotencyKey(manager, userId, key);
    const products = await this.lockProducts(manager, items);
    const reservations = manager.getRepository(ProductStockReservation);
    const existing = await reservations.find({
      where: { userId, idempotencyKey: key },
      order: { productId: 'ASC' },
    });
    if (existing.length > 0) {
      this.assertSameRequest(existing, items, orderId);
      return existing;
    }

    const activeQuantities = await this.activeReservedQuantities(
      manager,
      items.map((item) => item.productId),
    );
    for (const item of items) {
      const product = products.get(item.productId);
      if (!product) this.productNotFound();
      if (product.status !== ProductStatus.PUBLISHED)
        throw stockReservationError(
          HttpStatus.CONFLICT,
          StockReservationErrorCode.PRODUCT_NOT_PUBLISHED,
          'Product is not published',
        );
      const available =
        product.stock - (activeQuantities.get(item.productId) ?? 0);
      if (available < item.quantity)
        throw stockReservationError(
          HttpStatus.CONFLICT,
          StockReservationErrorCode.INSUFFICIENT_AVAILABILITY,
          'Insufficient product availability',
        );
    }

    const now = await this.databaseNow(manager);
    const expiresAt = new Date(
      now.getTime() + StockReservationsService.DEFAULT_HOLD_MINUTES * 60_000,
    );
    return reservations.save(
      items.map((item) =>
        reservations.create({
          userId,
          idempotencyKey: key,
          productId: item.productId,
          quantity: item.quantity,
          orderId,
          status: ProductStockReservationStatus.ACTIVE,
          expiresAt,
        }),
      ),
    );
  }

  async release(
    reservationId: string,
    userId?: string,
  ): Promise<ProductStockReservation> {
    const result = await this.dataSource.transaction(async (manager) => {
      const reservation = await this.lockReservation(
        manager,
        reservationId,
        userId,
      );
      if (reservation.status !== ProductStockReservationStatus.ACTIVE)
        this.invalidState();
      if (await this.isExpired(manager, reservation)) {
        reservation.status = ProductStockReservationStatus.EXPIRED;
        return {
          reservation: await manager
            .getRepository(ProductStockReservation)
            .save(reservation),
          expired: true,
        };
      }
      reservation.status = ProductStockReservationStatus.RELEASED;
      return {
        reservation: await manager
          .getRepository(ProductStockReservation)
          .save(reservation),
        expired: false,
      };
    });
    if (result.expired) this.invalidState();
    return result.reservation;
  }

  async consume(
    reservationId: string,
    orderId?: string,
  ): Promise<ProductStockReservation> {
    const result = await this.dataSource.transaction(async (manager) => {
      // Fixed lock order for transitions: reservation, then its Product.
      const reservation = await this.lockReservation(manager, reservationId);
      if (reservation.status !== ProductStockReservationStatus.ACTIVE)
        this.invalidState();
      if (await this.isExpired(manager, reservation)) {
        reservation.status = ProductStockReservationStatus.EXPIRED;
        return {
          reservation: await manager
            .getRepository(ProductStockReservation)
            .save(reservation),
          expired: true,
        };
      }
      const product = await this.lockProduct(manager, reservation.productId);
      if (product.stock < reservation.quantity)
        throw stockReservationError(
          HttpStatus.CONFLICT,
          StockReservationErrorCode.INSUFFICIENT_STOCK,
          'Insufficient physical product stock',
        );
      product.stock -= reservation.quantity;
      await manager
        .getRepository(Product)
        .update(product.id, { stock: product.stock });
      reservation.status = ProductStockReservationStatus.CONSUMED;
      reservation.orderId = orderId ?? null;
      return {
        reservation: await manager
          .getRepository(ProductStockReservation)
          .save(reservation),
        expired: false,
      };
    });
    if (result.expired) this.invalidState();
    return result.reservation;
  }

  async expireBatch(limit = 100): Promise<ProductStockReservation[]> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > StockReservationsService.MAX_REAPER_BATCH
    )
      throw stockReservationError(
        HttpStatus.BAD_REQUEST,
        StockReservationErrorCode.INVALID_REQUEST,
        'Expiry batch size is invalid',
      );
    return this.dataSource.transaction((manager) =>
      manager.query<ProductStockReservation[]>(
        `WITH candidates AS (
           SELECT id
             FROM public.product_stock_reservations
            WHERE status = 'ACTIVE'
              AND "expiresAt" <= CURRENT_TIMESTAMP
            ORDER BY "expiresAt" ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE public.product_stock_reservations AS reservation
            SET status = 'EXPIRED', "updatedAt" = CURRENT_TIMESTAMP
           FROM candidates
          WHERE reservation.id = candidates.id
         RETURNING reservation.*`,
        [limit],
      ),
    );
  }

  async consumeForOrderInTransaction(
    manager: EntityManager,
    orderId: string,
  ): Promise<OrderReservationTransition> {
    const reservations = await this.lockOrderReservations(manager, orderId);
    if (reservations.length === 0) return { reservations: [], expired: false };
    if (
      reservations.every(
        (value) => value.status === ProductStockReservationStatus.CONSUMED,
      )
    )
      return { reservations, expired: false };
    if (
      reservations.some(
        (value) => value.status !== ProductStockReservationStatus.ACTIVE,
      )
    )
      this.invalidState();

    const now = await this.databaseNow(manager);
    if (
      reservations.some((value) => value.expiresAt.getTime() <= now.getTime())
    ) {
      for (const reservation of reservations) {
        reservation.status =
          reservation.expiresAt.getTime() <= now.getTime()
            ? ProductStockReservationStatus.EXPIRED
            : ProductStockReservationStatus.RELEASED;
      }
      return {
        reservations: await manager
          .getRepository(ProductStockReservation)
          .save(reservations),
        expired: true,
      };
    }

    const quantities = this.groupReservationQuantities(reservations);
    const products = await this.lockProducts(
      manager,
      [...quantities].map(([productId, quantity]) => ({
        productId,
        quantity,
      })),
    );
    for (const [productId, quantity] of quantities) {
      const product = products.get(productId);
      if (!product) this.productNotFound();
      if (product.status !== ProductStatus.PUBLISHED)
        throw stockReservationError(
          HttpStatus.CONFLICT,
          StockReservationErrorCode.PRODUCT_NOT_PUBLISHED,
          'Product is not published',
        );
      if (product.stock < quantity)
        throw stockReservationError(
          HttpStatus.CONFLICT,
          StockReservationErrorCode.INSUFFICIENT_STOCK,
          'Insufficient physical product stock',
        );
      await manager
        .getRepository(Product)
        .update(productId, { stock: product.stock - quantity });
    }
    for (const reservation of reservations)
      reservation.status = ProductStockReservationStatus.CONSUMED;
    return {
      reservations: await manager
        .getRepository(ProductStockReservation)
        .save(reservations),
      expired: false,
    };
  }

  async releaseForOrderInTransaction(
    manager: EntityManager,
    orderId: string,
  ): Promise<ProductStockReservation[]> {
    const reservations = await this.lockOrderReservations(manager, orderId);
    if (reservations.length === 0) return [];
    const now = await this.databaseNow(manager);
    const changed = reservations.filter(
      (value) => value.status === ProductStockReservationStatus.ACTIVE,
    );
    for (const reservation of changed)
      reservation.status =
        reservation.expiresAt.getTime() <= now.getTime()
          ? ProductStockReservationStatus.EXPIRED
          : ProductStockReservationStatus.RELEASED;
    if (changed.length > 0)
      await manager.getRepository(ProductStockReservation).save(changed);
    return reservations;
  }

  private async lockProducts(
    manager: EntityManager,
    items: readonly StockReservationItem[],
  ): Promise<Map<string, Product>> {
    const products = new Map<string, Product>();
    for (const item of items) {
      const product = await this.lockProduct(manager, item.productId);
      products.set(product.id, product);
    }
    return products;
  }

  private async lockIdempotencyKey(
    manager: EntityManager,
    userId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`stock-reservation:${userId}:${idempotencyKey}`],
    );
  }

  private async lockProduct(
    manager: EntityManager,
    productId: string,
  ): Promise<Product> {
    const product = await manager
      .getRepository(Product)
      .createQueryBuilder('product')
      .select(['product.id', 'product.stock', 'product.status'])
      .where('product.id = :productId', { productId })
      .setLock('pessimistic_write')
      .getOne();
    if (!product) this.productNotFound();
    return product;
  }

  private async lockReservation(
    manager: EntityManager,
    reservationId: string,
    userId?: string,
  ): Promise<ProductStockReservation> {
    const reservation = await manager
      .getRepository(ProductStockReservation)
      .findOne({
        where: userId ? { id: reservationId, userId } : { id: reservationId },
        lock: { mode: 'pessimistic_write' },
      });
    if (!reservation)
      throw stockReservationError(
        HttpStatus.NOT_FOUND,
        StockReservationErrorCode.NOT_FOUND,
        'Stock reservation not found',
      );
    return reservation;
  }

  private async lockOrderReservations(
    manager: EntityManager,
    orderId: string,
  ): Promise<ProductStockReservation[]> {
    return manager
      .getRepository(ProductStockReservation)
      .createQueryBuilder('reservation')
      .where('reservation.orderId = :orderId', { orderId })
      .orderBy('reservation.productId', 'ASC')
      .addOrderBy('reservation.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
  }

  private groupReservationQuantities(
    reservations: readonly ProductStockReservation[],
  ): Map<string, number> {
    const quantities = new Map<string, number>();
    for (const reservation of reservations)
      quantities.set(
        reservation.productId,
        (quantities.get(reservation.productId) ?? 0) + reservation.quantity,
      );
    return quantities;
  }

  private async activeReservedQuantities(
    manager: EntityManager,
    productIds: string[],
  ): Promise<Map<string, number>> {
    const rows = await manager
      .getRepository(ProductStockReservation)
      .createQueryBuilder('reservation')
      .select('reservation.productId', 'productId')
      .addSelect('SUM(reservation.quantity)', 'quantity')
      .where('reservation.productId IN (:...productIds)', { productIds })
      .andWhere('reservation.status = :status', {
        status: ProductStockReservationStatus.ACTIVE,
      })
      .andWhere('reservation.expiresAt > CURRENT_TIMESTAMP')
      .groupBy('reservation.productId')
      .getRawMany<ReservedQuantity>();
    return new Map(rows.map((row) => [row.productId, Number(row.quantity)]));
  }

  private async databaseNow(manager: EntityManager): Promise<Date> {
    const [row] = await manager.query<DatabaseNow[]>(
      'SELECT CURRENT_TIMESTAMP AS now',
    );
    return new Date(row.now);
  }

  private async isExpired(
    manager: EntityManager,
    reservation: ProductStockReservation,
  ): Promise<boolean> {
    const now = await this.databaseNow(manager);
    return reservation.expiresAt.getTime() <= now.getTime();
  }

  private normalizeIdempotencyKey(value: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || normalized.length > 128)
      throw stockReservationError(
        HttpStatus.BAD_REQUEST,
        StockReservationErrorCode.INVALID_REQUEST,
        'Idempotency key is invalid',
      );
    return normalized;
  }

  private normalizeItems(
    requestedItems: readonly StockReservationItem[],
  ): StockReservationItem[] {
    if (requestedItems.length === 0) this.invalidRequest();
    const quantities = new Map<string, number>();
    for (const item of requestedItems) {
      if (
        !item ||
        typeof item.productId !== 'string' ||
        !item.productId.trim() ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1
      )
        this.invalidRequest();
      const productId = item.productId.trim();
      const quantity = (quantities.get(productId) ?? 0) + item.quantity;
      if (!Number.isSafeInteger(quantity)) this.invalidRequest();
      quantities.set(productId, quantity);
    }
    return [...quantities.entries()]
      .map(([productId, quantity]) => ({ productId, quantity }))
      .sort((left, right) => left.productId.localeCompare(right.productId));
  }

  private assertSameRequest(
    existing: readonly ProductStockReservation[],
    items: readonly StockReservationItem[],
    orderId: string | null,
  ): void {
    if (
      existing.length !== items.length ||
      existing.some(
        (reservation, index) =>
          reservation.productId !== items[index].productId ||
          reservation.quantity !== items[index].quantity ||
          reservation.orderId !== orderId,
      )
    )
      throw stockReservationError(
        HttpStatus.CONFLICT,
        StockReservationErrorCode.IDEMPOTENCY_CONFLICT,
        'Idempotency key was used for a different request',
      );
  }

  private productNotFound(): never {
    throw stockReservationError(
      HttpStatus.NOT_FOUND,
      StockReservationErrorCode.PRODUCT_NOT_FOUND,
      'Product not found',
    );
  }

  private invalidState(): never {
    throw stockReservationError(
      HttpStatus.CONFLICT,
      StockReservationErrorCode.INVALID_STATE,
      'Stock reservation is not active',
    );
  }

  private invalidRequest(): never {
    throw stockReservationError(
      HttpStatus.BAD_REQUEST,
      StockReservationErrorCode.INVALID_REQUEST,
      'Stock reservation request is invalid',
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    return (
      (error as QueryFailedError & { driverError?: { code?: string } })
        .driverError?.code === '23505'
    );
  }
}
