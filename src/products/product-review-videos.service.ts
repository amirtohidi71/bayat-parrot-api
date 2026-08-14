import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { Product, ProductStatus } from './entities/product.entity';
import { ProductReviewVideo } from './entities/product-review-video.entity';
import {
  ProductReviewVideoResponse,
  toProductReviewVideoResponse,
} from './product-review-video-response';
import {
  PreparedProductReviewVideoMedia,
  ProductReviewVideoStorageService,
  ProductReviewVideoUploadFiles,
} from './media/product-review-video-storage.service';

export const PRODUCT_REVIEW_VIDEO_LIMIT = 10;

type ProductReviewVideosResponse = { items: ProductReviewVideoResponse[] };

@Injectable()
export class ProductReviewVideosService {
  private readonly logger = new Logger(ProductReviewVideosService.name);

  constructor(
    @InjectRepository(Product)
    private readonly products: Repository<Product>,
    @InjectRepository(ProductReviewVideo)
    private readonly reviewVideos: Repository<ProductReviewVideo>,
    private readonly dataSource: DataSource,
    private readonly storage: ProductReviewVideoStorageService,
  ) {}

  async findForAdmin(productId: string): Promise<ProductReviewVideosResponse> {
    await this.requireAdminProduct(productId);
    return this.toList(
      await this.reviewVideos.find({
        where: { productId },
        order: { displayOrder: 'ASC', id: 'ASC' },
      }),
    );
  }

  async findPublic(productId: string): Promise<ProductReviewVideosResponse> {
    const product = await this.products.findOne({
      where: { id: productId, status: ProductStatus.PUBLISHED },
      select: { id: true },
    });
    if (!product) throw productNotFound();
    return this.toList(
      await this.reviewVideos.find({
        where: { productId: product.id },
        order: { displayOrder: 'ASC', id: 'ASC' },
      }),
    );
  }

  async create(
    productId: string,
    files: ProductReviewVideoUploadFiles,
  ): Promise<ProductReviewVideoResponse> {
    let video: Express.Multer.File | undefined;
    let cover: Express.Multer.File | undefined;
    try {
      video = exactlyOne(files.video);
      cover = exactlyOne(files.cover);
    } catch (error) {
      await this.discardStaged(files);
      throw error;
    }
    if (!video || !cover) {
      await this.discardStaged(files);
      throw new BadRequestException(
        !video
          ? 'Review video file is required'
          : 'Review video cover is required',
      );
    }

    await this.requireAdminProduct(productId).catch(async (error) => {
      await this.discardStaged(files);
      throw error;
    });
    const media = await this.storage.prepareCreate(video, cover);
    try {
      const created = await this.dataSource.transaction(async (manager) => {
        await this.lockProductGroup(manager, productId);
        await this.requireTransactionProduct(manager, productId);
        const repository = manager.getRepository(ProductReviewVideo);
        const count = await repository.count({ where: { productId } });
        if (count >= PRODUCT_REVIEW_VIDEO_LIMIT) {
          throw new ConflictException(
            'A product can have at most 10 review videos',
          );
        }
        const latest = await repository.findOne({
          where: { productId },
          order: { displayOrder: 'DESC', id: 'DESC' },
          lock: { mode: 'pessimistic_write' },
        });
        return repository.save(
          repository.create({
            productId,
            videoPath: media.videoPath,
            coverPath: media.coverPath,
            videoMimeType: media.videoMimeType,
            displayOrder: latest ? latest.displayOrder + 1 : 0,
          }),
        );
      });
      return toProductReviewVideoResponse(created);
    } catch (error) {
      await this.removeNewMedia(media);
      this.rethrowSafe(error, 'Could not create product review video');
    }
  }

  async replace(
    productId: string,
    videoId: string,
    files: ProductReviewVideoUploadFiles,
  ): Promise<ProductReviewVideoResponse> {
    let hasVideo: boolean;
    let hasCover: boolean;
    try {
      hasVideo = Boolean(exactlyOne(files.video));
      hasCover = Boolean(exactlyOne(files.cover));
    } catch (error) {
      await this.discardStaged(files);
      throw error;
    }
    if (!hasVideo && !hasCover) {
      await this.discardStaged(files);
      throw new BadRequestException(
        'A replacement video or cover file is required',
      );
    }
    await this.requireAdminProduct(productId).catch(async (error) => {
      await this.discardStaged(files);
      throw error;
    });
    await this.requireBoundVideo(productId, videoId).catch(async (error) => {
      await this.discardStaged(files);
      throw error;
    });

    const prepared = await this.storage.prepareReplacement(files);
    const superseded: PreparedProductReviewVideoMedia = {};
    try {
      const updated = await this.dataSource.transaction(async (manager) => {
        await this.lockProductGroup(manager, productId);
        await this.requireTransactionProduct(manager, productId);
        const repository = manager.getRepository(ProductReviewVideo);
        const row = await repository.findOne({
          where: { id: videoId, productId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!row) throw videoNotFound();
        if (prepared.videoPath) {
          superseded.videoPath = row.videoPath;
          row.videoPath = prepared.videoPath;
          row.videoMimeType = prepared.videoMimeType!;
        }
        if (prepared.coverPath) {
          superseded.coverPath = row.coverPath;
          row.coverPath = prepared.coverPath;
        }
        return repository.save(row);
      });
      await this.removeSupersededMedia(superseded);
      return toProductReviewVideoResponse(updated);
    } catch (error) {
      await this.removeNewMedia(prepared);
      this.rethrowSafe(error, 'Could not replace product review video media');
    }
  }

  async remove(
    productId: string,
    videoId: string,
  ): Promise<ProductReviewVideosResponse> {
    let removedMedia: PreparedProductReviewVideoMedia = {};
    try {
      const remaining = await this.dataSource.transaction(async (manager) => {
        await this.lockProductGroup(manager, productId);
        await this.requireTransactionProduct(manager, productId);
        const repository = manager.getRepository(ProductReviewVideo);
        const row = await repository.findOne({
          where: { id: videoId, productId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!row) throw videoNotFound();
        removedMedia = {
          videoPath: row.videoPath,
          coverPath: row.coverPath,
        };
        await repository.delete({ id: row.id, productId });
        const rows = await repository.find({
          where: { productId },
          order: { displayOrder: 'ASC', id: 'ASC' },
          lock: { mode: 'pessimistic_write' },
        });
        rows.forEach((item, index) => {
          item.displayOrder = index;
        });
        if (rows.length) await repository.save(rows);
        return rows;
      });
      await this.removeSupersededMedia(removedMedia);
      return this.toList(remaining);
    } catch (error) {
      this.rethrowSafe(error, 'Could not delete product review video');
    }
  }

  async reorder(
    productId: string,
    orderedIds: string[],
  ): Promise<ProductReviewVideosResponse> {
    try {
      const ordered = await this.dataSource.transaction(async (manager) => {
        await this.lockProductGroup(manager, productId);
        await this.requireTransactionProduct(manager, productId);
        const repository = manager.getRepository(ProductReviewVideo);
        const current = await repository.find({
          where: { productId },
          order: { displayOrder: 'ASC', id: 'ASC' },
          lock: { mode: 'pessimistic_write' },
        });
        if (new Set(orderedIds).size !== orderedIds.length) {
          throw invalidOrder();
        }
        if (orderedIds.length !== current.length) throw invalidOrder();

        const submitted = orderedIds.length
          ? await repository.find({ where: { id: In(orderedIds) } })
          : [];
        if (
          submitted.length !== orderedIds.length ||
          submitted.some((row) => row.productId !== productId)
        ) {
          throw invalidOrder();
        }
        const byId = new Map(current.map((row) => [row.id, row]));
        const rows = orderedIds.map((id, index) => {
          const row = byId.get(id);
          if (!row) throw invalidOrder();
          row.displayOrder = index;
          return row;
        });
        if (rows.length) await repository.save(rows);
        return rows;
      });
      return this.toList(ordered);
    } catch (error) {
      this.rethrowSafe(error, 'Could not reorder product review videos');
    }
  }

  private async requireAdminProduct(productId: string): Promise<Product> {
    const product = await this.products.findOne({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw productNotFound();
    return product;
  }

  private async requireBoundVideo(
    productId: string,
    videoId: string,
  ): Promise<ProductReviewVideo> {
    const row = await this.reviewVideos.findOne({
      where: { id: videoId, productId },
    });
    if (!row) throw videoNotFound();
    return row;
  }

  private async requireTransactionProduct(
    manager: EntityManager,
    productId: string,
  ): Promise<void> {
    const product = await manager.getRepository(Product).findOne({
      where: { id: productId },
      select: { id: true },
      lock: { mode: 'pessimistic_read' },
    });
    if (!product) throw productNotFound();
  }

  private lockProductGroup(
    manager: EntityManager,
    productId: string,
  ): Promise<unknown> {
    return manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `product-review-videos:${productId}`,
    ]);
  }

  private toList(rows: ProductReviewVideo[]): ProductReviewVideosResponse {
    return { items: rows.map(toProductReviewVideoResponse) };
  }

  private async discardStaged(
    files: ProductReviewVideoUploadFiles,
  ): Promise<void> {
    await this.storage.discardStaged(files).catch(() => {
      this.logger.warn('Product review video staging cleanup failed');
    });
  }

  private async removeNewMedia(
    media: PreparedProductReviewVideoMedia,
  ): Promise<void> {
    await this.storage.removeStored(media).catch(() => {
      this.logger.warn('New product review video media cleanup failed');
    });
  }

  private async removeSupersededMedia(
    media: PreparedProductReviewVideoMedia,
  ): Promise<void> {
    await this.storage.removeStored(media).catch(() => {
      this.logger.warn('Superseded product review video media cleanup failed');
    });
  }

  private rethrowSafe(error: unknown, message: string): never {
    if (error instanceof HttpException) throw error;
    throw new InternalServerErrorException(message);
  }
}

function exactlyOne(
  files: Express.Multer.File[] | undefined,
): Express.Multer.File | undefined {
  if (!files?.length) return undefined;
  if (files.length !== 1) {
    throw new BadRequestException(
      'Exactly one file per upload field is allowed',
    );
  }
  return files[0];
}

function productNotFound(): NotFoundException {
  return new NotFoundException('Product not found');
}

function videoNotFound(): NotFoundException {
  return new NotFoundException('Product review video not found');
}

function invalidOrder(): BadRequestException {
  return new BadRequestException('Invalid product review video order');
}
