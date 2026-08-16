import * as bcrypt from 'bcrypt';
import {
  PUBLIC_BIRD_PASSPORT_OTP_BCRYPT_COST,
  createPublicBirdPassportOtpCandidate,
} from './public-bird-passport-otp-candidate';

describe('public Bird Passport OTP candidate', () => {
  it('pads a mocked crypto randomInt result to the exact leading-zero OTP', async () => {
    const randomInteger = jest.fn(() => 42);
    const hashOtp = jest.fn().mockResolvedValue('bcrypt-hash');
    await expect(
      createPublicBirdPassportOtpCandidate(randomInteger, hashOtp),
    ).resolves.toEqual({ rawCode: '00042', codeHash: 'bcrypt-hash' });
    expect(randomInteger).toHaveBeenCalledWith(0, 100_000);
    expect(hashOtp).toHaveBeenCalledWith(
      '00042',
      PUBLIC_BIRD_PASSPORT_OTP_BCRYPT_COST,
    );
  });

  it('creates a real cost-10 bcrypt hash without persisting the raw value', async () => {
    const candidate = await createPublicBirdPassportOtpCandidate(() => 12_345);
    expect(candidate).toMatchObject({ rawCode: '12345' });
    expect(candidate.codeHash).not.toContain(candidate.rawCode);
    expect(bcrypt.getRounds(candidate.codeHash)).toBe(10);
    await expect(
      bcrypt.compare(candidate.rawCode, candidate.codeHash),
    ).resolves.toBe(true);
  });
});
