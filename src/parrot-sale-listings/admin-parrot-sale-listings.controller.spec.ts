import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'crypto';
import type { Server } from 'http';
import request from 'supertest';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminParrotSaleListingsController } from './admin-parrot-sale-listings.controller';
import {
  ParrotSaleListing,
  ParrotSaleListingStatus,
} from './entities/parrot-sale-listing.entity';
import { ParrotSaleListingsService } from './parrot-sale-listings.service';

describe('AdminParrotSaleListingsController HTTP', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  const id = randomUUID();
  const sellerId = randomUUID();
  const adminUsername = 'pahlevan';
  const service = {
    listForAdmin: jest.fn(),
    getForAdmin: jest.fn(),
    reject: jest.fn(),
    readReviewImage: jest.fn(),
  };

  const row = (status = ParrotSaleListingStatus.PENDING_REVIEW) =>
    Object.assign(new ParrotSaleListing(), {
      id,
      sellerUserId: sellerId,
      seller: {
        id: sellerId,
        phone: '09120000000',
        firstName: 'Seller',
        lastName: 'Bird',
        email: 'private@example.com',
        nationalId: 'private-national-id',
        loyaltyPoints: 999,
        role: UserRole.CUSTOMER,
        profileCompleted: true,
      },
      status,
      name: 'Grey parrot',
      description: null,
      species: 'African Grey',
      subspecies: null,
      gender: null,
      ageStage: null,
      colors: null,
      tagPair: false,
      tagHandTame: true,
      requestedPrice: 100,
      approvedPrice: null,
      quantity: 1,
      productId: null,
      rejectionReason:
        status === ParrotSaleListingStatus.REJECTED ? 'Reason' : null,
      internalAdminNote:
        status === ParrotSaleListingStatus.REJECTED ? 'Internal' : null,
      reviewedBy:
        status === ParrotSaleListingStatus.REJECTED ? adminUsername : null,
      reviewedAt:
        status === ParrotSaleListingStatus.REJECTED ? new Date() : null,
      resubmissionOfId: null,
      images: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: randomBytes(32).toString('hex') }),
      ],
      controllers: [AdminParrotSaleListingsController],
      providers: [
        AdminAuthGuard,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'ADMIN_USERS') return adminUsername;
              if (key === 'GOD_ADMIN_USERNAME') return 'owner-fixture';
              return undefined;
            }),
          },
        },
        { provide: ParrotSaleListingsService, useValue: service },
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
    service.listForAdmin.mockResolvedValue([row()]);
    service.getForAdmin.mockResolvedValue(row());
    service.reject.mockResolvedValue(row(ParrotSaleListingStatus.REJECTED));
    service.readReviewImage.mockResolvedValue({
      buffer: Buffer.from('webp'),
      mimeType: 'image/webp',
      size: 4,
    });
  });

  afterAll(async () => app?.close());

  const bearer = (payload: Record<string, unknown>) =>
    `Bearer ${jwt.sign(payload)}`;
  const adminBearer = () =>
    bearer({ scope: 'admin-panel', username: adminUsername });

  it('lists and filters review records through the admin allowlist', async () => {
    const response = await request(server)
      .get('/admin-panel/parrot-sale-listings?status=PENDING_REVIEW')
      .set('Authorization', adminBearer())
      .expect(200);
    expect(service.listForAdmin).toHaveBeenCalledWith(
      ParrotSaleListingStatus.PENDING_REVIEW,
    );
    expect(response.body).toEqual([
      expect.objectContaining({
        id,
        seller: {
          id: sellerId,
          phone: '09120000000',
          firstName: 'Seller',
          lastName: 'Bird',
          role: UserRole.CUSTOMER,
          profileCompleted: true,
        },
        requestedPrice: 100,
      }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain('nationalId');
    expect(JSON.stringify(response.body)).not.toContain('loyaltyPoints');
    expect(JSON.stringify(response.body)).not.toContain('private@example.com');
  });

  it('returns detail and rejects with the authenticated admin identity', async () => {
    await request(server)
      .get(`/admin-panel/parrot-sale-listings/${id}`)
      .set('Authorization', adminBearer())
      .expect(200);
    await request(server)
      .post(`/admin-panel/parrot-sale-listings/${id}/reject`)
      .set('Authorization', adminBearer())
      .send({
        rejectionReason: 'Missing details',
        internalAdminNote: 'Private review note',
      })
      .expect(201);
    expect(service.getForAdmin).toHaveBeenCalledWith(id);
    expect(service.reject).toHaveBeenCalledWith(id, adminUsername, {
      rejectionReason: 'Missing details',
      internalAdminNote: 'Private review note',
    });
  });

  it('streams an authenticated review image with private no-store headers', async () => {
    await request(server)
      .get(`/admin-panel/parrot-sale-listings/${id}/images/${id}/content`)
      .set('Authorization', adminBearer())
      .expect(200)
      .expect('Content-Type', 'image/webp')
      .expect('Content-Disposition', 'inline')
      .expect('Cache-Control', 'private, no-store')
      .expect('X-Content-Type-Options', 'nosniff');
    expect(service.readReviewImage).toHaveBeenCalledWith(id, id);
  });

  it('rejects invalid filters, missing rejection reason and absent approval route', async () => {
    const authorization = adminBearer();
    await request(server)
      .get('/admin-panel/parrot-sale-listings?status=INVALID')
      .set('Authorization', authorization)
      .expect(400);
    await request(server)
      .post(`/admin-panel/parrot-sale-listings/${id}/reject`)
      .set('Authorization', authorization)
      .send({})
      .expect(400);
    await request(server)
      .post(`/admin-panel/parrot-sale-listings/${id}/approve`)
      .set('Authorization', authorization)
      .expect(404);
  });

  it.each([
    ['missing', undefined],
    [
      'customer',
      { sub: sellerId, phone: '09120000000', role: UserRole.CUSTOMER },
    ],
    [
      'god admin',
      { scope: 'god-admin-panel', role: 'owner', username: 'owner-fixture' },
    ],
  ])('rejects %s credentials', async (_kind, payload) => {
    const call = request(server).get('/admin-panel/parrot-sale-listings');
    if (payload) call.set('Authorization', bearer(payload));
    await call.expect(401);
    expect(service.listForAdmin).not.toHaveBeenCalled();
  });
});
