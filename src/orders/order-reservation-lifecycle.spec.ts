import { ConflictException } from '@nestjs/common';
import { Order, PaymentStatus } from './entities/order.entity';
import {
  ORDER_RESERVATION_EXPIRED_ERROR_CODE,
  OrdersService,
} from './orders.service';

function context() {
  const order = Object.assign(new Order(), {
    id: 'order-id',
    paymentStatus: PaymentStatus.PENDING,
    paymentDate: null,
  });
  const orders = {
    findOne: jest.fn().mockResolvedValue(order),
    save: jest.fn((value: Order) => Promise.resolve(value)),
  };
  const manager = {
    getRepository: jest.fn(() => orders),
  };
  const dataSource = {
    transaction: jest.fn((work: (value: typeof manager) => Promise<unknown>) =>
      work(manager),
    ),
  };
  const stockReservations = {
    consumeForOrderInTransaction: jest
      .fn()
      .mockResolvedValue({ reservations: [], expired: false }),
    releaseForOrderInTransaction: jest.fn().mockResolvedValue([]),
  };
  const service = new OrdersService(
    orders as never,
    {} as never,
    {} as never,
    dataSource as never,
    stockReservations as never,
  );
  return { service, order, orders, manager, stockReservations };
}

describe('OrdersService reservation lifecycle', () => {
  it('consumes linked reservations before marking payment successful', async () => {
    const value = context();
    await expect(
      value.service.fulfillPaymentSuccess('order-id'),
    ).resolves.toMatchObject({ paymentStatus: PaymentStatus.SUCCESS });
    expect(
      value.stockReservations.consumeForOrderInTransaction,
    ).toHaveBeenCalledWith(value.manager, 'order-id');
    expect(value.orders.save).toHaveBeenCalledTimes(1);
  });

  it('commits expiry state but keeps an expired order unpaid', async () => {
    const value = context();
    value.stockReservations.consumeForOrderInTransaction.mockResolvedValue({
      reservations: [],
      expired: true,
    });
    try {
      await value.service.fulfillPaymentSuccess('order-id');
      throw new Error('Expected fulfillment to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: ORDER_RESERVATION_EXPIRED_ERROR_CODE,
      });
    }
    expect(value.order.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(value.orders.save).not.toHaveBeenCalled();
  });

  it('releases active reservations before marking payment failed', async () => {
    const value = context();
    await expect(
      value.service.markPaymentFailed('order-id'),
    ).resolves.toMatchObject({
      paymentStatus: PaymentStatus.FAILED,
    });
    expect(
      value.stockReservations.releaseForOrderInTransaction,
    ).toHaveBeenCalledWith(value.manager, 'order-id');
  });

  it('makes payment-success fulfillment idempotent', async () => {
    const value = context();
    await value.service.fulfillPaymentSuccess('order-id');
    await value.service.fulfillPaymentSuccess('order-id');
    expect(
      value.stockReservations.consumeForOrderInTransaction,
    ).toHaveBeenCalledTimes(1);
    expect(value.orders.save).toHaveBeenCalledTimes(1);
  });
});
