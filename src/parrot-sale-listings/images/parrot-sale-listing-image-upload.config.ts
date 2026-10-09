import { memoryStorage } from 'multer';
import {
  PRODUCT_IMAGE_MAX_BYTES,
  productImageFileFilter,
} from '../../products/product-image-policy';
import { PARROT_SALE_LISTING_MAX_IMAGES } from '../parrot-sale-listing.constants';

export const parrotSaleListingImageUploadOptions = {
  storage: memoryStorage(),
  fileFilter: productImageFileFilter,
  limits: {
    fileSize: PRODUCT_IMAGE_MAX_BYTES,
    files: PARROT_SALE_LISTING_MAX_IMAGES,
  },
};
