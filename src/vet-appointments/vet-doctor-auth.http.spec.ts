import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { VetDoctor } from './entities/doctor.entity';
import { VetDoctorAuthGuard } from './guards/vet-doctor-auth.guard';
import { VetDoctorLoginThrottlerGuard } from './guards/vet-doctor-login-throttler.guard';
import { VetDoctorAuthController } from './vet-doctor-auth.controller';
import { VetDoctorAuthService } from './vet-doctor-auth.service';
import { DoctorVetVideoController } from './vet-video.controller';
import { VetDoctorTokenService } from './vet-doctor-token.service';
import { VetVideoService } from './vet-video.service';

describe('Vet doctor authentication HTTP', () => {
  const doctorId = randomUUID();
  const generalSecret = 'general-http-jwt-secret-not-for-vet-doctors';
  const doctorSecret = 'dedicated-http-vet-doctor-secret-1234567890';
  const video = { joinDoctor: jest.fn() };
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await bcrypt.hash('correct-password', 10);
    const queryBuilder = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => ({
        id: doctorId,
        username: 'Doctor_One',
        passwordHash,
        displayName: 'Doctor One',
        mobile: '09120000000',
        active: true,
      })),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({}),
        ThrottlerModule.forRoot([
          { name: 'default', limit: 10, ttl: 15 * 60 * 1000 },
        ]),
      ],
      controllers: [VetDoctorAuthController, DoctorVetVideoController],
      providers: [
        VetDoctorAuthService,
        VetDoctorTokenService,
        VetDoctorAuthGuard,
        VetDoctorLoginThrottlerGuard,
        {
          provide: getRepositoryToken(VetDoctor),
          useValue: {
            createQueryBuilder: jest.fn(() => queryBuilder),
          },
        },
        { provide: VetVideoService, useValue: video },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_SECRET: generalSecret,
            VET_DOCTOR_JWT_SECRET: doctorSecret,
            VET_DOCTOR_JWT_TTL_SECONDS: '600',
          }),
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

  beforeEach(() => video.joinDoctor.mockReset());
  afterAll(async () => app?.close());

  it('issues an allowlisted, no-store token accepted by the doctor video guard', async () => {
    const login = await request(server)
      .post('/vet/doctor/auth/login')
      .set('X-Forwarded-For', '198.51.100.1')
      .send({
        username: '  DOCTOR_ONE  ',
        password: 'correct-password',
        doctorId: randomUUID(),
        scope: 'admin-panel',
        mobile: '09121111111',
      })
      .expect(201)
      .expect('Cache-Control', 'no-store');

    expect(login.body).toEqual({
      accessToken: expect.any(String),
      expiresIn: 600,
      doctor: { id: doctorId, displayName: 'Doctor One' },
    });
    expect(JSON.stringify(login.body)).not.toMatch(/passwordHash|mobile/);
    const payload = jwt.decode(login.body.accessToken) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({ sub: doctorId, scope: 'vet-doctor' });
    expect(payload).not.toHaveProperty('role');
    expect(payload).not.toHaveProperty('doctorId');
    expect(payload).not.toHaveProperty('username');

    video.joinDoctor.mockResolvedValueOnce({ roomId: randomUUID() });
    const appointmentId = randomUUID();
    await request(server)
      .post(`/vet/doctor/appointments/${appointmentId}/video-room/join`)
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(201);
    expect(video.joinDoctor).toHaveBeenCalledWith(appointmentId, doctorId);
  });

  it('does not accept customer or admin tokens as doctor tokens', async () => {
    for (const claims of [
      { sub: randomUUID(), phone: '09111111111', role: 'customer' },
      { scope: 'admin-panel', username: 'admin' },
    ]) {
      const token = jwt.sign(claims, { secret: generalSecret });
      await request(server)
        .post(`/vet/doctor/appointments/${randomUUID()}/video-room/join`)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    }
    expect(video.joinDoctor).not.toHaveBeenCalled();
  });

  it('sets no-store and returns validation errors without echoing credentials', async () => {
    const response = await request(server)
      .post('/vet/doctor/auth/login')
      .set('X-Forwarded-For', '198.51.100.2')
      .send({ username: 'bad name', password: '' })
      .expect(400)
      .expect('Cache-Control', 'no-store');
    expect(JSON.stringify(response.body)).not.toContain('bad name');
  });

  it('enforces a bounded login rate limit', async () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await request(server)
        .post('/vet/doctor/auth/login')
        .set('X-Forwarded-For', '198.51.100.50')
        .send({})
        .expect(400);
    }
    await request(server)
      .post('/vet/doctor/auth/login')
      .set('X-Forwarded-For', '198.51.100.50')
      .send({})
      .expect(429)
      .expect('Cache-Control', 'no-store');
  });
});
