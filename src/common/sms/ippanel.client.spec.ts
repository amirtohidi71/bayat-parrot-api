import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IppanelClient, normalizeIranianMobile } from './ippanel.client';
import { SmsService } from './sms.service';
import {
  SmsError,
  createSmsRuntimeConfig,
  type SmsHttpTransport,
  type SmsRuntimeConfig,
} from './sms.types';

const enabledConfig: SmsRuntimeConfig = {
  environment: 'development',
  enabled: true,
  devLogOtp: false,
  baseUrl: 'https://edge.ippanel.com/v1',
  apiKey: 'test-api-key',
  fromNumber: 'test-sender',
  otpPatternCode: 'test-pattern',
  timeoutMs: 500,
};

function successfulResponse(metaStatus = true): Response {
  return new Response(JSON.stringify({ meta: { status: metaStatus } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('IppanelClient', () => {
  it('creates the exact Pattern payload and raw Authorization header', async () => {
    const transport = jest.fn(async () => successfulResponse());
    const client = new IppanelClient(enabledConfig, transport as SmsHttpTransport);

    await client.sendPattern('09123456789', '12345');

    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = transport.mock.calls[0];
    expect(url).toBe('https://edge.ippanel.com/v1/api/send');
    expect(options?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'test-api-key',
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      sending_type: 'pattern',
      from_number: 'test-sender',
      code: 'test-pattern',
      recipients: ['+989123456789'],
      params: { code: '12345' },
    });
    expect(String(options?.body)).not.toContain('phonebook');
    expect(String(options?.body)).not.toContain('send_time');
  });

  it('creates the exact Webservice payload', async () => {
    const transport = jest.fn(async () => successfulResponse());
    const client = new IppanelClient(enabledConfig, transport as SmsHttpTransport);

    await client.sendWebservice('+989123456789', 'Test message');

    const options = transport.mock.calls[0][1];
    expect(JSON.parse(String(options?.body))).toEqual({
      sending_type: 'webservice',
      from_number: 'test-sender',
      message: 'Test message',
      params: { recipients: ['+989123456789'] },
    });
    expect(String(options?.body)).not.toContain('phonebook');
    expect(String(options?.body)).not.toContain('send_time');
  });

  it.each([
    ['09123456789', '+989123456789'],
    ['+989123456789', '+989123456789'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeIranianMobile(input)).toBe(expected);
  });

  it.each(['9123456789', '00989123456789', '+981234', '0912345678', '']) (
    'rejects invalid phone %s',
    (phone) => {
      expect(() => normalizeIranianMobile(phone)).toThrow(
        expect.objectContaining({ code: 'SMS_INVALID_PHONE' }),
      );
    },
  );

  it.each([
    [401, 'SMS_PROVIDER_AUTH_ERROR'],
    [403, 'SMS_PROVIDER_AUTH_ERROR'],
    [429, 'SMS_PROVIDER_RATE_LIMIT'],
    [500, 'SMS_PROVIDER_HTTP_ERROR'],
  ])('maps HTTP %s to %s without retry', async (status, code) => {
    const transport = jest.fn(async () => new Response('{}', { status }));
    const client = new IppanelClient(enabledConfig, transport as SmsHttpTransport);

    await expect(client.sendPattern('09123456789', '12345')).rejects.toMatchObject({ code });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects meta.status=false', async () => {
    const transport = jest.fn(async () => successfulResponse(false));
    const client = new IppanelClient(enabledConfig, transport as SmsHttpTransport);

    await expect(client.sendPattern('09123456789', '12345')).rejects.toMatchObject({
      code: 'SMS_PROVIDER_REJECTED',
    });
  });

  it('rejects invalid JSON', async () => {
    const transport = jest.fn(async () => new Response('not-json', { status: 200 }));
    const client = new IppanelClient(enabledConfig, transport as SmsHttpTransport);

    await expect(client.sendPattern('09123456789', '12345')).rejects.toMatchObject({
      code: 'SMS_PROVIDER_INVALID_RESPONSE',
    });
  });

  it('aborts on timeout and does not retry', async () => {
    jest.useFakeTimers();
    const transport = jest.fn(
      async (_url: string | URL | Request, options?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const client = new IppanelClient(
      { ...enabledConfig, timeoutMs: 100 },
      transport as SmsHttpTransport,
    );

    const request = client.sendPattern('09123456789', '12345');
    const assertion = expect(request).rejects.toMatchObject({ code: 'SMS_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(100);
    await assertion;
    expect(transport).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});

describe('SMS runtime policy and logging', () => {
  it('fails fast in production when SMS is disabled', () => {
    const config = new ConfigService({ NODE_ENV: 'production', SMS_ENABLED: 'false' });
    expect(() => createSmsRuntimeConfig(config)).toThrow('SMS_ENABLED must be true');
  });

  it('fails fast when production development OTP logging is enabled', () => {
    const config = new ConfigService({
      NODE_ENV: 'production',
      SMS_ENABLED: 'true',
      SMS_DEV_LOG_OTP: 'true',
    });
    expect(() => createSmsRuntimeConfig(config)).toThrow('SMS_DEV_LOG_OTP must be false');
  });

  it.each(['IPPANEL_API_KEY', 'IPPANEL_FROM_NUMBER', 'IPPANEL_OTP_PATTERN_CODE', 'IPPANEL_TIMEOUT_MS'])(
    'fails fast when enabled configuration lacks %s',
    (missingName) => {
      const values: Record<string, string> = {
        NODE_ENV: 'production',
        SMS_ENABLED: 'true',
        SMS_DEV_LOG_OTP: 'false',
        IPPANEL_API_KEY: 'test-api-key',
        IPPANEL_FROM_NUMBER: 'test-sender',
        IPPANEL_OTP_PATTERN_CODE: 'test-pattern',
        IPPANEL_TIMEOUT_MS: '5000',
      };
      delete values[missingName];
      expect(() => createSmsRuntimeConfig(new ConfigService(values))).toThrow(missingName);
    },
  );

  it('forces test environment delivery off regardless of SMS_ENABLED', () => {
    const config = createSmsRuntimeConfig(
      new ConfigService({ NODE_ENV: 'test', SMS_ENABLED: 'true', SMS_DEV_LOG_OTP: 'true' }),
    );
    expect(config).toMatchObject({ enabled: false, devLogOtp: false });
  });

  it('does not call the client when development delivery is disabled', async () => {
    const client = { sendPattern: jest.fn(), sendWebservice: jest.fn() } as unknown as IppanelClient;
    const service = new SmsService(client, {
      ...enabledConfig,
      enabled: false,
      devLogOtp: false,
    });

    await expect(service.sendOtp('09123456789', '12345')).rejects.toMatchObject({
      code: 'SMS_DISABLED',
    });
    expect(client.sendPattern).not.toHaveBeenCalled();
  });

  it('logs a development OTP only with the explicit flag and without a full phone', async () => {
    const logger = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const client = { sendPattern: jest.fn(), sendWebservice: jest.fn() } as unknown as IppanelClient;
    const service = new SmsService(client, {
      ...enabledConfig,
      enabled: false,
      devLogOtp: true,
    });

    await service.sendOtp('09123456789', '12345');

    const output = logger.mock.calls.flat().join(' ');
    expect(output).toContain('12345');
    expect(output).not.toContain('09123456789');
    expect(client.sendPattern).not.toHaveBeenCalled();
    logger.mockRestore();
  });

  it('never logs API key or OTP on provider failure', async () => {
    const logger = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const client = {
      sendPattern: jest.fn().mockRejectedValue(new SmsError('SMS_PROVIDER_AUTH_ERROR')),
      sendWebservice: jest.fn(),
    } as unknown as IppanelClient;
    const service = new SmsService(client, enabledConfig);

    await expect(service.sendOtp('09123456789', '12345')).rejects.toBeInstanceOf(SmsError);

    const output = logger.mock.calls.flat().join(' ');
    expect(output).not.toContain('12345');
    expect(output).not.toContain('test-api-key');
    expect(output).not.toContain('09123456789');
    logger.mockRestore();
  });
});
