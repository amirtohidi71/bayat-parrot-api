export const BIRD_PASSPORT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const BIRD_PASSPORT_IMAGE_MIN_DIMENSION = 32;
export const BIRD_PASSPORT_IMAGE_MAX_DIMENSION = 6000;
export const BIRD_PASSPORT_IMAGE_MAX_PIXELS = 36_000_000;

export type BirdPassportInputFormat = 'jpeg' | 'png' | 'webp';

export interface SanitizedBirdPassportImage {
  buffer: Buffer;
  inputFormat: BirdPassportInputFormat;
  width: number;
  height: number;
}

export interface PrivateBirdPassportImage {
  buffer: Buffer;
  mimeType: 'image/webp';
  size: number;
}
