import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { SmsService } from '../common/sms/sms.service';
import { User, UserRole } from './entities/user.entity';
import { UserDirectoryAdminGuard } from './guards/user-directory-admin.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('Users HTTP security with real JWT guards and profile services', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let users: Map<string, User>;
  let customer: User;
  let other: User;
  let admin: User;
  const secret = randomBytes(32).toString('hex');
  const repository = {
    find: jest.fn(() => Promise.resolve([...users.values()])),
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(users.get(where.id) ?? null),
    ),
    save: jest.fn((user: User) => {
      users.set(user.id, user);
      return Promise.resolve(user);
    }),
  };
  const sms = { sendOtp: jest.fn() };
  const database = { transaction: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret }),
      ],
      controllers: [UsersController, AuthController],
      providers: [
        UsersService,
        AuthService,
        JwtStrategy,
        JwtAuthGuard,
        UserDirectoryAdminGuard,
        { provide: getRepositoryToken(User), useValue: repository },
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: secret }),
        },
        { provide: DataSource, useValue: database },
        { provide: SmsService, useValue: sms },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        validationError: { target: false, value: false },
      }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
    jwt = moduleRef.get(JwtService);
  });

  beforeEach(() => {
    customer = fixture('09111111111', '0012345678');
    other = fixture('09222222222', '0098765432');
    admin = fixture('09333333333', '0055555555', UserRole.ADMIN);
    users = new Map([customer, other, admin].map((user) => [user.id, user]));
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lets a customer read only their own allowlisted profile, without loaded relations', async () => {
    const response = await request(server)
      .get('/users/profile')
      .set('Authorization', token(customer))
      .expect(200);
    expect(response.body).toMatchObject({
      id: customer.id,
      phone: customer.phone,
      nationalId: customer.nationalId,
      loyaltyPoints: 12,
    });
    expect(response.body).not.toHaveProperty('productReviews');
    expect(response.body).not.toHaveProperty('reviewedProductReviews');
    expect(response.body).not.toHaveProperty('unexpectedPrivateField');
    expect(response.text).not.toContain(other.nationalId);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { id: customer.id },
    });
  });

  it.each([
    '/users',
    '/users/00000000-0000-4000-8000-000000000000',
    '/users/not-a-uuid',
  ])(
    'denies customer directory access to %s before loading user records',
    async (path) => {
      const response = await request(server)
        .get(path)
        .set('Authorization', token(customer))
        .expect(403);
      expect(repository.find).not.toHaveBeenCalled();
      expect(repository.findOne).not.toHaveBeenCalled();
      expect(response.text).not.toContain(other.phone);
      expect(response.text).not.toContain(other.nationalId);
    },
  );

  it('does not expose another existing user or allow /:id as a customer profile alias', async () => {
    for (const target of [other.id, customer.id]) {
      const response = await request(server)
        .get('/users/' + target)
        .set('Authorization', token(customer))
        .expect(403);
      expect(response.text).not.toContain(other.nationalId);
      expect(response.text).not.toContain(other.firstName);
    }
    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('preserves own profile edits, ignoring injected identity, role, phone and loyalty fields', async () => {
    const response = await request(server)
      .patch('/users/profile')
      .set('Authorization', token(customer))
      .send({
        firstName: 'Updated',
        lastName: 'Owner',
        email: 'owner@example.test',
        nationalId: '0011111111',
        id: other.id,
        role: 'admin',
        phone: other.phone,
        loyaltyPoints: 999,
      })
      .expect(200);
    expect(response.body).toMatchObject({
      id: customer.id,
      firstName: 'Updated',
      lastName: 'Owner',
      email: 'owner@example.test',
      nationalId: '0011111111',
      role: 'customer',
      phone: customer.phone,
      loyaltyPoints: 12,
    });
    expect(users.get(other.id)?.nationalId).toBe('0098765432');
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('retains national ID input validation without saving invalid profile edits', async () => {
    await request(server)
      .patch('/users/profile')
      .set('Authorization', token(customer))
      .send({ nationalId: 'bad' })
      .expect(400);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('preserves current-user registration and its safe response contract', async () => {
    customer.profileCompleted = false;
    const response = await request(server)
      .post('/auth/register')
      .set('Authorization', token(customer))
      .send({
        firstName: 'Registered',
        lastName: 'Owner',
        id: other.id,
        role: 'admin',
      })
      .expect(201);
    expect(response.body).toMatchObject({
      id: customer.id,
      firstName: 'Registered',
      profileCompleted: true,
      role: 'customer',
    });
    expect(response.body).not.toHaveProperty('productReviews');
    expect(response.text).not.toContain(other.nationalId);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('preserves current-user loyalty/account reads', async () => {
    const response = await request(server)
      .get('/users/loyalty-points')
      .set('Authorization', token(customer))
      .expect(200);
    expect(response.body).toEqual({ loyaltyPoints: 12 });
  });

  it('preserves persisted legacy admin directory/detail access without national IDs or relations', async () => {
    const list = await request(server)
      .get('/users')
      .set('Authorization', token(admin))
      .expect(200);
    expect(list.body).toHaveLength(3);
    expect(list.text).not.toContain('nationalId');
    expect(list.text).not.toContain('productReviews');
    expect(list.text).not.toContain('unexpectedPrivateField');
    const detail = await request(server)
      .get('/users/' + other.id)
      .set('Authorization', token(admin))
      .expect(200);
    expect(detail.body).toMatchObject({ id: other.id, phone: other.phone });
    expect(detail.body).not.toHaveProperty('nationalId');
    expect(detail.headers['cache-control']).toBe('private, no-store');
  });

  it('rejects a stale admin JWT after the persisted user has been demoted', async () => {
    const authorization = token(admin);
    admin.role = UserRole.CUSTOMER;
    await request(server)
      .get('/users')
      .set('Authorization', authorization)
      .expect(403);
    expect(repository.find).not.toHaveBeenCalled();
  });

  it('validates admin detail UUIDs and preserves not-found behavior', async () => {
    await request(server)
      .get('/users/not-a-uuid')
      .set('Authorization', token(admin))
      .expect(400);
    await request(server)
      .get('/users/' + randomUUID())
      .set('Authorization', token(admin))
      .expect(404);
  });

  it.each([
    '/users',
    '/users/profile',
    '/users/00000000-0000-4000-8000-000000000000',
  ])('rejects unauthenticated access to %s', async (path) => {
    await request(server).get(path).expect(401);
    expect(repository.findOne).not.toHaveBeenCalled();
    expect(repository.find).not.toHaveBeenCalled();
  });

  it('rejects expired, forged and cross-scope tokens through the actual JWT strategy', async () => {
    const payload = { sub: admin.id, phone: admin.phone, role: admin.role };
    const tokens = [
      jwt.sign(payload, { expiresIn: -1 }),
      jwt.sign(payload, { secret: randomBytes(32).toString('hex') }),
      ...['admin-panel', 'bird-passport', 'sales-agent', 'vet-doctor'].map(
        (scope) => jwt.sign({ ...payload, scope }),
      ),
    ];
    for (const value of tokens) {
      await request(server)
        .get('/users')
        .set('Authorization', 'Bearer ' + value)
        .expect(401);
    }
    expect(repository.findOne).not.toHaveBeenCalled();
  });

  function token(user: User): string {
    return (
      'Bearer ' + jwt.sign({ sub: user.id, phone: user.phone, role: user.role })
    );
  }
  function fixture(
    phone: string,
    nationalId: string,
    role = UserRole.CUSTOMER,
  ): User {
    return Object.assign(new User(), {
      id: randomUUID(),
      phone,
      nationalId,
      firstName: 'Owner-' + phone,
      lastName: 'Test',
      email: null,
      profileCompleted: true,
      loyaltyPoints: 12,
      role,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      productReviews: [{ unexpected: 'must not serialize' }],
      reviewedProductReviews: [],
      unexpectedPrivateField: 'must not serialize',
    });
  }
});
