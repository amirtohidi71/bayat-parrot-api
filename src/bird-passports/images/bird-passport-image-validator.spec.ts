import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { validImage } from './bird-passport-image.test-fixtures';
import { sanitizeBirdPassportImage } from './bird-passport-image-validator';
import { BIRD_PASSPORT_IMAGE_MAX_BYTES } from './bird-passport-image.types';

describe('bird passport image validation and sanitization', () => {
  it.each([
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
  ] as const)(
    'fully decodes valid %s and emits canonical WebP',
    async (format, mime) => {
      const result = await sanitizeBirdPassportImage(
        await validImage(format),
        mime,
      );
      expect(result).toMatchObject({
        inputFormat: format,
        width: 32,
        height: 32,
      });
      expect((await sharp(result.buffer).metadata()).format).toBe('webp');
    },
  );

  it.each([
    [
      'SVG',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
    ],
    ['text', Buffer.from('hello')],
    ['executable', Buffer.from('MZ\0\0')],
    ['PDF', Buffer.from('%PDF-1.7')],
    ['zero byte', Buffer.alloc(0)],
  ])('rejects %s content', async (_name, buffer) => {
    await expect(sanitizeBirdPassportImage(buffer)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each(['jpeg', 'png', 'webp'] as const)(
    'rejects truncated %s after full decode',
    async (format) => {
      const input = await validImage(format);
      await expect(
        sanitizeBirdPassportImage(
          input.subarray(0, Math.floor(input.length / 2)),
        ),
      ).rejects.toThrow();
    },
  );

  it.each([
    ['jpeg bytes as PNG', 'jpeg', 'image/png'],
    ['PNG bytes as JPEG', 'png', 'image/jpeg'],
    ['WebP bytes as JPEG', 'webp', 'image/jpeg'],
  ] as const)('rejects MIME mismatch: %s', async (_name, format, mime) => {
    await expect(
      sanitizeBirdPassportImage(await validImage(format), mime),
    ).rejects.toThrow('MIME');
  });

  it('rejects unknown or malformed supplied MIME values', async () => {
    const input = await validImage('png');
    await expect(
      sanitizeBirdPassportImage(input, 'IMAGE/UNKNOWN'),
    ).rejects.toThrow('MIME');
    await expect(
      sanitizeBirdPassportImage(input, ' image/png '),
    ).rejects.toThrow('MIME');
  });

  it('rejects SVG even with an image MIME type', async () => {
    await expect(
      sanitizeBirdPassportImage(Buffer.from('<svg/>'), 'image/png'),
    ).rejects.toThrow();
  });

  it.each([
    [32, 32, true],
    [32, 40, true],
    [40, 32, true],
    [31, 32, false],
    [32, 31, false],
    [6000, 32, true],
    [32, 6000, true],
    [6001, 32, false],
    [32, 6001, false],
  ])('enforces dimension boundary %sx%s', async (width, height, accepted) => {
    const action = sanitizeBirdPassportImage(
      await validImage('png', width, height),
    );
    if (accepted)
      await expect(action).resolves.toMatchObject({ width, height });
    else await expect(action).rejects.toThrow('dimensions');
  });

  it('accepts a valid input whose buffer is exactly 5 MB and strips trailing bytes', async () => {
    const original = await validImage('jpeg');
    const marker = Buffer.from('private-trailing-marker');
    const padded = Buffer.concat([
      original,
      Buffer.alloc(
        BIRD_PASSPORT_IMAGE_MAX_BYTES - original.length - marker.length,
      ),
      marker,
    ]);
    const result = await sanitizeBirdPassportImage(padded, 'image/jpeg');
    expect(padded).toHaveLength(BIRD_PASSPORT_IMAGE_MAX_BYTES);
    expect(result.buffer.includes(marker)).toBe(false);
    expect((await sharp(result.buffer).metadata()).format).toBe('webp');
  });

  it('rejects 5 MB plus one byte before decode', async () => {
    await expect(
      sanitizeBirdPassportImage(
        Buffer.alloc(BIRD_PASSPORT_IMAGE_MAX_BYTES + 1),
      ),
    ).rejects.toThrow('exceeds 5 MB');
  });

  it('strips EXIF metadata while retaining decoded pixels', async () => {
    const source = await sharp(await validImage('jpeg'))
      .withExif({ IFD0: { Copyright: 'private-metadata-marker' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const result = await sanitizeBirdPassportImage(source, 'image/jpeg');
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.exif).toBeUndefined();
    expect(result.buffer.includes(Buffer.from('private-metadata-marker'))).toBe(
      false,
    );
  });
});
