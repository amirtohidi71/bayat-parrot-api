import { Matches } from 'class-validator';

export class SendOtpDto {
  @Matches(/^09\d{9}$/, { message: 'phone must be a valid Iranian mobile number' })
  phone: string;
}
