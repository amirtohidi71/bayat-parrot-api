import { BadRequestException } from '@nestjs/common';
import { lstat, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { validImage } from '../../bird-passports/images/bird-passport-image.test-fixtures';
import { BIRD_PASSPORT_IMAGE_MAX_BYTES } from '../../bird-passports/images/bird-passport-image.types';
import {
  PRODUCT_IMAGE_ALLOWED_EXTENSIONS,
  PRODUCT_IMAGE_MAX_BYTES,
} from '../../products/product-image-policy';
import { PARROT_SALE_LISTING_MAX_IMAGES } from '../parrot-sale-listing.constants';
import {
  isAllowedParrotListingPrivateRoot,
  ParrotSaleListingImageStorageService,
} from './parrot-sale-listing-image-storage.service';
import { parrotSaleListingImageUploadOptions } from './parrot-sale-listing-image-upload.config';

describe('ParrotSaleListingImageStorageService', () => {
  let temporaryParent: string;
  let storageRoot: string;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalStorage = process.env.PARROT_SALE_LISTING_PRIVATE_STORAGE_DIR;

  beforeEach(async () => {
    temporaryParent = await mkdtemp(join(tmpdir(), 'parrot-sale-listings-'));
    storageRoot = join(temporaryParent, 'private-listings');
    process.env.NODE_ENV = 'test';
    process.env.PARROT_SALE_LISTING_PRIVATE_STORAGE_DIR = storageRoot;
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalStorage === undefined)
      delete process.env.PARROT_SALE_LISTING_PRIVATE_STORAGE_DIR;
    else process.env.PARROT_SALE_LISTING_PRIVATE_STORAGE_DIR = originalStorage;
    await rm(temporaryParent, { recursive: true, force: true });
  });

  it('uses the exact product image size policy with the eight-image cap', () => {
    expect(parrotSaleListingImageUploadOptions.limits.fileSize).toBe(
      PRODUCT_IMAGE_MAX_BYTES,
    );
    expect(BIRD_PASSPORT_IMAGE_MAX_BYTES).toBe(PRODUCT_IMAGE_MAX_BYTES);
    expect(parrotSaleListingImageUploadOptions.limits.files).toBe(
      PARROT_SALE_LISTING_MAX_IMAGES,
    );
    expect(parrotSaleListingImageUploadOptions.storage).toBeDefined();
  });

  it.each([
    ['image.jpg', true],
    ['image.jpeg', true],
    ['image.png', true],
    ['image.webp', true],
    ['image.JPG', true],
    ['image.gif', false],
    ['image.svg', false],
  ])('applies the product extension policy to %s', (originalname, accepted) => {
    const callback = jest.fn();
    parrotSaleListingImageUploadOptions.fileFilter(
      undefined,
      { originalname } as Express.Multer.File,
      callback,
    );
    if (accepted) expect(callback).toHaveBeenCalledWith(null, true);
    else {
      expect(callback).toHaveBeenCalledWith(
        expect.any(BadRequestException),
        false,
      );
    }
    expect(PRODUCT_IMAGE_ALLOWED_EXTENSIONS).toEqual([
      '.jpg',
      '.jpeg',
      '.png',
      '.webp',
    ]);
  });

  it('decodes and normalizes a valid upload to a private WebP file', async () => {
    const service = new ParrotSaleListingImageStorageService();
    const storageKey = await service.save(await validImage('png'), 'image/png');
    expect(storageKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/,
    );
    expect(
      (await sharp(await readFile(join(storageRoot, storageKey))).metadata())
        .format,
    ).toBe('webp');
    expect(await service.read(storageKey)).toMatchObject({
      mimeType: 'image/webp',
    });
    if (process.platform !== 'win32') {
      expect((await lstat(join(storageRoot, storageKey))).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it('rejects invalid decoded image data and MIME mismatches', async () => {
    const service = new ParrotSaleListingImageStorageService();
    await expect(
      service.save(Buffer.from('<svg/>'), 'image/png'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.save(await validImage('png'), 'image/jpeg'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    '../image.webp',
    '..\\image.webp',
    '/absolute.webp',
    'subdir/image.webp',
    'not-a-uuid.webp',
  ])('rejects unsafe storage key %s', async (storageKey) => {
    const service = new ParrotSaleListingImageStorageService();
    await expect(service.read(storageKey)).rejects.toThrow(
      'Invalid private image identifier',
    );
    await expect(service.delete(storageKey)).rejects.toThrow(
      'Invalid private image identifier',
    );
  });

  it('returns a stable 404 for an unavailable private image', async () => {
    const service = new ParrotSaleListingImageStorageService();
    try {
      await service.read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp');
      throw new Error('Expected unavailable image rejection');
    } catch (error: unknown) {
      expect(error).toMatchObject({ status: 404 });
      expect(
        (error as { getResponse: () => unknown }).getResponse(),
      ).toMatchObject({
        code: 'PARROT_SALE_LISTING_IMAGE_NOT_FOUND',
      });
    }
  });

  it('allows only a strict child of the production shared private root', () => {
    const base = '/opt/bayat-parrot/shared/private';
    expect(
      isAllowedParrotListingPrivateRoot(base, `${base}/parrot-sale-listings`),
    ).toBe(true);
    expect(isAllowedParrotListingPrivateRoot(base, base)).toBe(false);
    expect(
      isAllowedParrotListingPrivateRoot(
        base,
        '/opt/bayat-parrot/shared/uploads',
      ),
    ).toBe(false);
    expect(
      isAllowedParrotListingPrivateRoot(
        base,
        '/opt/bayat-parrot/releases/r1/private',
      ),
    ).toBe(false);
  });
});
