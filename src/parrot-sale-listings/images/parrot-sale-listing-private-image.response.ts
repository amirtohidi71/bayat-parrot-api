import { StreamableFile } from '@nestjs/common';
import type { PrivateBirdPassportImage } from '../../bird-passports/images/bird-passport-image.types';

export const PRIVATE_LISTING_IMAGE_CACHE_CONTROL = 'private, no-store';

export function parrotSaleListingPrivateImageResponse(
  image: PrivateBirdPassportImage,
): StreamableFile {
  return new StreamableFile(image.buffer, {
    type: 'image/webp',
    length: image.size,
    disposition: 'inline',
  });
}
