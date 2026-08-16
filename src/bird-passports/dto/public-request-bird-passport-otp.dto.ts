import { Transform, TransformFnParams } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { normalizeBirdPassportCode } from '../bird-passport-code';
import { normalizeBirdPassportMobile } from '../mobile-normalizer';

export class PublicRequestBirdPassportOtpDto {
  @Transform((parameters: TransformFnParams) =>
    normalizeBirdPassportCode(parameters.value as unknown),
  )
  @IsString()
  @Matches(/^B[0-9]{8}$/)
  code: string;

  @Transform((parameters: TransformFnParams) =>
    normalizeOptionalMobile(parameters.value as unknown),
  )
  @IsString()
  @Matches(/^09[0-9]{9}$/)
  ownerMobile: string;
}

function normalizeOptionalMobile(value: unknown): unknown {
  return typeof value === 'string' ? normalizeBirdPassportMobile(value) : value;
}
