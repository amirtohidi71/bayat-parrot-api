import {
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CustomerCapabilityGuard } from '../auth/guards/customer-capability.guard';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AdminBreederTaxonController } from './admin-breeder-taxon.controller';
import { BreederTaxonController } from './breeder-taxon.controller';
import { BreederTaxonService } from './breeder-taxon.service';
import { SellerOnboardingController } from '../seller-onboarding/seller-onboarding.controller';
import { SellerOnboardingService } from '../seller-onboarding/seller-onboarding.service';

describe('Breeder taxonomy HTTP guard and payload contracts', () => {
  let app: INestApplication, server: Server, jwt: JwtService;
  const userId = randomUUID(),
    applicationId = randomUUID(),
    permissionId = randomUUID();
  const service = {
    taxonomy: jest.fn(),
    read: jest.fn(),
    request: jest.fn(),
    decide: jest.fn(),
  };
  const secret = randomBytes(32).toString('hex');
  const onboarding = { submitBreeder: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret })],
      controllers: [
        BreederTaxonController,
        AdminBreederTaxonController,
        SellerOnboardingController,
      ],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        CustomerCapabilityGuard,
        AdminAuthGuard,
        { provide: BreederTaxonService, useValue: service },
        { provide: SellerOnboardingService, useValue: onboarding },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({
                JWT_SECRET: secret,
                ADMIN_USERS: 'review-fixture',
                GOD_ADMIN_USERNAME: 'owner-fixture',
              })[key],
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        validationError: { target: false, value: false },
        exceptionFactory: (errors) => new BadRequestException(errors),
      }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
    jwt = module.get(JwtService);
  });
  afterAll(async () => app?.close());
  beforeEach(() => {
    jest.clearAllMocks();
    service.taxonomy.mockResolvedValue([]);
    service.read.mockResolvedValue({ speciesPermissions: [] });
    service.request.mockResolvedValue({ speciesPermissions: [] });
    service.decide.mockResolvedValue({ speciesPermissions: [] });
    onboarding.submitBreeder.mockResolvedValue({
      id: applicationId,
      status: 'PENDING_CALL',
      species: ['Fixture'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
  const customer = (role = 'customer') =>
    'Bearer ' + jwt.sign({ sub: userId, phone: '09000000000', role });
  const admin = () =>
    'Bearer ' + jwt.sign({ scope: 'admin-panel', username: 'review-fixture' });
  const path = `/admin-panel/seller-onboarding/breeder-applications/${applicationId}`;
  const body = () => ({
    requestId: randomUUID(),
    expectedRevision: 1,
    reason: 'Explicit decision',
  });
  it('requires authentication for customer taxonomy', async () => {
    await request(server).get('/seller-onboarding/taxonomy').expect(401);
    expect(service.taxonomy).not.toHaveBeenCalled();
  });
  it.each(['customer', 'breeder'])(
    'accepts %s with existing customer guards',
    async (role) => {
      await request(server)
        .get('/seller-onboarding/taxonomy')
        .set('Authorization', customer(role))
        .expect(200);
    },
  );
  it('rejects persisted ADMIN from the customer API', async () => {
    await request(server)
      .get('/seller-onboarding/taxonomy')
      .set('Authorization', customer('admin'))
      .expect(403);
  });
  it('binds customer ownership to authenticated identity', async () => {
    await request(server)
      .get(
        `/seller-onboarding/breeder-applications/${applicationId}/permissions`,
      )
      .set('Authorization', customer())
      .expect(200);
    expect(service.read).toHaveBeenCalledWith(applicationId, userId);
    const input = {
      requestId: randomUUID(),
      selections: [{ speciesId: randomUUID(), subspeciesIds: [randomUUID()] }],
    };
    await request(server)
      .post(
        `/seller-onboarding/breeder-applications/${applicationId}/taxon-requests`,
      )
      .set('Authorization', customer())
      .send(input)
      .expect(201);
    expect(service.request).toHaveBeenCalledWith(applicationId, userId, input);
  });
  it.each(['species-permissions', 'subspecies-permissions'])(
    'wires all four %s actions using server admin identity',
    async (kind) => {
      for (const action of ['approve', 'reject', 'revoke', 'regrant']) {
        const input = body();
        await request(server)
          .post(`${path}/${kind}/${permissionId}/${action}`)
          .set('Authorization', admin())
          .send(input)
          .expect(201);
        expect(service.decide).toHaveBeenLastCalledWith(
          applicationId,
          permissionId,
          kind,
          action,
          'review-fixture',
          input,
        );
      }
    },
  );
  it.each([undefined, 'customer', 'breeder', 'owner', 'unregistered'])(
    'rejects unauthorized admin caller %s',
    async (identity) => {
      const authorization =
        identity === 'owner'
          ? 'Bearer ' + jwt.sign({ scope: 'god-admin-panel', role: 'owner' })
          : identity === 'unregistered'
            ? 'Bearer ' + jwt.sign({ scope: 'admin-panel', username: identity })
            : identity
              ? customer(identity)
              : undefined;
      const req = request(server)
        .post(`${path}/species-permissions/${permissionId}/approve`)
        .send(body());
      if (authorization) req.set('Authorization', authorization);
      await req.expect(401);
      expect(service.decide).not.toHaveBeenCalled();
    },
  );
  it('rejects invalid paths, invalid revisions and missing reasons', async () => {
    for (const input of [
      { ...body(), expectedRevision: '1' },
      { ...body(), reason: '' },
    ])
      await request(server)
        .post(`${path}/species-permissions/${permissionId}/approve`)
        .set('Authorization', admin())
        .send(input)
        .expect(400);
    await request(server)
      .post(`${path}/species-permissions/${permissionId}/request`)
      .set('Authorization', admin())
      .send(body())
      .expect(400);
    expect(service.decide).not.toHaveBeenCalled();
  });
  it.each(['species-permissions', 'subspecies-permissions'])(
    'strips injected fields for every %s admin mutation; actor and action come from server/route',
    async (kind) => {
      for (const action of ['approve', 'reject', 'revoke', 'regrant']) {
        const input = body();
        await request(server)
          .post(`${path}/${kind}/${permissionId}/${action}`)
          .set('Authorization', admin())
          .send({
            ...input,
            actorId: 'forged',
            username: 'owner-fixture',
            state: 'APPROVED',
            revision: 500,
            applicationId: randomUUID(),
            permissionId: randomUUID(),
            action: 'approve',
          })
          .expect(201);
        expect(service.decide).toHaveBeenLastCalledWith(
          applicationId,
          permissionId,
          kind,
          action,
          'review-fixture',
          input,
        );
      }
    },
  );
  it('strips customer actor/owner/approval claims recursively and preserves server ownership', async () => {
    const selected = { speciesId: randomUUID(), subspeciesIds: [randomUUID()] };
    const input = { requestId: randomUUID(), selections: [selected] };
    await request(server)
      .post(
        `/seller-onboarding/breeder-applications/${applicationId}/taxon-requests`,
      )
      .set('Authorization', customer())
      .send({
        ...input,
        userId: randomUUID(),
        actorId: 'forged',
        state: 'APPROVED',
        selections: [
          {
            ...selected,
            state: 'APPROVED',
            revision: 500,
            speciesPermissionId: randomUUID(),
          },
        ],
      })
      .expect(201);
    expect(service.request).toHaveBeenCalledWith(applicationId, userId, input);
  });
  const application = {
    breederName: 'Fixture',
    city: 'City',
    experienceYears: 1,
    approximateBirdCount: 1,
    preferredContactTime: 'Morning',
  };
  it.each([[], [[]], null, true, 42, 'text', {}])(
    'initial application rejects malformed taxonRequest %p before service execution',
    async (taxonRequest) => {
      const response = await request(server)
        .post('/seller-onboarding/breeder-application')
        .set('Authorization', customer())
        .send({ ...application, taxonRequest })
        .expect(400);
      expect(response.text).not.toContain('TypeError');
      expect(onboarding.submitBreeder).not.toHaveBeenCalled();
    },
  );
  it.each([
    [],
    [[]],
    [[], []],
    [[{}]],
    [null],
    [42],
    [true],
    ['text'],
    null,
    {},
    'text',
    42,
  ])(
    'customer request rejects malformed selections %p before service execution',
    async (selections) => {
      await request(server)
        .post(
          `/seller-onboarding/breeder-applications/${applicationId}/taxon-requests`,
        )
        .set('Authorization', customer())
        .send({ requestId: randomUUID(), selections })
        .expect(400);
      expect(service.request).not.toHaveBeenCalled();
    },
  );
  it.each([[], [[]], [null], [{}], [true], [42], null, {}, 'text'])(
    'customer request rejects malformed children %p before service execution',
    async (subspeciesIds) => {
      await request(server)
        .post(
          `/seller-onboarding/breeder-applications/${applicationId}/taxon-requests`,
        )
        .set('Authorization', customer())
        .send({
          requestId: randomUUID(),
          selections: [{ speciesId: randomUUID(), subspeciesIds }],
        })
        .expect(400);
      expect(service.request).not.toHaveBeenCalled();
    },
  );
  it('preserves valid legacy and structured initial application payloads under production validation', async () => {
    const legacy = { ...application, species: ['Fixture'] };
    await request(server)
      .post('/seller-onboarding/breeder-application')
      .set('Authorization', customer())
      .send(legacy)
      .expect(201);
    expect(onboarding.submitBreeder).toHaveBeenLastCalledWith(userId, legacy);
    const structured = {
      ...application,
      taxonRequest: {
        requestId: randomUUID(),
        selections: [
          { speciesId: randomUUID(), subspeciesIds: [randomUUID()] },
        ],
      },
    };
    await request(server)
      .post('/seller-onboarding/breeder-application')
      .set('Authorization', customer())
      .send(structured)
      .expect(201);
    expect(onboarding.submitBreeder).toHaveBeenLastCalledWith(
      userId,
      structured,
    );
  });
  it.each(['approve', 'reject', 'revoke', 'regrant'])(
    'validates known fields strictly for admin %s despite stripping unknown fields',
    async (action) => {
      for (const invalid of [
        { ...body(), requestId: [] },
        { ...body(), expectedRevision: [] },
        { ...body(), reason: [] },
        { ...body(), expectedRevision: true },
        { ...body(), reason: null },
      ])
        await request(server)
          .post(`${path}/species-permissions/${permissionId}/${action}`)
          .set('Authorization', admin())
          .send(invalid)
          .expect(400);
      expect(service.decide).not.toHaveBeenCalled();
    },
  );
  it('serves admin taxonomy and permission reads under the admin guard', async () => {
    await request(server)
      .get('/admin-panel/seller-onboarding/taxonomy')
      .set('Authorization', admin())
      .expect(200);
    await request(server)
      .get(`${path}/permissions`)
      .set('Authorization', admin())
      .expect(200);
    expect(service.read).toHaveBeenCalledWith(applicationId);
  });
});
