import { Matches } from 'class-validator';

export class VerifyOtpDto {
  @Matches(/^09\d{9}$/, { message: 'phone must be a valid Iranian mobile number' })
  phone: string;

  @Matches(/^\d{5}$/, { message: 'code must be a 5-digit number' })
  code: string;
}
