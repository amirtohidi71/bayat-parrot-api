import { memoryStorage } from 'multer';
import { BIRD_PASSPORT_IMAGE_MAX_BYTES } from '../../bird-passports/images/bird-passport-image.types';
import { PARROT_SALE_LISTING_MAX_IMAGES } from '../parrot-sale-listing.constants';

export const parrotSaleListingImageUploadOptions = {
  storage: memoryStorage(),
  limits: {
    fileSize: BIRD_PASSPORT_IMAGE_MAX_BYTES,
    files: PARROT_SALE_LISTING_MAX_IMAGES,
  },
};
