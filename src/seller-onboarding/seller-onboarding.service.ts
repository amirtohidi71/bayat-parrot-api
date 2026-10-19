import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  Not,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { Product, ProductStatus } from '../products/entities/product.entity';
import {
  ParrotSaleListing,
  ParrotSaleListingStatus,
} from '../parrot-sale-listings/entities/parrot-sale-listing.entity';
import { User, UserRole, isCustomerRole } from '../users/entities/user.entity';
import {
  AdminBreederCallDto,
  AdminGrantSellerReapplicationDto,
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
import { lockSellerLifecycle, ReapplicationIntent } from './seller-lifecycle';

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
        await lockSellerLifecycle(manager, userId);
        const user = await this.lockedUserForSubmission(users, userId);
        await this.assertReapplicationAllowed(verifications, userId, false);
        if (
          await verifications.exists({
            where: { userId, status: In(sellerActive), revokedAt: IsNull() },
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
          reapplicationIntent: ReapplicationIntent.BLOCKED,
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
      relations: { user: true },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
  }

  async listSellers(status?: SellerVerificationStatus) {
    const values = await this.sellers.find({
      where: status ? { status } : {},
      relations: { user: true },
      order: { createdAt: 'DESC' },
    });
    for (const value of values)
      value.isCurrent = (await this.ownSeller(value.userId))?.id === value.id;
    return values;
  }

  async sellerDetail(id: string) {
    const value = await this.requiredSeller(id, true);
    value.isCurrent = (await this.ownSeller(value.userId))?.id === value.id;
    return value;
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
      await lockSellerLifecycle(manager, initial.userId);

      // Stable lock order: all seller listings, verification, then linked products.
      const listings = await manager.getRepository(ParrotSaleListing).find({
        where: { sellerUserId: initial.userId },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const verification = await verifications.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!verification)
        throw new NotFoundException('Seller verification not found');
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
      verification.reapplicationIntent =
        input.intent ?? ReapplicationIntent.BLOCKED;
      const saved = await verifications.save(verification);
      saved.user = await this.requiredUser(
        manager.getRepository(User),
        verification.userId,
      );
      return saved;
    });
  }

  async submitBreeder(userId: string, input: SubmitBreederApplicationDto) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockSellerLifecycle(manager, userId);
        const user = await this.lockedUserForSubmission(
          manager.getRepository(User),
          userId,
        );
        if (user.role !== UserRole.CUSTOMER) {
          throw onboardingError(
            HttpStatus.FORBIDDEN,
            SellerErrorCode.BREEDER_BASE_ROLE_REQUIRED,
            'فقط کاربر عادی واجد شرایط می‌تواند درخواست پرورش‌دهنده ثبت کند.',
          );
        }
        await this.eligibility.assertEligibleSellerInTransaction(
          userId,
          manager,
        );
        const applications = manager.getRepository(BreederApplication);
        await this.assertReapplicationAllowed(applications, userId, true);
        if (
          await applications.exists({
            where: { userId, status: In(breederActive), revokedAt: IsNull() },
          })
        )
          this.activeBreederConflict();
        return applications.save(
          applications.create({
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
            revokedAt: null,
            revokedBy: null,
            revocationReason: null,
            reapplicationIntent: ReapplicationIntent.BLOCKED,
          }),
        );
      });
    } catch (error) {
      if (this.postgresCode(error) === '23505') this.activeBreederConflict();
      throw error;
    }
  }

  async revokeBreeder(
    id: string,
    admin: string,
    input: AdminRevokeSellerAccessDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const applications = manager.getRepository(BreederApplication);
      const application = await this.lockedBreeder(applications, id, manager);
      if (application.status !== BreederApplicationStatus.APPROVED)
        this.invalidTransition();
      if (application.revokedAt)
        throw onboardingError(
          HttpStatus.CONFLICT,
          SellerErrorCode.BREEDER_ACCESS_ALREADY_REVOKED,
          'تأیید پرورش‌دهندگی قبلاً لغو شده است.',
        );
      const users = manager.getRepository(User);
      const user = await users.findOne({
        where: { id: application.userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user || user.role !== UserRole.BREEDER)
        throw onboardingError(
          HttpStatus.CONFLICT,
          SellerErrorCode.BREEDER_BASE_ROLE_REQUIRED,
          'نقش فعلی کاربر برای لغو پرورش‌دهندگی معتبر نیست.',
        );
      application.revokedAt = new Date();
      application.revokedBy = this.admin(admin);
      application.revocationReason = input.reason.trim();
      application.reapplicationIntent =
        input.intent ?? ReapplicationIntent.BLOCKED;
      user.role = UserRole.CUSTOMER;
      await users.save(user);
      const saved = await applications.save(application);
      saved.user = user;
      saved.sellerAccessEligible = (
        await this.eligibility.canSubmitParrotSaleListingInTransaction(
          user.id,
          manager,
        )
      ).eligible;
      return saved;
    });
  }

  async ownBreeder(userId: string) {
    const value = await this.breeders.findOne({
      where: { userId },
      relations: { user: true },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    if (value)
      value.sellerAccessEligible = (
        await this.eligibility.canSubmitParrotSaleListing(userId)
      ).eligible;
    return value;
  }

  async listBreeders(status?: BreederApplicationStatus) {
    const values = await this.breeders.find({
      where: status ? { status } : {},
      relations: { user: true },
      order: { createdAt: 'DESC' },
    });
    for (const value of values) {
      const current = await this.ownBreeder(value.userId);
      value.isCurrent = current?.id === value.id;
      value.sellerAccessEligible = current?.sellerAccessEligible;
    }
    return values;
  }

  async breederDetail(id: string) {
    const value = await this.requiredBreeder(id, true);
    const current = await this.ownBreeder(value.userId);
    value.isCurrent = current?.id === value.id;
    value.sellerAccessEligible = current?.sellerAccessEligible;
    return value;
  }

  async recordBreederCall(
    id: string,
    admin: string,
    input: AdminBreederCallDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const applications = manager.getRepository(BreederApplication);
      const application = await this.lockedBreeder(applications, id, manager);
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
      const application = await this.lockedBreeder(applications, id, manager);
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
      await this.eligibility.assertEligibleSellerInTransaction(
        user.id,
        manager,
      );
      await this.assertReapplicationAllowed(applications, user.id, true);
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
      const application = await this.lockedBreeder(applications, id, manager);
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
      const verification = await this.lockedSeller(verifications, id, manager);
      if (
        verification.status !== SellerVerificationStatus.PENDING ||
        verification.revokedAt
      )
        this.invalidTransition();
      await this.assertReapplicationAllowed(
        verifications,
        verification.userId,
        false,
      );
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
    manager: EntityManager,
  ) {
    const initial = await verifications.findOne({ where: { id } });
    if (!initial) throw new NotFoundException('Seller verification not found');
    await lockSellerLifecycle(manager, initial.userId);
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
    manager: EntityManager,
  ) {
    const initial = await applications.findOne({ where: { id } });
    if (!initial) throw new NotFoundException('Breeder application not found');
    await lockSellerLifecycle(manager, initial.userId);
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

  async grantSellerReapplication(
    id: string,
    admin: string,
    input: AdminGrantSellerReapplicationDto,
  ) {
    const actor = this.admin(admin);
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 500) {
      throw onboardingError(
        HttpStatus.BAD_REQUEST,
        SellerErrorCode.INVALID_TRANSITION,
        'دلیل اعطای اجازه درخواست مجدد الزامی است.',
      );
    }
    return this.dataSource.transaction(async (manager) => {
      const verifications = manager.getRepository(SellerVerification);
      const verification = await this.lockedSeller(verifications, id, manager);
      if (
        verification.status !== SellerVerificationStatus.APPROVED ||
        !verification.revokedAt ||
        verification.reapplicationIntent !== ReapplicationIntent.BLOCKED ||
        verification.reapplicationGrantedAt
      )
        this.invalidTransition();
      const current = await verifications.findOne({
        where: { userId: verification.userId },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      if (
        current?.id !== id ||
        (await verifications.exists({
          where: {
            userId: verification.userId,
            status: In([
              SellerVerificationStatus.PENDING,
              SellerVerificationStatus.APPROVED,
            ]),
            revokedAt: IsNull(),
          },
        }))
      )
        this.invalidTransition();
      if (
        await verifications.exists({
          where: {
            userId: verification.userId,
            id: Not(id),
            revokedAt: Not(IsNull()),
            reapplicationIntent: ReapplicationIntent.BLOCKED,
            reapplicationGrantedAt: IsNull(),
          },
        })
      )
        this.invalidTransition();
      const user = await this.lockedUserForSubmission(
        manager.getRepository(User),
        verification.userId,
      );
      assertAdultBirthDate(verification.birthDate);
      const rows = await manager.query<{ now: Date }[]>(
        'SELECT clock_timestamp() AS now',
      );
      verification.reapplicationGrantedAt = rows[0].now;
      verification.reapplicationGrantedBy = actor;
      verification.reapplicationGrantReason = reason;
      const saved = await verifications.save(verification);
      saved.user = user;
      return saved;
    });
  }

  private async assertReapplicationAllowed(
    repository: Repository<SellerVerification> | Repository<BreederApplication>,
    userId: string,
    breeder: boolean,
  ) {
    const blocked = await repository.exists({
      where: {
        userId,
        reapplicationIntent: ReapplicationIntent.BLOCKED,
        revokedAt: Not(IsNull()),
        ...(!breeder ? { reapplicationGrantedAt: IsNull() } : {}),
      },
    });
    if (blocked)
      throw onboardingError(
        HttpStatus.FORBIDDEN,
        breeder
          ? SellerErrorCode.BREEDER_ACCESS_REVOKED
          : SellerErrorCode.ACCESS_REVOKED,
        breeder
          ? 'دسترسی درخواست پرورش‌دهندگی برای شما غیرفعال شده است.'
          : 'دسترسی ثبت آگهی فروش پرنده برای شما غیرفعال شده است.',
      );
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
