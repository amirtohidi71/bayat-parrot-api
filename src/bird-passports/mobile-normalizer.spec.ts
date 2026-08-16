import { BadRequestException } from '@nestjs/common';
import { normalizeBirdPassportMobile } from './mobile-normalizer';

describe('normalizeBirdPassportMobile', () => {
  it.each([
    ['09123456789', '09123456789'],
    ['+989123456789', '09123456789'],
    ['00989123456789', '09123456789'],
    ['۰۹۱۲۳۴۵۶۷۸۹', '09123456789'],
    ['٠٩١٢٣٤٥٦٧٨٩', '09123456789'],
    ['+98 (912) 345-6789', '09123456789'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeBirdPassportMobile(input)).toBe(expected);
  });

  it.each(['', '123', '08123456789', '+981234', '09123x56789'])(
    'rejects %s',
    (input) => {
      expect(() => normalizeBirdPassportMobile(input)).toThrow(
        BadRequestException,
      );
    },
  );
});
