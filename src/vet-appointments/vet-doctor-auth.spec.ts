import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import { VetDoctor } from './entities/doctor.entity';
import { VetDoctorAuthService } from './vet-doctor-auth.service';
import { VET_DOCTOR_SCOPE } from './vet-doctor-auth.constants';
import { VetDoctorTokenService } from './vet-doctor-token.service';

describe('VetDoctorAuthService', () => {
  const doctorId = randomUUID();
  let selectedDoctor: VetDoctor | null;
  let whereParameters: Record<string, unknown> | undefined;
  let service: VetDoctorAuthService;
  let tokens: VetDoctorTokenService;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('correct-password', 10);
    selectedDoctor = {
      id: doctorId,
      username: 'Doctor_One',
      passwordHash,
      displayName: 'Doctor One',
      mobile: '09120000000',
      active: true,
      consultationFeeMinor: '0',
      currency: 'IRR',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const queryBuilder = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn((_sql, parameters) => {
        whereParameters = parameters;
        return queryBuilder;
      }),
      getOne: jest.fn(() => Promise.resolve(selectedDoctor)),
    };
    const repository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
    } as unknown as Repository<VetDoctor>;
    tokens = new VetDoctorTokenService(
      new JwtService(),
      new ConfigService({
        VET_DOCTOR_JWT_SECRET: 'unit-vet-doctor-jwt-secret-that-is-long-enough',
      }),
    );
    service = new VetDoctorAuthService(repository, tokens);
  });

  it('authenticates case-insensitively and returns an allowlisted response', async () => {
    const result = await service.login({
      username: '  DOCTOR_ONE  ',
      password: 'correct-password',
    });

    expect(whereParameters).toEqual({ username: 'doctor_one' });
    expect(result).toEqual({
      accessToken: expect.any(String),
      expiresIn: 900,
      doctor: { id: doctorId, displayName: 'Doctor One' },
    });
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('mobile');
    const payload = tokens.verify(result.accessToken) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({ sub: doctorId, scope: VET_DOCTOR_SCOPE });
    expect(payload).not.toHaveProperty('role');
    expect(payload).not.toHaveProperty('doctorId');
    expect(payload).not.toHaveProperty('username');
  });

  it.each([
    ['unknown username', null, 'anything'],
    [
      'wrong password',
      () => ({ ...selectedDoctor!, active: true }),
      'wrong-password',
    ],
    [
      'inactive doctor',
      () => ({ ...selectedDoctor!, active: false }),
      'correct-password',
    ],
  ])(
    'returns the same generic failure for %s',
    async (_case, value, password) => {
      const original = selectedDoctor;
      selectedDoctor = typeof value === 'function' ? value() : value;
      await expect(
        service.login({ username: 'doctor_one', password }),
      ).rejects.toMatchObject({
        status: 401,
        message: 'Invalid username or password',
      });
      selectedDoctor = original;
    },
  );
});
