import { Inject, Injectable, Logger } from '@nestjs/common';
import { IppanelClient } from './ippanel.client';
import {
  SMS_RUNTIME_CONFIG,
  SmsError,
  getSmsErrorCode,
  maskPhone,
  type SmsRuntimeConfig,
} from './sms.types';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    private readonly ippanelClient: IppanelClient,
    @Inject(SMS_RUNTIME_CONFIG) private readonly config: SmsRuntimeConfig,
  ) {}

  async sendOtp(
    phone: string,
    otp: string,
    options: { logCodeInDevelopment?: boolean } = {},
  ): Promise<void> {
    const maskedPhone = maskPhone(phone);
    if (this.config.devLogOtp && options.logCodeInDevelopment !== false) {
      this.logger.warn(`Development OTP recipient=${maskedPhone} code=${otp}`);
    }
    if (!this.config.enabled) {
      if (this.config.devLogOtp && options.logCodeInDevelopment !== false) {
        return;
      }
      throw new SmsError('SMS_DISABLED');
    }

    try {
      await this.ippanelClient.sendPattern(phone, otp);
      this.logger.log(
        `SMS operation=otp result=success recipient=${maskedPhone}`,
      );
    } catch (error) {
      this.logger.warn(
        `SMS operation=otp result=failed recipient=${maskedPhone} code=${getSmsErrorCode(error)}`,
      );
      throw error;
    }
  }

  async sendText(phone: string, message: string): Promise<void> {
    const maskedPhone = maskPhone(phone);
    try {
      await this.ippanelClient.sendWebservice(phone, message);
      this.logger.log(
        `SMS operation=text result=success recipient=${maskedPhone}`,
      );
    } catch (error) {
      this.logger.warn(
        `SMS operation=text result=failed recipient=${maskedPhone} code=${getSmsErrorCode(error)}`,
      );
      throw error;
    }
  }
}
