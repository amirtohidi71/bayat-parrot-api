import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SmsService } from '../common/sms/sms.service';
import { BirdPassportOtp } from './entities/bird-passport-otp.entity';
import { PublicBirdPassportBackgroundScheduler } from './public-bird-passport-background-scheduler';

export type PublicBirdPassportSmsDispatch = {
  otpId: string;
  phone: string;
  rawCode: string;
};

@Injectable()
export class PublicBirdPassportSmsDispatchService {
  private readonly logger = new Logger(
    PublicBirdPassportSmsDispatchService.name,
  );

  constructor(
    private readonly sms: SmsService,
    private readonly dataSource: DataSource,
    private readonly scheduler: PublicBirdPassportBackgroundScheduler,
  ) {}

  dispatch(delivery: PublicBirdPassportSmsDispatch): void {
    this.scheduler.schedule(
      () => this.deliver(delivery),
      () => this.logger.warn('Bird passport OTP background dispatch failed'),
    );
  }

  private async deliver(
    delivery: PublicBirdPassportSmsDispatch,
  ): Promise<void> {
    try {
      await this.sms.sendOtp(delivery.phone, delivery.rawCode, {
        logCodeInDevelopment: false,
      });
    } catch {
      try {
        await this.dataSource
          .getRepository(BirdPassportOtp)
          .update({ id: delivery.otpId, consumed: false }, { consumed: true });
      } catch {
        this.logger.warn(
          'Bird passport OTP invalidation after delivery failed',
        );
      }
      this.logger.warn('Bird passport OTP delivery failed');
    }
  }
}
