import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { User } from '../users/entities/user.entity';
import { AdminSellerOnboardingController } from './admin-seller-onboarding.controller';
import { BreederApplication } from './entities/breeder-application.entity';
import { SellerVerification } from './entities/seller-verification.entity';
import { SellerEligibilityPolicy } from './seller-eligibility.policy';
import { SellerOnboardingController } from './seller-onboarding.controller';
import { SellerOnboardingService } from './seller-onboarding.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, SellerVerification, BreederApplication]),
    AdminModule,
  ],
  controllers: [SellerOnboardingController, AdminSellerOnboardingController],
  providers: [SellerOnboardingService, SellerEligibilityPolicy],
  exports: [SellerEligibilityPolicy],
})
export class SellerOnboardingModule {}
