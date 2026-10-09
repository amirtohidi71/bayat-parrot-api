import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
import { Product, ProductStatus } from '../products/entities/product.entity';
import {
  ParrotSaleListing,
  ParrotSaleListingStatus,
} from '../parrot-sale-listings/entities/parrot-sale-listing.entity';
import { User, UserRole, isCustomerRole } from '../users/entities/user.entity';
import {
  AdminBreederCallDto,
  AdminNoteDto,
  AdminRejectDto,
  AdminRevokeSellerAccessDto,
  SubmitBreederApplicationDto,
  SubmitSellerVerificationDto,
} from './dto/seller-onboarding.dto';
import {
  BreederApplication,
  BreederApplicationStatus,
  BreederCallOutcome,
} from './entities/breeder-application.entity';
import {
  SellerVerification,
  SellerVerificationStatus,
} from './entities/seller-verification.entity';
import { SellerEligibilityPolicy } from './seller-eligibility.policy';
import { assertAdultBirthDate } from './seller-age.policy';
import {
  SELLER_CONSENT_VERSION,
  SellerErrorCode,
} from './seller-onboarding.constants';
import { onboardingError } from './seller-onboarding.errors';

const sellerActive = [
  SellerVerificationStatus.PENDING,
  SellerVerificationStatus.APPROVED,
];
const breederActive = [
  BreederApplicationStatus.PENDING_CALL,
  BreederApplicationStatus.FOLLOW_UP,
  BreederApplicationStatus.APPROVED,
];

@Injectable()
export class SellerOnboardingService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(SellerVerification)
    private readonly sellers: Repository<SellerVerification>,
    @InjectRepository(BreederApplication)
    private readonly breeders: Repository<BreederApplication>,
    private readonly eligibility: SellerEligibilityPolicy,
  ) {}

  async submitSeller(userId: string, input: SubmitSellerVerificationDto) {
    if (input.consent !== true) {
      throw onboardingError(
        HttpStatus.BAD_REQUEST,
        SellerErrorCode.CONSENT_REQUIRED,
        'پذیرش رضایت‌نامه فروشنده الزامی است.',
      );
    }
    assertAdultBirthDate(input.birthDate);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const users = manager.getRepository(User);
        const verifications = manager.getRepository(SellerVerification);
        // Submission lock order is always user first; the verification is new.
        const user = await this.lockedUserForSubmission(users, userId);
        if (
          await verifications.exists({
            where: { userId, status: In(sellerActive) },
          })
        )
          this.activeSellerConflict();

        if (
          user.firstName !== input.firstName ||
          user.lastName !== input.lastName
        ) {
          user.firstName = input.firstName;
          user.lastName = input.lastName;
          await users.save(user);
        }

        const verification = verifications.create({
          userId,
          user,
          firstName: input.firstName,
          lastName: input.lastName,
          birthDate: input.birthDate,
          consentAcceptedAt: new Date(),
          consentVersion: SELLER_CONSENT_VERSION,
          status: SellerVerificationStatus.PENDING,
          rejectionReason: null,
          internalAdminNote: null,
          reviewedBy: null,
          reviewedAt: null,
          revokedAt: null,
          revokedBy: null,
          revocationReason: null,
        });
        return verifications.save(verification);
      });
    } catch (error) {
      if (this.postgresCode(error) === '23505') this.activeSellerConflict();
      throw error;
    }
  }

  ownSeller(userId: string) {
    return this.sellers.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  listSellers(status?: SellerVerificationStatus) {
    return this.sellers.find({
      where: status ? { status } : {},
      relations: { user: true },
      order: { createdAt: 'DESC' },
    });
  }

  sellerDetail(id: string) {
    return this.requiredSeller(id, true);
  }

  approveSeller(id: string, admin: string, note: AdminNoteDto) {
    return this.reviewSeller(
      id,
      admin,
      SellerVerificationStatus.APPROVED,
      note,
    );
  }

  rejectSeller(id: string, admin: string, input: AdminRejectDto) {
    return this.reviewSeller(
      id,
      admin,
      SellerVerificationStatus.REJECTED,
      input,
    );
  }

  async revokeSellerAccess(
    id: string,
    admin: string,
    input: AdminRevokeSellerAccessDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const verifications = manager.getRepository(SellerVerification);
      const initial = await verifications.findOne({ where: { id } });
      if (!initial)
        throw new NotFoundException('Seller verification not found');

      // Stable lock order: all seller listings, verification, then linked products.
      const listings = await manager.getRepository(ParrotSaleListing).find({
        where: { sellerUserId: initial.userId },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const verification = await this.lockedSeller(verifications, id);
      if (
        verification.userId !== initial.userId ||
        verification.status !== SellerVerificationStatus.APPROVED
      )
        this.invalidTransition();
      if (verification.revokedAt)
        throw onboardingError(
          HttpStatus.CONFLICT,
          SellerErrorCode.ACCESS_ALREADY_REVOKED,
          'دسترسی فروشندگی قبلاً غیرفعال شده است.',
        );

      const reviewedBy = this.admin(admin);
      const reason = input.reason.trim();
      const productIds = listings
        .filter(
          (listing) =>
            listing.status !== ParrotSaleListingStatus.DELETED_BY_USER &&
            listing.productId,
        )
        .map((listing) => listing.productId as string)
        .sort();
      if (productIds.length) {
        const products = manager.getRepository(Product);
        const linkedProducts = await products.find({
          where: { id: In(productIds) },
          order: { id: 'ASC' },
          lock: { mode: 'pessimistic_write' },
        });
        for (const product of linkedProducts) {
          if (product.isSellerListing) product.status = ProductStatus.DRAFT;
        }
        await products.save(linkedProducts);
      }

      verification.revokedAt = new Date();
      verification.revokedBy = reviewedBy;
      verification.revocationReason = reason;
      const saved = await verifications.save(verification);
      saved.user = await this.requiredUser(
        manager.getRepository(User),
        verification.userId,
      );
      return saved;
    });
  }

  async submitBreeder(userId: string, input: SubmitBreederApplicationDto) {
    const { user } =
      await this.eligibility.assertEligibleForBreederPromotion(userId);
    if (
      await this.breeders.exists({
        where: { userId, status: In(breederActive) },
      })
    )
      this.activeBreederConflict();
    try {
      return await this.breeders.save(
        this.breeders.create({
          breederName: input.breederName,
          city: input.city,
          species: input.species,
          experienceYears: input.experienceYears,
          approximateBirdCount: input.approximateBirdCount,
          preferredContactTime: input.preferredContactTime,
          instagramUrl: input.instagramUrl ?? null,
          websiteUrl: input.websiteUrl ?? null,
          description: input.description ?? null,
          userId,
          user,
          status: BreederApplicationStatus.PENDING_CALL,
          callOutcome: null,
          contactedAt: null,
          privateCallNote: null,
          rejectionReason: null,
          reviewedBy: null,
          reviewedAt: null,
        }),
      );
    } catch (error) {
      if (this.postgresCode(error) === '23505') this.activeBreederConflict();
      throw error;
    }
  }

  ownBreeder(userId: string) {
    return this.breeders.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  listBreeders(status?: BreederApplicationStatus) {
    return this.breeders.find({
      where: status ? { status } : {},
      relations: { user: true },
      order: { createdAt: 'DESC' },
    });
  }

  breederDetail(id: string) {
    return this.requiredBreeder(id, true);
  }

  async recordBreederCall(
    id: string,
    admin: string,
    input: AdminBreederCallDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const applications = manager.getRepository(BreederApplication);
      const application = await this.lockedBreeder(applications, id);
      if (
        ![
          BreederApplicationStatus.PENDING_CALL,
          BreederApplicationStatus.FOLLOW_UP,
        ].includes(application.status)
      )
        this.invalidTransition();
      application.callOutcome = input.outcome;
      application.contactedAt = new Date();
      application.privateCallNote = input.privateCallNote ?? null;
      application.reviewedBy = this.admin(admin);
      application.status = BreederApplicationStatus.FOLLOW_UP;
      const saved = await applications.save(application);
      saved.user = await this.requiredUser(
        manager.getRepository(User),
        application.userId,
      );
      return saved;
    });
  }

  async approveBreeder(id: string, admin: string) {
    return this.dataSource.transaction(async (manager) => {
      const applications = manager.getRepository(BreederApplication);
      // Keep the lock order stable across approvals: application first, user second.
      const application = await this.lockedBreeder(applications, id);
      if (application.status !== BreederApplicationStatus.FOLLOW_UP)
        this.invalidTransition();
      if (
        application.callOutcome !== BreederCallOutcome.SUCCESSFUL ||
        !application.contactedAt
      ) {
        throw onboardingError(
          HttpStatus.CONFLICT,
          SellerErrorCode.BREEDER_CALL_REQUIRED,
          'تأیید پرورش‌دهنده به تماس موفق ادمین نیاز دارد.',
        );
      }
      const users = manager.getRepository(User);
      const user = await users.findOne({
        where: { id: application.userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user || !user.isActive) {
        throw onboardingError(
          HttpStatus.FORBIDDEN,
          SellerErrorCode.USER_NOT_ACTIVE,
          'حساب کاربری برای تأیید پرورش‌دهنده فعال نیست.',
        );
      }
      if (user.role !== UserRole.CUSTOMER) {
        throw onboardingError(
          HttpStatus.CONFLICT,
          SellerErrorCode.BREEDER_BASE_ROLE_REQUIRED,
          'نقش فعلی کاربر برای تأیید پرورش‌دهنده معتبر نیست.',
        );
      }
      const seller = await manager.getRepository(SellerVerification).findOne({
        where: {
          userId: user.id,
          status: SellerVerificationStatus.APPROVED,
        },
        order: { createdAt: 'DESC' },
      });
      if (!seller || !user.phoneVerifiedAt) {
        throw onboardingError(
          HttpStatus.FORBIDDEN,
          SellerErrorCode.VERIFICATION_REQUIRED,
          'احراز فروشندگی معتبر برای تأیید پرورش‌دهنده لازم است.',
        );
      }
      assertAdultBirthDate(seller.birthDate);
      application.status = BreederApplicationStatus.APPROVED;
      application.reviewedBy = this.admin(admin);
      application.reviewedAt = new Date();
      application.rejectionReason = null;
      user.role = UserRole.BREEDER;
      await users.save(user);
      const saved = await applications.save(application);
      saved.user = user;
      return saved;
    });
  }

  async rejectBreeder(id: string, admin: string, input: AdminRejectDto) {
    return this.dataSource.transaction(async (manager) => {
      const applications = manager.getRepository(BreederApplication);
      const application = await this.lockedBreeder(applications, id);
      if (
        ![
          BreederApplicationStatus.PENDING_CALL,
          BreederApplicationStatus.FOLLOW_UP,
        ].includes(application.status)
      )
        this.invalidTransition();
      application.status = BreederApplicationStatus.REJECTED;
      application.rejectionReason = input.rejectionReason;
      application.privateCallNote =
        input.internalAdminNote ?? application.privateCallNote;
      application.reviewedBy = this.admin(admin);
      application.reviewedAt = new Date();
      const saved = await applications.save(application);
      saved.user = await this.requiredUser(
        manager.getRepository(User),
        application.userId,
      );
      return saved;
    });
  }

  private async reviewSeller(
    id: string,
    admin: string,
    status: SellerVerificationStatus,
    input: AdminNoteDto & Partial<AdminRejectDto>,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const verifications = manager.getRepository(SellerVerification);
      const verification = await this.lockedSeller(verifications, id);
      if (verification.status !== SellerVerificationStatus.PENDING)
        this.invalidTransition();
      const user = await manager.getRepository(User).findOne({
        where: { id: verification.userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user?.isActive || !user.phoneVerifiedAt) {
        throw onboardingError(
          HttpStatus.FORBIDDEN,
          SellerErrorCode.PHONE_NOT_VERIFIED,
          'شماره موبایل تأییدشده و حساب فعال برای بررسی لازم است.',
        );
      }
      assertAdultBirthDate(verification.birthDate);
      verification.status = status;
      verification.rejectionReason = input.rejectionReason ?? null;
      verification.internalAdminNote = input.internalAdminNote ?? null;
      verification.reviewedBy = this.admin(admin);
      verification.reviewedAt = new Date();
      const saved = await verifications.save(verification);
      saved.user = user;
      return saved;
    });
  }

  private async requiredSeller(id: string, user: boolean) {
    const value = await this.sellers.findOne({
      where: { id },
      relations: user ? { user: true } : undefined,
    });
    if (!value) throw new NotFoundException('Seller verification not found');
    return value;
  }

  private async lockedSeller(
    verifications: Repository<SellerVerification>,
    id: string,
  ) {
    const value = await verifications.findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!value) throw new NotFoundException('Seller verification not found');
    return value;
  }

  private async requiredBreeder(id: string, user: boolean) {
    const value = await this.breeders.findOne({
      where: { id },
      relations: user ? { user: true } : undefined,
    });
    if (!value) throw new NotFoundException('Breeder application not found');
    return value;
  }

  private async lockedBreeder(
    applications: Repository<BreederApplication>,
    id: string,
  ) {
    const value = await applications.findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!value) throw new NotFoundException('Breeder application not found');
    return value;
  }

  private async requiredUser(users: Repository<User>, id: string) {
    const user = await users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async lockedUserForSubmission(
    users: Repository<User>,
    userId: string,
  ) {
    const user = await users.findOne({
      where: { id: userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!user || !user.isActive || !isCustomerRole(user.role)) {
      throw onboardingError(
        HttpStatus.FORBIDDEN,
        SellerErrorCode.USER_NOT_ACTIVE,
        'حساب کاربری برای ثبت درخواست فعال نیست.',
      );
    }
    if (!user.phoneVerifiedAt) {
      throw onboardingError(
        HttpStatus.FORBIDDEN,
        SellerErrorCode.PHONE_NOT_VERIFIED,
        'شماره موبایل باید با رمز یک‌بارمصرف تأیید شود.',
      );
    }
    return user;
  }

  private activeSellerConflict(): never {
    throw onboardingError(
      HttpStatus.CONFLICT,
      SellerErrorCode.ACTIVE_REQUEST_EXISTS,
      'یک درخواست فعال احراز فروشنده وجود دارد.',
    );
  }

  private activeBreederConflict(): never {
    throw onboardingError(
      HttpStatus.CONFLICT,
      SellerErrorCode.BREEDER_ACTIVE_REQUEST_EXISTS,
      'یک درخواست فعال همکاری پرورش‌دهنده وجود دارد.',
    );
  }

  private invalidTransition(): never {
    throw onboardingError(
      HttpStatus.CONFLICT,
      SellerErrorCode.INVALID_TRANSITION,
      'تغییر وضعیت درخواست مجاز نیست.',
    );
  }

  private admin(value: string): string {
    const normalized = value?.trim();
    if (!normalized || normalized.length > 100)
      throw onboardingError(
        HttpStatus.BAD_REQUEST,
        SellerErrorCode.INVALID_TRANSITION,
        'شناسه ادمین معتبر نیست.',
      );
    return normalized;
  }

  private postgresCode(error: unknown) {
    return error instanceof QueryFailedError
      ? (error.driverError as { code?: string }).code
      : undefined;
  }
}
