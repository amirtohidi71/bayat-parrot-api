import { ReapplicationIntent } from './seller-lifecycle';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import {
  BreederApplicationStatus,
  BreederCallOutcome,
} from './entities/breeder-application.entity';
import { SellerVerificationStatus } from './entities/seller-verification.entity';
import { AdminSellerOnboardingController } from './admin-seller-onboarding.controller';
import { SellerOnboardingService } from './seller-onboarding.service';

describe('Admin seller onboarding HTTP authorization', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  const id = randomUUID();
  const adminUsernames = ['pahlevan', 'bayat', 'shoaei', 'shayan', 'ahmadi'];
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'ADMIN_USERS') return adminUsernames.join(',');
      if (key === 'GOD_ADMIN_USERNAME') return 'owner-fixture';
      return undefined;
    }),
  };
  const user = {
    id: randomUUID(),
    firstName: 'First',
    lastName: 'Last',
    phone: '09120000000',
  };
  const seller = {
    id,
    user,
    firstName: 'First',
    lastName: 'Last',
    birthDate: '2000-01-01',
    consentAcceptedAt: new Date(),
    consentVersion: 'seller-consent-v1',
    status: SellerVerificationStatus.PENDING,
    rejectionReason: null,
    internalAdminNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const breeder = {
    id,
    user,
    breederName: 'Breeder',
    city: 'City',
    species: ['Species'],
    experienceYears: 1,
    approximateBirdCount: 1,
    preferredContactTime: 'Morning',
    instagramUrl: null,
    websiteUrl: null,
    description: null,
    status: BreederApplicationStatus.PENDING_CALL,
    callOutcome: null,
    contactedAt: null,
    privateCallNote: null,
    rejectionReason: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const onboarding = {
    listSellers: jest.fn(),
    sellerDetail: jest.fn(),
    approveSeller: jest.fn(),
    rejectSeller: jest.fn(),
    revokeSellerAccess: jest.fn(),
    grantSellerReapplication: jest.fn(),
    listBreeders: jest.fn(),
    breederDetail: jest.fn(),
    recordBreederCall: jest.fn(),
    approveBreeder: jest.fn(),
    rejectBreeder: jest.fn(),
    revokeBreeder: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: randomBytes(32).toString('hex') }),
      ],
      controllers: [AdminSellerOnboardingController],
      providers: [
        AdminAuthGuard,
        { provide: ConfigService, useValue: configService },
        { provide: SellerOnboardingService, useValue: onboarding },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
    jwt = moduleRef.get(JwtService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    onboarding.listSellers.mockResolvedValue([]);
    onboarding.sellerDetail.mockResolvedValue(seller);
    onboarding.approveSeller.mockResolvedValue(seller);
    onboarding.rejectSeller.mockResolvedValue(seller);
    onboarding.revokeSellerAccess.mockResolvedValue({
      ...seller,
      status: SellerVerificationStatus.APPROVED,
      revokedAt: new Date(),
      revokedBy: adminUsernames[0],
      revocationReason: 'Policy violation',
    });
    onboarding.listBreeders.mockResolvedValue([]);
    onboarding.breederDetail.mockResolvedValue(breeder);
    onboarding.recordBreederCall.mockResolvedValue(breeder);
    onboarding.approveBreeder.mockResolvedValue(breeder);
    onboarding.rejectBreeder.mockResolvedValue(breeder);
    onboarding.revokeBreeder.mockResolvedValue({
      ...breeder,
      status: BreederApplicationStatus.APPROVED,
      revokedAt: new Date(),
      revokedBy: adminUsernames[0],
      revocationReason: 'Renew evidence',
      reapplicationIntent: ReapplicationIntent.REQUIRE_REVERIFICATION,
    });
  });

  afterAll(async () => app?.close());

  const bearer = (payload: Record<string, unknown>) =>
    'Bearer ' + jwt.sign(payload);
  const adminBearer = (username = adminUsernames[0]) =>
    bearer({ scope: 'admin-panel', username });

  it('mounts every admin operation under the admin-panel prefix', async () => {
    const authorization = adminBearer();
    await request(server)
      .get('/admin-panel/seller-onboarding/verifications')
      .set('Authorization', authorization)
      .expect(200);
    await request(server)
      .get(`/admin-panel/seller-onboarding/verifications/${id}`)
      .set('Authorization', authorization)
      .expect(200);
    await request(server)
      .post(`/admin-panel/seller-onboarding/verifications/${id}/approve`)
      .set('Authorization', authorization)
      .send({})
      .expect(201);
    await request(server)
      .post(`/admin-panel/seller-onboarding/verifications/${id}/reject`)
      .set('Authorization', authorization)
      .send({ rejectionReason: 'Correction required' })
      .expect(201);
    await request(server)
      .post(`/admin-panel/seller-onboarding/verifications/${id}/revoke`)
      .set('Authorization', authorization)
      .send({ reason: 'Policy violation' })
      .expect(201);
    await request(server)
      .get('/admin-panel/seller-onboarding/breeder-applications')
      .set('Authorization', authorization)
      .expect(200);
    await request(server)
      .get(`/admin-panel/seller-onboarding/breeder-applications/${id}`)
      .set('Authorization', authorization)
      .expect(200);
    await request(server)
      .post(`/admin-panel/seller-onboarding/breeder-applications/${id}/contact`)
      .set('Authorization', authorization)
      .send({ outcome: BreederCallOutcome.SUCCESSFUL })
      .expect(201);
    await request(server)
      .post(`/admin-panel/seller-onboarding/breeder-applications/${id}/approve`)
      .set('Authorization', authorization)
      .expect(201);
    await request(server)
      .post(`/admin-panel/seller-onboarding/breeder-applications/${id}/reject`)
      .set('Authorization', authorization)
      .send({ rejectionReason: 'Correction required' })
      .expect(201);
  });

  it.each([
    ['missing', undefined],
    ['customer', { sub: randomUUID(), phone: '09120000000', role: 'customer' }],
  ])(
    'rejects %s credentials from seller access revocation',
    async (_kind, payload) => {
      const call = request(server)
        .post(`/admin-panel/seller-onboarding/verifications/${id}/revoke`)
        .send({ reason: 'Policy violation' });
      if (payload) call.set('Authorization', bearer(payload));
      await call.expect(401);
      expect(onboarding.revokeSellerAccess).not.toHaveBeenCalled();
    },
  );

  it('requires a bounded revocation reason', async () => {
    await request(server)
      .post(`/admin-panel/seller-onboarding/verifications/${id}/revoke`)
      .set('Authorization', adminBearer())
      .send({ reason: '   ' })
      .expect(400);
    expect(onboarding.revokeSellerAccess).not.toHaveBeenCalled();
  });

  it('accepts every configured admin-panel identity', async () => {
    for (const username of adminUsernames) {
      await request(server)
        .get('/admin-panel/seller-onboarding/verifications')
        .set('Authorization', adminBearer(username))
        .expect(200);
    }
    expect(onboarding.listSellers).toHaveBeenCalledTimes(5);
  });

  it('grants only reason and authenticated admin identity, ignoring spoofed audit/access fields', async () => {
    onboarding.grantSellerReapplication.mockResolvedValue({
      ...seller,
      status: SellerVerificationStatus.APPROVED,
      revokedAt: new Date(),
      reapplicationIntent: ReapplicationIntent.BLOCKED,
      reapplicationGrantedAt: new Date(),
      reapplicationGrantedBy: adminUsernames[0],
      reapplicationGrantReason: 'Reviewed recovery',
    });
    const response = await request(server)
      .post(
        `/admin-panel/seller-onboarding/verifications/${id}/grant-reapplication`,
      )
      .set('Authorization', adminBearer())
      .send({
        reason: ' Reviewed recovery ',
        userId: randomUUID(),
        status: 'APPROVED',
        reapplicationGrantedBy: 'spoofed',
        reapplicationGrantedAt: '2000-01-01',
      })
      .expect(201);
    expect(onboarding.grantSellerReapplication).toHaveBeenCalledWith(
      id,
      adminUsernames[0],
      { reason: 'Reviewed recovery' },
    );
    expect(response.body as unknown).toMatchObject({
      effectiveStatus: 'REVERIFICATION_REQUIRED',
      reapplicationIntent: 'REQUIRE_REVERIFICATION',
      originalReapplicationIntent: 'BLOCKED',
      reapplicationGrantedBy: adminUsernames[0],
    });
  });

  it.each([
    undefined,
    { role: 'customer', sub: id },
    { role: 'breeder', sub: id },
    { scope: 'god-admin-panel', username: 'owner-fixture' },
  ])('denies direct recovery bypass %#', async (payload) => {
    const call = request(server)
      .post(
        `/admin-panel/seller-onboarding/verifications/${id}/grant-reapplication`,
      )
      .send({ reason: 'Reason' });
    if (payload) call.set('Authorization', bearer(payload));
    await call.expect(401);
    expect(onboarding.grantSellerReapplication).not.toHaveBeenCalled();
  });

  it.each([{}, { reason: ' ' }, { reason: true }, { reason: 'x'.repeat(501) }])(
    'validates recovery reason %#',
    async (input) => {
      await request(server)
        .post(
          `/admin-panel/seller-onboarding/verifications/${id}/grant-reapplication`,
        )
        .set('Authorization', adminBearer())
        .send(input)
        .expect(400);
      expect(onboarding.grantSellerReapplication).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing', undefined],
    ['customer', { sub: randomUUID(), phone: '09120000000', role: 'customer' }],
    ['breeder', { sub: randomUUID(), phone: '09120000000', role: 'breeder' }],
    ['missing username', { scope: 'admin-panel' }],
    ['blank username', { scope: 'admin-panel', username: '   ' }],
    ['unregistered username', { scope: 'admin-panel', username: randomUUID() }],
    [
      'god admin',
      { scope: 'god-admin-panel', role: 'owner', username: randomUUID() },
    ],
  ])('rejects %s credentials', async (_kind, payload) => {
    const call = request(server).get(
      '/admin-panel/seller-onboarding/verifications',
    );
    if (payload) call.set('Authorization', bearer(payload));
    await call.expect(401);
    expect(onboarding.listSellers).not.toHaveBeenCalled();
  });

  it('does not expose the previous admin route', async () => {
    await request(server)
      .get('/admin/seller-onboarding/verifications')
      .set('Authorization', adminBearer())
      .expect(404);
    expect(onboarding.listSellers).not.toHaveBeenCalled();
  });
  it('accepts explicit seller re-verification intent without changing the default revoke contract', async () => {
    await request(server)
      .post(`/admin-panel/seller-onboarding/verifications/${id}/revoke`)
      .set('Authorization', adminBearer())
      .send({ reason: 'Renew identity', intent: 'REQUIRE_REVERIFICATION' })
      .expect(201);
    expect(onboarding.revokeSellerAccess).toHaveBeenCalledWith(
      id,
      adminUsernames[0],
      { reason: 'Renew identity', intent: 'REQUIRE_REVERIFICATION' },
    );
  });
  it('exposes breeder revoke only to configured admins with strict allowlisted output', async () => {
    const response = await request(server)
      .post(`/admin-panel/seller-onboarding/breeder-applications/${id}/revoke`)
      .set('Authorization', adminBearer())
      .send({ reason: 'Renew evidence', intent: 'REQUIRE_REVERIFICATION' })
      .expect(201);
    expect(onboarding.revokeBreeder).toHaveBeenCalledWith(
      id,
      adminUsernames[0],
      { reason: 'Renew evidence', intent: 'REQUIRE_REVERIFICATION' },
    );
    const body = response.body as {
      effectiveStatus: string;
      revokedBy: string;
      privateCallNote: string | null;
      user: Record<string, unknown>;
    };
    expect(body.effectiveStatus).toBe('REVERIFICATION_REQUIRED');
    expect(body.user).not.toHaveProperty('nationalId');
  });
  it.each([
    undefined,
    { role: 'customer', sub: id },
    { role: 'breeder', sub: id },
    { scope: 'god-admin-panel', role: 'owner', username: 'owner-fixture' },
  ])('denies non-admin breeder revocation %#', async (payload) => {
    const call = request(server)
      .post(`/admin-panel/seller-onboarding/breeder-applications/${id}/revoke`)
      .send({ reason: 'Forbidden' });
    if (payload) call.set('Authorization', bearer(payload));
    await call.expect(401);
    expect(onboarding.revokeBreeder).not.toHaveBeenCalled();
  });
  it.each([
    { reason: ' ' },
    { reason: 'Reason', intent: true },
    { reason: 'Reason', intent: 'ALLOW_ANYTHING' },
  ])('rejects invalid breeder revoke input %#', async (input) => {
    await request(server)
      .post(`/admin-panel/seller-onboarding/breeder-applications/${id}/revoke`)
      .set('Authorization', adminBearer())
      .send(input)
      .expect(400);
    expect(onboarding.revokeBreeder).not.toHaveBeenCalled();
  });
});
