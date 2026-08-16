import { Logger } from '@nestjs/common';
import { SmsService } from './sms.service';
import type { SmsRuntimeConfig } from './sms.types';

function runtimeConfig(
  overrides: Partial<SmsRuntimeConfig> = {},
): SmsRuntimeConfig {
  return {
    environment: 'test',
    enabled: true,
    devLogOtp: true,
    baseUrl: 'https://sms.example.test',
    apiKey: 'test-only',
    fromNumber: 'test-only',
    otpPatternCode: 'test-only',
    timeoutMs: 1000,
    ...overrides,
  };
}

describe('SmsService OTP logging policy', () => {
  it('delivers a Passport OTP without logging its raw code', async () => {
    const logger = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const client = { sendPattern: jest.fn().mockResolvedValue(undefined) };
    const service = new SmsService(client as never, runtimeConfig());
    await service.sendOtp('09123456789', '12345', {
      logCodeInDevelopment: false,
    });
    expect(client.sendPattern).toHaveBeenCalledWith('09123456789', '12345');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('12345');
    logger.mockRestore();
  });

  it('preserves the existing opt-in development login behavior by default', async () => {
    const logger = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const client = { sendPattern: jest.fn() };
    const service = new SmsService(
      client as never,
      runtimeConfig({ enabled: false }),
    );
    await service.sendOtp('09123456789', '54321');
    expect(client.sendPattern).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.mock.calls)).toContain('54321');
    logger.mockRestore();
  });
});
