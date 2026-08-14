import { ProductReviewVideo } from './entities/product-review-video.entity';

export type ProductReviewVideoResponse = {
  id: string;
  videoUrl: string;
  coverUrl: string;
  displayOrder: number;
};

export function toProductReviewVideoResponse(
  video: ProductReviewVideo,
): ProductReviewVideoResponse {
  return {
    id: video.id,
    videoUrl: `/uploads/${video.videoPath}`,
    coverUrl: `/uploads/${video.coverPath}`,
    displayOrder: video.displayOrder,
  };
}
