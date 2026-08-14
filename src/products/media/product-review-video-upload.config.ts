import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { StorageEngine } from 'multer';
import {
  PRODUCT_REVIEW_VIDEO_COVER_MAX_BYTES,
  PRODUCT_REVIEW_VIDEO_MAX_BYTES,
} from './product-review-video-validator';

export const PRODUCT_REVIEW_VIDEO_STAGING_DIR = join(
  process.cwd(),
  'var',
  'staging',
  'product-review-videos',
);

const COVER_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

type FieldAwareStorageOptions = {
  stagingDirectory?: string | (() => string);
  videoMaxBytes?: number;
  coverMaxBytes?: number;
};

export function createProductReviewVideoDiskStorage(
  options: FieldAwareStorageOptions = {},
): StorageEngine {
  const videoMaxBytes = options.videoMaxBytes ?? PRODUCT_REVIEW_VIDEO_MAX_BYTES;
  const coverMaxBytes =
    options.coverMaxBytes ?? PRODUCT_REVIEW_VIDEO_COVER_MAX_BYTES;
  const configuredStagingDirectory = options.stagingDirectory;
  const getStagingDirectory =
    typeof configuredStagingDirectory === 'function'
      ? configuredStagingDirectory
      : () =>
          resolve(
            configuredStagingDirectory ??
              (process.env.PRODUCT_REVIEW_VIDEO_STAGING_DIR?.trim() ||
                PRODUCT_REVIEW_VIDEO_STAGING_DIR),
          );

  return {
    _handleFile: (_request, file, callback) => {
      void (async () => {
        const stagingDirectory = getStagingDirectory();
        await mkdir(stagingDirectory, { recursive: true });
        const filename = `${randomUUID()}.upload`;
        const path = resolve(stagingDirectory, filename);
        const byteLimit =
          file.fieldname === 'cover' ? coverMaxBytes : videoMaxBytes;
        let size = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            size += chunk.length;
            if (size > byteLimit) {
              done(
                new PayloadTooLargeException(
                  file.fieldname === 'cover'
                    ? 'Review video cover exceeds 5 MB'
                    : 'Review video exceeds 200 MB',
                ),
              );
              return;
            }
            done(null, chunk);
          },
        });

        try {
          await pipeline(
            file.stream,
            limiter,
            createWriteStream(path, { flags: 'wx', mode: 0o600 }),
          );
          callback(null, {
            destination: stagingDirectory,
            filename,
            path,
            size,
          });
        } catch (error) {
          await rm(path, { force: true }).catch(() => undefined);
          callback(safeUploadError(error));
        }
      })().catch((error: unknown) => callback(safeUploadError(error)));
    },
    _removeFile: (_request, file, callback) => {
      const path = file.path;
      if (!path) {
        callback(null);
        return;
      }
      void rm(path, { force: true }).then(
        () => callback(null),
        () =>
          callback(
            new InternalServerErrorException('Could not clean staged upload'),
          ),
      );
    },
  };
}

export const productReviewVideoUploadOptions = {
  storage: createProductReviewVideoDiskStorage(),
  fileFilter: (
    _request: unknown,
    file: Express.Multer.File,
    callback: (error: Error | null, accept: boolean) => void,
  ) => {
    const extension = extname(file.originalname).toLowerCase();
    if (
      file.fieldname === 'video' &&
      extension === '.mp4' &&
      file.mimetype.toLowerCase() === 'video/mp4'
    ) {
      callback(null, true);
      return;
    }
    if (
      file.fieldname === 'cover' &&
      COVER_TYPES.get(extension) === file.mimetype.toLowerCase()
    ) {
      callback(null, true);
      return;
    }
    callback(
      new BadRequestException(
        file.fieldname === 'video'
          ? 'Review video must be an MP4 file'
          : 'Review video cover type is unsupported',
      ),
      false,
    );
  },
  limits: {
    fileSize: PRODUCT_REVIEW_VIDEO_MAX_BYTES,
    files: 2,
  },
};

export const productReviewVideoFileFields = [
  { name: 'video', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
];

function safeUploadError(error: unknown): Error {
  if (error instanceof HttpException) return error;
  return new InternalServerErrorException('Could not receive uploaded media');
}
