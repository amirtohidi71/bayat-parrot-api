import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { ProductReviewVideosService } from './product-review-videos.service';
describe('fresh public Product response cache protection', () => {
  let app: INestApplication, server: Server;
  const service = {
    findAllPublished: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    searchPublished: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    findOnePublished: jest.fn(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [
        { provide: ProductsService, useValue: service },
        { provide: ProductReviewVideosService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    server = app.getHttpServer() as Server;
  });
  afterAll(async () => app?.close());
  it.each(['/products', '/products/search?q=bird'])(
    'prevents storage of %s',
    async (path) => {
      await request(server)
        .get(path)
        .expect(200)
        .expect('Cache-Control', 'no-store');
    },
  );
  it('protects detail responses and keeps held/unpublished detail at 404', async () => {
    service.findOnePublished.mockResolvedValueOnce({
      id: 'fixture',
      status: 'published',
      isSellerListing: true,
    });
    await request(server)
      .get('/products/fixture')
      .expect(200)
      .expect('Cache-Control', 'no-store');
    service.findOnePublished.mockRejectedValueOnce(new NotFoundException());
    await request(server)
      .get('/products/held')
      .expect(404)
      .expect('Cache-Control', 'no-store');
    expect(service.findOnePublished).toHaveBeenLastCalledWith('held');
  });
});
