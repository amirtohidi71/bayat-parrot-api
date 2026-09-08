import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { VetPaidHoldService } from './vet-paid-hold.service';

describe('Vet paid hold and reaper boundary', () => {
  const config = (seconds: string | number = 900) =>
    new ConfigService({
      VET_PAYMENT_HOLD_SECONDS: seconds,
      VET_FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });

  it.each([0, 59, 3601, 1.5, 'bad'])(
    'fails closed for invalid hold duration %p',
    (seconds) => {
      expect(
        () => new VetPaidHoldService({} as DataSource, config(seconds)),
      ).toThrow('VET_PAYMENT_HOLD_SECONDS');
    },
  );

  it('validates hold identifiers and reaper batch bounds before writes', async () => {
    const transaction = jest.fn();
    const service = new VetPaidHoldService(
      { manager: {}, transaction } as unknown as DataSource,
      config(),
    );
    await expect(
      service.createInternalHold('bad', {
        bookingRequestId: randomUUID(),
        slotId: randomUUID(),
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(service.expireHolds(0)).rejects.toThrow(BadRequestException);
    await expect(service.expireHolds(101)).rejects.toThrow(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('runs an empty reaper in explicit READ COMMITTED with bounded timeouts', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([]);
    const manager = { query };
    const transaction = jest.fn(
      async (
        isolation: string,
        action: (value: typeof manager) => Promise<unknown>,
      ) => action(manager),
    );
    const service = new VetPaidHoldService(
      { transaction } as unknown as DataSource,
      config(),
    );
    await expect(service.expireHolds(10)).resolves.toEqual({ expired: 0 });
    expect(transaction).toHaveBeenCalledWith(
      'READ COMMITTED',
      expect.any(Function),
    );
    expect(query).toHaveBeenNthCalledWith(1, "SET LOCAL lock_timeout = '5s'");
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SET LOCAL statement_timeout = '15s'",
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('FOR UPDATE SKIP LOCKED'),
      [10],
    );
  });

  it.each(['23505', '23514', '40P01', '55P03', '57014'])(
    'maps PostgreSQL conflict %s without exposing SQL',
    async (code) => {
      const transaction = jest
        .fn()
        .mockRejectedValue(
          new QueryFailedError(
            'SECRET SQL',
            [],
            Object.assign(new Error('PRIVATE'), { code }),
          ),
        );
      const service = new VetPaidHoldService(
        { transaction } as unknown as DataSource,
        config(),
      );
      await expect(service.expireHolds()).rejects.toEqual(
        new ConflictException(
          'Vet hold conflicts with current scheduling state',
        ),
      );
      expect(transaction).toHaveBeenCalledTimes(
        ['40P01', '55P03'].includes(code) ? 3 : 1,
      );
    },
  );

  it('fails closed for unexpected database/isolation drift', async () => {
    const service = new VetPaidHoldService(
      {
        transaction: jest
          .fn()
          .mockRejectedValue(
            new QueryFailedError(
              'SECRET SQL',
              [],
              Object.assign(new Error('PRIVATE'), { code: '25000' }),
            ),
          ),
      } as unknown as DataSource,
      config(),
    );
    await expect(service.expireHolds()).rejects.toThrow(
      InternalServerErrorException,
    );
  });
});
