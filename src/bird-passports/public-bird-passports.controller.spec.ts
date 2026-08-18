/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- Supertest and deferred-promise mocks expose framework any/async boundaries. */
import {
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import {
  BIRD_PASSPORT_LOOKUP_GRANT_SECONDS,
  BirdPassportLookupGrantService,
} from './bird-passport-lookup-grant.service';
import { BirdPassportLookupGuard } from './bird-passport-lookup.guard';
import { PublicBirdPassportNoStoreInterceptor } from './public-bird-passport-no-store.interceptor';
import { PublicBirdPassportBackgroundScheduler } from './public-bird-passport-background-scheduler';
import { PublicBirdPassportSmsDispatchService } from './public-bird-passport-sms-dispatch.service';
import { PublicBirdPassportThrottlerGuard } from './public-bird-passport-throttler.guard';
import { PublicBirdPassportsController } from './public-bird-passports.controller';
import {
  PUBLIC_OTP_REQUEST_MESSAGE,
  PublicBirdPassportsService,
} from './public-bird-passports.service';

const PASSPORT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOOKUP_SECRET = 'lookup-http-test-secret-12345678901234567890';
const GENERAL_SECRET = 'general-http-test-secret-1234567890123456789';
const requestBody = { code: 'B25543210', ownerMobile: '09123456789' };
const generalJwt = new JwtService();
const userToken = generalJwt.sign(
  { sub: 'user-1', role: 'customer' },
  { secret: GENERAL_SECRET },
);
const adminToken = generalJwt.sign(
  { scope: 'admin-panel', username: 'editor' },
  { secret: GENERAL_SECRET },
);
const godAdminToken = generalJwt.sign(
  { scope: 'god-admin-panel', role: 'owner', username: 'owner' },
  { secret: GENERAL_SECRET },
);
const publicDetail = {
  code: 'B25543210',
  ownerFullName: 'Owner Name',
  birdName: 'Rio',
  birthDate: '2025-05-10',
  ageMonths: 15,
  species: 'Parrot',
  subspecies: 'Macaw',
  hasImage: true,
  vaccines: [],
  feedings: [],
  veterinaryVisits: [],
};

describe('PublicBirdPassportsController HTTP', () => {
  let app: INestApplication;
  const passports = {
    requestOtp: jest.fn().mockResolvedValue({
      message: PUBLIC_OTP_REQUEST_MESSAGE,
    }),
    verifyOtp: jest.fn().mockResolvedValue({ passportId: PASSPORT_ID }),
    getPublicPassport: jest.fn().mockResolvedValue(publicDetail),
    readPublicImage: jest.fn().mockResolvedValue({
      buffer: Buffer.from('private-image'),
      mimeType: 'image/webp',
      size: Buffer.byteLength('private-image'),
    }),
  };
  const config = {
    get: jest.fn((name: string) => {
      const values: Record<string, string> = {
        NODE_ENV: 'test',
        BIRD_PASSPORT_LOOKUP_JWT_SECRET: LOOKUP_SECRET,
        JWT_SECRET: GENERAL_SECRET,
      };
      return values[name];
    }),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({}),
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 15 * 60 * 1000, limit: 120 },
        ]),
      ],
      controllers: [PublicBirdPassportsController],
      providers: [
        { provide: PublicBirdPassportsService, useValue: passports },
        { provide: ConfigService, useValue: config },
        BirdPassportLookupGrantService,
        BirdPassportLookupGuard,
        PublicBirdPassportThrottlerGuard,
        PublicBirdPassportNoStoreInterceptor,
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        validationError: { target: false, value: false },
      }),
    );
    await app.init();
  });

  afterAll(() => app.close());

  it('runs request → verify → HttpOnly cookie → protected detail over real HTTP', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/bird-passports/public/request-otp')
      .set('X-Forwarded-For', '198.51.100.10')
      .send({ code: ' b25543210 ', ownerMobile: '+989123456789' })
      .expect(202)
      .expect('Cache-Control', 'no-store')
      .expect({ message: PUBLIC_OTP_REQUEST_MESSAGE });
    expect(passports.requestOtp).toHaveBeenLastCalledWith(requestBody);

    const verified = await agent
      .post('/bird-passports/public/verify-otp')
      .set('X-Forwarded-For', '198.51.100.10')
      .send({ code: 'b25543210', ownerMobile: '00989123456789', otp: '12345' })
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(verified.body).toEqual({ message: 'Verification succeeded.' });
    expect(passports.verifyOtp).toHaveBeenLastCalledWith({
      ...requestBody,
      otp: '12345',
    });
    expect(JSON.stringify(verified.body)).not.toMatch(/token|jwt|passportId/i);
    expect(verified.headers['set-cookie'][0]).toContain('bird_passport_view=');
    expect(verified.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(verified.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(verified.headers['set-cookie'][0]).toContain(
      'Path=/bird-passports/public',
    );
    expect(verified.headers['set-cookie'][0]).toContain('Max-Age=600');
    expect(verified.headers['set-cookie'][0]).not.toContain('Domain=');
    expect(verified.headers['set-cookie'][0]).not.toContain('Secure');

    await agent
      .get('/bird-passports/public/b25543210')
      .set('X-Forwarded-For', '198.51.100.10')
      .expect(200)
      .expect('Cache-Control', 'no-store')
      .expect(publicDetail);
    expect(passports.getPublicPassport).toHaveBeenLastCalledWith(
      PASSPORT_ID,
      'B25543210',
    );
  });

  it('returns HTTP 202 while the asynchronously scheduled SMS promise is unresolved', async () => {
    let releaseSms: (() => void) | undefined;
    const smsPending = new Promise<void>((resolve) => {
      releaseSms = resolve;
    });
    const sms = { sendOtp: jest.fn(() => smsPending) };
    const dataSource = {
      getRepository: jest.fn(() => ({ update: jest.fn() })),
    };
    const dispatcher = new PublicBirdPassportSmsDispatchService(
      sms as never,
      dataSource as never,
      new PublicBirdPassportBackgroundScheduler(),
    );
    passports.requestOtp.mockImplementationOnce(async () => {
      dispatcher.dispatch({
        otpId: PASSPORT_ID,
        phone: requestBody.ownerMobile,
        rawCode: '00042',
      });
      return { message: PUBLIC_OTP_REQUEST_MESSAGE };
    });

    await request(app.getHttpServer())
      .post('/bird-passports/public/request-otp')
      .set('X-Forwarded-For', '198.51.100.11')
      .send(requestBody)
      .expect(202)
      .expect('Cache-Control', 'no-store')
      .expect({ message: PUBLIC_OTP_REQUEST_MESSAGE });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sms.sendOtp).toHaveBeenCalled();
    releaseSms!();
    await smsPending;
  });

  it.each([
    ['without credentials', undefined, '198.51.100.41'],
    ['with a user token', `Bearer ${userToken}`, '198.51.100.42'],
    ['with an admin token', `Bearer ${adminToken}`, '198.51.100.43'],
    ['with a god-admin token', `Bearer ${godAdminToken}`, '198.51.100.44'],
  ])(
    'rejects protected GET %s but preserves no-store',
    async (_label, bearer, ip) => {
      const call = request(app.getHttpServer())
        .get('/bird-passports/public/B25543210')
        .set('X-Forwarded-For', ip);
      if (bearer) call.set('Authorization', bearer);
      await call.expect(401).expect('Cache-Control', 'no-store');
    },
  );

  it('protects private image bytes and sends exact security headers', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/bird-passports/public/verify-otp')
      .set('X-Forwarded-For', '198.51.100.90')
      .send({ ...requestBody, otp: '12345' });
    await agent
      .get('/bird-passports/public/B25543210/image')
      .set('X-Forwarded-For', '198.51.100.90')
      .expect(200)
      .expect('Content-Type', 'image/webp')
      .expect('Content-Length', String(Buffer.byteLength('private-image')))
      .expect('Cache-Control', 'private, no-store')
      .expect('X-Content-Type-Options', 'nosniff');
    expect(passports.readPublicImage).toHaveBeenLastCalledWith(
      PASSPORT_ID,
      'B25543210',
    );
  });

  it('applies no-store to an authorized public 404 response', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/bird-passports/public/verify-otp')
      .set('X-Forwarded-For', '198.51.100.92')
      .send({ ...requestBody, otp: '12345' })
      .expect(200);
    passports.getPublicPassport.mockRejectedValueOnce(
      new NotFoundException('Bird passport not found'),
    );
    await agent
      .get('/bird-passports/public/B25543210')
      .set('X-Forwarded-For', '198.51.100.92')
      .expect(404)
      .expect('Cache-Control', 'no-store');
  });

  it.each([
    [{ code: 'invalid', ownerMobile: '09123456789' }, '/request-otp'],
    [{ code: 'B25543210', ownerMobile: 'invalid' }, '/request-otp'],
    [{ ...requestBody, otp: '1234' }, '/verify-otp'],
    [{ ...requestBody, otp: '123456' }, '/verify-otp'],
  ])(
    'rejects malformed public input through ValidationPipe',
    async (body, path) => {
      await request(app.getHttpServer())
        .post(`/bird-passports/public${path}`)
        .set('X-Forwarded-For', '198.51.100.91')
        .send(body)
        .expect(400)
        .expect('Cache-Control', 'no-store');
    },
  );

  it('limits request-otp to ten requests per fifteen minutes per trusted proxy client', async () => {
    for (let index = 0; index < 10; index += 1) {
      await request(app.getHttpServer())
        .post('/bird-passports/public/request-otp')
        .set('X-Forwarded-For', '198.51.100.100')
        .send(requestBody)
        .expect(202);
    }
    await request(app.getHttpServer())
      .post('/bird-passports/public/request-otp')
      .set('X-Forwarded-For', '198.51.100.100')
      .send(requestBody)
      .expect(429)
      .expect('Cache-Control', 'no-store');
    await request(app.getHttpServer())
      .post('/bird-passports/public/request-otp')
      .set('X-Forwarded-For', '198.51.100.101')
      .send(requestBody)
      .expect(202);
  });

  it('limits verify-otp to twenty requests per fifteen minutes per IP', async () => {
    for (let index = 0; index < 20; index += 1) {
      await request(app.getHttpServer())
        .post('/bird-passports/public/verify-otp')
        .set('X-Forwarded-For', '198.51.100.110')
        .send({ ...requestBody, otp: '12345' })
        .expect(200);
    }
    await request(app.getHttpServer())
      .post('/bird-passports/public/verify-otp')
      .set('X-Forwarded-For', '198.51.100.110')
      .send({ ...requestBody, otp: '12345' })
      .expect(429)
      .expect('Cache-Control', 'no-store');
  });

  it('sets Secure on the lookup cookie in production', async () => {
    const controller = new PublicBirdPassportsController(
      passports as never,
      { issue: jest.fn(() => 'lookup.jwt.token') } as never,
      { get: jest.fn(() => 'production') } as never,
    );
    const response = { cookie: jest.fn() };
    await controller.verifyOtp(
      { ...requestBody, otp: '12345' },
      response as never,
    );
    expect(response.cookie).toHaveBeenCalledWith(
      'bird_passport_view',
      'lookup.jwt.token',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: '/bird-passports/public',
        maxAge: BIRD_PASSPORT_LOOKUP_GRANT_SECONDS * 1000,
      }),
    );
  });
});
