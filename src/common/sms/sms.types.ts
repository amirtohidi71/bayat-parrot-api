import { ConfigService } from '@nestjs/config';

export const SMS_HTTP_TRANSPORT = Symbol('SMS_HTTP_TRANSPORT');
export const SMS_RUNTIME_CONFIG = Symbol('SMS_RUNTIME_CONFIG');

export type SmsHttpTransport = typeof fetch;

export type SmsErrorCode =
  | 'SMS_TIMEOUT'
  | 'SMS_PROVIDER_AUTH_ERROR'
  | 'SMS_PROVIDER_RATE_LIMIT'
  | 'SMS_PROVIDER_HTTP_ERROR'
  | 'SMS_PROVIDER_REJECTED'
  | 'SMS_PROVIDER_INVALID_RESPONSE'
  | 'SMS_DISABLED'
  | 'SMS_INVALID_PHONE';

export class SmsError extends Error {
  constructor(public readonly code: SmsErrorCode) {
    super(code);
    this.name = 'SmsError';
  }
}

export type SmsRuntimeConfig = {
  environment: string;
  enabled: boolean;
  devLogOtp: boolean;
  baseUrl: string;
  apiKey: string;
  fromNumber: string;
  otpPatternCode: string;
  timeoutMs: number;
};

const DEFAULT_BASE_URL = 'https://edge.ippanel.com/v1';

function strictBoolean(value: unknown, name: string, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  throw new Error(`${name} must be either true or false`);
}

function required(configService: ConfigService, name: string): string {
  const value = configService.get<string>(name)?.trim();
  if (!value) {
    throw new Error(`${name} is required when SMS delivery is enabled`);
  }
  return value;
}

export function createSmsRuntimeConfig(configService: ConfigService): SmsRuntimeConfig {
  const environment = configService.get<string>('NODE_ENV')?.trim() || 'development';
  const requestedEnabled = strictBoolean(configService.get('SMS_ENABLED'), 'SMS_ENABLED', false);
  const requestedDevLogOtp = strictBoolean(
    configService.get('SMS_DEV_LOG_OTP'),
    'SMS_DEV_LOG_OTP',
    false,
  );

  if (environment === 'production' && !requestedEnabled) {
    throw new Error('SMS_ENABLED must be true in production');
  }
  if (environment === 'production' && requestedDevLogOtp) {
    throw new Error('SMS_DEV_LOG_OTP must be false in production');
  }

  // Unit tests are always network-disabled even if the surrounding shell has SMS variables.
  const enabled = environment === 'test' ? false : requestedEnabled;
  const devLogOtp = environment === 'development' && requestedDevLogOtp;
  const baseUrl = configService.get<string>('IPPANEL_BASE_URL')?.trim() || DEFAULT_BASE_URL;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error('IPPANEL_BASE_URL must be a valid URL');
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
    throw new Error('IPPANEL_BASE_URL must be an HTTPS URL without credentials');
  }

  const timeoutValue = enabled ? required(configService, 'IPPANEL_TIMEOUT_MS') : '5000';
  const timeoutMs = Number(timeoutValue);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('IPPANEL_TIMEOUT_MS must be an integer between 100 and 60000');
  }

  return {
    environment,
    enabled,
    devLogOtp,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: enabled ? required(configService, 'IPPANEL_API_KEY') : '',
    fromNumber: enabled ? required(configService, 'IPPANEL_FROM_NUMBER') : '',
    otpPatternCode: enabled ? required(configService, 'IPPANEL_OTP_PATTERN_CODE') : '',
    timeoutMs,
  };
}

export function maskPhone(phone: string): string {
  const lastFour = phone.replace(/\D/g, '').slice(-4);
  return lastFour ? `***${lastFour}` : '***';
}

export function getSmsErrorCode(error: unknown): SmsErrorCode {
  return error instanceof SmsError ? error.code : 'SMS_PROVIDER_HTTP_ERROR';
}
