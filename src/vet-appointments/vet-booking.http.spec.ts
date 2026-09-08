import {
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { CustomerVetBookingController } from './customer-booking.controller';
import { VetBookingService } from './vet-booking.service';

describe('Customer vet booking HTTP', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  const secret = randomBytes(32).toString('hex');
  const service = { book: jest.fn() };
  const input = { bookingRequestId: randomUUID(), slotId: randomUUID() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret }),
      ],
      controllers: [CustomerVetBookingController],
      providers: [
        JwtAuthGuard,
        JwtStrategy,
        { provide: VetBookingService, useValue: service },
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

  it('requires a valid customer JWT and rejects user-admin tokens', async () => {
    await request(server).post('/vet/appointments').send(input).expect(401);
    await request(server)
      .post('/vet/appointments')
      .set('Authorization', 'Bearer invalid')
      .send(input)
      .expect(401);
    await request(server)
      .post('/vet/appointments')
      .set('Authorization', token('admin'))
      .send(input)
      .expect(403);
    expect(service.book).not.toHaveBeenCalled();
  });

  it('passes only validated identifiers and normalized passport code', async () => {
    service.book.mockResolvedValue({ appointmentId: randomUUID() });
    await request(server)
      .post('/vet/appointments')
      .set('Authorization', token())
      .send({ ...input, passportCode: ' b12345678 ', customerUserId: 'attack' })
      .expect(201);
    expect(service.book).toHaveBeenCalledWith(expect.any(String), {
      ...input,
      passportCode: 'B12345678',
    });
  });

  it.each([
    { bookingRequestId: null },
    { bookingRequestId: 'bad' },
    { slotId: 'bad' },
    { passportCode: 'B123' },
    { passportCode: null },
  ])('returns 400 for malformed input %j', async (change) => {
    await request(server)
      .post('/vet/appointments')
      .set('Authorization', token())
      .send({ ...input, ...change })
      .expect(400);
    expect(service.book).not.toHaveBeenCalled();
  });

  it.each([
    [new ForbiddenException('Bird passport does not belong to customer'), 403],
    [new NotFoundException('Vet appointment slot not found'), 404],
    [new ConflictException('Vet appointment slot is unavailable'), 409],
  ])('preserves stable service error mapping %#', async (error, status) => {
    service.book.mockRejectedValue(error);
    await request(server)
      .post('/vet/appointments')
      .set('Authorization', token())
      .send(input)
      .expect(status);
  });
});
