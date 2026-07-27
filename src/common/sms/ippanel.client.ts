import { Inject, Injectable } from '@nestjs/common';
import {
  SMS_HTTP_TRANSPORT,
  SMS_RUNTIME_CONFIG,
  SmsError,
  type SmsHttpTransport,
  type SmsRuntimeConfig,
} from './sms.types';

export function normalizeIranianMobile(phone: string): string {
  if (/^09\d{9}$/.test(phone)) {
    return `+98${phone.slice(1)}`;
  }
  if (/^\+989\d{9}$/.test(phone)) {
    return phone;
  }
  throw new SmsError('SMS_INVALID_PHONE');
}

@Injectable()
export class IppanelClient {
  constructor(
    @Inject(SMS_RUNTIME_CONFIG) private readonly config: SmsRuntimeConfig,
    @Inject(SMS_HTTP_TRANSPORT) private readonly httpTransport: SmsHttpTransport,
  ) {}

  sendPattern(phone: string, otp: string): Promise<void> {
    const recipient = normalizeIranianMobile(phone);
    return this.send({
      sending_type: 'pattern',
      from_number: this.config.fromNumber,
      code: this.config.otpPatternCode,
      recipients: [recipient],
      params: { code: otp },
    });
  }

  sendWebservice(phone: string, message: string): Promise<void> {
    const recipient = normalizeIranianMobile(phone);
    return this.send({
      sending_type: 'webservice',
      from_number: this.config.fromNumber,
      message,
      params: { recipients: [recipient] },
    });
  }

  private async send(payload: Record<string, unknown>): Promise<void> {
    if (!this.config.enabled) {
      throw new SmsError('SMS_DISABLED');
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), this.config.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.httpTransport(`${this.config.baseUrl}/api/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: this.config.apiKey,
          },
          body: JSON.stringify(payload),
          signal: abortController.signal,
        });
      } catch (error) {
        if (abortController.signal.aborted || (error as { name?: string })?.name === 'AbortError') {
          throw new SmsError('SMS_TIMEOUT');
        }
        throw new SmsError('SMS_PROVIDER_HTTP_ERROR');
      }

      if (response.status === 401 || response.status === 403) {
        throw new SmsError('SMS_PROVIDER_AUTH_ERROR');
      }
      if (response.status === 429) {
        throw new SmsError('SMS_PROVIDER_RATE_LIMIT');
      }
      if (!response.ok) {
        throw new SmsError('SMS_PROVIDER_HTTP_ERROR');
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new SmsError('SMS_PROVIDER_INVALID_RESPONSE');
      }
      const meta = (body as { meta?: { status?: unknown } } | null)?.meta;
      if (meta?.status !== true) {
        throw new SmsError('SMS_PROVIDER_REJECTED');
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
