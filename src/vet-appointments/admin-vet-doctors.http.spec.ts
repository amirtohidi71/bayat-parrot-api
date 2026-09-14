import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import { AdminVetDoctorsController } from './admin-vet-doctors.controller';
import { VetDoctorDirectoryService } from './vet-doctor-directory.service';

describe('Admin vet doctor management HTTP', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  const id = randomUUID();
  const response = {
    id,
    displayName: 'دکتر الف',
    mobile: '09120000000',
    username: 'Doctor_One',
    active: true,
    consultationFeeMinor: '100000',
    currency: 'IRR',
  };
  const doctors = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    activate: jest.fn(),
    deactivate: jest.fn(),
  };
  const authorization = (scope = 'admin-panel') =>
    `Bearer ${jwt.sign({ scope, username: 'test-admin' })}`;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: randomBytes(32).toString('hex') }),
      ],
      controllers: [AdminVetDoctorsController],
      providers: [
        AdminAuthGuard,
        { provide: VetDoctorDirectoryService, useValue: doctors },
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
  afterAll(async () => app?.close());

  it('protects every operation with the existing admin guard', async () => {
    await request(server).get('/admin/vet/doctors').expect(401);
    await request(server).post('/admin/vet/doctors').send({}).expect(401);
    await request(server)
      .patch(`/admin/vet/doctors/${id}`)
      .send({})
      .expect(401);
    await request(server).post(`/admin/vet/doctors/${id}/activate`).expect(401);
    await request(server)
      .post(`/admin/vet/doctors/${id}/deactivate`)
      .expect(401);
    Object.values(doctors).forEach((method) =>
      expect(method).not.toHaveBeenCalled(),
    );
  });

  it('lists both active and inactive doctors with compatible fields', async () => {
    doctors.list.mockResolvedValue([
      response,
      { ...response, id: randomUUID(), active: false },
    ]);
    const result = await request(server)
      .get('/admin/vet/doctors')
      .set('Authorization', authorization())
      .expect(200);
    const body = result.body as unknown as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ id, displayName: 'دکتر الف' });
    expect(body[0]).not.toHaveProperty('passwordHash');
  });

  it('creates a validated doctor and strips unknown request fields', async () => {
    doctors.create.mockResolvedValue(response);
    const input = {
      displayName: '  دکتر الف  ',
      mobile: '09120000000',
      username: ' Doctor_One ',
      password: 'secure-password',
      consultationFeeMinor: '100000',
      currency: 'irr',
      active: true,
      passwordHash: 'attacker',
    };
    await request(server)
      .post('/admin/vet/doctors')
      .set('Authorization', authorization())
      .send(input)
      .expect(201)
      .expect(response);
    expect(doctors.create).toHaveBeenCalledWith({
      displayName: 'دکتر الف',
      mobile: '09120000000',
      username: 'Doctor_One',
      password: 'secure-password',
      consultationFeeMinor: '100000',
      currency: 'IRR',
      active: true,
    });
  });

  it('forwards a safe partial update including an optional password', async () => {
    doctors.update.mockResolvedValue({ ...response, displayName: 'دکتر جدید' });
    await request(server)
      .patch(`/admin/vet/doctors/${id}`)
      .set('Authorization', authorization())
      .send({ displayName: ' دکتر جدید ', password: 'replacement-password' })
      .expect(200);
    expect(doctors.update).toHaveBeenCalledWith(id, {
      displayName: 'دکتر جدید',
      password: 'replacement-password',
    });
  });

  it('activates and deactivates without a delete operation', async () => {
    doctors.activate.mockResolvedValue(response);
    doctors.deactivate.mockResolvedValue({ ...response, active: false });
    await request(server)
      .post(`/admin/vet/doctors/${id}/activate`)
      .set('Authorization', authorization())
      .expect(200);
    await request(server)
      .post(`/admin/vet/doctors/${id}/deactivate`)
      .set('Authorization', authorization())
      .expect(200);
    expect(doctors.activate).toHaveBeenCalledWith(id);
    expect(doctors.deactivate).toHaveBeenCalledWith(id);
  });

  it.each([
    {
      displayName: '',
      mobile: 'bad',
      username: 'x',
      password: 'short',
      consultationFeeMinor: '-1',
      currency: 'rial',
    },
    {
      displayName: 'دکتر',
      mobile: '09120000000',
      username: 'invalid-name',
      password: 'secure-password',
      consultationFeeMinor: '1.5',
      currency: 'IRR',
    },
  ])('rejects invalid create payloads', async (input) => {
    await request(server)
      .post('/admin/vet/doctors')
      .set('Authorization', authorization())
      .send(input)
      .expect(400);
    expect(doctors.create).not.toHaveBeenCalled();
  });

  it('rejects malformed doctor identifiers', async () => {
    await request(server)
      .patch('/admin/vet/doctors/not-a-uuid')
      .set('Authorization', authorization())
      .send({ active: false })
      .expect(400);
    expect(doctors.update).not.toHaveBeenCalled();
  });
});
