import {
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { rm } from 'node:fs/promises';
import { CallHandler } from '@nestjs/common';
import { concatMap, dematerialize, from, map, materialize } from 'rxjs';
import {
  productReviewVideoFileFields,
  productReviewVideoUploadOptions,
} from './product-review-video-upload.config';
import type { ProductReviewVideoUploadFiles } from './product-review-video-storage.service';

const MulterProductReviewVideoInterceptor = FileFieldsInterceptor(
  productReviewVideoFileFields,
  productReviewVideoUploadOptions,
);

@Injectable()
export class ProductReviewVideoUploadInterceptor
  extends MulterProductReviewVideoInterceptor
  implements NestInterceptor
{
  private readonly cleanupLogger = new Logger(
    ProductReviewVideoUploadInterceptor.name,
  );

  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{
      files?: ProductReviewVideoUploadFiles;
    }>();
    try {
      const response = await super.intercept(context, next);
      return response.pipe(
        materialize(),
        concatMap((notification) =>
          from(this.cleanup(request.files)).pipe(map(() => notification)),
        ),
        dematerialize(),
      );
    } catch (error) {
      await this.cleanup(request.files);
      throw error;
    }
  }

  private async cleanup(files?: ProductReviewVideoUploadFiles): Promise<void> {
    const paths = [...(files?.video ?? []), ...(files?.cover ?? [])].map(
      (file) => file.path,
    );
    const results = await Promise.allSettled(
      paths.map((path) => rm(path, { force: true })),
    );
    if (results.some((result) => result.status === 'rejected')) {
      this.cleanupLogger.warn('Product review video request cleanup failed');
    }
  }
}
