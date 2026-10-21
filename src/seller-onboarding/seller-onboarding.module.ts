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
import { BREEDER_SCHEMA_ENTITIES } from '../breeder-listings/breeder-schema.entities';
import { BreederTaxonService } from '../breeder-listings/breeder-taxon.service';
import { BreederTaxonController } from '../breeder-listings/breeder-taxon.controller';
import { AdminBreederTaxonController } from '../breeder-listings/admin-breeder-taxon.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      SellerVerification,
      BreederApplication,
      ...BREEDER_SCHEMA_ENTITIES,
    ]),
    AdminModule,
  ],
  controllers: [
    SellerOnboardingController,
    AdminSellerOnboardingController,
    BreederTaxonController,
    AdminBreederTaxonController,
  ],
  providers: [
    SellerOnboardingService,
    SellerEligibilityPolicy,
    BreederTaxonService,
  ],
  exports: [SellerEligibilityPolicy],
})
export class SellerOnboardingModule {}
