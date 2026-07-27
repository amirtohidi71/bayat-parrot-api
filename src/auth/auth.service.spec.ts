jest.mock('bcrypt', () => ({
  hash: jest.fn(async (value: string) => `hash:${value}`),
  compare: jest.fn(async (value: string, hash: string) => hash === `hash:${value}`),
}));

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomInt: jest.fn(() => 123),
}));

import {
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { Otp } from './entities/otp.entity';
import { SmsError } from '../common/sms/sms.types';

type OtpRow = Otp & { id: string };

function otpRow(overrides: Partial<OtpRow> = {}): OtpRow {
  return Object.assign(new Otp(), {
    id: 'otp-1',
    phone: '09123456789',
    codeHash: 'hash:12345',
    expiresAt: new Date(Date.now() + 120_000),
    consumed: false,
    attempts: 0,
    createdAt: new Date(),
  }, overrides);
}

function createOtpDatabase(initialRows: OtpRow[] = []) {
  let rows = initialRows.map((row) => ({ ...row })) as OtpRow[];
  let sequence = rows.length;
  let queue = Promise.resolve();

  const repository = {
    findOne: jest.fn(async ({ where }: { where: { phone: string; consumed?: boolean } }) => {
      const matches = rows
        .filter((row) => row.phone === where.phone)
        .filter((row) => where.consumed === undefined || row.consumed === where.consumed)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
      return matches[0] ?? null;
    }),
    delete: jest.fn(async ({ phone, consumed }: { phone: string; consumed: boolean }) => {
      rows = rows.filter((row) => row.phone !== phone || row.consumed !== consumed);
    }),
    create: jest.fn((value: Partial<OtpRow>) => otpRow({ ...value, id: '' })),
    save: jest.fn(async (row: OtpRow) => {
      if (!row.id) {
        row.id = `otp-${++sequence}`;
        row.createdAt = new Date();
        rows.push(row);
      }
      return row;
    }),
  };

  const manager = {
    query: jest.fn(async () => undefined),
    getRepository: jest.fn(() => repository),
  };
  const dataSource = {
    transaction: jest.fn(<T>(callback: (value: typeof manager) => Promise<T>): Promise<T> => {
      const execution = queue.then(async () => {
        const snapshot = rows.map((row) => ({ ...row })) as OtpRow[];
        try {
          return await callback(manager);
        } catch (error) {
          rows = snapshot;
          throw error;
        }
      });
      queue = execution.then(() => undefined, () => undefined);
      return execution;
    }),
  };

  return { dataSource, repository, manager, rows: () => rows };
}

function createService(database = createOtpDatabase()) {
  const usersService = {
    findByPhone: jest.fn(async () => ({
      id: 'user-1',
      phone: '09123456789',
      role: 'customer',
      profileCompleted: true,
    })),
    createWithPhone: jest.fn(),
    completeRegistration: jest.fn(),
  };
  const jwtService = { sign: jest.fn(() => 'test-access-token') };
  const smsService = { sendOtp: jest.fn(async () => undefined) };
  const service = new AuthService(
    database.dataSource as never,
    usersService as never,
    jwtService as never,
    smsService as never,
  );
  return { service, database, usersService, jwtService, smsService };
}

describe('AuthService OTP security', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T10:00:00.000Z'));
    (crypto.randomInt as jest.Mock).mockReturnValue(123);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('uses crypto.randomInt and creates a five-digit OTP with 120-second TTL', async () => {
    const { service, database, smsService } = createService();

    await service.sendOtp({ phone: '09123456789' });

    expect(crypto.randomInt).toHaveBeenCalledWith(0, 100_000);
    expect(smsService.sendOtp).toHaveBeenCalledWith('09123456789', '00123');
    expect(database.rows()).toHaveLength(1);
    expect(database.rows()[0]).toMatchObject({ attempts: 0, consumed: false });
    expect(database.rows()[0].expiresAt.getTime() - Date.now()).toBe(120_000);
  });

  it('enforces a 120-second server cooldown', async () => {
    const { service, smsService } = createService();
    await service.sendOtp({ phone: '09123456789' });

    try {
      await service.sendOtp({ phone: '09123456789' });
      throw new Error('Expected the cooldown request to fail');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(HttpException);
      if (!(error instanceof HttpException)) {
        throw error;
      }
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
    expect(smsService.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('serializes simultaneous sends so only one active OTP exists', async () => {
    const { service, database, smsService } = createService();

    const results = await Promise.allSettled([
      service.sendOtp({ phone: '09123456789' }),
      service.sendOtp({ phone: '09123456789' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(database.rows().filter((row) => !row.consumed)).toHaveLength(1);
    expect(smsService.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('rolls back only the OTP created by a failed provider request', async () => {
    const previous = otpRow({
      id: 'previous',
      createdAt: new Date(Date.now() - 121_000),
      expiresAt: new Date(Date.now() + 30_000),
    });
    const context = createService(createOtpDatabase([previous]));
    context.smsService.sendOtp.mockRejectedValue(new SmsError('SMS_TIMEOUT'));

    await expect(context.service.sendOtp({ phone: '09123456789' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(context.database.rows()).toHaveLength(1);
    expect(context.database.rows()[0].id).toBe('previous');
  });

  it('increments attempts and invalidates the OTP after the fifth failure', async () => {
    const row = otpRow({ attempts: 4 });
    const context = createService(createOtpDatabase([row]));

    await expect(
      context.service.verifyOtp({ phone: '09123456789', code: '00000' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(context.database.rows()[0]).toMatchObject({ attempts: 5, consumed: true });
  });

  it('consumes an OTP after successful verification', async () => {
    const context = createService(createOtpDatabase([otpRow()]));

    const result = await context.service.verifyOtp({ phone: '09123456789', code: '12345' });

    expect(context.database.rows()[0].consumed).toBe(true);
    expect(result).toEqual({ accessToken: 'test-access-token', profileCompleted: true });
  });

  it('allows only one of two simultaneous verifications to succeed', async () => {
    const context = createService(createOtpDatabase([otpRow()]));

    const results = await Promise.allSettled([
      context.service.verifyOtp({ phone: '09123456789', code: '12345' }),
      context.service.verifyOtp({ phone: '09123456789', code: '12345' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(context.jwtService.sign).toHaveBeenCalledTimes(1);
  });

  it('uses the same safe response for missing, expired and consumed OTPs', async () => {
    const cases = [
      createOtpDatabase(),
      createOtpDatabase([otpRow({ expiresAt: new Date(Date.now() - 1) })]),
      createOtpDatabase([otpRow({ consumed: true })]),
    ];

    for (const database of cases) {
      const { service } = createService(database);
      await expect(
        service.verifyOtp({ phone: '09123456789', code: '12345' }),
      ).rejects.toMatchObject({
        status: 401,
        message: 'OTP code is invalid or expired',
      });
    }
  });
});
