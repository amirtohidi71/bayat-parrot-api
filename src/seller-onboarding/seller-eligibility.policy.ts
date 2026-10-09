import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { User, UserRole, isCustomerRole } from '../users/entities/user.entity';
import {
  SellerVerification,
  SellerVerificationStatus,
} from './entities/seller-verification.entity';
import { assertAdultBirthDate } from './seller-age.policy';
import { SellerErrorCode } from './seller-onboarding.constants';
import { onboardingError } from './seller-onboarding.errors';

export type SellerEligibility =
  | { eligible: true; user: User; verification: SellerVerification }
  | { eligible: false; code: string; message: string };

@Injectable()
export class SellerEligibilityPolicy {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(SellerVerification)
    private readonly verifications: Repository<SellerVerification>,
  ) {}

  async assertEligibleSeller(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    return this.assertEligibleSellerUser(userId, user, this.verifications);
  }

  async assertEligibleSellerInTransaction(
    userId: string,
    manager: EntityManager,
  ) {
    const user = await manager.getRepository(User).findOne({
      where: { id: userId },
    });
    return this.assertEligibleSellerUser(
      userId,
      user,
      manager.getRepository(SellerVerification),
    );
  }

  async assertEligibleForBreederPromotion(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw onboardingError(
        HttpStatus.FORBIDDEN,
        SellerErrorCode.USER_NOT_ACTIVE,
        'حساب کاربری برای ثبت آگهی فعال نیست.',
      );
    }
    if (user.role !== UserRole.CUSTOMER) {
      throw onboardingError(
        HttpStatus.FORBIDDEN,
        SellerErrorCode.BREEDER_BASE_ROLE_REQUIRED,
        'فقط کاربر عادی واجد شرایط می‌تواند درخواست پرورش‌دهنده ثبت کند.',
      );
    }
    return this.assertEligibleSellerUser(userId, user, this.verifications);
  }

  private async assertEligibleSellerUser(
    userId: string,
    user: User | null,
    verifications: Repository<SellerVerification>,
  ) {
    if (!user || !user.isActive || !isCustomerRole(user.role)) {
      throw onboardingError(
        HttpStatus.FORBIDDEN,
        SellerErrorCode.USER_NOT_ACTIVE,
        'حساب کاربری برای ثبت آگهی فعال نیست.',
      );
    }
    if (!user.phoneVerifiedAt) {
      throw onboardingError(
        HttpStatus.FORBIDDEN,
        SellerErrorCode.PHONE_NOT_VERIFIED,
        'شماره موبایل باید با رمز یک‌بارمصرف تأیید شود.',
      );
    }
    if (!user.firstName?.trim() || !user.lastName?.trim()) {
      throw onboardingError(
        HttpStatus.FORBIDDEN,
        SellerErrorCode.PROFILE_INCOMPLETE,
        'نام و نام خانوادگی باید تکمیل شود.',
      );
    }
    const verification = await verifications.findOne({
      where: { userId, status: SellerVerificationStatus.APPROVED },
      order: { createdAt: 'DESC' },
    });
    if (!verification) {
      throw onboardingError(
        HttpStatus.FORBIDDEN,
        SellerErrorCode.VERIFICATION_REQUIRED,
        'برای ثبت آگهی فروش پرنده، ابتدا باید احراز فروشندگی شما تأیید شود.',
      );
    }
    assertAdultBirthDate(verification.birthDate);
    return { user, verification };
  }

  async canSubmitParrotSaleListing(userId: string): Promise<SellerEligibility> {
    try {
      const value = await this.assertEligibleSeller(userId);
      return { eligible: true, ...value };
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const response = error.getResponse();
      const body =
        typeof response === 'object' && response !== null
          ? (response as Record<string, unknown>)
          : {};
      return {
        eligible: false,
        code: typeof body.code === 'string' ? body.code : 'SELLER_NOT_ELIGIBLE',
        message:
          typeof body.message === 'string'
            ? body.message
            : 'امکان ثبت آگهی وجود ندارد.',
      };
    }
  }
}
