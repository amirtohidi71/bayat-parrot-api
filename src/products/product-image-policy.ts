import { BadRequestException } from '@nestjs/common';
import { extname } from 'path';

export const PRODUCT_IMAGE_ALLOWED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
] as const;
export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export function productImageFileFilter(
  _request: unknown,
  file: Express.Multer.File,
  callback: (error: Error | null, accept: boolean) => void,
): void {
  const extension = extname(file.originalname).toLowerCase();
  if (!PRODUCT_IMAGE_ALLOWED_EXTENSIONS.some((value) => value === extension)) {
    callback(
      new BadRequestException(
        `Unsupported image format. Allowed formats: ${PRODUCT_IMAGE_ALLOWED_EXTENSIONS.join(', ')}`,
      ),
      false,
    );
    return;
  }
  callback(null, true);
}
