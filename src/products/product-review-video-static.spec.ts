/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import {
  configurePublicUploadsStatic,
  PUBLIC_UPLOADS_PREFIX,
  PUBLIC_UPLOADS_ROOT,
} from '../common/public-uploads-static';

describe('product review video static delivery', () => {
  let app: INestApplication;
  let root: string;
  let content: Buffer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'product-review-video-static-'));
    const videos = join(root, 'product-review-videos', 'videos');
    await mkdir(videos, { recursive: true });
    content = Buffer.from('000000206674797069736f6d0000000069736f6d', 'hex');
    await writeFile(join(videos, 'sample.mp4'), content);

    const moduleRef = await Test.createTestingModule({}).compile();
    const expressApp = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    configurePublicUploadsStatic(expressApp, root);
    await expressApp.init();
    app = expressApp;
  });

  it('shares the exact bootstrap uploads root and prefix contract', () => {
    expect(PUBLIC_UPLOADS_ROOT).toBe(join(process.cwd(), 'public', 'uploads'));
    expect(PUBLIC_UPLOADS_PREFIX).toBe('/uploads');
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('serves a normal GET with byte ranges and the MP4 content type', async () => {
    const response = await request(app.getHttpServer())
      .get('/uploads/product-review-videos/videos/sample.mp4')
      .expect(200);

    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-type']).toMatch(/^video\/mp4\b/);
    expect(Number(response.headers['content-length'])).toBe(content.length);
  });

  it('supports HEAD without returning a response body', async () => {
    const response = await request(app.getHttpServer())
      .head('/uploads/product-review-videos/videos/sample.mp4')
      .expect(200);

    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-type']).toMatch(/^video\/mp4\b/);
    expect(Number(response.headers['content-length'])).toBe(content.length);
    expect(response.text).toBeUndefined();
  });

  it('returns a satisfiable byte range as 206', async () => {
    const response = await request(app.getHttpServer())
      .get('/uploads/product-review-videos/videos/sample.mp4')
      .set('Range', 'bytes=0-3')
      .expect(206);

    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-range']).toBe(
      `bytes 0-3/${content.length}`,
    );
    expect(Number(response.headers['content-length'])).toBe(4);
  });

  it('returns an unsatisfiable byte range as 416', async () => {
    const response = await request(app.getHttpServer())
      .get('/uploads/product-review-videos/videos/sample.mp4')
      .set('Range', `bytes=${content.length + 10}-`)
      .expect(416);

    expect(response.headers['content-range']).toBe(`bytes */${content.length}`);
  });
});
