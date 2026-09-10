import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AdminVetAppointmentQueryController } from './admin-appointment-query.controller';
import { CustomerVetAppointmentQueryController } from './customer-appointment-query.controller';
import { DoctorVetAppointmentQueryController } from './doctor-appointment-query.controller';
import { VetDoctorAuthGuard } from './guards/vet-doctor-auth.guard';
import {
  VET_DOCTOR_JWT_AUDIENCE,
  VET_DOCTOR_JWT_ISSUER,
} from './vet-doctor-auth.constants';
import { VetDoctorTokenService } from './vet-doctor-token.service';
import { VetAppointmentQueryService } from './vet-appointment-query.service';

describe('Vet appointment dashboard HTTP', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  const secret = 'vet-query-http-test-secret';
  const doctorSecret = 'vet-query-doctor-http-test-secret-123456789';
  const appointments = {
    listCustomer: jest.fn(),
    detailCustomer: jest.fn(),
    listDoctor: jest.fn(),
    detailDoctor: jest.fn(),
    listAdmin: jest.fn(),
    detailAdmin: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret }),
      ],
      controllers: [
        CustomerVetAppointmentQueryController,
        DoctorVetAppointmentQueryController,
        AdminVetAppointmentQueryController,
      ],
      providers: [
        JwtAuthGuard,
        JwtStrategy,
        AdminAuthGuard,
        VetDoctorAuthGuard,
        VetDoctorTokenService,
        { provide: VetAppointmentQueryService, useValue: appointments },
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
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
    jwt = moduleRef.get(JwtService);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    for (const mock of Object.values(appointments))
      mock.mockResolvedValue({ items: [], pagination: {} });
  });
  afterAll(async () => app?.close());

  const customerToken = (id: string, role = 'customer') =>
    'Bearer ' + jwt.sign({ sub: id, phone: '09111111111', role });
  const adminToken = () =>
    'Bearer ' + jwt.sign({ scope: 'admin-panel', username: 'admin' });
  const doctorToken = (id: string) =>
    'Bearer ' +
    jwt.sign(
      { sub: id, scope: 'vet-doctor' },
      {
        secret: doctorSecret,
        issuer: VET_DOCTOR_JWT_ISSUER,
        audience: VET_DOCTOR_JWT_AUDIENCE,
      },
    );

  it('requires the correct independent guard for every role', async () => {
    const appointmentId = randomUUID();
    await request(server).get('/vet/appointments').expect(401);
    await request(server)
      .get('/vet/appointments')
      .set('Authorization', customerToken(randomUUID(), 'admin'))
      .expect(403);
    await request(server)
      .get('/vet/doctor/appointments')
      .set('Authorization', customerToken(randomUUID()))
      .expect(401);
    await request(server)
      .get('/admin/vet/appointments')
      .set('Authorization', doctorToken(randomUUID()))
      .expect(401);
    await request(server)
      .get(`/vet/doctor/appointments/${appointmentId}`)
      .expect(401);
    expect(appointments.listCustomer).not.toHaveBeenCalled();
    expect(appointments.listDoctor).not.toHaveBeenCalled();
    expect(appointments.listAdmin).not.toHaveBeenCalled();
  });

  it('passes customer and doctor identity only from authenticated tokens', async () => {
    const customerId = randomUUID();
    const doctorId = randomUUID();
    const appointmentId = randomUUID();
    await request(server)
      .get('/vet/appointments?page=2&pageSize=7&status=CONFIRMED')
      .set('Authorization', customerToken(customerId))
      .expect(200);
    await request(server)
      .get(`/vet/appointments/${appointmentId}`)
      .set('Authorization', customerToken(customerId))
      .expect(200);
    await request(server)
      .get('/vet/doctor/appointments?period=upcoming')
      .set('Authorization', doctorToken(doctorId))
      .expect(200);
    await request(server)
      .get(`/vet/doctor/appointments/${appointmentId}`)
      .set('Authorization', doctorToken(doctorId))
      .expect(200);

    expect(appointments.listCustomer).toHaveBeenCalledWith(
      customerId,
      expect.objectContaining({
        page: 2,
        pageSize: 7,
        status: 'CONFIRMED',
      }),
    );
    expect(appointments.detailCustomer).toHaveBeenCalledWith(
      customerId,
      appointmentId,
    );
    expect(appointments.listDoctor).toHaveBeenCalledWith(
      doctorId,
      expect.objectContaining({ period: 'upcoming' }),
    );
    expect(appointments.detailDoctor).toHaveBeenCalledWith(
      doctorId,
      appointmentId,
    );
  });

  it('allows admin-only filters without accepting scope filters elsewhere', async () => {
    const doctorId = randomUUID();
    const customerId = randomUUID();
    const appointmentId = randomUUID();
    await request(server)
      .get(
        `/admin/vet/appointments?doctorId=${doctorId}&customerUserId=${customerId}&page=1&pageSize=10`,
      )
      .set('Authorization', adminToken())
      .expect(200);
    await request(server)
      .get(`/admin/vet/appointments/${appointmentId}`)
      .set('Authorization', adminToken())
      .expect(200);
    expect(appointments.listAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId, customerUserId: customerId }),
    );
    expect(appointments.detailAdmin).toHaveBeenCalledWith(appointmentId);

    await request(server)
      .get(`/vet/appointments?customerUserId=${randomUUID()}`)
      .set('Authorization', customerToken(customerId))
      .expect(200);
    const customerCalls = appointments.listCustomer.mock.calls as unknown as
      | Array<[string, Record<string, unknown>]>
      | undefined;
    const customerQuery = customerCalls?.at(-1)?.[1];
    expect(customerQuery).not.toHaveProperty('customerUserId');
    expect(customerQuery).not.toHaveProperty('doctorId');
  });

  it('maps malformed filters and detail ids to 400 before service access', async () => {
    await request(server)
      .get('/vet/appointments?pageSize=101')
      .set('Authorization', customerToken(randomUUID()))
      .expect(400);
    await request(server)
      .get('/vet/appointments?page=10001')
      .set('Authorization', customerToken(randomUUID()))
      .expect(400);
    await request(server)
      .get('/admin/vet/appointments?doctorId=bad')
      .set('Authorization', adminToken())
      .expect(400);
    await request(server)
      .get('/vet/doctor/appointments/not-a-uuid')
      .set('Authorization', doctorToken(randomUUID()))
      .expect(400);
    expect(appointments.listCustomer).not.toHaveBeenCalled();
    expect(appointments.listAdmin).not.toHaveBeenCalled();
    expect(appointments.detailDoctor).not.toHaveBeenCalled();
  });
});
