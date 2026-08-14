import { BadRequestException } from '@nestjs/common';
import { FileHandle, open, readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import sharp, { Metadata } from 'sharp';

export const PRODUCT_REVIEW_VIDEO_MAX_BYTES = 200 * 1024 * 1024;
export const PRODUCT_REVIEW_VIDEO_COVER_MAX_BYTES = 5 * 1024 * 1024;
const PRODUCT_REVIEW_VIDEO_COVER_MAX_PIXELS = 40_000_000;
const MAX_TOP_LEVEL_BOXES = 10_000;
const MAX_MP4_NESTING_DEPTH = 8;

const MP4_BRANDS = new Set([
  'avc1',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'isom',
  'M4V ',
  'mp41',
  'mp42',
]);

const COVER_MIME_BY_FORMAT: Record<'jpeg' | 'png' | 'webp', string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export type SanitizedProductReviewVideoCover = {
  buffer: Buffer;
  width: number;
  height: number;
};

type Mp4Box = {
  type: string;
  contentStart: number;
  end: number;
};

type Mp4ParseBudget = { boxes: number };

export async function validateProductReviewMp4(
  filePath: string,
  declaredMimeType: string,
  originalName: string,
): Promise<void> {
  if (
    declaredMimeType.toLowerCase() !== 'video/mp4' ||
    extname(originalName).toLowerCase() !== '.mp4'
  ) {
    throw new BadRequestException('Review video must be an MP4 file');
  }

  const handle = await open(filePath, 'r').catch(() => {
    throw new BadRequestException('Review video content is invalid');
  });
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size === 0) {
      throw new BadRequestException('Review video content is invalid');
    }
    if (fileStat.size > PRODUCT_REVIEW_VIDEO_MAX_BYTES) {
      throw new BadRequestException('Review video exceeds 200 MB');
    }

    const budget: Mp4ParseBudget = { boxes: 0 };
    const topLevel = await readMp4Boxes(
      handle,
      0,
      fileStat.size,
      0,
      budget,
      true,
    );
    const ftypBoxes = topLevel.filter((box) => box.type === 'ftyp');
    const moovBoxes = topLevel.filter((box) => box.type === 'moov');
    const hasMdat = topLevel.some((box) => box.type === 'mdat');

    if (ftypBoxes.length !== 1 || moovBoxes.length < 1 || !hasMdat) {
      invalidMp4();
    }
    await validateFtyp(handle, ftypBoxes[0]);

    let hasVideoTrack = false;
    for (const moov of moovBoxes) {
      if (await moovDeclaresVideoTrack(handle, moov, budget)) {
        hasVideoTrack = true;
        break;
      }
    }
    if (!hasVideoTrack) invalidMp4();
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('Review video content is invalid');
  } finally {
    await handle.close();
  }
}

async function readMp4Boxes(
  handle: FileHandle,
  start: number,
  end: number,
  depth: number,
  budget: Mp4ParseBudget,
  allowFinalTopLevelMdatSizeZero = false,
): Promise<Mp4Box[]> {
  if (
    depth > MAX_MP4_NESTING_DEPTH ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    invalidMp4();
  }

  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) invalidMp4();
    budget.boxes += 1;
    if (budget.boxes > MAX_TOP_LEVEL_BOXES) invalidMp4();

    const header = Buffer.alloc(16);
    await readExactly(handle, header, 0, 8, offset);
    const size32 = header.readUInt32BE(0);
    const type = header.toString('ascii', 4, 8);
    if (!/^[\x20-\x7e]{4}$/.test(type)) invalidMp4();

    let headerSize = 8;
    let boxSize: number;
    if (size32 === 1) {
      if (end - offset < 16) invalidMp4();
      await readExactly(handle, header, 8, 8, offset + 8);
      const extendedSize = header.readBigUInt64BE(8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) invalidMp4();
      boxSize = Number(extendedSize);
      headerSize = 16;
    } else if (size32 === 0) {
      if (!allowFinalTopLevelMdatSizeZero || depth !== 0 || type !== 'mdat') {
        invalidMp4();
      }
      boxSize = end - offset;
    } else {
      boxSize = size32;
    }

    if (boxSize < headerSize || boxSize > end - offset) invalidMp4();
    const boxEnd = offset + boxSize;
    if (!Number.isSafeInteger(boxEnd) || boxEnd <= offset) invalidMp4();
    boxes.push({ type, contentStart: offset + headerSize, end: boxEnd });
    offset = boxEnd;
  }
  if (offset !== end) invalidMp4();
  return boxes;
}

async function validateFtyp(handle: FileHandle, box: Mp4Box): Promise<void> {
  const contentLength = box.end - box.contentStart;
  if (contentLength < 8 || contentLength > 1024 * 1024) invalidMp4();
  const brandData = Buffer.alloc(contentLength);
  await readExactly(handle, brandData, 0, contentLength, box.contentStart);
  const brands = [brandData.toString('ascii', 0, 4)];
  for (let index = 8; index + 4 <= brandData.length; index += 4) {
    brands.push(brandData.toString('ascii', index, index + 4));
  }
  if (!brands.some((brand) => MP4_BRANDS.has(brand))) invalidMp4();
}

async function moovDeclaresVideoTrack(
  handle: FileHandle,
  moov: Mp4Box,
  budget: Mp4ParseBudget,
): Promise<boolean> {
  const moovChildren = await readMp4Boxes(
    handle,
    moov.contentStart,
    moov.end,
    1,
    budget,
  );
  for (const trak of moovChildren.filter((box) => box.type === 'trak')) {
    const trakChildren = await readMp4Boxes(
      handle,
      trak.contentStart,
      trak.end,
      2,
      budget,
    );
    for (const mdia of trakChildren.filter((box) => box.type === 'mdia')) {
      const mdiaChildren = await readMp4Boxes(
        handle,
        mdia.contentStart,
        mdia.end,
        3,
        budget,
      );
      for (const hdlr of mdiaChildren.filter((box) => box.type === 'hdlr')) {
        if (await isVideoHandler(handle, hdlr)) return true;
      }
    }
  }
  return false;
}

async function isVideoHandler(
  handle: FileHandle,
  hdlr: Mp4Box,
): Promise<boolean> {
  if (hdlr.end - hdlr.contentStart < 12) invalidMp4();
  const handlerType = Buffer.alloc(4);
  await readExactly(handle, handlerType, 0, 4, hdlr.contentStart + 8);
  return handlerType.toString('ascii') === 'vide';
}

async function readExactly(
  handle: FileHandle,
  buffer: Buffer,
  bufferOffset: number,
  length: number,
  filePosition: number,
): Promise<void> {
  const result = await handle.read(buffer, bufferOffset, length, filePosition);
  if (result.bytesRead !== length) invalidMp4();
}

export async function sanitizeProductReviewVideoCover(
  filePath: string,
  declaredMimeType: string,
  originalName: string,
): Promise<SanitizedProductReviewVideoCover> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size === 0) {
    throw new BadRequestException('Review video cover content is invalid');
  }
  if (fileStat.size > PRODUCT_REVIEW_VIDEO_COVER_MAX_BYTES) {
    throw new BadRequestException('Review video cover exceeds 5 MB');
  }

  const extension = extname(originalName).toLowerCase();
  const expectedMime =
    extension === '.jpg' || extension === '.jpeg'
      ? 'image/jpeg'
      : extension === '.png'
        ? 'image/png'
        : extension === '.webp'
          ? 'image/webp'
          : undefined;
  if (!expectedMime || declaredMimeType.toLowerCase() !== expectedMime) {
    throw new BadRequestException('Review video cover type is unsupported');
  }

  try {
    const input = await readFile(filePath);
    const decoder = sharp(input, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: PRODUCT_REVIEW_VIDEO_COVER_MAX_PIXELS,
      sequentialRead: true,
    });
    const metadata = await decoder.metadata();
    const format = assertCoverMetadata(metadata);
    if (COVER_MIME_BY_FORMAT[format] !== expectedMime) {
      throw new BadRequestException('Review video cover MIME type mismatch');
    }
    const { data, info } = await decoder
      .clone()
      .autoOrient()
      .webp({ quality: 85, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (!data.length || data.length > PRODUCT_REVIEW_VIDEO_COVER_MAX_BYTES) {
      throw new BadRequestException('Sanitized review video cover is invalid');
    }
    return { buffer: data, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(
      'Review video cover content is invalid or unsupported',
    );
  }
}

function assertCoverMetadata(metadata: Metadata): 'jpeg' | 'png' | 'webp' {
  if (!metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
    throw new BadRequestException('Review video cover type is unsupported');
  }
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > PRODUCT_REVIEW_VIDEO_COVER_MAX_PIXELS ||
    (metadata.pages ?? 1) !== 1 ||
    (metadata.pageHeight && metadata.pageHeight !== metadata.height)
  ) {
    throw new BadRequestException('Review video cover dimensions are invalid');
  }
  return metadata.format as 'jpeg' | 'png' | 'webp';
}

function invalidMp4(): never {
  throw new BadRequestException('Review video MP4 container is invalid');
}
