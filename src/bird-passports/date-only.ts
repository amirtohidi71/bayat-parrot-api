import { BadRequestException } from '@nestjs/common';

const DATE_ONLY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function assertValidDateOnly(value: string, field: string): void {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date`);
  }
}

export function assertNotFutureDateOnly(
  value: string,
  field: string,
  clock: Date = new Date(),
): void {
  assertValidDateOnly(value, field);
  const today = getTehranDateOnly(clock);
  if (value > today)
    throw new BadRequestException(`${field} cannot be in the future`);
}

export function getTehranDateOnly(clock: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran',
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(clock);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  if (!values.year || !values.month || !values.day) {
    throw new Error('Unable to determine the current date in Asia/Tehran');
  }
  return `${values.year}-${values.month}-${values.day}`;
}
