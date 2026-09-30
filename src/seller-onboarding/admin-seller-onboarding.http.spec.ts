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
    listBreeders: jest.fn(),
    breederDetail: jest.fn(),
    recordBreederCall: jest.fn(),
    approveBreeder: jest.fn(),
    rejectBreeder: jest.fn(),
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
    onboarding.listBreeders.mockResolvedValue([]);
    onboarding.breederDetail.mockResolvedValue(breeder);
    onboarding.recordBreederCall.mockResolvedValue(breeder);
    onboarding.approveBreeder.mockResolvedValue(breeder);
    onboarding.rejectBreeder.mockResolvedValue(breeder);
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

  it('accepts every configured admin-panel identity', async () => {
    for (const username of adminUsernames) {
      await request(server)
        .get('/admin-panel/seller-onboarding/verifications')
        .set('Authorization', adminBearer(username))
        .expect(200);
    }
    expect(onboarding.listSellers).toHaveBeenCalledTimes(5);
  });

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
});
