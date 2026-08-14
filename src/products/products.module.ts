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

@Module({
  imports: [
    TypeOrmModule.forFeature([Product, ProductReview, ProductReviewVideo]),
  ],
  providers: [
    ProductsService,
    ProductReviewVideosService,
    ProductReviewVideoStorageService,
    ProductReviewVideoUploadInterceptor,
  ],
  controllers: [ProductsController],
  exports: [
    ProductsService,
    ProductReviewVideosService,
    ProductReviewVideoUploadInterceptor,
  ],
})
export class ProductsModule {}
