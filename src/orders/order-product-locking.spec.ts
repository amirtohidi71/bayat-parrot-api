/* eslint-disable @typescript-eslint/require-await -- repository mocks mirror async TypeORM methods. */
import { BadRequestException } from '@nestjs/common';
import { Product, ProductStatus } from '../products/entities/product.entity';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import {
  OrdersService,
  PRODUCT_NOT_PUBLISHED_ERROR_CODE,
} from './orders.service';

const PRODUCT_A = '11111111-1111-4111-8111-111111111111';
const PRODUCT_B = '22222222-2222-4222-8222-222222222222';

function product(id: string, status = ProductStatus.PUBLISHED) {
  return Object.assign(new Product(), {
    id,
    sku: `SKU-${id.slice(0, 1)}`,
    name: `Product ${id.slice(0, 1)}`,
    price: 100,
    discountPrice: null,
    stock: 5,
    colorVariants: null,
    status,
  });
}

function context(rows: Product[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const bySku = new Map(rows.map((row) => [row.sku, row]));
  const lockOrder: string[] = [];
  class ProductQueryMock {
    private locked = false;
    private selected: Product | undefined;

    readonly select = jest.fn((): ProductQueryMock => this);

    readonly setLock = jest.fn((): ProductQueryMock => {
      this.locked = true;
      return this;
    });

    readonly where = jest.fn(
      (
        _sql: string,
        parameters: { productId?: string; sku?: string },
      ): ProductQueryMock => {
        this.selected = parameters.productId
          ? byId.get(parameters.productId)
          : bySku.get(parameters.sku ?? '');
        return this;
      },
    );

    readonly getOne = jest.fn(async (): Promise<Product | null> => {
      if (this.locked && this.selected) lockOrder.push(this.selected.id);
      return this.selected ?? null;
    });
  }
  const productRepository = {
    createQueryBuilder: jest.fn(() => new ProductQueryMock()),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const orderRepository = {
    query: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ max: null }),
    })),
    create: jest.fn((value: Partial<Order>) =>
      Object.assign(new Order(), value),
    ),
    save: jest.fn(async (value: Order) =>
      Object.assign(value, { id: 'order-id' }),
    ),
  };
  const orderItemRepository = {
    create: jest.fn((value: Partial<OrderItem>) =>
      Object.assign(new OrderItem(), value),
    ),
    save: jest.fn(async (values: OrderItem[]) => values),
  };
  const manager = {
    getRepository: jest.fn((target: unknown) => {
      if (target === Product) return productRepository;
      if (target === Order) return orderRepository;
      if (target === OrderItem) return orderItemRepository;
      throw new Error('Unexpected repository');
    }),
  };
  const dataSource = {
    transaction: jest.fn(
      async (callback: (value: typeof manager) => Promise<Order>) =>
        callback(manager),
    ),
  };
  const sms = { sendText: jest.fn().mockResolvedValue(undefined) };
  const stockReservations = {
    reserveInTransaction: jest.fn().mockResolvedValue([]),
    consumeForOrderInTransaction: jest
      .fn()
      .mockResolvedValue({ reservations: [], expired: false }),
    releaseForOrderInTransaction: jest.fn().mockResolvedValue([]),
  };
  const service = new OrdersService(
    orderRepository as never,
    orderItemRepository as never,
    sms as never,
    dataSource as never,
    stockReservations as never,
  );
  return {
    service,
    lockOrder,
    productRepository,
    orderRepository,
    orderItemRepository,
    stockReservations,
  };
}

describe('OrdersService product publication and lock policy', () => {
  it('locks products in deterministic ID order while preserving requested line order', async () => {
    const first = product(PRODUCT_A);
    const second = product(PRODUCT_B);
    second.stock = 1;
    second.isSellerListing = true;
    const value = context([first, second]);

    const order = await value.service.create('user-id', '09120000000', {
      items: [
        { productId: PRODUCT_B, quantity: 1 },
        { productId: PRODUCT_A, quantity: 2 },
      ],
      address: 'Address',
      postalCode: '1234567890',
    });

    expect(value.lockOrder).toEqual([PRODUCT_A, PRODUCT_B]);
    expect(order.items.map((item) => item.productId)).toEqual([
      PRODUCT_B,
      PRODUCT_A,
    ]);
    expect(first.stock).toBe(3);
    expect(second.stock).toBe(1);
    expect(second.status).toBe(ProductStatus.PUBLISHED);
    expect(value.stockReservations.reserveInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'user-id',
      'order:order-id',
      [{ productId: PRODUCT_B, quantity: 1 }],
      'order-id',
    );
  });

  it.each([ProductStatus.DRAFT, ProductStatus.PENDING])(
    'rejects a %s product with a stable public error before decrementing stock',
    async (status) => {
      const row = product(PRODUCT_A, status);
      const value = context([row]);

      try {
        await value.service.create('user-id', '09120000000', {
          items: [{ productId: PRODUCT_A, quantity: 1 }],
          address: 'Address',
          postalCode: '1234567890',
        });
        throw new Error('Expected order creation to fail');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          statusCode: 400,
          code: PRODUCT_NOT_PUBLISHED_ERROR_CODE,
          message: 'Product is not available for purchase',
        });
      }
      expect(row.stock).toBe(5);
      expect(value.productRepository.update).not.toHaveBeenCalled();
      expect(value.orderRepository.save).not.toHaveBeenCalled();
    },
  );
});
