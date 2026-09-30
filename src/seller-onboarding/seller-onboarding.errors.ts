import { HttpException, HttpStatus } from '@nestjs/common';

export function onboardingError(
  status: HttpStatus,
  code: string,
  message: string,
): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}
