import { HttpException } from '@nestjs/common';
import { UserRole, isCustomerRole } from '../users/entities/user.entity';
import { SellerVerificationStatus } from './entities/seller-verification.entity';
import { SellerEligibilityPolicy } from './seller-eligibility.policy';
import { SellerErrorCode } from './seller-onboarding.constants';

function setup(role: UserRole) {
  const user = {
    id: 'user-1',
    role,
    isActive: true,
    phoneVerifiedAt: new Date(),
    firstName: 'Ali',
    lastName: 'Bird',
  };
  const verification = {
    userId: user.id,
    status: SellerVerificationStatus.APPROVED,
    birthDate: '2000-01-01',
  };
  const users = { findOne: jest.fn(() => Promise.resolve(user)) };
  const verifications = {
    findOne: jest.fn(() => Promise.resolve(verification)),
  };
  const policy = new SellerEligibilityPolicy(
    users as never,
    verifications as never,
  );
  return { policy, user, verification, users, verifications };
}

async function expectBaseRoleRequired(
  action: Promise<unknown>,
  status: number,
) {
  try {
    await action;
    throw new Error('expected base-role rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(status);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: SellerErrorCode.BREEDER_BASE_ROLE_REQUIRED,
    });
  }
}

describe('SellerEligibilityPolicy role separation', () => {
  it.each([UserRole.CUSTOMER, UserRole.BREEDER])(
    'keeps general seller eligibility available to %s',
    async (role) => {
      const value = setup(role);

      await expect(
        value.policy.assertEligibleSeller(value.user.id),
      ).resolves.toEqual({
        user: value.user,
        verification: value.verification,
      });
      expect(isCustomerRole(role)).toBe(true);
    },
  );

  it('allows an eligible CUSTOMER to enter breeder promotion', async () => {
    const value = setup(UserRole.CUSTOMER);

    await expect(
      value.policy.assertEligibleForBreederPromotion(value.user.id),
    ).resolves.toEqual({
      user: value.user,
      verification: value.verification,
    });
  });

  it.each([UserRole.BREEDER, UserRole.ADMIN])(
    'rejects %s from entering breeder promotion',
    async (role) => {
      const value = setup(role);

      await expectBaseRoleRequired(
        value.policy.assertEligibleForBreederPromotion(value.user.id),
        403,
      );
      expect(value.verifications.findOne).not.toHaveBeenCalled();
    },
  );
});
