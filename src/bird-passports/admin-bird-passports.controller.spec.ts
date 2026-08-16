/* eslint-disable @typescript-eslint/no-unsafe-argument -- Supertest accepts Nest's any-typed HTTP server handle. */
import {
  BadRequestException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import {
  AdminAuthGuard,
  ADMIN_PANEL_SCOPE,
} from '../admin/guards/admin-auth.guard';
import { AdminBirdPassportsController } from './admin-bird-passports.controller';
import {
  BirdPassport,
  BirdPassportStatus,
} from './entities/bird-passport.entity';
import { BirdPassportsService } from './bird-passports.service';
import { BirdPassportImagesService } from './images/bird-passport-images.service';
import { BIRD_PASSPORT_IMAGE_MAX_BYTES } from './images/bird-passport-image.types';
import { AdminBirdPassportNoStoreInterceptor } from './admin-bird-passport-no-store.interceptor';

const ID = '11111111-1111-4111-8111-111111111111';
const RECORD_ID = '22222222-2222-4222-8222-222222222222';

function passport(overrides: Partial<BirdPassport> = {}): BirdPassport {
  return Object.assign(new BirdPassport(), {
    id: ID,
    code: 'B25543210',
    ownerMobile: '09123456789',
    birthDate: '2025-01-01',
    species: 'Parrot',
    subspecies: 'Macaw',
    imagePath: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    status: BirdPassportStatus.DRAFT,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    vaccineRecords: [],
    feedingRecords: [],
    veterinaryVisits: [],
    ...overrides,
  });
}

function context() {
  const passports = {
    create: jest.fn().mockResolvedValue(passport()),
    listPassportsAdmin: jest.fn().mockResolvedValue({
      items: [passport()],
      total: 1,
      page: 1,
      limit: 20,
    }),
    getById: jest.fn().mockResolvedValue(passport()),
    updatePassport: jest.fn().mockResolvedValue(passport()),
    activatePassport: jest
      .fn()
      .mockResolvedValue(passport({ status: BirdPassportStatus.ACTIVE })),
    archivePassport: jest
      .fn()
      .mockResolvedValue(passport({ status: BirdPassportStatus.ARCHIVED })),
    addVaccine: jest.fn().mockResolvedValue({
      id: RECORD_ID,
      vaccineName: 'A',
      vaccinationDate: '2025-01-01',
      sortOrder: 0,
    }),
    updateVaccine: jest.fn().mockResolvedValue({
      id: RECORD_ID,
      vaccineName: 'B',
      vaccinationDate: '2025-01-01',
      sortOrder: 0,
    }),
    deleteVaccine: jest.fn().mockResolvedValue(undefined),
    addFeeding: jest.fn().mockResolvedValue({
      id: RECORD_ID,
      ageRange: 'adult',
      description: 'seed',
      sortOrder: 0,
    }),
    updateFeeding: jest.fn().mockResolvedValue({
      id: RECORD_ID,
      ageRange: 'adult',
      description: 'pellet',
      sortOrder: 0,
    }),
    deleteFeeding: jest.fn().mockResolvedValue(undefined),
    addVeterinaryVisit: jest.fn().mockResolvedValue({
      id: RECORD_ID,
      visitDate: '2025-01-01',
      clinicalNotes: 'ok',
      veterinaryActions: 'check',
      sortOrder: 0,
    }),
    updateVeterinaryVisit: jest.fn().mockResolvedValue({
      id: RECORD_ID,
      visitDate: '2025-01-01',
      clinicalNotes: 'good',
      veterinaryActions: 'check',
      sortOrder: 0,
    }),
    deleteVeterinaryVisit: jest.fn().mockResolvedValue(undefined),
  };
  const images = {
    replaceImage: jest.fn().mockResolvedValue(passport()),
    readImage: jest.fn().mockResolvedValue({
      buffer: Buffer.from('webp'),
      mimeType: 'image/webp',
      size: 4,
    }),
  };
  return {
    controller: new AdminBirdPassportsController(
      passports as never,
      images as never,
    ),
    passports,
    images,
  };
}

describe('AdminBirdPassportsController', () => {
  it('uses the existing AdminAuthGuard at the controller boundary', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminBirdPassportsController),
    ).toContain(AdminAuthGuard);
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminBirdPassportsController),
    ).toBe('admin-panel/bird-passports');
  });

  it.each([
    ['unauthenticated', undefined, new Error('missing')],
    ['normal user token', 'Bearer user', { sub: 'user', role: 'customer' }],
  ])('rejects %s access', (_label, authorization, verification) => {
    const jwt = {
      verify: jest.fn(() => {
        if (verification instanceof Error) throw verification;
        return verification;
      }),
    };
    const guard = new AdminAuthGuard(jwt as never);
    const request = { headers: { authorization } };
    const execution = { switchToHttp: () => ({ getRequest: () => request }) };
    expect(() => guard.canActivate(execution as never)).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts an existing admin-panel scoped token', () => {
    const jwt = {
      verify: jest.fn(() => ({ scope: ADMIN_PANEL_SCOPE, username: 'editor' })),
    };
    const guard = new AdminAuthGuard(jwt as never);
    const request: { headers: { authorization: string }; admin?: unknown } = {
      headers: { authorization: 'Bearer admin' },
    };
    const execution = { switchToHttp: () => ({ getRequest: () => request }) };
    expect(guard.canActivate(execution as never)).toBe(true);
    expect(request.admin).toEqual({
      scope: ADMIN_PANEL_SCOPE,
      username: 'editor',
    });
  });

  it('creates through the typed DTO and never exposes storage or OTP fields', async () => {
    const value = context();
    const dto = {
      ownerMobile: '09123456789',
      birthDate: '2025-01-01',
      species: 'Parrot',
      subspecies: 'Macaw',
    };
    const result = await value.controller.create(dto);
    expect(value.passports.create).toHaveBeenCalledWith(dto);
    expect(result).toMatchObject({ code: 'B25543210', hasImage: true });
    expect(result).not.toHaveProperty('imagePath');
    expect(result).not.toHaveProperty('otps');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('forwards pagination, status and search to the database list service', async () => {
    const value = context();
    const query = {
      page: 2,
      limit: 10,
      status: BirdPassportStatus.DRAFT,
      search: 'B255',
    };
    const result = await value.controller.list(query);
    expect(value.passports.listPassportsAdmin).toHaveBeenCalledWith(query);
    expect(result.items[0]).not.toHaveProperty('imagePath');
  });

  it('returns mapped detail and forwards update/activate/archive', async () => {
    const value = context();
    expect(await value.controller.detail(ID)).toMatchObject({
      vaccines: [],
      feedings: [],
      veterinaryVisits: [],
    });
    await value.controller.update(ID, { species: 'Cockatoo' });
    await value.controller.activate(ID);
    await value.controller.archive(ID);
    expect(value.passports.updatePassport).toHaveBeenCalledWith(ID, {
      species: 'Cockatoo',
    });
    expect(value.passports.activatePassport).toHaveBeenCalledWith(ID);
    expect(value.passports.archivePassport).toHaveBeenCalledWith(ID);
  });

  it('uploads only the buffer and supplied MIME to private image orchestration', async () => {
    const value = context();
    const file = {
      buffer: Buffer.from('image'),
      mimetype: 'image/png',
      originalname: '../../unsafe.png',
    } as Express.Multer.File;
    const result = await value.controller.replaceImage(ID, file);
    expect(value.images.replaceImage).toHaveBeenCalledWith(
      ID,
      file.buffer,
      'image/png',
    );
    expect(result).not.toHaveProperty('imagePath');
  });

  it('rejects a missing image', async () => {
    await expect(
      context().controller.replaceImage(ID, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sends authenticated private image bytes with secure headers and no path', async () => {
    const value = context();
    const response = { set: jest.fn(), send: jest.fn() };
    await value.controller.readImage(ID, response as never);
    expect(response.set).toHaveBeenCalledWith({
      'Content-Type': 'image/webp',
      'Content-Length': '4',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    expect(response.send).toHaveBeenCalledWith(Buffer.from('webp'));
  });

  it('supports vaccine add/update/delete', async () => {
    const value = context();
    await value.controller.addVaccine(ID, {
      vaccineName: 'A',
      vaccinationDate: '2025-01-01',
    });
    await value.controller.updateVaccine(ID, RECORD_ID, { vaccineName: 'B' });
    await value.controller.deleteVaccine(ID, RECORD_ID);
    expect(value.passports.deleteVaccine).toHaveBeenCalledWith(ID, RECORD_ID);
  });

  it('supports feeding add/update/delete', async () => {
    const value = context();
    await value.controller.addFeeding(ID, {
      ageRange: 'adult',
      description: 'seed',
    });
    await value.controller.updateFeeding(ID, RECORD_ID, {
      description: 'pellet',
    });
    await value.controller.deleteFeeding(ID, RECORD_ID);
    expect(value.passports.deleteFeeding).toHaveBeenCalledWith(ID, RECORD_ID);
  });

  it('supports veterinary add/update/delete', async () => {
    const value = context();
    await value.controller.addVeterinaryVisit(ID, {
      visitDate: '2025-01-01',
      clinicalNotes: 'ok',
      veterinaryActions: 'check',
    });
    await value.controller.updateVeterinaryVisit(ID, RECORD_ID, {
      clinicalNotes: 'good',
    });
    await value.controller.deleteVeterinaryVisit(ID, RECORD_ID);
    expect(value.passports.deleteVeterinaryVisit).toHaveBeenCalledWith(
      ID,
      RECORD_ID,
    );
  });

  it('has no Passport DELETE route', () => {
    const prototype =
      AdminBirdPassportsController.prototype as unknown as Record<
        string,
        unknown
      >;
    const deletePaths = Object.getOwnPropertyNames(prototype)
      .filter(
        (name) =>
          Reflect.getMetadata(METHOD_METADATA, prototype[name] as object) === 3,
      )
      .map(
        (name) =>
          Reflect.getMetadata(
            PATH_METADATA,
            prototype[name] as object,
          ) as unknown,
      );
    expect(deletePaths).toEqual(
      expect.arrayContaining([
        ':passportId/vaccines/:recordId',
        ':passportId/feedings/:recordId',
        ':passportId/veterinary-visits/:recordId',
      ]),
    );
    expect(deletePaths).not.toContain(':id');
  });
});

describe('AdminBirdPassportsController HTTP validation', () => {
  let app: INestApplication;
  let httpContext: ReturnType<typeof context>;
  let adminToken: string;
  let jwtService: JwtService;
  const testJwtSecret = 'admin-passport-http-test-secret-only';

  beforeAll(async () => {
    httpContext = context();
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: testJwtSecret })],
      controllers: [AdminBirdPassportsController],
      providers: [
        { provide: BirdPassportsService, useValue: httpContext.passports },
        { provide: BirdPassportImagesService, useValue: httpContext.images },
        AdminAuthGuard,
        AdminBirdPassportNoStoreInterceptor,
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    jwtService = module.get(JwtService);
    adminToken = jwtService.sign({
      scope: ADMIN_PANEL_SCOPE,
      username: 'test-admin',
    });
  });

  afterAll(() => app?.close());

  it('rejects HTTP requests without a token', async () => {
    await request(app.getHttpServer())
      .get('/admin-panel/bird-passports')
      .expect(401);
  });

  it.each([
    ['normal user', { sub: 'user-1', role: 'customer' }],
    [
      'god admin',
      { scope: 'god-admin-panel', role: 'owner', username: 'owner' },
    ],
  ])(
    'rejects an HTTP %s token through the real guard',
    async (_label, payload) => {
      await request(app.getHttpServer())
        .get('/admin-panel/bird-passports')
        .set('Authorization', `Bearer ${jwtService.sign(payload)}`)
        .expect(401);
    },
  );

  it('accepts an admin-panel JWT through the real guard and route', async () => {
    await request(app.getHttpServer())
      .get('/admin-panel/bird-passports')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
      .expect('Cache-Control', 'no-store');
  });

  it('rejects an invalid Passport UUID through ParseUUIDPipe', async () => {
    await request(app.getHttpServer())
      .get('/admin-panel/bird-passports/not-a-uuid')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('rejects an invalid child UUID through ParseUUIDPipe', async () => {
    await request(app.getHttpServer())
      .delete(`/admin-panel/bird-passports/${ID}/vaccines/not-a-uuid`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('strips forbidden create fields before forwarding the typed DTO', async () => {
    await request(app.getHttpServer())
      .post('/admin-panel/bird-passports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        ownerMobile: '09123456789',
        birthDate: '2025-01-01',
        species: 'Parrot',
        subspecies: 'Macaw',
        code: 'B99999999',
        status: 'active',
        imagePath: '/unsafe',
      })
      .expect(201);
    expect(httpContext.passports.create).toHaveBeenLastCalledWith({
      ownerMobile: '09123456789',
      birthDate: '2025-01-01',
      species: 'Parrot',
      subspecies: 'Macaw',
    });
  });

  it('strips client sortOrder from child create and update payloads', async () => {
    await request(app.getHttpServer())
      .post(`/admin-panel/bird-passports/${ID}/vaccines`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        vaccineName: 'A',
        vaccinationDate: '2025-01-01',
        sortOrder: 999,
      })
      .expect(201);
    expect(httpContext.passports.addVaccine).toHaveBeenLastCalledWith(ID, {
      vaccineName: 'A',
      vaccinationDate: '2025-01-01',
    });

    await request(app.getHttpServer())
      .patch(`/admin-panel/bird-passports/${ID}/vaccines/${RECORD_ID}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vaccineName: 'B', sortOrder: 0 })
      .expect(200);
    expect(httpContext.passports.updateVaccine).toHaveBeenLastCalledWith(
      ID,
      RECORD_ID,
      { vaccineName: 'B' },
    );
  });

  it('enforces query boundaries through the production-like ValidationPipe', async () => {
    await request(app.getHttpServer())
      .get('/admin-panel/bird-passports?limit=101')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/admin-panel/bird-passports?search=${'x'.repeat(101)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/admin-panel/bird-passports?search=${'x'.repeat(100)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('applies no-store to list, detail and JSON mutations', async () => {
    await request(app.getHttpServer())
      .get('/admin-panel/bird-passports')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect('Cache-Control', 'no-store');
    await request(app.getHttpServer())
      .get(`/admin-panel/bird-passports/${ID}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect('Cache-Control', 'no-store');
    await request(app.getHttpServer())
      .post(`/admin-panel/bird-passports/${ID}/activate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect('Cache-Control', 'no-store');
  });

  it('preserves private no-store for authenticated image reads', async () => {
    await request(app.getHttpServer())
      .get(`/admin-panel/bird-passports/${ID}/image`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
      .expect('Content-Type', 'image/webp')
      .expect('Cache-Control', 'private, no-store')
      .expect('X-Content-Type-Options', 'nosniff');
  });

  it('rejects missing and oversized multipart images safely', async () => {
    await request(app.getHttpServer())
      .put(`/admin-panel/bird-passports/${ID}/image`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .put(`/admin-panel/bird-passports/${ID}/image`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach(
        'image',
        Buffer.alloc(BIRD_PASSPORT_IMAGE_MAX_BYTES + 1),
        'large.png',
      )
      .expect(413);
  });
});
