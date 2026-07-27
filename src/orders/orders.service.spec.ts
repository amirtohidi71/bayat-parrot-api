import { Logger } from '@nestjs/common';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrdersService } from './orders.service';

function createService(options: { transactionError?: Error; smsError?: Error } = {}) {
  const events: string[] = [];
  const orderRepository = {
    query: jest.fn(async () => undefined),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(async () => ({ max: null })),
    })),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => ({ id: 'order-1', ...value })),
  };
  const orderItemRepository = {
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
  };
  const productRepository = {};
  const manager = {
    getRepository: jest.fn((entity) => {
      if (entity === Order) return orderRepository;
      if (entity === OrderItem) return orderItemRepository;
      return productRepository;
    }),
  };
  const dataSource = {
    transaction: jest.fn(async (callback) => {
      events.push('transaction-start');
      if (options.transactionError) throw options.transactionError;
      const result = await callback(manager);
      events.push('transaction-commit');
      return result;
    }),
  };
  const smsService = {
    sendText: jest.fn(async () => {
      events.push('sms');
      if (options.smsError) throw options.smsError;
    }),
  };
  const service = new OrdersService(
    orderRepository as never,
    orderItemRepository as never,
    smsService as never,
    dataSource as never,
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
    const { service, dataSource, smsService } = createService({ smsError: new Error('provider failure') });

    await expect(service.create('user-1', '09123456789', dto)).resolves.toMatchObject({
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
    const { service, dataSource, smsService } = createService({ transactionError });

    await expect(service.create('user-1', '09123456789', dto)).rejects.toBe(transactionError);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(smsService.sendText).not.toHaveBeenCalled();
  });
});
