import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import { UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AdminVetCustomerDirectoryController } from './admin-vet-customer-directory.controller';

describe('Admin vet customer directory HTTP', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  const secret = randomBytes(32).toString('hex');
  const customers = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret })],
      controllers: [AdminVetCustomerDirectoryController],
      providers: [
        AdminAuthGuard,
        {
          provide: UsersService,
          useValue: { findCustomersForAdminVetAssignment: customers },
        },
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: secret }),
        },
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

  beforeEach(() => jest.resetAllMocks());
  afterAll(async () => app?.close());

  const authorization = (scope = 'admin-panel') =>
    'Bearer ' + jwt.sign({ scope, username: 'test-admin' });

  it('accepts an admin-panel token and returns only allowlisted customer fields', async () => {
    customers.mockResolvedValue([
      {
        id: randomUUID(),
        phone: '09120000000',
        firstName: 'Customer',
        lastName: 'One',
        email: 'customer@example.test',
        profileCompleted: true,
        role: UserRole.CUSTOMER,
        nationalId: 'secret',
        loyaltyPoints: 12,
        createdAt: new Date(),
        updatedAt: new Date(),
        productReviews: [{ secret: true }],
      },
    ]);

    const response = await request(server)
      .get('/admin/vet/customers')
      .set('Authorization', authorization())
      .expect(200);

    expect(response.body).toEqual([
      expect.objectContaining({
        phone: '09120000000',
        role: UserRole.CUSTOMER,
      }),
    ]);
    expect(Object.keys(response.body[0]).sort()).toEqual([
      'email',
      'firstName',
      'id',
      'lastName',
      'phone',
      'profileCompleted',
      'role',
    ]);
    expect(response.text).not.toContain('secret');
    expect(response.text).not.toContain('loyaltyPoints');
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it.each(['missing', 'customer'])('rejects %s credentials', async (kind) => {
    const token = kind === 'missing' ? '' : authorization('customer');
    await request(server)
      .get('/admin/vet/customers')
      .set('Authorization', token)
      .expect(401);
    expect(customers).not.toHaveBeenCalled();
  });
});
