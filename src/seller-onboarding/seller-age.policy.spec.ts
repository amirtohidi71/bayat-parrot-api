import { HttpException } from '@nestjs/common';
import { assertAdultBirthDate } from './seller-age.policy';
import { SellerErrorCode } from './seller-onboarding.constants';

describe('seller age policy in Asia/Tehran', () => {
  const now = new Date('2026-09-26T08:00:00.000Z');

  it('accepts the exact eighteenth birthday', () => {
    expect(() => assertAdultBirthDate('2008-09-26', now)).not.toThrow();
  });

  it('rejects a user one day younger with the stable Persian error', () => {
    try {
      assertAdultBirthDate('2008-09-27', now);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(403);
      expect((error as HttpException).getResponse()).toMatchObject({
        code: SellerErrorCode.UNDERAGE,
        message: 'سن شما کمتر از ۱۸ سال است و امکان ثبت آگهی ندارید.',
      });
    }
  });

  it.each(['2027-01-01', '2026-02-30', 'not-a-date'])(
    'rejects invalid or future birth date %s',
    (birthDate) => {
      try {
        assertAdultBirthDate(birthDate, now);
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(400);
      }
    },
  );
});
