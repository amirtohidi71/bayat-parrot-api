import { HttpException } from '@nestjs/common';
import { User, UserRole, isCustomerRole } from '../users/entities/user.entity';
import {
  SellerVerification,
  SellerVerificationStatus,
} from './entities/seller-verification.entity';
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
  it('can recheck eligibility through transaction-scoped repositories', async () => {
    const value = setup(UserRole.CUSTOMER);
    const manager = {
      getRepository: jest.fn((target: unknown) => {
        if (target === User) return value.users;
        if (target === SellerVerification) return value.verifications;
        throw new Error('Unexpected repository');
      }),
    };

    await expect(
      value.policy.assertEligibleSellerInTransaction(
        value.user.id,
        manager as never,
      ),
    ).resolves.toEqual({
      user: value.user,
      verification: value.verification,
    });
    expect(manager.getRepository).toHaveBeenNthCalledWith(1, User);
    expect(manager.getRepository).toHaveBeenNthCalledWith(
      2,
      SellerVerification,
    );
  });

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

  it('returns the stable seller-verification-required response for listing flows', async () => {
    const value = setup(UserRole.CUSTOMER);
    value.verifications.findOne.mockResolvedValueOnce(null);

    await expect(
      value.policy.assertEligibleSeller(value.user.id),
    ).rejects.toMatchObject({
      status: 403,
      response: {
        code: SellerErrorCode.VERIFICATION_REQUIRED,
        message:
          'برای ثبت آگهی فروش پرنده، ابتدا باید احراز فروشندگی شما تأیید شود.',
      },
    });
  });

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
