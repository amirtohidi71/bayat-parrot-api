import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname } from 'path';
import {
  PRODUCT_IMAGE_MAX_BYTES,
  productImageFileFilter,
} from '../../products/product-image-policy';
import { PUBLIC_UPLOADS_ROOT } from '../../common/public-uploads-static';

export const PRODUCT_IMAGES_DIR = PUBLIC_UPLOADS_ROOT;

export const productImageUploadOptions = {
  storage: diskStorage({
    destination: (_req, _file, callback) => {
      if (!existsSync(PRODUCT_IMAGES_DIR)) {
        mkdirSync(PRODUCT_IMAGES_DIR, { recursive: true });
      }
      callback(null, PRODUCT_IMAGES_DIR);
    },
    filename: (_req, file, callback) => {
      callback(
        null,
        `${randomUUID()}${extname(file.originalname).toLowerCase()}`,
      );
    },
  }),
  fileFilter: productImageFileFilter,
  limits: {
    fileSize: PRODUCT_IMAGE_MAX_BYTES,
  },
};
