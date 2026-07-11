import { IsEnum } from 'class-validator';
import { ProductReviewStatus } from '../entities/product-review.entity';

export class UpdateProductReviewStatusDto {
  @IsEnum([ProductReviewStatus.APPROVED, ProductReviewStatus.REJECTED])
  status: ProductReviewStatus.APPROVED | ProductReviewStatus.REJECTED;
}
