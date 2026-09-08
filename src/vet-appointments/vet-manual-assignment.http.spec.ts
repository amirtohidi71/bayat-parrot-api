import {
  ConflictException,
  ForbiddenException,
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
import { AdminVetManualAssignmentController } from './admin-manual-assignment.controller';
import { VetManualAssignmentService } from './vet-manual-assignment.service';

describe('Admin manual vet assignment HTTP', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  const secret = randomBytes(32).toString('hex');
  const service = { create: jest.fn() };
  const input = { customerUserId: randomUUID(), slotId: randomUUID() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret })],
      controllers: [AdminVetManualAssignmentController],
      providers: [
        AdminAuthGuard,
        { provide: VetManualAssignmentService, useValue: service },
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

  const authorization = (scope = 'admin-panel') =>
    'Bearer ' + jwt.sign({ scope, username: 'test-admin' });

  it.each(['missing', 'customer', 'tampered', 'expired'])(
    'rejects %s credentials before service access',
    async (kind) => {
      const token =
        kind === 'missing'
          ? ''
          : kind === 'tampered'
            ? 'Bearer invalid'
            : kind === 'expired'
              ? 'Bearer ' +
                jwt.sign(
                  { scope: 'admin-panel', username: 'test-admin' },
                  { expiresIn: -1 },
                )
              : authorization('customer');
      await request(server)
        .post('/admin/vet/appointments/manual')
        .set('Authorization', token)
        .send(input)
        .expect(401);
      expect(service.create).not.toHaveBeenCalled();
    },
  );

  it('accepts only allowlisted identifiers and normalizes passport code', async () => {
    service.create.mockResolvedValue({ appointmentId: randomUUID() });
    await request(server)
      .post('/admin/vet/appointments/manual')
      .set('Authorization', authorization())
      .send({
        ...input,
        passportCode: ' b12345678 ',
        doctorId: randomUUID(),
        feeAmountMinor: '1',
        status: 'PAYMENT_PENDING',
        holdExpiresAt: new Date().toISOString(),
      })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(
      { ...input, passportCode: 'B12345678' },
      'test-admin',
    );
  });

  it.each([
    { customerUserId: null },
    { customerUserId: 'bad' },
    { slotId: null },
    { slotId: 'bad' },
    { passportCode: null },
    { passportCode: 'B12' },
  ])('maps malformed input to 400: %j', async (change) => {
    await request(server)
      .post('/admin/vet/appointments/manual')
      .set('Authorization', authorization())
      .send({ ...input, ...change })
      .expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it.each([
    [new ForbiddenException('Passport ownership mismatch'), 403],
    [new NotFoundException('Customer not found'), 404],
    [new ConflictException('Slot unavailable'), 409],
  ])('preserves stable service status %#', async (error, status) => {
    service.create.mockRejectedValue(error);
    await request(server)
      .post('/admin/vet/appointments/manual')
      .set('Authorization', authorization())
      .send(input)
      .expect(status);
  });
});
