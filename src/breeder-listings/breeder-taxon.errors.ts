import { HttpException } from '@nestjs/common';

// Stable response contract: {statusCode, code, message}; no database details.
export enum BreederTaxonErrorCode {
  INVALID_SELECTION = 'BREEDER_TAXON_INVALID_SELECTION',
  NOT_FOUND = 'BREEDER_TAXON_NOT_FOUND',
  NOT_CURRENT = 'BREEDER_TAXON_APPLICATION_NOT_CURRENT',
  NOT_ELIGIBLE = 'BREEDER_TAXON_APPLICATION_NOT_ELIGIBLE',
  INVALID_TRANSITION = 'BREEDER_TAXON_INVALID_TRANSITION',
  REVISION_CONFLICT = 'BREEDER_TAXON_REVISION_CONFLICT',
  IDEMPOTENCY_CONFLICT = 'BREEDER_TAXON_IDEMPOTENCY_CONFLICT',
  REQUEST_CONFLICT = 'BREEDER_TAXON_REQUEST_CONFLICT',
  REGRANT_REQUIRED = 'BREEDER_TAXON_REGRANT_REQUIRED',
  UNPUBLISH_REQUIRED = 'BREEDER_TAXON_UNPUBLISH_REQUIRED',
}

export function taxonError(status: number, code: BreederTaxonErrorCode): never {
  throw new HttpException(
    {
      statusCode: status,
      code,
      message: {
        [BreederTaxonErrorCode.INVALID_SELECTION]:
          'گونه یا زیرگونه انتخاب‌شده معتبر نیست.',
        [BreederTaxonErrorCode.NOT_FOUND]: 'درخواست یا مجوز موردنظر یافت نشد.',
        [BreederTaxonErrorCode.NOT_CURRENT]:
          'این درخواست، درخواست جاری پرورش‌دهنده نیست.',
        [BreederTaxonErrorCode.NOT_ELIGIBLE]:
          'وضعیت فعلی حساب یا درخواست اجازه این عملیات را نمی‌دهد.',
        [BreederTaxonErrorCode.INVALID_TRANSITION]:
          'تغییر وضعیت این مجوز مجاز نیست.',
        [BreederTaxonErrorCode.REVISION_CONFLICT]:
          'مجوز تغییر کرده است؛ اطلاعات را دوباره دریافت کنید.',
        [BreederTaxonErrorCode.IDEMPOTENCY_CONFLICT]:
          'شناسه عملیات قبلاً برای درخواست دیگری استفاده شده است.',
        [BreederTaxonErrorCode.REQUEST_CONFLICT]:
          'این زیرگونه قبلاً درخواست شده است.',
        [BreederTaxonErrorCode.REGRANT_REQUIRED]:
          'مجوز گونه به اعطای مجدد صریح ادمین نیاز دارد.',
        [BreederTaxonErrorCode.UNPUBLISH_REQUIRED]:
          'لغو این مجوز ابتدا به خارج‌کردن آگهی مرتبط از انتشار نیاز دارد.',
      }[code],
    },
    status,
  );
}
