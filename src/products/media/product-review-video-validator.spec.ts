import { BadRequestException } from '@nestjs/common';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  PRODUCT_REVIEW_VIDEO_COVER_MAX_BYTES,
  PRODUCT_REVIEW_VIDEO_MAX_BYTES,
  sanitizeProductReviewVideoCover,
  validateProductReviewMp4,
} from './product-review-video-validator';

function box(type: string, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function minimalMp4(): Buffer {
  return Buffer.concat([
    box(
      'ftyp',
      Buffer.concat([
        Buffer.from('isom'),
        Buffer.alloc(4),
        Buffer.from('isommp42'),
      ]),
    ),
    box(
      'moov',
      box(
        'trak',
        box(
          'mdia',
          box(
            'hdlr',
            Buffer.concat([
              Buffer.alloc(8),
              Buffer.from('vide'),
              Buffer.alloc(12),
            ]),
          ),
        ),
      ),
    ),
    box('mdat', Buffer.from([0])),
  ]);
}

function mp4WithMoov(moovPayload: Uint8Array): Buffer {
  return Buffer.concat([
    box(
      'ftyp',
      Buffer.concat([
        Buffer.from('isom'),
        Buffer.alloc(4),
        Buffer.from('mp42'),
      ]),
    ),
    box('moov', moovPayload),
    box('mdat', Buffer.from('arbitrary payload')),
  ]);
}

function handler(type: 'vide' | 'soun'): Buffer {
  return box(
    'hdlr',
    Buffer.concat([Buffer.alloc(8), Buffer.from(type), Buffer.alloc(12)]),
  );
}

describe('product review video media validation', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'review-video-validator-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('accepts an MP4 container with an MP4 brand, moov and mdat boxes', async () => {
    const path = join(directory, 'video.upload');
    await writeFile(path, minimalMp4());
    await expect(
      validateProductReviewMp4(path, 'video/mp4', 'review.mp4'),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['an empty moov', Buffer.alloc(0)],
    ['a trak without mdia', box('trak', box('tkhd'))],
    ['an mdia without hdlr', box('trak', box('mdia', box('mdhd')))],
    ['only an audio handler', box('trak', box('mdia', handler('soun')))],
    [
      'fake vide text in unrelated payload',
      box('trak', box('mdia', box('free', Buffer.from('vide')))),
    ],
  ])('rejects a container with %s', async (_label, moovPayload) => {
    const path = join(directory, 'video.upload');
    await writeFile(path, mp4WithMoov(moovPayload));
    await expect(
      validateProductReviewMp4(path, 'video/mp4', 'review.mp4'),
    ).rejects.toThrow('Review video MP4 container is invalid');
  });

  it('rejects a nested box that extends beyond its parent', async () => {
    const path = join(directory, 'video.upload');
    const malformedTrak = Buffer.alloc(8);
    malformedTrak.writeUInt32BE(128, 0);
    malformedTrak.write('trak', 4, 4, 'ascii');
    await writeFile(path, mp4WithMoov(malformedTrak));
    await expect(
      validateProductReviewMp4(path, 'video/mp4', 'review.mp4'),
    ).rejects.toThrow('Review video MP4 container is invalid');
  });

  it('rejects a truncated nested extended-size header', async () => {
    const path = join(directory, 'video.upload');
    const truncated = Buffer.alloc(12);
    truncated.writeUInt32BE(1, 0);
    truncated.write('trak', 4, 4, 'ascii');
    await writeFile(path, mp4WithMoov(truncated));
    await expect(
      validateProductReviewMp4(path, 'video/mp4', 'review.mp4'),
    ).rejects.toThrow('Review video MP4 container is invalid');
  });

  it.each([
    ['wrong MIME', 'application/octet-stream', 'review.mp4'],
    ['wrong extension', 'video/mp4', 'review.webm'],
  ])('rejects an MP4 upload with %s', async (_label, mime, name) => {
    const path = join(directory, 'video.upload');
    await writeFile(path, minimalMp4());
    await expect(
      validateProductReviewMp4(path, mime, name),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects declared MP4 data without a valid MP4 container', async () => {
    const path = join(directory, 'video.upload');
    await writeFile(path, Buffer.from('not an mp4'));
    await expect(
      validateProductReviewMp4(path, 'video/mp4', 'review.mp4'),
    ).rejects.toThrow('Review video MP4 container is invalid');
  });

  it('rejects a sparse video larger than 200 MB without loading it', async () => {
    const path = join(directory, 'video.upload');
    await writeFile(path, minimalMp4());
    await truncate(path, PRODUCT_REVIEW_VIDEO_MAX_BYTES + 1);
    await expect(
      validateProductReviewMp4(path, 'video/mp4', 'review.mp4'),
    ).rejects.toThrow('Review video exceeds 200 MB');
  });

  it('decodes and sanitizes JPEG cover content to WebP', async () => {
    const path = join(directory, 'cover.upload');
    await writeFile(
      path,
      await sharp({
        create: {
          width: 32,
          height: 24,
          channels: 3,
          background: '#228844',
        },
      })
        .jpeg()
        .toBuffer(),
    );
    const sanitized = await sanitizeProductReviewVideoCover(
      path,
      'image/jpeg',
      'cover.jpg',
    );
    expect(sanitized).toMatchObject({ width: 32, height: 24 });
    expect((await sharp(sanitized.buffer).metadata()).format).toBe('webp');
  });

  it('rejects invalid image content and MIME/extension mismatch', async () => {
    const path = join(directory, 'cover.upload');
    await writeFile(path, Buffer.from('not an image'));
    await expect(
      sanitizeProductReviewVideoCover(path, 'image/png', 'cover.png'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      sanitizeProductReviewVideoCover(path, 'image/jpeg', 'cover.png'),
    ).rejects.toThrow('Review video cover type is unsupported');
  });

  it('rejects a sparse cover larger than 5 MB before decoding', async () => {
    const path = join(directory, 'cover.upload');
    await writeFile(path, Buffer.from([0]));
    await truncate(path, PRODUCT_REVIEW_VIDEO_COVER_MAX_BYTES + 1);
    await expect(
      sanitizeProductReviewVideoCover(path, 'image/jpeg', 'cover.jpg'),
    ).rejects.toThrow('Review video cover exceeds 5 MB');
  });
});
