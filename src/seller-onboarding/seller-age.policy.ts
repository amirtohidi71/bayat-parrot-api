import { HttpStatus } from '@nestjs/common';
import {
  SELLER_MINIMUM_AGE,
  SellerErrorCode,
} from './seller-onboarding.constants';
import { onboardingError } from './seller-onboarding.errors';

type CalendarDate = { year: number; month: number; day: number };

function parseDateOnly(value: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) invalidBirthDate();
  const [, yearText, monthText, dayText] = match;
  const date = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
  };
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    utc.getUTCFullYear() !== date.year ||
    utc.getUTCMonth() + 1 !== date.month ||
    utc.getUTCDate() !== date.day
  )
    invalidBirthDate();
  return date;
}

function tehranDate(now: Date): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran',
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function compare(left: CalendarDate, right: CalendarDate): number {
  return (
    left.year - right.year || left.month - right.month || left.day - right.day
  );
}

function invalidBirthDate(): never {
  throw onboardingError(
    HttpStatus.BAD_REQUEST,
    SellerErrorCode.BIRTH_DATE_INVALID,
    'تاریخ تولد معتبر نیست.',
  );
}

export function assertAdultBirthDate(
  birthDate: string,
  now = new Date(),
): void {
  const birth = parseDateOnly(birthDate);
  const today = tehranDate(now);
  if (compare(birth, today) > 0) invalidBirthDate();
  const eighteenthBirthday = {
    ...birth,
    year: birth.year + SELLER_MINIMUM_AGE,
  };
  if (compare(today, eighteenthBirthday) < 0) {
    throw onboardingError(
      HttpStatus.FORBIDDEN,
      SellerErrorCode.UNDERAGE,
      'سن شما کمتر از ۱۸ سال است و امکان ثبت آگهی ندارید.',
    );
  }
}
