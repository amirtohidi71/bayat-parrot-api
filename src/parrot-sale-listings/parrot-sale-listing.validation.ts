import { HttpStatus } from '@nestjs/common';
import {
  PARROT_SALE_LISTING_MAX_IMAGES,
  PARROT_SALE_LISTING_MIN_IMAGES,
} from './parrot-sale-listing.constants';
import {
  ParrotSaleListingErrorCode,
  parrotSaleListingError,
} from './parrot-sale-listing.errors';

export function assertParrotSaleListingImageCount(imageCount: number): void {
  if (
    !Number.isInteger(imageCount) ||
    imageCount < PARROT_SALE_LISTING_MIN_IMAGES ||
    imageCount > PARROT_SALE_LISTING_MAX_IMAGES
  ) {
    throw parrotSaleListingError(
      HttpStatus.BAD_REQUEST,
      ParrotSaleListingErrorCode.INVALID_IMAGE_COUNT,
      `A submitted parrot sale listing requires ${PARROT_SALE_LISTING_MIN_IMAGES} to ${PARROT_SALE_LISTING_MAX_IMAGES} images`,
    );
  }
}
