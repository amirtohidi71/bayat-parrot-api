import { BadRequestException } from '@nestjs/common';

const BIRD_PASSPORT_CODE_PATTERN = /^B[0-9]{8}$/;

export function normalizeBirdPassportCode(input: unknown): string {
  if (typeof input !== 'string') {
    throw new BadRequestException('code must be a string');
  }
  const code = input.trim().toUpperCase();
  if (!BIRD_PASSPORT_CODE_PATTERN.test(code)) {
    throw new BadRequestException('code must match B followed by 8 digits');
  }
  return code;
}
