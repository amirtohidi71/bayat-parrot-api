import { Logger } from '@nestjs/common';
import { PublicBirdPassportSmsDispatchService } from './public-bird-passport-sms-dispatch.service';

const DELIVERY = {
  otpId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  phone: '09123456789',
  rawCode: '00042',
};

function context(options: { smsFailure?: boolean; dbFailure?: boolean } = {}) {
  let scheduledTask: (() => Promise<void>) | undefined;
  let unexpectedFailure: (() => void) | undefined;
  const scheduler = {
    schedule: jest.fn((task: () => Promise<void>, onFailure: () => void) => {
      scheduledTask = task;
      unexpectedFailure = onFailure;
    }),
  };
  const sms = {
    sendOtp: options.smsFailure
      ? jest
          .fn()
          .mockRejectedValue(new Error('provider payload must stay hidden'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const repository = {
    update: options.dbFailure
      ? jest
          .fn()
          .mockRejectedValue(new Error('database details must stay hidden'))
      : jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const dataSource = { getRepository: jest.fn(() => repository) };
  const service = new PublicBirdPassportSmsDispatchService(
    sms as never,
    dataSource as never,
    scheduler,
  );
  return {
    service,
    sms,
    repository,
    scheduler,
    run: () => {
      if (!scheduledTask) throw new Error('SMS task was not scheduled');
      return scheduledTask();
    },
    failUnexpectedly: () => {
      if (!unexpectedFailure) {
        throw new Error('Unexpected-failure handler was not registered');
      }
      return unexpectedFailure();
    },
  };
}

describe('PublicBirdPassportSmsDispatchService', () => {
  it('returns immediately and does not start SMS until the scheduled task runs', async () => {
    const value = context();
    expect(value.service.dispatch(DELIVERY)).toBeUndefined();
    expect(value.sms.sendOtp).not.toHaveBeenCalled();
    await value.run();
    expect(value.sms.sendOtp).toHaveBeenCalledWith(
      DELIVERY.phone,
      DELIVERY.rawCode,
      { logCodeInDevelopment: false },
    );
  });

  it('best-effort consumes the OTP after asynchronous SMS failure', async () => {
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const value = context({ smsFailure: true });
    value.service.dispatch(DELIVERY);
    await expect(value.run()).resolves.toBeUndefined();
    expect(value.repository.update).toHaveBeenCalledWith(
      { id: DELIVERY.otpId, consumed: false },
      { consumed: true },
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(DELIVERY.phone);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(DELIVERY.rawCode);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      'provider payload',
    );
    warning.mockRestore();
  });

  it('contains invalidation failure without leaking or rejecting', async () => {
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const value = context({ smsFailure: true, dbFailure: true });
    value.service.dispatch(DELIVERY);
    await expect(value.run()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      'Bird passport OTP invalidation after delivery failed',
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      'database details',
    );
    warning.mockRestore();
  });

  it('provides a safe terminal handler for unexpected scheduled rejection', () => {
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const value = context();
    value.service.dispatch(DELIVERY);
    expect(() => value.failUnexpectedly()).not.toThrow();
    expect(warning).toHaveBeenCalledWith(
      'Bird passport OTP background dispatch failed',
    );
    warning.mockRestore();
  });
});
