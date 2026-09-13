import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { VetAvailabilityService } from './availability.service';
import { CustomerVetAvailabilityController } from './customer-availability.controller';

describe('Customer bookable vet slots HTTP', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  const secret = randomBytes(32).toString('hex');
  const service = { bookableSlots: jest.fn() };
  const range = {
    from: '2030-01-01T00:00:00Z',
    to: '2030-02-01T00:00:00Z',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret }),
      ],
      controllers: [CustomerVetAvailabilityController],
      providers: [
        JwtAuthGuard,
        JwtStrategy,
        { provide: VetAvailabilityService, useValue: service },
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: secret }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        validationError: { target: false, value: false },
      }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
    jwt = moduleRef.get(JwtService);
  });

  beforeEach(() => jest.resetAllMocks());
  afterAll(async () => app?.close());

  const token = (role = 'customer') =>
    'Bearer ' + jwt.sign({ sub: randomUUID(), phone: '09111111111', role });

  it('requires a valid customer JWT before querying availability', async () => {
    await request(server)
      .get('/vet/availability/slots')
      .query(range)
      .expect(401);
    await request(server)
      .get('/vet/availability/slots')
      .query(range)
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    await request(server)
      .get('/vet/availability/slots')
      .query(range)
      .set('Authorization', token('admin'))
      .expect(403);
    expect(service.bookableSlots).not.toHaveBeenCalled();
  });

  it('passes only validated date bounds and returns the public slot shape', async () => {
    const slot = {
      slotId: randomUUID(),
      doctorId: randomUUID(),
      doctorDisplayName: 'Test Doctor',
      startsAt: '2030-01-02T10:00:00.000Z',
      endsAt: '2030-01-02T10:15:00.000Z',
    };
    service.bookableSlots.mockResolvedValue([slot]);
    await request(server)
      .get('/vet/availability/slots')
      .query({ ...range, status: 'CANCELLED' })
      .set('Authorization', token())
      .expect(400);
    expect(service.bookableSlots).not.toHaveBeenCalled();

    await request(server)
      .get('/vet/availability/slots')
      .query(range)
      .set('Authorization', token())
      .expect(200, [slot]);
    expect(service.bookableSlots).toHaveBeenCalledWith(range);
  });

  it.each([
    {},
    { from: range.from },
    { to: range.to },
    { ...range, from: '2030-01-01T00:00:00' },
    { ...range, to: 'bad' },
  ])('rejects malformed bounds %j', async (query) => {
    await request(server)
      .get('/vet/availability/slots')
      .query(query)
      .set('Authorization', token())
      .expect(400);
    expect(service.bookableSlots).not.toHaveBeenCalled();
  });
});
