import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname, join } from 'path';

export const PRODUCT_IMAGES_DIR = join(process.cwd(), 'public', 'uploads');

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

export const productImageUploadOptions = {
  storage: diskStorage({
    destination: (_req, _file, callback) => {
      if (!existsSync(PRODUCT_IMAGES_DIR)) {
        mkdirSync(PRODUCT_IMAGES_DIR, { recursive: true });
      }
      callback(null, PRODUCT_IMAGES_DIR);
    },
    filename: (_req, file, callback) => {
      callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  fileFilter: (_req: unknown, file: Express.Multer.File, callback: (error: Error | null, accept: boolean) => void) => {
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      callback(
        new BadRequestException(
          `Unsupported image format. Allowed formats: ${ALLOWED_EXTENSIONS.join(', ')}`,
        ),
        false,
      );
      return;
    }
    callback(null, true);
  },
  limits: {
    fileSize: MAX_IMAGE_SIZE_BYTES,
  },
};
