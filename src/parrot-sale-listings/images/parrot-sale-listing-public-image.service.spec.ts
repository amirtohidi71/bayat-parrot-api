import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { validImage } from '../../bird-passports/images/bird-passport-image.test-fixtures';
import {
  configurePublicUploadsStatic,
  PUBLIC_UPLOADS_ROOT,
} from '../../common/public-uploads-static';
import {
  parrotSaleListingPublicUploadsProvider,
  ParrotSaleListingPublicImageService,
} from './parrot-sale-listing-public-image.service';

describe('ParrotSaleListingPublicImageService', () => {
  let root: string;
  let service: ParrotSaleListingPublicImageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'parrot-listing-public-'));
    service = new ParrotSaleListingPublicImageService(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('publishes private sanitized bytes only under the dedicated public namespace', async () => {
    const bytes = Buffer.from('sanitized-webp');
    const [publicPath] = await service.publish([bytes]);
    expect(publicPath).toMatch(
      /^\/uploads\/parrot-sale-listings\/[0-9a-f-]{36}\.webp$/,
    );
    expect(
      await readFile(
        join(root, ...publicPath.replace('/uploads/', '').split('/')),
      ),
    ).toEqual(bytes);
  });

  it('uses the same central root as public static delivery', () => {
    expect(parrotSaleListingPublicUploadsProvider.useValue).toBe(
      PUBLIC_UPLOADS_ROOT,
    );
  });

  it('serves the returned Product image path from the shared public uploads root', async () => {
    const image = await validImage('webp');
    const [publicPath] = await service.publish([image]);
    const moduleRef = await Test.createTestingModule({}).compile();
    const expressApp = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    configurePublicUploadsStatic(expressApp, root);
    await expressApp.init();
    const app: INestApplication = expressApp;
    const server = app.getHttpServer() as unknown as Parameters<
      typeof request
    >[0];

    try {
      const response = await request(server).get(publicPath).expect(200);
      expect(response.headers['content-type']).toMatch(/^image\/webp\b/);
      expect(response.body).toEqual(image);
    } finally {
      await app.close();
    }
  });

  it('removes only paths issued from the dedicated namespace', async () => {
    const [publicPath] = await service.publish([Buffer.from('image')]);
    await service.remove(['/uploads/other/file.webp', publicPath]);
    await expect(
      readFile(join(root, ...publicPath.replace('/uploads/', '').split('/'))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
