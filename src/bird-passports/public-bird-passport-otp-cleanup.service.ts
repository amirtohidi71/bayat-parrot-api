import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PublicBirdPassportBackgroundScheduler } from './public-bird-passport-background-scheduler';

export const PUBLIC_BIRD_PASSPORT_OTP_RETENTION_HOURS = 24;
export const PUBLIC_BIRD_PASSPORT_OTP_CLEANUP_BATCH_SIZE = 500;

@Injectable()
export class PublicBirdPassportOtpCleanupService {
  private readonly logger = new Logger(
    PublicBirdPassportOtpCleanupService.name,
  );
  private scheduledOrRunning = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly scheduler: PublicBirdPassportBackgroundScheduler,
  ) {}

  schedule(): void {
    if (this.scheduledOrRunning) return;
    this.scheduledOrRunning = true;
    this.scheduler.schedule(
      async () => {
        try {
          await this.deleteOneBatch();
        } catch {
          this.logger.warn('Bird passport OTP cleanup failed');
        } finally {
          this.scheduledOrRunning = false;
        }
      },
      () => {
        this.scheduledOrRunning = false;
        this.logger.warn('Bird passport OTP cleanup scheduling failed');
      },
    );
  }

  private async deleteOneBatch(clock: Date = new Date()): Promise<void> {
    const cutoff = new Date(
      clock.getTime() -
        PUBLIC_BIRD_PASSPORT_OTP_RETENTION_HOURS * 60 * 60 * 1000,
    );
    await this.dataSource.query(
      `WITH candidates AS (
         SELECT id
         FROM public.bird_passport_otps
         WHERE "expiresAt" < $1
         ORDER BY "expiresAt" ASC
         LIMIT $2
       )
       DELETE FROM public.bird_passport_otps AS otp
       USING candidates
       WHERE otp.id = candidates.id`,
      [cutoff, PUBLIC_BIRD_PASSPORT_OTP_CLEANUP_BATCH_SIZE],
    );
  }
}
