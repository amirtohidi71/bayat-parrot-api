/* eslint-disable @typescript-eslint/require-await -- In-memory Jest repositories implement TypeORM's asynchronous interface. */
import * as bcrypt from 'bcrypt';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { BirdPassportOtp } from './entities/bird-passport-otp.entity';
import {
  BirdPassport,
  BirdPassportGender,
  BirdPassportStatus,
} from './entities/bird-passport.entity';
import {
  PUBLIC_OTP_FAILURE_MESSAGE,
  PUBLIC_OTP_OWNER_MOBILE_MISMATCH_CODE,
  PUBLIC_OTP_OWNER_MOBILE_MISMATCH_MESSAGE,
  PUBLIC_OTP_REQUEST_MESSAGE,
  PublicBirdPassportsService,
} from './public-bird-passports.service';
import { BIRD_PASSPORT_OTP_PURPOSE } from './entities/bird-passport-otp.entity';

const PASSPORT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODE = 'B25543210';
const PHONE = '09123456789';

type TestContextOptions = {
  passportExists?: boolean;
  status?: BirdPassportStatus;
  phone?: string;
};

function findOperatorValue(value: unknown): unknown {
  return value && typeof value === 'object' && '_value' in value
    ? value._value
    : value;
}

function createContext(options: TestContextOptions = {}) {
  const passport = {
    id: PASSPORT_ID,
    code: CODE,
    ownerFullName: 'Owner Name',
    ownerMobile: options.phone ?? PHONE,
    birdName: 'Rio',
    status: options.status ?? BirdPassportStatus.ACTIVE,
    birthDate: '2025-05-10',
    gender: BirdPassportGender.UNKNOWN,
    species: 'Parrot',
    subspecies: 'Macaw',
    imagePath: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    vaccineRecords: [],
    feedingRecords: [],
    veterinaryVisits: [],
  } as unknown as BirdPassport;
  const otpRows: BirdPassportOtp[] = [];
  let idCounter = 0;

  const passportTransactionRepository = {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (options.passportExists === false) return null;
      if (where.code !== passport.code) return null;
      if (
        where.ownerMobile !== undefined &&
        where.ownerMobile !== passport.ownerMobile
      )
        return null;
      if (where.status !== undefined && where.status !== passport.status)
        return null;
      return passport;
    }),
  };
  const otpRepository = {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        [...otpRows]
          .filter((row) => {
            if (
              where.birdPassportId !== undefined &&
              row.birdPassportId !== where.birdPassportId
            )
              return false;
            if (where.phone !== undefined && row.phone !== where.phone)
              return false;
            if (where.purpose !== undefined && row.purpose !== where.purpose)
              return false;
            if (where.consumed !== undefined && row.consumed !== where.consumed)
              return false;
            if (
              where.expiresAt !== undefined &&
              row.expiresAt <= (findOperatorValue(where.expiresAt) as Date)
            )
              return false;
            if (
              where.attempts !== undefined &&
              row.attempts >= (findOperatorValue(where.attempts) as number)
            )
              return false;
            return true;
          })
          .sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime() ||
              right.id.localeCompare(left.id),
          )[0] ?? null
      );
    }),
    count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const lowerBound = findOperatorValue(where.createdAt) as Date;
      return otpRows.filter(
        (row) =>
          row.birdPassportId === where.birdPassportId &&
          row.phone === where.phone &&
          row.purpose === where.purpose &&
          row.consumed === where.consumed &&
          row.createdAt >= lowerBound,
      ).length;
    }),
    update: jest.fn(
      async (
        where: Record<string, unknown>,
        patch: Partial<BirdPassportOtp>,
      ) => {
        for (const row of otpRows) {
          if (
            Object.entries(where).every(
              ([key, value]) =>
                (row as unknown as Record<string, unknown>)[key] === value,
            )
          )
            Object.assign(row, patch);
        }
        return { affected: 1 };
      },
    ),
    create: jest.fn((value: Partial<BirdPassportOtp>) => value),
    save: jest.fn(async (value: BirdPassportOtp) => {
      if (!value.id) value.id = `otp-${++idCounter}`;
      if (!value.createdAt) value.createdAt = new Date();
      if (!otpRows.includes(value)) otpRows.push(value);
      return value;
    }),
  };
  const manager = {
    query: jest.fn(async () => undefined),
    getRepository: jest.fn((entity: unknown) =>
      entity === BirdPassport ? passportTransactionRepository : otpRepository,
    ),
  };
  let transactionTail = Promise.resolve<unknown>(undefined);
  const dataSource = {
    transaction: jest.fn(<T>(work: (value: typeof manager) => Promise<T>) => {
      const result = transactionTail.then(() => work(manager));
      transactionTail = result.catch(() => undefined);
      return result;
    }),
  };
  const images = { readActiveImage: jest.fn() };
  const candidates = {
    create: jest.fn().mockResolvedValue({
      rawCode: '00042',
      codeHash: 'bcrypt-hash-for-00042',
    }),
  };
  const timing = {
    start: jest.fn(() => 100),
    waitForFloor: jest.fn().mockResolvedValue(undefined),
  };
  const dispatch = { dispatch: jest.fn() };
  const cleanup = { schedule: jest.fn() };
  const publicPassportRepository = { findOne: jest.fn() };
  const service = new PublicBirdPassportsService(
    publicPassportRepository as never,
    dataSource as never,
    images as never,
    candidates,
    timing as never,
    dispatch as never,
    cleanup as never,
  );

  async function seedOtp(
    rawCode = '12345',
    overrides: Partial<BirdPassportOtp> = {},
  ) {
    const row = Object.assign(new BirdPassportOtp(), {
      id: `otp-${++idCounter}`,
      birdPassportId: PASSPORT_ID,
      phone: PHONE,
      purpose: BIRD_PASSPORT_OTP_PURPOSE,
      codeHash: await bcrypt.hash(rawCode, 4),
      expiresAt: new Date(Date.now() + 120_000),
      attempts: 0,
      consumed: false,
      createdAt: new Date(),
      ...overrides,
    });
    otpRows.push(row);
    return row;
  }

  return {
    service,
    candidates,
    timing,
    dispatch,
    cleanup,
    manager,
    otpRepository,
    otpRows,
    passport,
    publicPassportRepository,
    images,
    seedOtp,
  };
}

const requestDto = { code: CODE, ownerMobile: PHONE };
const verifyDto = { ...requestDto, otp: '12345' };

describe('PublicBirdPassportsService request OTP', () => {
  it('stores only the prepared hash and schedules asynchronous SMS delivery', async () => {
    const value = createContext();
    const before = Date.now();
    await expect(value.service.requestOtp(requestDto)).resolves.toEqual({
      message: PUBLIC_OTP_REQUEST_MESSAGE,
    });
    const stored = value.otpRows[0];
    expect(value.candidates.create).toHaveBeenCalledTimes(1);
    expect(value.dispatch.dispatch).toHaveBeenCalledWith({
      otpId: stored.id,
      phone: PHONE,
      rawCode: '00042',
    });
    expect(stored.codeHash).toBe('bcrypt-hash-for-00042');
    expect(stored.codeHash).not.toBe('00042');
    expect(stored).toMatchObject({
      birdPassportId: PASSPORT_ID,
      phone: PHONE,
      purpose: BIRD_PASSPORT_OTP_PURPOSE,
      attempts: 0,
      consumed: false,
    });
    expect(stored.expiresAt.getTime() - before).toBeGreaterThanOrEqual(119_000);
    expect(stored.expiresAt.getTime() - before).toBeLessThanOrEqual(121_000);
    expect(value.timing.waitForFloor).toHaveBeenCalledWith(100);
    expect(value.cleanup.schedule).toHaveBeenCalled();
    expect(value.timing.waitForFloor.mock.invocationCallOrder[0]).toBeLessThan(
      value.dispatch.dispatch.mock.invocationCallOrder[0],
    );
    expect(value.manager.query.mock.invocationCallOrder[0]).toBeLessThan(
      value.candidates.create.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['nonexistent code', { passportExists: false }],
    ['draft passport', { status: BirdPassportStatus.DRAFT }],
    ['archived passport', { status: BirdPassportStatus.ARCHIVED }],
  ])(
    'returns the same generic result for %s without SMS',
    async (_label, options) => {
      const value = createContext(options);
      await expect(value.service.requestOtp(requestDto)).resolves.toEqual({
        message: PUBLIC_OTP_REQUEST_MESSAGE,
      });
      expect(value.dispatch.dispatch).not.toHaveBeenCalled();
      expect(value.otpRows).toHaveLength(0);
      expect(value.candidates.create).not.toHaveBeenCalled();
      expect(value.timing.waitForFloor).toHaveBeenCalledWith(100);
    },
  );

  it('returns an explicit safe error for an active passport owner-mobile mismatch', async () => {
    const realOwnerMobile = '09999999999';
    const value = createContext({ phone: realOwnerMobile });

    const error = await value.service
      .requestOtp(requestDto)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
    expect((error as ForbiddenException).getResponse()).toEqual({
      code: PUBLIC_OTP_OWNER_MOBILE_MISMATCH_CODE,
      message: PUBLIC_OTP_OWNER_MOBILE_MISMATCH_MESSAGE,
    });
    expect(
      JSON.stringify((error as ForbiddenException).getResponse()),
    ).not.toContain(realOwnerMobile);
    expect(value.candidates.create).not.toHaveBeenCalled();
    expect(value.dispatch.dispatch).not.toHaveBeenCalled();
    expect(value.otpRows).toHaveLength(0);
    expect(value.manager.query).not.toHaveBeenCalled();
    expect(value.timing.waitForFloor).toHaveBeenCalledWith(100);
    expect(value.cleanup.schedule).toHaveBeenCalled();
  });

  it('enforces the 120-second cooldown with a generic result', async () => {
    const value = createContext();
    await value.seedOtp('11111', { createdAt: new Date() });
    await value.service.requestOtp(requestDto);
    expect(value.dispatch.dispatch).not.toHaveBeenCalled();
    expect(value.candidates.create).not.toHaveBeenCalled();
    expect(value.timing.waitForFloor).toHaveBeenCalledWith(100);
    expect(
      value.otpRepository.findOne.mock.calls.map(
        ([options]) =>
          (options as { where: { consumed: boolean } }).where.consumed,
      ),
    ).toEqual([false, true]);
  });

  it('enforces five real OTP rows per fifteen minutes', async () => {
    const value = createContext();
    for (let index = 0; index < 5; index += 1) {
      await value.seedOtp(String(10000 + index), {
        createdAt: new Date(Date.now() - (index + 2) * 121_000),
        consumed: true,
      });
    }
    await value.service.requestOtp(requestDto);
    expect(value.dispatch.dispatch).not.toHaveBeenCalled();
    expect(value.otpRows).toHaveLength(5);
    expect(value.candidates.create).not.toHaveBeenCalled();
    expect(value.timing.waitForFloor).toHaveBeenCalledWith(100);
    expect(
      value.otpRepository.count.mock.calls.map(
        ([options]) =>
          (options as { where: { consumed: boolean } }).where.consumed,
      ),
    ).toEqual([false, true]);
  });

  it('invalidates an older unconsumed OTP before storing the replacement', async () => {
    const value = createContext();
    const old = await value.seedOtp('11111', {
      createdAt: new Date(Date.now() - 121_000),
    });
    await value.service.requestOtp(requestDto);
    expect(old.consumed).toBe(true);
    expect(value.otpRows.at(-1)?.consumed).toBe(false);
  });

  it('serializes concurrent requests so only one OTP is sent', async () => {
    const value = createContext();
    await Promise.all([
      value.service.requestOtp(requestDto),
      value.service.requestOtp(requestDto),
    ]);
    expect(value.dispatch.dispatch).toHaveBeenCalledTimes(1);
    expect(value.candidates.create).toHaveBeenCalledTimes(1);
    expect(value.manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`bird-passport-otp:${PASSPORT_ID}:${PHONE}`],
    );
  });
});

describe('PublicBirdPassportsService verify OTP', () => {
  it('consumes a valid OTP and returns only the internal passport binding', async () => {
    const value = createContext();
    const otp = await value.seedOtp();
    await expect(value.service.verifyOtp(verifyDto)).resolves.toEqual({
      passportId: PASSPORT_ID,
    });
    expect(otp.consumed).toBe(true);
  });

  it('uses one generic failure for a wrong OTP and increments attempts', async () => {
    const value = createContext();
    const otp = await value.seedOtp();
    await expect(
      value.service.verifyOtp({ ...verifyDto, otp: '99999' }),
    ).rejects.toThrow(PUBLIC_OTP_FAILURE_MESSAGE);
    expect(otp.attempts).toBe(1);
  });

  it.each([
    ['expired', { expiresAt: new Date(Date.now() - 1) }],
    ['consumed', { consumed: true }],
    ['attempts exceeded', { attempts: 5 }],
  ])('fails generically when the OTP is %s', async (_label, overrides) => {
    const value = createContext();
    await value.seedOtp('12345', overrides);
    await expect(value.service.verifyOtp(verifyDto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('consumes the OTP on the fifth failed attempt', async () => {
    const value = createContext();
    const otp = await value.seedOtp('12345', { attempts: 4 });
    await expect(
      value.service.verifyOtp({ ...verifyDto, otp: '99999' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(otp).toMatchObject({ attempts: 5, consumed: true });
  });

  it.each([
    ['nonexistent code', { passportExists: false }],
    ['mismatched mobile', { phone: '09999999999' }],
    ['archived after issue', { status: BirdPassportStatus.ARCHIVED }],
  ])('fails generically for %s', async (_label, options) => {
    const value = createContext(options);
    await value.seedOtp();
    await expect(value.service.verifyOtp(verifyDto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('executes the dummy bcrypt path when no record exists', async () => {
    const value = createContext({ passportExists: false });
    const compare = jest.spyOn(
      value.service as unknown as {
        compareOtp(code: string, hash: string): Promise<boolean>;
      },
      'compareOtp',
    );
    await expect(value.service.verifyOtp(verifyDto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(compare).toHaveBeenCalled();
    expect(compare.mock.calls[0][1]).not.toBe(value.otpRows[0]?.codeHash);
  });

  it('never falls back to an older OTP when the newest record is unusable', async () => {
    const value = createContext();
    await value.seedOtp('12345', {
      createdAt: new Date(Date.now() - 30_000),
      consumed: false,
    });
    await value.seedOtp('99999', {
      createdAt: new Date(),
      consumed: true,
    });
    await expect(value.service.verifyOtp(verifyDto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('allows only one of two concurrent verification attempts to succeed', async () => {
    const value = createContext();
    await value.seedOtp();
    const outcomes = await Promise.allSettled([
      value.service.verifyOtp(verifyDto),
      value.service.verifyOtp(verifyDto),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(
      1,
    );
  });
});

describe('PublicBirdPassportsService public reads', () => {
  it('requires the grant passport id, canonical code and active status', async () => {
    const value = createContext();
    value.publicPassportRepository.findOne.mockResolvedValue(value.passport);
    await value.service.getPublicPassport(PASSPORT_ID, CODE);
    expect(value.publicPassportRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: PASSPORT_ID,
          code: CODE,
          status: BirdPassportStatus.ACTIVE,
        },
      }),
    );
  });

  it('routes public image reads through active private image orchestration', async () => {
    const value = createContext();
    await value.service.readPublicImage(PASSPORT_ID, CODE);
    expect(value.images.readActiveImage).toHaveBeenCalledWith(
      PASSPORT_ID,
      CODE,
    );
  });

  it.each([
    ['grant for passport A with code B'],
    ['passport archived after grant issuance'],
  ])('rejects public detail when %s', async () => {
    const value = createContext();
    value.publicPassportRepository.findOne.mockResolvedValue(null);
    await expect(
      value.service.getPublicPassport(PASSPORT_ID, CODE),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
