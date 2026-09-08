import {
  ConflictException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import { AdminVetAvailabilityController } from './admin-availability.controller';
import { VetAvailabilityService } from './availability.service';

describe('Admin vet availability HTTP with existing JWT guard', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  const id = randomUUID();
  const base = '/admin/vet/availability-windows';
  const input = {
    doctorId: randomUUID(),
    startsAt: '2030-01-02T10:00:00Z',
    endsAt: '2030-01-02T11:00:00Z',
    slotDurationMinutes: 15,
  };
  const service = {
    create: jest.fn(),
    list: jest.fn(),
    read: jest.fn(),
    slots: jest.fn(),
    cancel: jest.fn(),
    retire: jest.fn(),
    replace: jest.fn(),
  };
  const authorization = (scope = 'admin-panel') =>
    'Bearer ' + jwt.sign({ scope, username: 'test-admin' });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: randomBytes(32).toString('hex') }),
      ],
      controllers: [AdminVetAvailabilityController],
      providers: [
        AdminAuthGuard,
        { provide: VetAvailabilityService, useValue: service },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        validationError: { target: false, value: false },
      }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
    jwt = module.get(JwtService);
  });
  beforeEach(() => jest.resetAllMocks());
  afterAll(async () => {
    await app?.close();
  });

  it.each([
    'missing',
    'customer',
    'doctor',
    'god-admin',
    'tampered',
    'expired',
  ])(
    'rejects %s credentials on every endpoint before service access',
    async (kind) => {
      const token =
        kind === 'missing'
          ? ''
          : kind === 'tampered'
            ? 'Bearer invalid'
            : kind === 'expired'
              ? 'Bearer ' +
                jwt.sign(
                  { scope: 'admin-panel', username: 'admin' },
                  { expiresIn: -1 },
                )
              : authorization(kind);
      for (const path of [base, `${base}/${id}`, `${base}/${id}/slots`])
        await request(server).get(path).set('Authorization', token).expect(401);
      for (const path of [
        base,
        `${base}/${id}/cancel`,
        `${base}/${id}/retire`,
        `${base}/${id}/replace`,
      ])
        await request(server)
          .post(path)
          .set('Authorization', token)
          .send(input)
          .expect(401);
      Object.values(service).forEach((method) =>
        expect(method).not.toHaveBeenCalled(),
      );
    },
  );

  it('creates as the authenticated admin and strips injected identity/status', async () => {
    service.create.mockResolvedValue({ window: { id }, slots: [] });
    await request(server)
      .post(base)
      .set('Authorization', authorization())
      .send({ ...input, createdByAdmin: 'attacker', status: 'CANCELLED' })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(
      { ...input, timeZone: 'Asia/Tehran' },
      'test-admin',
    );
  });

  it.each([
    { slotDurationMinutes: '15' },
    { slotDurationMinutes: 0 },
    { slotDurationMinutes: 1441 },
    { slotDurationMinutes: 1.5 },
    { timeZone: 'UTC' },
    { timeZone: null },
    { startsAt: '2030-01-02T10:00:00' },
    { startsAt: '2030-01-02T10:00:01Z' },
    { endsAt: 'bad' },
    { doctorId: 'bad' },
  ])('rejects malformed create input %j', async (change) => {
    await request(server)
      .post(base)
      .set('Authorization', authorization())
      .send({ ...input, ...change })
      .expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('lists with validated pagination and reads the window and slots', async () => {
    service.list.mockResolvedValue({
      items: [{ id }],
      total: 1,
      limit: 5,
      offset: 0,
    });
    const response = await request(server)
      .get(base)
      .query({ doctorId: input.doctorId, limit: 5 })
      .set('Authorization', authorization())
      .expect(200);
    expect(response.body).toEqual({
      items: [{ id }],
      total: 1,
      limit: 5,
      offset: 0,
    });
    expect(service.list).toHaveBeenCalledWith({
      doctorId: input.doctorId,
      limit: 5,
      offset: 0,
    });
    service.read.mockResolvedValue({ id });
    service.slots.mockResolvedValue([{ availabilityWindowId: id }]);
    await request(server)
      .get(`${base}/${id}`)
      .set('Authorization', authorization())
      .expect(200, { id });
    await request(server)
      .get(`${base}/${id}/slots`)
      .set('Authorization', authorization())
      .expect(200, [{ availabilityWindowId: id }]);
  });

  it.each([
    { limit: 101 },
    { offset: -1 },
    { status: 'unknown' },
    { from: '2030-01-01T00:00:00' },
  ])('rejects invalid filters %j', async (query) => {
    await request(server)
      .get(base)
      .query(query)
      .set('Authorization', authorization())
      .expect(400);
    expect(service.list).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'retire'] as const)(
    'exposes explicit %s lifecycle action',
    async (action) => {
      service[action].mockResolvedValue({
        id,
        status: action === 'cancel' ? 'CANCELLED' : 'RETIRED',
      });
      await request(server)
        .post(`${base}/${id}/${action}`)
        .set('Authorization', authorization())
        .expect(200);
      expect(service[action]).toHaveBeenCalledWith(id);
    },
  );

  it('replaces with the same doctor identity and server admin identity', async () => {
    const geometry = {
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      slotDurationMinutes: input.slotDurationMinutes,
    };
    service.replace.mockResolvedValue({
      previousWindow: { id },
      window: { id: randomUUID() },
      slots: [],
    });
    await request(server)
      .post(`${base}/${id}/replace`)
      .set('Authorization', authorization())
      .send(input)
      .expect(201);
    expect(service.replace).toHaveBeenCalledWith(
      id,
      { ...geometry, timeZone: 'Asia/Tehran' },
      'test-admin',
    );
  });

  it('returns clean 404 and 409 errors, validates UUIDs, and has no hard delete route', async () => {
    service.read.mockRejectedValue(
      new NotFoundException('Availability window not found'),
    );
    await request(server)
      .get(`${base}/${id}`)
      .set('Authorization', authorization())
      .expect(404);
    service.cancel.mockRejectedValue(
      new ConflictException('Availability window is terminal'),
    );
    await request(server)
      .post(`${base}/${id}/cancel`)
      .set('Authorization', authorization())
      .expect(409);
    await request(server)
      .get(`${base}/bad`)
      .set('Authorization', authorization())
      .expect(400);
    await request(server)
      .delete(`${base}/${id}`)
      .set('Authorization', authorization())
      .expect(404);
  });
});
