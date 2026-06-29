import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  // No SMS provider is wired up yet (e.g. Kavenegar/sms.ir). Swap this
  // implementation out once one is integrated.
  async send(phone: string, message: string): Promise<void> {
    this.logger.log(`[SMS] to ${phone}: ${message}`);
  }
}
