import { BadRequestException } from '@nestjs/common';
import {
  assertNotFutureDateOnly,
  assertValidDateOnly,
  getTehranDateOnly,
} from './date-only';

describe('date-only helpers', () => {
  it('accepts a valid leap day', () => {
    expect(() => assertValidDateOnly('2024-02-29', 'date')).not.toThrow();
  });

  it.each(['2026-02-29', '2026-02-30', '2026-13-01', '2026-01-00'])(
    'rejects invalid date %s',
    (value) => {
      expect(() => assertValidDateOnly(value, 'date')).toThrow(
        BadRequestException,
      );
    },
  );

  it('uses the Asia/Tehran calendar day at the UTC boundary', () => {
    const clock = new Date('2026-08-11T21:00:00.000Z');
    expect(getTehranDateOnly(clock)).toBe('2026-08-12');
    expect(() =>
      assertNotFutureDateOnly('2026-08-12', 'birthDate', clock),
    ).not.toThrow();
    expect(() =>
      assertNotFutureDateOnly('2026-08-13', 'birthDate', clock),
    ).toThrow(BadRequestException);
  });
});
