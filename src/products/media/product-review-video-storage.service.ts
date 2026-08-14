import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  sanitizeProductReviewVideoCover,
  validateProductReviewMp4,
} from './product-review-video-validator';

const VIDEO_KEY_PATTERN =
  /^product-review-videos\/videos\/[0-9a-f-]{36}\.mp4$/i;
const COVER_KEY_PATTERN =
  /^product-review-videos\/covers\/[0-9a-f-]{36}\.webp$/i;
export const PRODUCT_REVIEW_VIDEO_UPLOAD_ROOT = Symbol(
  'PRODUCT_REVIEW_VIDEO_UPLOAD_ROOT',
);

export type ProductReviewVideoUploadFiles = {
  video?: Express.Multer.File[];
  cover?: Express.Multer.File[];
};

export type PreparedProductReviewVideoMedia = {
  videoPath?: string;
  coverPath?: string;
  videoMimeType?: 'video/mp4';
};

@Injectable()
export class ProductReviewVideoStorageService {
  private readonly logger = new Logger(ProductReviewVideoStorageService.name);
  private readonly uploadRoot: string;
  private readonly videoDirectory: string;
  private readonly coverDirectory: string;

  constructor(
    @Optional()
    @Inject(PRODUCT_REVIEW_VIDEO_UPLOAD_ROOT)
    uploadRoot?: string,
  ) {
    this.uploadRoot = resolve(
      uploadRoot ?? resolve(process.cwd(), 'public', 'uploads'),
    );
    this.videoDirectory = resolve(
      this.uploadRoot,
      'product-review-videos',
      'videos',
    );
    this.coverDirectory = resolve(
      this.uploadRoot,
      'product-review-videos',
      'covers',
    );
  }

  async prepareCreate(
    video: Express.Multer.File,
    cover: Express.Multer.File,
  ): Promise<Required<PreparedProductReviewVideoMedia>> {
    let prepared: PreparedProductReviewVideoMedia = {};
    try {
      prepared = await this.prepareReplacement({
        video: [video],
        cover: [cover],
      });
      return {
        videoPath: prepared.videoPath!,
        coverPath: prepared.coverPath!,
        videoMimeType: 'video/mp4',
      };
    } catch (error) {
      await this.removeStored(prepared).catch(() => undefined);
      await this.discardStaged({ video: [video], cover: [cover] });
      throw error;
    }
  }

  async prepareReplacement(
    files: ProductReviewVideoUploadFiles,
  ): Promise<PreparedProductReviewVideoMedia> {
    const video = singleFile(files.video, 'video');
    const cover = singleFile(files.cover, 'cover');
    const prepared: PreparedProductReviewVideoMedia = {};
    try {
      await this.ensureDirectories();
      if (video) {
        await validateProductReviewMp4(
          video.path,
          video.mimetype,
          video.originalname,
        );
        const name = `${randomUUID()}.mp4`;
        const destination = resolve(this.videoDirectory, name);
        await rename(video.path, destination);
        prepared.videoPath = `product-review-videos/videos/${name}`;
        prepared.videoMimeType = 'video/mp4';
      }
      if (cover) {
        const sanitized = await sanitizeProductReviewVideoCover(
          cover.path,
          cover.mimetype,
          cover.originalname,
        );
        const name = `${randomUUID()}.webp`;
        const destination = resolve(this.coverDirectory, name);
        await writeFile(destination, sanitized.buffer, {
          flag: 'wx',
          mode: 0o644,
        });
        prepared.coverPath = `product-review-videos/covers/${name}`;
      }
      return prepared;
    } catch (error) {
      await this.removeStored(prepared).catch(() => undefined);
      if (
        error instanceof BadRequestException ||
        error instanceof InternalServerErrorException
      ) {
        throw error;
      }
      throw new InternalServerErrorException(
        'Could not store product review video media',
      );
    } finally {
      await this.discardStaged(files);
    }
  }

  async discardStaged(files: ProductReviewVideoUploadFiles): Promise<void> {
    const paths = [...(files.video ?? []), ...(files.cover ?? [])].map(
      (file) => file.path,
    );
    const results = await Promise.allSettled(
      paths.map((path) => rm(path, { force: true })),
    );
    if (results.some((result) => result.status === 'rejected')) {
      this.logger.warn('Product review video staging cleanup failed');
    }
  }

  async removeStored(media: PreparedProductReviewVideoMedia): Promise<void> {
    const keys = [media.videoPath, media.coverPath].filter(
      (key): key is string => Boolean(key),
    );
    await Promise.all(keys.map((key) => this.removeKey(key)));
  }

  private async removeKey(key: string): Promise<void> {
    if (!VIDEO_KEY_PATTERN.test(key) && !COVER_KEY_PATTERN.test(key)) {
      throw new InternalServerErrorException(
        'Invalid product review video storage key',
      );
    }
    await rm(resolve(this.uploadRoot, ...key.split('/')), { force: true });
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.videoDirectory, { recursive: true }),
      mkdir(this.coverDirectory, { recursive: true }),
    ]);
  }
}

function singleFile(
  files: Express.Multer.File[] | undefined,
  field: string,
): Express.Multer.File | undefined {
  if (!files?.length) return undefined;
  if (files.length !== 1) {
    throw new BadRequestException(`Exactly one ${field} file is allowed`);
  }
  return files[0];
}
