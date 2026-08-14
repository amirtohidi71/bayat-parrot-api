/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {
  BadRequestException,
  ConflictException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AdminController } from '../admin/admin.controller';
import { AdminService } from '../admin/admin.service';
import {
  ADMIN_PANEL_SCOPE,
  AdminAuthGuard,
} from '../admin/guards/admin-auth.guard';
import {
  GOD_ADMIN_PANEL_SCOPE,
  GOD_ADMIN_ROLE,
} from '../admin/guards/god-admin-auth.guard';
import { ProductReviewVideoUploadInterceptor } from './media/product-review-video-upload.interceptor';
import { PRODUCT_REVIEW_VIDEO_MAX_BYTES } from './media/product-review-video-validator';
import { validateProductReviewMp4 } from './media/product-review-video-validator';
import type { ProductReviewVideoUploadFiles } from './media/product-review-video-storage.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { ProductReviewVideosService } from './product-review-videos.service';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const VIDEO_ID = '22222222-2222-4222-8222-222222222222';
const TEST_SECRET = 'product-review-video-http-test-secret';

function box(type: string, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function validMp4(): Buffer {
  const handler = box(
    'hdlr',
    Buffer.concat([Buffer.alloc(8), Buffer.from('vide'), Buffer.alloc(12)]),
  );
  return Buffer.concat([
    box(
      'ftyp',
      Buffer.concat([
        Buffer.from('isom'),
        Buffer.alloc(4),
        Buffer.from('mp42'),
      ]),
    ),
    box('moov', box('trak', box('mdia', handler))),
    box('mdat', Buffer.from([1])),
  ]);
}

type PublicMode = 'empty' | 'not-found';

describe('Product Review Videos HTTP contract', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let adminToken: string;
  let userToken: string;
  let godAdminToken: string;
  let staging: string;
  let originalStaging: string | undefined;
  let maxReached = false;
  let crossProduct = false;
  let publicMode: PublicMode = 'empty';

  const reviewVideos = {
    findForAdmin: jest.fn().mockResolvedValue({ items: [] }),
    create: jest.fn(
      async (_productId: string, files: ProductReviewVideoUploadFiles) => {
        const video = files.video?.[0];
        const cover = files.cover?.[0];
        if (!video)
          throw new BadRequestException('Review video file is required');
        if (!cover) {
          throw new BadRequestException('Review video cover is required');
        }
        await validateProductReviewMp4(
          video.path,
          video.mimetype,
          video.originalname,
        );
        if (maxReached) {
          throw new ConflictException(
            'A product can have at most 10 review videos',
          );
        }
        return response();
      },
    ),
    replace: jest.fn(
      (
        _productId: string,
        _videoId: string,
        files: ProductReviewVideoUploadFiles,
      ) => {
        if (crossProduct) {
          throw new NotFoundException('Product review video not found');
        }
        if (!files.video?.length && !files.cover?.length) {
          throw new BadRequestException(
            'A replacement video or cover file is required',
          );
        }
        return response();
      },
    ),
    remove: jest.fn(() => {
      if (crossProduct) {
        throw new NotFoundException('Product review video not found');
      }
      return { items: [] };
    }),
    reorder: jest.fn().mockResolvedValue({ items: [response()] }),
    findPublic: jest.fn(() => {
      if (publicMode === 'not-found')
        throw new NotFoundException('Product not found');
      return { items: [] };
    }),
  };

  beforeAll(async () => {
    staging = await mkdtemp(join(tmpdir(), 'review-video-http-'));
    originalStaging = process.env.PRODUCT_REVIEW_VIDEO_STAGING_DIR;
    process.env.PRODUCT_REVIEW_VIDEO_STAGING_DIR = staging;
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_SECRET })],
      controllers: [AdminController, ProductsController],
      providers: [
        AdminAuthGuard,
        ProductReviewVideoUploadInterceptor,
        { provide: AdminService, useValue: {} },
        { provide: ProductsService, useValue: {} },
        { provide: ProductReviewVideosService, useValue: reviewVideos },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    jwt = moduleRef.get(JwtService);
    adminToken = jwt.sign({ scope: ADMIN_PANEL_SCOPE, username: 'editor' });
    userToken = jwt.sign({ scope: 'user', sub: 'user-id' });
    godAdminToken = jwt.sign({
      scope: GOD_ADMIN_PANEL_SCOPE,
      role: GOD_ADMIN_ROLE,
      username: 'owner',
    });
  });

  beforeEach(async () => {
    maxReached = false;
    crossProduct = false;
    publicMode = 'empty';
    jest.clearAllMocks();
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
  });

  afterAll(async () => {
    await app.close();
    await rm(staging, { recursive: true, force: true });
    if (originalStaging === undefined) {
      delete process.env.PRODUCT_REVIEW_VIDEO_STAGING_DIR;
    } else {
      process.env.PRODUCT_REVIEW_VIDEO_STAGING_DIR = originalStaging;
    }
  });

  it.each([
    ['a missing token', undefined],
    ['a normal user token', userTokenPlaceholder()],
    ['a God Admin token', godAdminTokenPlaceholder()],
  ])('rejects %s on Admin routes', async (_label, tokenMarker) => {
    const token =
      tokenMarker === 'user'
        ? userToken
        : tokenMarker === 'god'
          ? godAdminToken
          : undefined;
    const call = request(app.getHttpServer()).get(
      `/admin-panel/products/${PRODUCT_ID}/review-videos`,
    );
    if (token) call.set('Authorization', `Bearer ${token}`);
    await call.expect(401);
  });

  it('returns 400 for invalid product and video UUID parameters and cleans staged files', async () => {
    await request(app.getHttpServer())
      .post('/admin-panel/products/not-a-uuid/review-videos')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('video', validMp4(), {
        filename: 'video.mp4',
        contentType: 'video/mp4',
      })
      .attach('cover', Buffer.from('cover'), {
        filename: 'cover.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(await readdir(staging)).toEqual([]);

    await request(app.getHttpServer())
      .patch(`/admin-panel/products/${PRODUCT_ID}/review-videos/not-a-uuid`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('cover', Buffer.from('cover'), {
        filename: 'cover.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(await readdir(staging)).toEqual([]);
  });

  it.each([
    ['video', 'cover', Buffer.from('cover'), 'cover.png', 'image/png'],
    ['cover', 'video', validMp4(), 'video.mp4', 'video/mp4'],
  ])(
    'returns safe 400 when %s is missing',
    async (_missing, field, content, filename, contentType) => {
      const responseValue = await request(app.getHttpServer())
        .post(`/admin-panel/products/${PRODUCT_ID}/review-videos`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach(field, content, { filename, contentType })
        .expect(400);
      expect(JSON.stringify(responseValue.body)).not.toMatch(
        /[A-Z]:\\|\/var\/|staging/i,
      );
      expect(await readdir(staging)).toEqual([]);
    },
  );

  it('returns 413 for an oversized cover and removes the partial file', async () => {
    const responseValue = await request(app.getHttpServer())
      .post(`/admin-panel/products/${PRODUCT_ID}/review-videos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('video', validMp4(), {
        filename: 'video.mp4',
        contentType: 'video/mp4',
      })
      .attach('cover', Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: 'cover.png',
        contentType: 'image/png',
      })
      .expect(413);
    expect(JSON.stringify(responseValue.body)).not.toMatch(
      /[A-Z]:\\|\/var\/|staging/i,
    );
    expect(await readdir(staging)).toEqual([]);
  });

  it('accepts a cover exactly at 5 MB without changing the multipart contract', async () => {
    await request(app.getHttpServer())
      .post(`/admin-panel/products/${PRODUCT_ID}/review-videos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('video', validMp4(), {
        filename: 'video.mp4',
        contentType: 'video/mp4',
      })
      .attach('cover', Buffer.alloc(5 * 1024 * 1024), {
        filename: 'cover.png',
        contentType: 'image/png',
      })
      .expect(201, response());
    expect(await readdir(staging)).toEqual([]);
  });

  it('returns safe 400 for invalid MP4 content', async () => {
    const responseValue = await request(app.getHttpServer())
      .post(`/admin-panel/products/${PRODUCT_ID}/review-videos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('video', Buffer.from('not mp4'), {
        filename: 'video.mp4',
        contentType: 'video/mp4',
      })
      .attach('cover', Buffer.from('cover'), {
        filename: 'cover.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(JSON.stringify(responseValue.body)).not.toMatch(
      /[A-Z]:\\|\/var\/|staging/i,
    );
    expect(await readdir(staging)).toEqual([]);
  });

  it('returns 409 at the maximum and 404 for cross-product video management', async () => {
    maxReached = true;
    await request(app.getHttpServer())
      .post(`/admin-panel/products/${PRODUCT_ID}/review-videos`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('video', validMp4(), {
        filename: 'video.mp4',
        contentType: 'video/mp4',
      })
      .attach('cover', Buffer.from('cover'), {
        filename: 'cover.png',
        contentType: 'image/png',
      })
      .expect(409);

    crossProduct = true;
    await request(app.getHttpServer())
      .delete(`/admin-panel/products/${PRODUCT_ID}/review-videos/${VIDEO_ID}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('keeps PATCH and reorder response contracts unchanged', async () => {
    await request(app.getHttpServer())
      .patch(`/admin-panel/products/${PRODUCT_ID}/review-videos/${VIDEO_ID}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('cover', Buffer.from('cover'), {
        filename: 'cover.png',
        contentType: 'image/png',
      })
      .expect(200, response());

    await request(app.getHttpServer())
      .put(`/admin-panel/products/${PRODUCT_ID}/review-videos/order`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ orderedIds: [VIDEO_ID] })
      .expect(200, { items: [response()] });
  });

  it('returns exact empty public data and hides unpublished or soft-deleted products', async () => {
    await request(app.getHttpServer())
      .get(`/products/${PRODUCT_ID}/review-videos`)
      .expect(200, { items: [] });
    publicMode = 'not-found';
    await request(app.getHttpServer())
      .get(`/products/${PRODUCT_ID}/review-videos`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/products/${PRODUCT_ID}/review-videos`)
      .expect(404);
  });

  const largeUploadIt =
    process.env.PRODUCT_REVIEW_VIDEO_RUN_LARGE_HTTP_TEST === '1' ? it : it.skip;
  largeUploadIt(
    'returns 413 for a video above 200 MB without buffering it in RAM',
    async () => {
      const path = join(staging, 'oversized-video.mp4');
      await writeFile(path, validMp4());
      await truncate(path, PRODUCT_REVIEW_VIDEO_MAX_BYTES + 1);
      await request(app.getHttpServer())
        .post(`/admin-panel/products/${PRODUCT_ID}/review-videos`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('video', path, {
          filename: 'video.mp4',
          contentType: 'video/mp4',
        })
        .attach('cover', Buffer.from('cover'), {
          filename: 'cover.png',
          contentType: 'image/png',
        })
        .expect(413);
    },
  );
});

function response() {
  return {
    id: VIDEO_ID,
    videoUrl: `/uploads/product-review-videos/videos/${VIDEO_ID}.mp4`,
    coverUrl: `/uploads/product-review-videos/covers/${VIDEO_ID}.webp`,
    displayOrder: 0,
  };
}

function userTokenPlaceholder(): 'user' {
  return 'user';
}

function godAdminTokenPlaceholder(): 'god' {
  return 'god';
}
