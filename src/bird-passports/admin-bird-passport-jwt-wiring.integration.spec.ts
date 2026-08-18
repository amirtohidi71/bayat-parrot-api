/* eslint-disable @typescript-eslint/no-unsafe-argument -- Supertest accepts Nest's any-typed HTTP server handle. */
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import { AdminModule } from '../admin/admin.module';
import { OrdersService } from '../orders/orders.service';
import { ProductReviewVideosService } from '../products/product-review-videos.service';
import { ProductsService } from '../products/products.service';
import { BirdPassportImagesService } from './images/bird-passport-images.service';
import { BirdPassportLookupGrantService } from './bird-passport-lookup-grant.service';
import { BirdPassportTaxonomyService } from './bird-passport-taxonomy.service';
import { BirdPassportsModule } from './bird-passports.module';
import { BirdPassportsService } from './bird-passports.service';

const ADMIN_JWT_SECRET = 'runtime-admin-jwt-test-secret-only-1234567890';
const LOOKUP_JWT_SECRET = 'runtime-lookup-jwt-test-secret-only-123456789';
const ADMIN_USERNAME = 'runtime-test-admin';
const ADMIN_PASSWORD = 'runtime-test-password';
const dataSourceToken = getDataSourceToken();

const fakeRepository = {};
const fakeDataSource = {
  entityMetadatas: [],
  options: { type: 'postgres' },
  getRepository: jest.fn(() => fakeRepository),
};

@Global()
@Module({
  providers: [{ provide: dataSourceToken, useValue: fakeDataSource }],
  exports: [dataSourceToken],
})
class RuntimeJwtFakeDatabaseModule {}

function readAccessToken(body: unknown): string {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('accessToken' in body) ||
    typeof body.accessToken !== 'string'
  ) {
    throw new Error('Admin login did not return an access token');
  }
  return body.accessToken;
}

describe('Admin Bird Passport runtime JWT wiring', () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let lookupGrants: BirdPassportLookupGrantService;

  beforeAll(async () => {
    const builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              NODE_ENV: 'test',
              JWT_SECRET: ADMIN_JWT_SECRET,
              ADMIN_USERS: ADMIN_USERNAME,
              [`ADMIN_PASSWORD_${ADMIN_USERNAME.toUpperCase()}`]:
                ADMIN_PASSWORD,
              BIRD_PASSPORT_LOOKUP_JWT_SECRET: LOOKUP_JWT_SECRET,
              SMS_ENABLED: 'false',
            }),
          ],
        }),
        RuntimeJwtFakeDatabaseModule,
        AdminModule,
        BirdPassportsModule,
      ],
    })
      .overrideProvider(OrdersService)
      .useValue({
        getAdminDashboardSummary: jest.fn().mockResolvedValue({ ok: true }),
      })
      .overrideProvider(ProductsService)
      .useValue({})
      .overrideProvider(ProductReviewVideosService)
      .useValue({})
      .overrideProvider(BirdPassportsService)
      .useValue({
        listPassportsAdmin: jest.fn().mockResolvedValue({
          items: [],
          total: 0,
          page: 1,
          limit: 20,
        }),
      })
      .overrideProvider(BirdPassportImagesService)
      .useValue({})
      .overrideProvider(BirdPassportTaxonomyService)
      .useValue({ list: jest.fn().mockResolvedValue([]) });

    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication();
    await app.init();
    jwtService = moduleRef.get(JwtService, { strict: false });
    lookupGrants = moduleRef.get(BirdPassportLookupGrantService, {
      strict: false,
    });
  });

  afterAll(() => app?.close());

  it('accepts one real login token across Admin and Admin Bird Passport routes', async () => {
    const login = await request(app.getHttpServer())
      .post('/admin-panel/login')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
      .expect(201);
    const accessToken = readAccessToken(login.body as unknown);
    const authorization = `Bearer ${accessToken}`;

    await request(app.getHttpServer())
      .get('/admin-panel/dashboard')
      .set('Authorization', authorization)
      .expect(200);
    await request(app.getHttpServer())
      .get('/admin-panel/bird-passports')
      .set('Authorization', authorization)
      .expect(200);
    await request(app.getHttpServer())
      .get('/admin-panel/bird-passports/taxonomy')
      .set('Authorization', authorization)
      .expect(200);
  });

  it.each([
    ['user', { sub: 'runtime-test-user', role: 'customer' }],
    [
      'God Admin',
      { scope: 'god-admin-panel', role: 'owner', username: 'runtime-owner' },
    ],
  ])('still rejects a correctly signed %s token', async (_label, payload) => {
    const nonAdminToken = jwtService.sign(payload);

    await request(app.getHttpServer())
      .get('/admin-panel/bird-passports')
      .set('Authorization', `Bearer ${nonAdminToken}`)
      .expect(401);
  });

  it('keeps Admin bearer and Public lookup grant authentication isolated', async () => {
    const publicGrant = lookupGrants.issue(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await request(app.getHttpServer())
      .get('/admin-panel/bird-passports')
      .set('Authorization', `Bearer ${publicGrant}`)
      .expect(401);

    const login = await request(app.getHttpServer())
      .post('/admin-panel/login')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
      .expect(201);
    const adminToken = readAccessToken(login.body as unknown);
    await request(app.getHttpServer())
      .get('/bird-passports/public/B25543210')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(401);
  });
});
