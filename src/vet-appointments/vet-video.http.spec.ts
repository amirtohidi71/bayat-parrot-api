import {
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import {
  CustomerVetVideoController,
  DoctorVetVideoController,
} from './vet-video.controller';
import { VetDoctorAuthGuard } from './guards/vet-doctor-auth.guard';
import {
  VET_DOCTOR_JWT_AUDIENCE,
  VET_DOCTOR_JWT_ISSUER,
} from './vet-doctor-auth.constants';
import { VetDoctorTokenService } from './vet-doctor-token.service';
import { VetVideoService } from './vet-video.service';

describe('Vet video consultation HTTP', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  const secret = 'vet-video-http-test-secret';
  const doctorSecret = 'vet-video-doctor-http-test-secret-123456789';
  const video = { joinCustomer: jest.fn(), joinDoctor: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret }),
      ],
      controllers: [CustomerVetVideoController, DoctorVetVideoController],
      providers: [
        JwtAuthGuard,
        JwtStrategy,
        VetDoctorAuthGuard,
        VetDoctorTokenService,
        { provide: VetVideoService, useValue: video },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_SECRET: secret,
            VET_DOCTOR_JWT_SECRET: doctorSecret,
          }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    server = app.getHttpServer() as Server;
    jwt = moduleRef.get(JwtService);
  });

  beforeEach(() => jest.resetAllMocks());
  afterAll(async () => app?.close());

  const customerToken = (id: string, role = 'customer') =>
    'Bearer ' + jwt.sign({ sub: id, phone: '09111111111', role });
  const doctorToken = (id: string, scope = 'vet-doctor') =>
    'Bearer ' +
    jwt.sign(
      { sub: id, scope },
      {
        secret: doctorSecret,
        issuer: VET_DOCTOR_JWT_ISSUER,
        audience: VET_DOCTOR_JWT_AUDIENCE,
      },
    );

  it('requires customer authentication and customer role', async () => {
    const appointmentId = randomUUID();
    await request(server)
      .post(`/vet/appointments/${appointmentId}/video-room/join`)
      .expect(401);
    await request(server)
      .post(`/vet/appointments/${appointmentId}/video-room/join`)
      .set('Authorization', customerToken(randomUUID(), 'admin'))
      .expect(403);
    expect(video.joinCustomer).not.toHaveBeenCalled();
  });

  it('keeps doctor authentication separate from customer roles', async () => {
    const appointmentId = randomUUID();
    await request(server)
      .post(`/vet/doctor/appointments/${appointmentId}/video-room/join`)
      .set('Authorization', customerToken(randomUUID()))
      .expect(401);
    await request(server)
      .post(`/vet/doctor/appointments/${appointmentId}/video-room/join`)
      .set('Authorization', doctorToken(randomUUID(), 'admin-panel'))
      .expect(401);
    expect(video.joinDoctor).not.toHaveBeenCalled();
  });

  it('passes authenticated customer and doctor identities server-side', async () => {
    const appointmentId = randomUUID();
    const customerId = randomUUID();
    const doctorId = randomUUID();
    video.joinCustomer.mockResolvedValueOnce({ roomId: randomUUID() });
    video.joinDoctor.mockResolvedValueOnce({ roomId: randomUUID() });
    await request(server)
      .post(`/vet/appointments/${appointmentId}/video-room/join`)
      .set('Authorization', customerToken(customerId))
      .expect(201);
    await request(server)
      .post(`/vet/doctor/appointments/${appointmentId}/video-room/join`)
      .set('Authorization', doctorToken(doctorId))
      .expect(201);
    expect(video.joinCustomer).toHaveBeenCalledWith(appointmentId, customerId);
    expect(video.joinDoctor).toHaveBeenCalledWith(appointmentId, doctorId);
  });

  it('maps malformed appointment IDs to 400 before service access', async () => {
    await request(server)
      .post('/vet/appointments/bad/video-room/join')
      .set('Authorization', customerToken(randomUUID()))
      .expect(400);
    expect(video.joinCustomer).not.toHaveBeenCalled();
  });

  it.each([
    [new ForbiddenException('Wrong participant'), 403],
    [new NotFoundException('Appointment missing'), 404],
    [new ConflictException('Room unavailable'), 409],
    [new ServiceUnavailableException('Provider unavailable'), 503],
  ])('preserves stable customer error mapping %#', async (error, status) => {
    video.joinCustomer.mockRejectedValueOnce(error);
    await request(server)
      .post(`/vet/appointments/${randomUUID()}/video-room/join`)
      .set('Authorization', customerToken(randomUUID()))
      .expect(status);
  });
});
