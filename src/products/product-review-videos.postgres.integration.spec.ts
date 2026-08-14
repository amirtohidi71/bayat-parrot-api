import { BadRequestException, ConflictException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { ProductReviewVideo } from './entities/product-review-video.entity';
import { ProductReview } from './entities/product-review.entity';
import { Product } from './entities/product.entity';
import { ProductReviewVideosService } from './product-review-videos.service';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const enabled =
  process.env.PRODUCT_REVIEW_VIDEO_RUN_DB_TESTS === '1' &&
  process.env.PRODUCT_REVIEW_VIDEO_TEST_DATABASE_CONFIRM === 'DISPOSABLE';
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase('Product Review Videos PostgreSQL integration', () => {
  let dataSource: DataSource;
  let service: ProductReviewVideosService;
  let mediaCounter = 0;

  const storage = {
    prepareCreate: jest.fn(() => {
      mediaCounter += 1;
      const id = `00000000-0000-4000-8000-${String(mediaCounter).padStart(12, '0')}`;
      return {
        videoPath: `product-review-videos/videos/${id}.mp4`,
        coverPath: `product-review-videos/covers/${id}.webp`,
        videoMimeType: 'video/mp4' as const,
      };
    }),
    prepareReplacement: jest.fn(),
    discardStaged: jest.fn().mockResolvedValue(undefined),
    removeStored: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const url = requireDisposableDatabaseUrl();
    dataSource = new DataSource({
      type: 'postgres',
      url,
      entities: [Product, ProductReview, ProductReviewVideo, User],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    const [identity] = await dataSource.query<
      Array<{ database: string; server: string }>
    >(
      'SELECT current_database() AS database, inet_server_addr()::text AS server',
    );
    if (!identity?.database || !/(test|disposable)/i.test(identity.database)) {
      throw new Error(
        'Refusing to use a database not named as test/disposable',
      );
    }

    await resetDisposableSchema();
    const migration = (
      await readFile(
        resolve(
          process.cwd(),
          'scripts',
          'migrations',
          '20260813-create-product-review-videos.sql',
        ),
        'utf8',
      )
    ).replace(/^\\set[^\r\n]*(?:\r?\n)?/, '');
    await dataSource.query(migration);
    await dataSource.query(migration);
    await dataSource.query(
      'INSERT INTO public.products (id) VALUES ($1), ($2)',
      [PRODUCT_ID, OTHER_PRODUCT_ID],
    );

    service = new ProductReviewVideosService(
      dataSource.getRepository(Product),
      dataSource.getRepository(ProductReviewVideo),
      dataSource,
      storage as never,
    );
  }, 60_000);

  beforeEach(async () => {
    mediaCounter = 0;
    jest.clearAllMocks();
    await dataSource.query('TRUNCATE TABLE public.product_review_videos');
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.query(
      'DROP TABLE IF EXISTS public.product_review_videos CASCADE',
    );
    await dataSource.query('DROP TABLE IF EXISTS public.products CASCADE');
    await dataSource.destroy();
  });

  it('runs the migration twice and exposes the Entity-compatible strict schema', async () => {
    const columns = await dataSource.query<
      Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>
    >(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'product_review_videos'
       ORDER BY ordinal_position`,
    );
    expect(columns).toEqual([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'productId', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'videoPath', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'coverPath', data_type: 'text', is_nullable: 'NO' },
      {
        column_name: 'videoMimeType',
        data_type: 'character varying',
        is_nullable: 'NO',
      },
      { column_name: 'displayOrder', data_type: 'integer', is_nullable: 'NO' },
      {
        column_name: 'createdAt',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
      {
        column_name: 'updatedAt',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
    ]);
    const [{ constraints, indexes }] = await dataSource.query<
      Array<{ constraints: number; indexes: number }>
    >(
      `SELECT
         (SELECT count(*)::int FROM pg_constraint
          WHERE conrelid = 'public.product_review_videos'::regclass) AS constraints,
         (SELECT count(*)::int FROM pg_index
          WHERE indrelid = 'public.product_review_videos'::regclass) AS indexes`,
    );
    expect({ constraints, indexes }).toEqual({ constraints: 3, indexes: 4 });
  });

  it('serializes concurrent creates and cannot exceed ten rows', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        service.create(PRODUCT_ID, uploadPair()),
      ),
    );
    expect(
      attempts.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(10);
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(2);
    expect(
      rejected.every((result) => result.reason instanceof ConflictException),
    ).toBe(true);
    const rows = await dataSource.getRepository(ProductReviewVideo).find({
      where: { productId: PRODUCT_ID },
      order: { displayOrder: 'ASC', id: 'ASC' },
    });
    expect(rows.map((row) => row.displayOrder)).toEqual(
      Array.from({ length: 10 }, (_, index) => index),
    );
  });

  it('keeps concurrent reorder results normalized and server-authoritative', async () => {
    await Promise.all(
      Array.from({ length: 5 }, () => service.create(PRODUCT_ID, uploadPair())),
    );
    const initial = await dataSource.getRepository(ProductReviewVideo).find({
      where: { productId: PRODUCT_ID },
      order: { displayOrder: 'ASC', id: 'ASC' },
    });
    const reverse = initial.map((row) => row.id).reverse();
    const rotate = [...reverse.slice(1), reverse[0]];
    await Promise.all([
      service.reorder(PRODUCT_ID, reverse),
      service.reorder(PRODUCT_ID, rotate),
    ]);
    const finalRows = await dataSource.getRepository(ProductReviewVideo).find({
      where: { productId: PRODUCT_ID },
      order: { displayOrder: 'ASC', id: 'ASC' },
    });
    expect(finalRows.map((row) => row.displayOrder)).toEqual([0, 1, 2, 3, 4]);
    expect([reverse, rotate]).toContainEqual(finalRows.map((row) => row.id));
  });

  it('rejects a foreign-product video ID with real repository behavior', async () => {
    await Promise.all([
      service.create(PRODUCT_ID, uploadPair()),
      service.create(PRODUCT_ID, uploadPair()),
      service.create(OTHER_PRODUCT_ID, uploadPair()),
    ]);
    const local = await dataSource.getRepository(ProductReviewVideo).find({
      where: { productId: PRODUCT_ID },
      order: { displayOrder: 'ASC' },
    });
    const [foreign] = await dataSource.getRepository(ProductReviewVideo).find({
      where: { productId: OTHER_PRODUCT_ID },
    });
    await expect(
      service.reorder(PRODUCT_ID, [local[0].id, foreign.id]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  async function resetDisposableSchema(): Promise<void> {
    await dataSource.query(
      'DROP TABLE IF EXISTS public.product_review_videos CASCADE',
    );
    await dataSource.query('DROP TABLE IF EXISTS public.products CASCADE');
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await dataSource.query(
      'CREATE TABLE public.products (id uuid PRIMARY KEY, "deletedAt" timestamptz NULL)',
    );
  }
});

function requireDisposableDatabaseUrl(): string {
  const url = process.env.PRODUCT_REVIEW_VIDEO_TEST_DATABASE_URL?.trim();
  if (!url)
    throw new Error('PRODUCT_REVIEW_VIDEO_TEST_DATABASE_URL is required');
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!/(test|disposable)/i.test(databaseName)) {
    throw new Error('Test database name must contain test or disposable');
  }
  return url;
}

function uploadPair() {
  return {
    video: [{ fieldname: 'video' } as Express.Multer.File],
    cover: [{ fieldname: 'cover' } as Express.Multer.File],
  };
}
