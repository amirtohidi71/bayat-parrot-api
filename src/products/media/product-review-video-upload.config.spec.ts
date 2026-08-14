import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { StorageEngine } from 'multer';
import {
  PRODUCT_REVIEW_VIDEO_STAGING_DIR,
  createProductReviewVideoDiskStorage,
  productReviewVideoUploadOptions,
} from './product-review-video-upload.config';
import {
  PRODUCT_REVIEW_VIDEO_COVER_MAX_BYTES,
  PRODUCT_REVIEW_VIDEO_MAX_BYTES,
} from './product-review-video-validator';

describe('product review video upload configuration', () => {
  let staging: string;

  beforeEach(async () => {
    staging = await mkdtemp(join(tmpdir(), 'review-video-upload-'));
  });

  afterEach(async () => {
    await rm(staging, { recursive: true, force: true });
  });

  it('keeps raw staging outside the public static uploads tree', () => {
    const publicRoot = resolve(process.cwd(), 'public', 'uploads');
    const relativePath = relative(publicRoot, PRODUCT_REVIEW_VIDEO_STAGING_DIR);
    expect(
      relativePath === '..' ||
        relativePath.startsWith(
          `..${process.platform === 'win32' ? '\\' : '/'}`,
        ),
    ).toBe(true);
  });

  it('uses server-side filenames and the 200 MB transport ceiling', () => {
    expect(productReviewVideoUploadOptions.limits).toMatchObject({
      fileSize: PRODUCT_REVIEW_VIDEO_MAX_BYTES,
      files: 2,
    });
  });

  it('accepts a cover exactly at the 5 MB field limit using disk storage', async () => {
    const storage = createProductReviewVideoDiskStorage({
      stagingDirectory: staging,
    });
    const stored = await store(storage, 'cover', [
      Buffer.alloc(PRODUCT_REVIEW_VIDEO_COVER_MAX_BYTES),
    ]);
    expect(stored.size).toBe(PRODUCT_REVIEW_VIDEO_COVER_MAX_BYTES);
    expect(stored.path).toMatch(/\.upload$/);
  });

  it('rejects an oversized cover while streaming and removes its partial file', async () => {
    const storage = createProductReviewVideoDiskStorage({
      stagingDirectory: staging,
    });
    await expect(
      store(storage, 'cover', [
        Buffer.alloc(PRODUCT_REVIEW_VIDEO_COVER_MAX_BYTES),
        Buffer.from([1]),
      ]),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(await readdir(staging)).toEqual([]);
  });

  it('keeps the video streaming limit independent from the cover limit', async () => {
    const storage = createProductReviewVideoDiskStorage({
      stagingDirectory: staging,
      videoMaxBytes: 1024,
      coverMaxBytes: 16,
    });
    const stored = await store(storage, 'video', [
      Buffer.alloc(512),
      Buffer.alloc(512),
    ]);
    expect(stored.size).toBe(1024);
    await expect(
      store(storage, 'video', [Buffer.alloc(1024), Buffer.from([1])]),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it.each([
    ['video', 'review.mp4', 'application/octet-stream'],
    ['video', 'review.webm', 'video/mp4'],
    ['cover', 'cover.gif', 'image/gif'],
    ['cover', 'cover.png', 'image/jpeg'],
  ])(
    'rejects invalid %s declaration %s / %s',
    (fieldname, originalname, mimetype) => {
      const callback = jest.fn();
      productReviewVideoUploadOptions.fileFilter(
        {},
        { fieldname, originalname, mimetype } as Express.Multer.File,
        callback,
      );
      expect(callback).toHaveBeenCalledWith(
        expect.any(BadRequestException),
        false,
      );
    },
  );
});

function store(
  storage: StorageEngine,
  fieldname: 'video' | 'cover',
  chunks: Buffer[],
): Promise<Partial<Express.Multer.File>> {
  const file = {
    fieldname,
    originalname: fieldname === 'video' ? 'video.mp4' : 'cover.png',
    encoding: '7bit',
    mimetype: fieldname === 'video' ? 'video/mp4' : 'image/png',
    stream: Readable.from(chunks),
  } as Express.Multer.File;
  return new Promise((resolvePromise, reject) => {
    storage._handleFile({} as never, file, (error, info) => {
      if (error) {
        reject(
          error instanceof Error
            ? error
            : new Error('Storage rejected the upload'),
        );
        return;
      }
      if (!info) {
        reject(new Error('Storage did not return file metadata'));
        return;
      }
      resolvePromise(info);
    });
  });
}
