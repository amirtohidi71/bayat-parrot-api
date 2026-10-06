import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { SellerOnboardingModule } from '../seller-onboarding/seller-onboarding.module';
import { ProductsModule } from '../products/products.module';
import { AdminParrotSaleListingsController } from './admin-parrot-sale-listings.controller';
import { ParrotSaleListingImage } from './entities/parrot-sale-listing-image.entity';
import { ParrotSaleListing } from './entities/parrot-sale-listing.entity';
import { ParrotSaleListingImageStorageService } from './images/parrot-sale-listing-image-storage.service';
import {
  ParrotSaleListingPublicImageService,
  parrotSaleListingPublicUploadsProvider,
} from './images/parrot-sale-listing-public-image.service';
import { GodAdminParrotSaleListingsController } from './god-admin-parrot-sale-listings.controller';
import { ParrotSaleListingApprovalService } from './parrot-sale-listing-approval.service';
import { ParrotSaleListingsController } from './parrot-sale-listings.controller';
import { ParrotSaleListingsService } from './parrot-sale-listings.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ParrotSaleListing, ParrotSaleListingImage]),
    AdminModule,
    ProductsModule,
    SellerOnboardingModule,
  ],
  controllers: [
    ParrotSaleListingsController,
    AdminParrotSaleListingsController,
    GodAdminParrotSaleListingsController,
  ],
  providers: [
    ParrotSaleListingsService,
    ParrotSaleListingApprovalService,
    ParrotSaleListingImageStorageService,
    ParrotSaleListingPublicImageService,
    parrotSaleListingPublicUploadsProvider,
  ],
  exports: [ParrotSaleListingImageStorageService],
})
export class ParrotSaleListingsModule {}
