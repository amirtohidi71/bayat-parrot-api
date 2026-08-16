import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';

export const PUBLIC_BIRD_PASSPORT_OTP_LENGTH = 5;
export const PUBLIC_BIRD_PASSPORT_OTP_BCRYPT_COST = 10;

type RandomInteger = (minimum: number, maximum: number) => number;
type HashOtp = (value: string, cost: number) => Promise<string>;

export type PublicBirdPassportOtpCandidate = {
  rawCode: string;
  codeHash: string;
};

export async function createPublicBirdPassportOtpCandidate(
  randomInteger: RandomInteger = randomInt,
  hashOtp: HashOtp = bcrypt.hash,
): Promise<PublicBirdPassportOtpCandidate> {
  const rawCode = randomInteger(0, 10 ** PUBLIC_BIRD_PASSPORT_OTP_LENGTH)
    .toString()
    .padStart(PUBLIC_BIRD_PASSPORT_OTP_LENGTH, '0');
  return {
    rawCode,
    codeHash: await hashOtp(rawCode, PUBLIC_BIRD_PASSPORT_OTP_BCRYPT_COST),
  };
}

@Injectable()
export class PublicBirdPassportOtpCandidateFactory {
  create(): Promise<PublicBirdPassportOtpCandidate> {
    return createPublicBirdPassportOtpCandidate();
  }
}
