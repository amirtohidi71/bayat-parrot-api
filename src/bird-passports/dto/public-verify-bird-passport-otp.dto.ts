import { IsString, Matches } from 'class-validator';
import { PublicRequestBirdPassportOtpDto } from './public-request-bird-passport-otp.dto';

export class PublicVerifyBirdPassportOtpDto extends PublicRequestBirdPassportOtpDto {
  @IsString()
  @Matches(/^[0-9]{5}$/)
  otp: string;
}
