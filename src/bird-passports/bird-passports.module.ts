import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BirdFeedingRecord } from './entities/bird-feeding-record.entity';
import { BirdPassportOtp } from './entities/bird-passport-otp.entity';
import { BirdPassport } from './entities/bird-passport.entity';
import { BirdVaccineRecord } from './entities/bird-vaccine-record.entity';
import { BirdVeterinaryVisit } from './entities/bird-veterinary-visit.entity';
import { BirdPassportsService } from './bird-passports.service';
import { BirdPassportImageStorageService } from './images/bird-passport-image-storage.service';
import { BirdPassportImagesService } from './images/bird-passport-images.service';
import { AdminModule } from '../admin/admin.module';
import { AdminBirdPassportsController } from './admin-bird-passports.controller';
import { AdminBirdPassportNoStoreInterceptor } from './admin-bird-passport-no-store.interceptor';
import { SmsModule } from '../common/sms/sms.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { PublicBirdPassportsController } from './public-bird-passports.controller';
import { PublicBirdPassportsService } from './public-bird-passports.service';
import { BirdPassportLookupGrantService } from './bird-passport-lookup-grant.service';
import { BirdPassportLookupGuard } from './bird-passport-lookup.guard';
import { PublicBirdPassportThrottlerGuard } from './public-bird-passport-throttler.guard';
import { PublicBirdPassportNoStoreInterceptor } from './public-bird-passport-no-store.interceptor';
import { PublicBirdPassportOtpCandidateFactory } from './public-bird-passport-otp-candidate';
import { PublicBirdPassportOtpCleanupService } from './public-bird-passport-otp-cleanup.service';
import {
  PUBLIC_BIRD_PASSPORT_TIMING_PRIMITIVES,
  PublicBirdPassportRequestTimingService,
  publicBirdPassportTimingPrimitives,
} from './public-bird-passport-request-timing.service';
import { PublicBirdPassportBackgroundScheduler } from './public-bird-passport-background-scheduler';
import { PublicBirdPassportSmsDispatchService } from './public-bird-passport-sms-dispatch.service';
import { BirdPassportTaxonomyService } from './bird-passport-taxonomy.service';

@Module({
  imports: [
    AdminModule,
    SmsModule,
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 15 * 60 * 1000, limit: 120 },
    ]),
    TypeOrmModule.forFeature([
      BirdPassport,
      BirdVaccineRecord,
      BirdFeedingRecord,
      BirdVeterinaryVisit,
      BirdPassportOtp,
    ]),
  ],
  controllers: [AdminBirdPassportsController, PublicBirdPassportsController],
  providers: [
    BirdPassportsService,
    BirdPassportImageStorageService,
    BirdPassportImagesService,
    BirdPassportTaxonomyService,
    AdminBirdPassportNoStoreInterceptor,
    PublicBirdPassportsService,
    BirdPassportLookupGrantService,
    BirdPassportLookupGuard,
    PublicBirdPassportThrottlerGuard,
    PublicBirdPassportNoStoreInterceptor,
    PublicBirdPassportOtpCandidateFactory,
    PublicBirdPassportRequestTimingService,
    {
      provide: PUBLIC_BIRD_PASSPORT_TIMING_PRIMITIVES,
      useValue: publicBirdPassportTimingPrimitives,
    },
    PublicBirdPassportBackgroundScheduler,
    PublicBirdPassportSmsDispatchService,
    PublicBirdPassportOtpCleanupService,
  ],
  exports: [BirdPassportsService, BirdPassportImagesService],
})
export class BirdPassportsModule {}
