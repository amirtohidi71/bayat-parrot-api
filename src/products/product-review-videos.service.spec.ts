/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ProductReviewVideo } from './entities/product-review-video.entity';
import { Product, ProductStatus } from './entities/product.entity';
import { ProductReviewVideosService } from './product-review-videos.service';

const PRODUCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PRODUCT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function file(fieldname: 'video' | 'cover'): Express.Multer.File {
  return {
    fieldname,
    path: `${fieldname}.upload`,
    originalname: fieldname === 'video' ? 'video.mp4' : 'cover.jpg',
    mimetype: fieldname === 'video' ? 'video/mp4' : 'image/jpeg',
  } as Express.Multer.File;
}

const pair = () => ({ video: [file('video')], cover: [file('cover')] });

function fixture() {
  let counter = 0;
  const products = [
    { id: PRODUCT_ID, status: ProductStatus.PUBLISHED },
    { id: OTHER_PRODUCT_ID, status: ProductStatus.PENDING },
  ] as Product[];
  const rows: ProductReviewVideo[] = [];

  const productRepository = {
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        products.find(
          (product) =>
            product.id === where.id &&
            (where.status === undefined || product.status === where.status),
        ) ?? null,
    ),
  };
  const reviewVideoRepository = {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const matches = rows.filter((row) => matchesWhere(row, where));
      return (
        matches.sort(
          (left, right) =>
            right.displayOrder - left.displayOrder ||
            right.id.localeCompare(left.id),
        )[0] ?? null
      );
    }),
    find: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows
        .filter((row) => matchesWhere(row, where))
        .sort(
          (left, right) =>
            left.displayOrder - right.displayOrder ||
            left.id.localeCompare(right.id),
        ),
    ),
    count: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matchesWhere(row, where)).length,
    ),
    create: jest.fn((value: Partial<ProductReviewVideo>) => value),
    save: jest.fn(
      async (
        value: ProductReviewVideo | ProductReviewVideo[],
      ): Promise<ProductReviewVideo | ProductReviewVideo[]> => {
        const values = Array.isArray(value) ? value : [value];
        for (const row of values) {
          if (!row.id) {
            counter += 1;
            row.id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
          }
          if (!rows.includes(row)) rows.push(row);
        }
        return value;
      },
    ),
    delete: jest.fn(async (where: Record<string, unknown>) => {
      const index = rows.findIndex((row) => matchesWhere(row, where));
      if (index >= 0) rows.splice(index, 1);
      return { affected: index >= 0 ? 1 : 0 };
    }),
  };
  const manager = {
    query: jest.fn().mockResolvedValue(undefined),
    getRepository: jest.fn((entity: unknown) =>
      entity === Product ? productRepository : reviewVideoRepository,
    ),
  };
  let tail = Promise.resolve<unknown>(undefined);
  const dataSource = {
    transaction: jest.fn(
      <T>(work: (transactionManager: typeof manager) => Promise<T>) => {
        const result = tail.then(async () => {
          const snapshot = rows.map((row) => ({
            row,
            value: Object.assign(new ProductReviewVideo(), row),
          }));
          try {
            return await work(manager);
          } catch (error) {
            rows.splice(
              0,
              rows.length,
              ...snapshot.map(({ row, value }) => Object.assign(row, value)),
            );
            throw error;
          }
        });
        tail = result.catch(() => undefined);
        return result;
      },
    ),
  };
  const storage = {
    prepareCreate: jest.fn().mockResolvedValue({
      videoPath:
        'product-review-videos/videos/11111111-1111-4111-8111-111111111111.mp4',
      coverPath:
        'product-review-videos/covers/11111111-1111-4111-8111-111111111111.webp',
      videoMimeType: 'video/mp4',
    }),
    prepareReplacement: jest.fn(async (files: ReturnType<typeof pair>) => ({
      ...(files.video
        ? {
            videoPath:
              'product-review-videos/videos/22222222-2222-4222-8222-222222222222.mp4',
            videoMimeType: 'video/mp4',
          }
        : {}),
      ...(files.cover
        ? {
            coverPath:
              'product-review-videos/covers/22222222-2222-4222-8222-222222222222.webp',
          }
        : {}),
    })),
    discardStaged: jest.fn().mockResolvedValue(undefined),
    removeStored: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ProductReviewVideosService(
    productRepository as never,
    reviewVideoRepository as never,
    dataSource as never,
    storage as never,
  );

  function seed(
    productId = PRODUCT_ID,
    displayOrder = rows.filter((row) => row.productId === productId).length,
  ) {
    counter += 1;
    const suffix = String(counter).padStart(12, '0');
    const row = {
      id: `00000000-0000-4000-8000-${suffix}`,
      productId,
      videoPath: `product-review-videos/videos/00000000-0000-4000-8000-${suffix}.mp4`,
      coverPath: `product-review-videos/covers/00000000-0000-4000-8000-${suffix}.webp`,
      videoMimeType: 'video/mp4',
      displayOrder,
    } as ProductReviewVideo;
    rows.push(row);
    return row;
  }

  return {
    service,
    products,
    rows,
    seed,
    storage,
    dataSource,
    manager,
    reviewVideoRepository,
  };
}

function matchesWhere(
  row: ProductReviewVideo,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, value]) => {
    const actual = (row as unknown as Record<string, unknown>)[key];
    if (value && typeof value === 'object' && '_value' in value) {
      return (value as { _value: unknown[] })._value.includes(actual);
    }
    return actual === value;
  });
}

describe('ProductReviewVideosService', () => {
  it('creates sequential server-authoritative display orders', async () => {
    const value = fixture();
    value.seed();
    const created = await value.service.create(PRODUCT_ID, pair());
    expect(created.displayOrder).toBe(1);
    expect(created.videoUrl).toMatch(/^\/uploads\/product-review-videos/);
    expect(value.manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`product-review-videos:${PRODUCT_ID}`],
    );
  });

  it('serializes concurrent creates and allocates distinct orders', async () => {
    const value = fixture();
    value.storage.prepareCreate
      .mockResolvedValueOnce({
        videoPath:
          'product-review-videos/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4',
        coverPath:
          'product-review-videos/covers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
        videoMimeType: 'video/mp4',
      })
      .mockResolvedValueOnce({
        videoPath:
          'product-review-videos/videos/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4',
        coverPath:
          'product-review-videos/covers/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp',
        videoMimeType: 'video/mp4',
      });
    const created = await Promise.all([
      value.service.create(PRODUCT_ID, pair()),
      value.service.create(PRODUCT_ID, pair()),
    ]);
    expect(created.map((row) => row.displayOrder)).toEqual([0, 1]);
  });

  it('enforces the ten-video limit and cleans newly prepared files', async () => {
    const value = fixture();
    for (let index = 0; index < 10; index += 1) value.seed();
    await expect(
      value.service.create(PRODUCT_ID, pair()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(value.storage.removeStored).toHaveBeenCalled();
    expect(value.rows).toHaveLength(10);
  });

  it.each([
    ['video', { cover: [file('cover')] }],
    ['cover', { video: [file('video')] }],
  ])(
    'rejects a missing %s and cleans staged uploads',
    async (_field, files) => {
      const value = fixture();
      await expect(
        value.service.create(PRODUCT_ID, files),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(value.storage.discardStaged).toHaveBeenCalledWith(files);
    },
  );

  it('cleans prepared files when DB persistence fails', async () => {
    const value = fixture();
    value.reviewVideoRepository.save.mockRejectedValueOnce(
      new Error('private database detail'),
    );
    await expect(value.service.create(PRODUCT_ID, pair())).rejects.toThrow(
      'Could not create product review video',
    );
    expect(value.storage.removeStored).toHaveBeenCalledWith(
      expect.objectContaining({ videoMimeType: 'video/mp4' }),
    );
  });

  it('rejects an unknown product before preparing permanent media', async () => {
    const value = fixture();
    await expect(
      value.service.create('cccccccc-cccc-4ccc-8ccc-cccccccccccc', pair()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(value.storage.prepareCreate).not.toHaveBeenCalled();
    expect(value.storage.discardStaged).toHaveBeenCalled();
  });

  it('replaces one file, commits metadata, then removes only the superseded file', async () => {
    const value = fixture();
    const existing = value.seed();
    const originalCover = existing.coverPath;
    const response = await value.service.replace(PRODUCT_ID, existing.id, {
      video: [file('video')],
    });
    expect(response.videoUrl).toContain('22222222-2222-4222-8222-222222222222');
    expect(existing.coverPath).toBe(originalCover);
    expect(value.storage.removeStored).toHaveBeenCalledWith({
      videoPath: expect.stringContaining(existing.id),
    });
  });

  it('replaces and sanitizes a cover without changing the working video', async () => {
    const value = fixture();
    const existing = value.seed();
    const originalVideo = existing.videoPath;

    const response = await value.service.replace(PRODUCT_ID, existing.id, {
      cover: [file('cover')],
    });

    expect(response.coverUrl).toContain('22222222-2222-4222-8222-222222222222');
    expect(existing.videoPath).toBe(originalVideo);
    expect(value.storage.removeStored).toHaveBeenCalledWith({
      coverPath: expect.stringContaining(existing.id),
    });
  });

  it('rolls back metadata and removes new media when replacement persistence fails', async () => {
    const value = fixture();
    const existing = value.seed();
    const before = {
      videoPath: existing.videoPath,
      coverPath: existing.coverPath,
    };
    value.reviewVideoRepository.save.mockRejectedValueOnce(
      new Error('private database detail'),
    );

    await expect(
      value.service.replace(PRODUCT_ID, existing.id, {
        video: [file('video')],
        cover: [file('cover')],
      }),
    ).rejects.toThrow('Could not replace product review video media');

    expect(existing).toMatchObject(before);
    expect(value.storage.removeStored).toHaveBeenCalledWith(
      expect.objectContaining({
        videoPath: expect.stringContaining('22222222'),
        coverPath: expect.stringContaining('22222222'),
      }),
    );
  });

  it('preserves the old row when replacement validation fails', async () => {
    const value = fixture();
    const existing = value.seed();
    const before = {
      videoPath: existing.videoPath,
      coverPath: existing.coverPath,
    };
    value.storage.prepareReplacement.mockRejectedValueOnce(
      new BadRequestException('Review video MP4 container is invalid'),
    );
    await expect(
      value.service.replace(PRODUCT_ID, existing.id, {
        video: [file('video')],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(existing).toMatchObject(before);
    expect(value.reviewVideoRepository.save).not.toHaveBeenCalled();
  });

  it('prevents managing a video through another product ID', async () => {
    const value = fixture();
    const foreign = value.seed(OTHER_PRODUCT_ID);
    await expect(
      value.service.replace(PRODUCT_ID, foreign.id, {
        cover: [file('cover')],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(value.storage.prepareReplacement).not.toHaveBeenCalled();
  });

  it('returns a safe error for an unknown video ID', async () => {
    const value = fixture();
    await expect(
      value.service.remove(PRODUCT_ID, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes the bound row, normalizes remaining order and contains file cleanup failure', async () => {
    const value = fixture();
    const first = value.seed(PRODUCT_ID, 4);
    const second = value.seed(PRODUCT_ID, 9);
    value.storage.removeStored.mockRejectedValueOnce(new Error('private path'));
    await expect(value.service.remove(PRODUCT_ID, first.id)).resolves.toEqual({
      items: [expect.objectContaining({ id: second.id, displayOrder: 0 })],
    });
    expect(value.rows).toEqual([
      expect.objectContaining({ id: second.id, displayOrder: 0 }),
    ]);
  });

  it('atomically reorders the exact product-bound set to 0..n-1', async () => {
    const value = fixture();
    const first = value.seed();
    const second = value.seed();
    const reordered = await value.service.reorder(PRODUCT_ID, [
      second.id,
      first.id,
    ]);
    expect(reordered.items.map((row) => [row.id, row.displayOrder])).toEqual([
      [second.id, 0],
      [first.id, 1],
    ]);
  });

  it.each([
    [
      'duplicates',
      (value: ReturnType<typeof fixture>) => {
        const first = value.seed();
        value.seed();
        return [first.id, first.id];
      },
    ],
    [
      'missing IDs',
      (value: ReturnType<typeof fixture>) => {
        value.seed();
        return [];
      },
    ],
    [
      'foreign IDs',
      (value: ReturnType<typeof fixture>) => {
        const local = value.seed();
        value.seed();
        const foreign = value.seed(OTHER_PRODUCT_ID);
        return [local.id, foreign.id];
      },
    ],
  ])('rejects reorder payload with %s', async (_label, buildIds) => {
    const value = fixture();
    await expect(
      value.service.reorder(PRODUCT_ID, buildIds(value)),
    ).rejects.toThrow('Invalid product review video order');
  });

  it('returns only ordered mapped records for a published product', async () => {
    const value = fixture();
    value.seed(PRODUCT_ID, 2);
    value.seed(PRODUCT_ID, 0);
    const response = await value.service.findPublic(PRODUCT_ID);
    expect(response.items.map((row) => row.displayOrder)).toEqual([0, 2]);
    expect(JSON.stringify(response)).not.toMatch(
      /videoPath|coverPath|videoMimeType|createdAt|updatedAt/,
    );
  });

  it('returns an exact empty list and hides non-published products', async () => {
    const value = fixture();
    await expect(value.service.findPublic(PRODUCT_ID)).resolves.toEqual({
      items: [],
    });
    value.seed(OTHER_PRODUCT_ID);
    await expect(
      value.service.findPublic(OTHER_PRODUCT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
