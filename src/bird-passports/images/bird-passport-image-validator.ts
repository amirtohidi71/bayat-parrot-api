import { BadRequestException } from '@nestjs/common';
import sharp, { Metadata } from 'sharp';
import {
  BIRD_PASSPORT_IMAGE_MAX_BYTES,
  BIRD_PASSPORT_IMAGE_MAX_DIMENSION,
  BIRD_PASSPORT_IMAGE_MAX_PIXELS,
  BIRD_PASSPORT_IMAGE_MIN_DIMENSION,
  BirdPassportInputFormat,
  SanitizedBirdPassportImage,
} from './bird-passport-image.types';

const MIME_BY_FORMAT: Record<BirdPassportInputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export async function sanitizeBirdPassportImage(
  buffer: Buffer,
  suppliedMimeType?: string,
): Promise<SanitizedBirdPassportImage> {
  if (!buffer.length)
    throw new BadRequestException('Bird passport image is invalid');
  if (buffer.length > BIRD_PASSPORT_IMAGE_MAX_BYTES)
    throw new BadRequestException('Bird passport image exceeds 5 MB');

  try {
    const decoder = sharp(buffer, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: BIRD_PASSPORT_IMAGE_MAX_PIXELS,
      sequentialRead: true,
    });
    const metadata = await decoder.metadata();
    const format = assertSupportedSingleImage(metadata);
    assertMimeType(format, suppliedMimeType);
    assertDimensions(metadata.width, metadata.height);

    const { data, info } = await decoder
      .clone()
      .autoOrient()
      .webp({ quality: 85, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    assertDimensions(info.width, info.height);
    if (data.length > BIRD_PASSPORT_IMAGE_MAX_BYTES)
      throw new BadRequestException(
        'Sanitized bird passport image exceeds 5 MB',
      );

    return {
      buffer: data,
      inputFormat: format,
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(
      'Bird passport image is invalid or unsupported',
    );
  }
}

function assertSupportedSingleImage(
  metadata: Metadata,
): BirdPassportInputFormat {
  if (!metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format))
    throw new BadRequestException('Bird passport image format is unsupported');
  if (
    (metadata.pages ?? 1) !== 1 ||
    (metadata.pageHeight && metadata.height !== metadata.pageHeight)
  )
    throw new BadRequestException(
      'Animated or multi-page images are unsupported',
    );
  return metadata.format as BirdPassportInputFormat;
}

function assertMimeType(
  format: BirdPassportInputFormat,
  suppliedMimeType?: string,
): void {
  if (
    suppliedMimeType !== undefined &&
    suppliedMimeType.toLowerCase() !== MIME_BY_FORMAT[format]
  )
    throw new BadRequestException('Bird passport image MIME type mismatch');
}

function assertDimensions(width?: number, height?: number): void {
  if (
    !width ||
    !height ||
    width < BIRD_PASSPORT_IMAGE_MIN_DIMENSION ||
    height < BIRD_PASSPORT_IMAGE_MIN_DIMENSION ||
    width > BIRD_PASSPORT_IMAGE_MAX_DIMENSION ||
    height > BIRD_PASSPORT_IMAGE_MAX_DIMENSION ||
    width * height > BIRD_PASSPORT_IMAGE_MAX_PIXELS
  )
    throw new BadRequestException('Bird passport image dimensions are invalid');
}
