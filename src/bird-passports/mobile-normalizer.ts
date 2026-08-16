import { BadRequestException } from '@nestjs/common';

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function normalizeBirdPassportMobile(input: string): string {
  const normalizedDigits = String(input ?? '')
    .trim()
    .replace(/[۰-۹]/g, (digit) => String(PERSIAN_DIGITS.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_DIGITS.indexOf(digit)))
    .replace(/[\s\-().]/g, '');

  let mobile = normalizedDigits;
  if (mobile.startsWith('+98')) mobile = `0${mobile.slice(3)}`;
  if (mobile.startsWith('0098')) mobile = `0${mobile.slice(4)}`;

  if (!/^09[0-9]{9}$/.test(mobile)) {
    throw new BadRequestException(
      'ownerMobile must be a valid Iranian mobile number',
    );
  }
  return mobile;
}
