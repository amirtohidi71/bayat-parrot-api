import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { Product } from './entities/product.entity';
import { ProductReview } from './entities/product-review.entity';
import { ProductReviewVideo } from './entities/product-review-video.entity';
import { ProductReviewVideosService } from './product-review-videos.service';
import { ProductReviewVideoStorageService } from './media/product-review-video-storage.service';
import { ProductReviewVideoUploadInterceptor } from './media/product-review-video-upload.interceptor';
import { SellerListingProductPublisherService } from './seller-listing-product-publisher.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product, ProductReview, ProductReviewVideo]),
  ],
  providers: [
    ProductsService,
    ProductReviewVideosService,
    ProductReviewVideoStorageService,
    ProductReviewVideoUploadInterceptor,
    SellerListingProductPublisherService,
  ],
  controllers: [ProductsController],
  exports: [
    ProductsService,
    ProductReviewVideosService,
    ProductReviewVideoUploadInterceptor,
    SellerListingProductPublisherService,
  ],
})
export class ProductsModule {}
