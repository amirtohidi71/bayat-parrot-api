import { Logger } from '@nestjs/common';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrdersService } from './orders.service';

function createService(
  options: { transactionError?: Error; smsError?: Error } = {},
) {
  const events: string[] = [];
  const orderRepository = {
    query: jest.fn(() => Promise.resolve(undefined)),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(() => Promise.resolve({ max: null })),
    })),
    create: jest.fn((value: Partial<Order>) =>
      Object.assign(new Order(), value),
    ),
    save: jest.fn((value: Order) =>
      Promise.resolve(Object.assign(value, { id: 'order-1' })),
    ),
  };
  const orderItemRepository = {
    create: jest.fn((value: Partial<OrderItem>) =>
      Object.assign(new OrderItem(), value),
    ),
    save: jest.fn((value: OrderItem[]) => Promise.resolve(value)),
  };
  const productRepository = {};
  const manager = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === Order) return orderRepository;
      if (entity === OrderItem) return orderItemRepository;
      return productRepository;
    }),
  };
  const dataSource = {
    transaction: jest.fn(
      async (callback: (value: typeof manager) => Promise<Order>) => {
        events.push('transaction-start');
        if (options.transactionError) throw options.transactionError;
        const result = await callback(manager);
        events.push('transaction-commit');
        return result;
      },
    ),
  };
  const smsService = {
    sendText: jest.fn(() => {
      events.push('sms');
      return options.smsError
        ? Promise.reject(options.smsError)
        : Promise.resolve(undefined);
    }),
  };
  const service = new OrdersService(
    orderRepository as never,
    orderItemRepository as never,
    smsService as never,
    dataSource as never,
    {
      reserveInTransaction: jest.fn(),
      consumeForOrderInTransaction: jest.fn(),
      releaseForOrderInTransaction: jest.fn(),
    } as never,
  );

  return { service, dataSource, smsService, events };
}

describe('OrdersService SMS delivery', () => {
  const dto = {
    items: [],
    address: 'address',
    postalCode: '1234567890',
  };

  afterEach(() => jest.restoreAllMocks());

  it('returns the committed order when the provider fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, dataSource, smsService } = createService({
      smsError: new Error('provider failure'),
    });

    await expect(
      service.create('user-1', '09123456789', dto),
    ).resolves.toMatchObject({
      id: 'order-1',
      orderNumber: '87653221',
    });
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(smsService.sendText).toHaveBeenCalledTimes(1);
  });

  it('sends the notification only after the order transaction commits', async () => {
    const { service, events } = createService();

    await service.create('user-1', '09123456789', dto);

    expect(events).toEqual(['transaction-start', 'transaction-commit', 'sms']);
  });

  it('does not send an SMS or retry order creation when the transaction fails', async () => {
    const transactionError = new Error('database failure');
    const { service, dataSource, smsService } = createService({
      transactionError,
    });

    await expect(service.create('user-1', '09123456789', dto)).rejects.toBe(
      transactionError,
    );
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(smsService.sendText).not.toHaveBeenCalled();
  });
});
