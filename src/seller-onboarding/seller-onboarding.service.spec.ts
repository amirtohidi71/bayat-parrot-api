/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
import { HttpException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { ProductStatus } from '../products/entities/product.entity';
import { ParrotSaleListingStatus } from '../parrot-sale-listings/entities/parrot-sale-listing.entity';
import { User, UserRole } from '../users/entities/user.entity';
import {
  BreederApplicationStatus,
  BreederCallOutcome,
} from './entities/breeder-application.entity';
import {
  SellerVerification,
  SellerVerificationStatus,
} from './entities/seller-verification.entity';
import { SellerErrorCode } from './seller-onboarding.constants';
import { SellerOnboardingService } from './seller-onboarding.service';

function entityRepository() {
  return {
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
    findOne: jest.fn(),
    find: jest.fn(),
    exists: jest.fn(async () => false),
  };
}

function setup() {
  const sellers = entityRepository();
  const breeders = entityRepository();
  const txUsers = entityRepository();
  const txSellers = entityRepository();
  const txBreeders = entityRepository();
  const txListings = entityRepository();
  const txProducts = entityRepository();
  const manager = {
    getRepository: jest.fn((entity) => {
      if (entity.name === 'User') return txUsers;
      if (entity.name === 'SellerVerification') return txSellers;
      if (entity.name === 'ParrotSaleListing') return txListings;
      if (entity.name === 'Product') return txProducts;
      return txBreeders;
    }),
  };
  const dataSource = {
    transaction: jest.fn(async (work) => work(manager)),
  };
  const eligibility = {
    assertEligibleSeller: jest.fn(),
    assertEligibleForBreederPromotion: jest.fn(),
  };
  const service = new SellerOnboardingService(
    dataSource as never,
    sellers as never,
    breeders as never,
    eligibility as never,
  );
  return {
    service,
    sellers,
    breeders,
    txUsers,
    txSellers,
    txBreeders,
    txListings,
    txProducts,
    dataSource,
    manager,
    eligibility,
  };
}

async function expectInvalidTransition(action: Promise<unknown>) {
  try {
    await action;
    throw new Error('expected transition conflict');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(409);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: SellerErrorCode.INVALID_TRANSITION,
    });
  }
}

describe('SellerOnboardingService security and transitions', () => {
  const activeUser = {
    id: 'user-1',
    phone: '09123456789',
    firstName: 'Ali',
    lastName: 'Bird',
    role: UserRole.CUSTOMER,
    isActive: true,
    phoneVerifiedAt: new Date(),
  };

  it('requires true seller consent and ignores client-controlled status/role fields', async () => {
    const value = setup();
    await expect(
      value.service.submitSeller('user-1', {
        firstName: 'Ali',
        lastName: 'Bird',
        birthDate: '2000-01-01',
        consent: false,
        status: SellerVerificationStatus.APPROVED,
        role: UserRole.BREEDER,
      } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(value.txSellers.save).not.toHaveBeenCalled();
  });

  it('atomically updates the user name and creates a server-controlled seller request', async () => {
    const value = setup();
    const user = { ...activeUser };
    value.txUsers.findOne.mockResolvedValue(user);
    value.sellers.findOne.mockResolvedValue(null);

    await value.service.submitSeller('user-1', {
      firstName: 'Reza',
      lastName: 'Parrot',
      birthDate: '2000-01-01',
      consent: true,
      status: SellerVerificationStatus.APPROVED,
      role: UserRole.BREEDER,
      internalAdminNote: 'injected',
    } as never);
    await value.service.ownSeller('user-1');

    expect(value.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(value.manager.getRepository).toHaveBeenCalledWith(User);
    expect(value.manager.getRepository).toHaveBeenCalledWith(
      SellerVerification,
    );
    expect(value.txUsers.findOne).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(value.txUsers.save).toHaveBeenCalledWith(user);
    expect(user).toMatchObject({ firstName: 'Reza', lastName: 'Parrot' });
    expect(value.txSellers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        firstName: 'Reza',
        lastName: 'Parrot',
        status: SellerVerificationStatus.PENDING,
        internalAdminNote: null,
      }),
    );
    expect(value.txSellers.save).toHaveBeenCalledTimes(1);
    expect(value.sellers.create).not.toHaveBeenCalled();
    expect(value.sellers.save).not.toHaveBeenCalled();
    expect(value.sellers.findOne).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      order: { createdAt: 'DESC' },
    });
  });

  it.each([
    ['approve', SellerVerificationStatus.APPROVED],
    ['reject', SellerVerificationStatus.REJECTED],
  ])('allows admin to %s a pending seller request', async (action, status) => {
    const value = setup();
    const verification = {
      id: 'seller-1',
      userId: 'user-1',
      status: SellerVerificationStatus.PENDING,
      birthDate: '2000-01-01',
      user: activeUser,
    };
    value.txSellers.findOne.mockResolvedValue(verification);
    value.txUsers.findOne.mockResolvedValue({ ...activeUser });

    if (action === 'approve') {
      await value.service.approveSeller('seller-1', 'admin', {});
    } else {
      await value.service.rejectSeller('seller-1', 'admin', {
        rejectionReason: 'Needs correction',
      });
    }

    expect(verification.status).toBe(status);
    expect(value.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(value.txSellers.findOne).toHaveBeenCalledWith({
      where: { id: 'seller-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(value.txUsers.findOne).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(value.txSellers.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      value.txUsers.findOne.mock.invocationCallOrder[0],
    );
    expect(value.txSellers.save).toHaveBeenCalledWith(verification);
    expect(value.sellers.findOne).not.toHaveBeenCalled();
    expect(value.sellers.save).not.toHaveBeenCalled();
  });

  it('revokes approved seller access and unpublishes linked listing Products', async () => {
    const value = setup();
    const verification = {
      id: 'seller-1',
      userId: 'user-1',
      status: SellerVerificationStatus.APPROVED,
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
    };
    const listing = {
      id: 'listing-1',
      sellerUserId: 'user-1',
      status: ParrotSaleListingStatus.APPROVED,
      productId: 'product-1',
    };
    const product = {
      id: 'product-1',
      isSellerListing: true,
      status: ProductStatus.PUBLISHED,
    };
    value.txSellers.findOne
      .mockResolvedValueOnce(verification)
      .mockResolvedValueOnce(verification);
    value.txListings.find.mockResolvedValue([listing]);
    value.txProducts.find.mockResolvedValue([product]);
    value.txUsers.findOne.mockResolvedValue(activeUser);

    const result = await value.service.revokeSellerAccess(
      'seller-1',
      'pahlevan',
      { reason: 'Policy violation' },
    );

    expect(value.txListings.find).toHaveBeenCalledWith({
      where: { sellerUserId: 'user-1' },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(value.txSellers.findOne).toHaveBeenLastCalledWith({
      where: { id: 'seller-1' },
      lock: { mode: 'pessimistic_write' },
    });
    const productFindOptions = value.txProducts.find.mock.calls[0]?.[0] as
      | {
          where: { id: unknown };
          order: { id: 'ASC' };
          lock: { mode: 'pessimistic_write' };
        }
      | undefined;
    expect(productFindOptions).toMatchObject({
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(productFindOptions?.where.id).toBeDefined();
    expect(product.status).toBe(ProductStatus.DRAFT);
    expect(result).toMatchObject({
      revokedBy: 'pahlevan',
      revocationReason: 'Policy violation',
      user: activeUser,
    });
    expect(result.revokedAt).toBeInstanceOf(Date);
  });

  it('requires OTP evidence before creating a seller verification', async () => {
    const value = setup();
    value.txUsers.findOne.mockResolvedValue({
      ...activeUser,
      phoneVerifiedAt: null,
    });
    await expect(
      value.service.submitSeller('user-1', {
        firstName: 'Ali',
        lastName: 'Bird',
        birthDate: '2000-01-01',
        consent: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('blocks a concurrent active seller request', async () => {
    const value = setup();
    const user = { ...activeUser };
    value.txUsers.findOne.mockResolvedValue(user);
    value.txSellers.exists.mockResolvedValue(true);
    await expect(
      value.service.submitSeller('user-1', {
        firstName: 'Changed',
        lastName: 'Name',
        birthDate: '2000-01-01',
        consent: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(user).toMatchObject({ firstName: 'Ali', lastName: 'Bird' });
    expect(value.txUsers.save).not.toHaveBeenCalled();
    expect(value.txSellers.create).not.toHaveBeenCalled();
  });

  it('creates a new request after a rejected request because only active statuses conflict', async () => {
    const value = setup();
    const user = { ...activeUser };
    value.txUsers.findOne.mockResolvedValue(user);
    value.txSellers.exists.mockResolvedValue(false);
    await expect(
      value.service.submitSeller('user-1', {
        firstName: 'New',
        lastName: 'Name',
        birthDate: '2000-01-01',
        consent: true,
      }),
    ).resolves.toMatchObject({ status: SellerVerificationStatus.PENDING });
    expect(user).toMatchObject({ firstName: 'New', lastName: 'Name' });
    expect(value.txUsers.save).toHaveBeenCalledWith(user);
    expect(value.txSellers.save).toHaveBeenCalledTimes(1);
  });

  it('rolls back the user name when verification insertion fails', async () => {
    const value = setup();
    const user = { ...activeUser };
    value.txUsers.findOne.mockResolvedValue(user);
    value.txSellers.save.mockRejectedValue(
      new Error('verification write failed'),
    );
    const originalTransaction =
      value.dataSource.transaction.getMockImplementation();
    value.dataSource.transaction.mockImplementation(async (work) => {
      const snapshot = { ...user };
      try {
        return await originalTransaction!(work);
      } catch (error) {
        Object.assign(user, snapshot);
        throw error;
      }
    });

    await expect(
      value.service.submitSeller('user-1', {
        firstName: 'Changed',
        lastName: 'Name',
        birthDate: '2000-01-01',
        consent: true,
      }),
    ).rejects.toThrow('verification write failed');

    expect(user).toMatchObject({ firstName: 'Ali', lastName: 'Bird' });
    expect(value.txUsers.save).toHaveBeenCalledTimes(1);
    expect(value.txSellers.save).toHaveBeenCalledTimes(1);
  });

  it('maps an active-request unique violation without exposing database detail', async () => {
    const value = setup();
    const user = { ...activeUser };
    value.txUsers.findOne.mockResolvedValue(user);
    value.txSellers.save.mockRejectedValue(
      new QueryFailedError('INSERT seller verification', [], {
        code: '23505',
        detail: 'sensitive constraint detail',
      }),
    );

    try {
      await value.service.submitSeller('user-1', {
        firstName: 'Ali',
        lastName: 'Bird',
        birthDate: '2000-01-01',
        consent: true,
      });
      throw new Error('expected active request conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(409);
      expect((error as HttpException).getResponse()).toMatchObject({
        code: SellerErrorCode.ACTIVE_REQUEST_EXISTS,
      });
      expect(
        JSON.stringify((error as HttpException).getResponse()),
      ).not.toContain('sensitive constraint detail');
    }
  });

  it('does not create a verification when saving the updated user fails', async () => {
    const value = setup();
    const user = { ...activeUser };
    value.txUsers.findOne.mockResolvedValue(user);
    value.txUsers.save.mockRejectedValue(new Error('user write failed'));

    await expect(
      value.service.submitSeller('user-1', {
        firstName: 'Changed',
        lastName: 'Name',
        birthDate: '2000-01-01',
        consent: true,
      }),
    ).rejects.toThrow('user write failed');

    expect(value.txSellers.create).not.toHaveBeenCalled();
    expect(value.txSellers.save).not.toHaveBeenCalled();
  });

  it('submits a breeder application only through the strict promotion policy', async () => {
    const value = setup();
    value.eligibility.assertEligibleForBreederPromotion.mockResolvedValue({
      user: activeUser,
      verification: { status: SellerVerificationStatus.APPROVED },
    });

    await expect(
      value.service.submitBreeder('user-1', {
        breederName: 'Breeder',
        city: 'Tehran',
        species: ['Cockatiel'],
        experienceYears: 3,
        approximateBirdCount: 4,
        preferredContactTime: 'Morning',
      }),
    ).resolves.toMatchObject({
      userId: 'user-1',
      status: BreederApplicationStatus.PENDING_CALL,
    });

    expect(
      value.eligibility.assertEligibleForBreederPromotion,
    ).toHaveBeenCalledWith('user-1');
    expect(value.eligibility.assertEligibleSeller).not.toHaveBeenCalled();
  });

  it('rejects a late seller rejection after approval', async () => {
    const value = setup();
    const verification = {
      id: 'seller-1',
      userId: 'user-1',
      status: SellerVerificationStatus.PENDING,
      birthDate: '2000-01-01',
      user: activeUser,
    };
    value.txSellers.findOne.mockResolvedValue(verification);
    value.txUsers.findOne.mockResolvedValue({ ...activeUser });

    await value.service.approveSeller('seller-1', 'admin-1', {});
    await expectInvalidTransition(
      value.service.rejectSeller('seller-1', 'admin-2', {
        rejectionReason: 'late rejection',
      }),
    );

    expect(verification.status).toBe(SellerVerificationStatus.APPROVED);
    expect(value.txSellers.save).toHaveBeenCalledTimes(1);
  });

  it('rejects a late seller approval after rejection', async () => {
    const value = setup();
    const verification = {
      id: 'seller-1',
      userId: 'user-1',
      status: SellerVerificationStatus.PENDING,
      birthDate: '2000-01-01',
      user: activeUser,
    };
    value.txSellers.findOne.mockResolvedValue(verification);
    value.txUsers.findOne.mockResolvedValue({ ...activeUser });

    await value.service.rejectSeller('seller-1', 'admin-1', {
      rejectionReason: 'not eligible',
    });
    await expectInvalidTransition(
      value.service.approveSeller('seller-1', 'admin-2', {}),
    );

    expect(verification.status).toBe(SellerVerificationStatus.REJECTED);
    expect(value.txSellers.save).toHaveBeenCalledTimes(1);
  });

  it('rejects repeated seller approval', async () => {
    const value = setup();
    const verification = {
      id: 'seller-1',
      userId: 'user-1',
      status: SellerVerificationStatus.PENDING,
      birthDate: '2000-01-01',
      user: activeUser,
    };
    value.txSellers.findOne.mockResolvedValue(verification);
    value.txUsers.findOne.mockResolvedValue({ ...activeUser });

    await value.service.approveSeller('seller-1', 'admin-1', {});
    await expectInvalidTransition(
      value.service.approveSeller('seller-1', 'admin-2', {}),
    );

    expect(verification.status).toBe(SellerVerificationStatus.APPROVED);
    expect(value.txSellers.save).toHaveBeenCalledTimes(1);
  });

  it('serializes stale seller approval and rejection through transaction-scoped locks', async () => {
    const value = setup();
    const verification = {
      id: 'seller-1',
      userId: 'user-1',
      status: SellerVerificationStatus.PENDING,
      birthDate: '2000-01-01',
      user: activeUser,
    };
    let queue = Promise.resolve();
    value.dataSource.transaction.mockImplementation((work) => {
      const execution = queue.then(() => work(value.manager));
      queue = execution.then(
        () => undefined,
        () => undefined,
      );
      return execution;
    });
    value.txSellers.findOne.mockImplementation(async () => verification);
    value.txUsers.findOne.mockResolvedValue({ ...activeUser });

    const results = await Promise.allSettled([
      value.service.approveSeller('seller-1', 'admin-1', {}),
      value.service.rejectSeller('seller-1', 'admin-2', {
        rejectionReason: 'stale rejection',
      }),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(verification.status).toBe(SellerVerificationStatus.APPROVED);
    expect(value.txSellers.save).toHaveBeenCalledTimes(1);
  });

  it('keeps seller verification unchanged when transactional save fails', async () => {
    const value = setup();
    const verification = {
      id: 'seller-1',
      userId: 'user-1',
      status: SellerVerificationStatus.PENDING,
      birthDate: '2000-01-01',
      rejectionReason: null,
      internalAdminNote: null,
      reviewedBy: null,
      reviewedAt: null,
      user: activeUser,
    };
    value.txSellers.findOne.mockResolvedValue(verification);
    value.txUsers.findOne.mockResolvedValue({ ...activeUser });
    value.txSellers.save.mockRejectedValue(new Error('write failed'));
    const originalTransaction =
      value.dataSource.transaction.getMockImplementation();
    value.dataSource.transaction.mockImplementation(async (work) => {
      const snapshot = { ...verification };
      try {
        return await originalTransaction!(work);
      } catch (error) {
        Object.assign(verification, snapshot);
        throw error;
      }
    });

    await expect(
      value.service.rejectSeller('seller-1', 'admin', {
        rejectionReason: 'not eligible',
        internalAdminNote: 'private',
      }),
    ).rejects.toThrow('write failed');

    expect(verification).toMatchObject({
      status: SellerVerificationStatus.PENDING,
      rejectionReason: null,
      internalAdminNote: null,
      reviewedBy: null,
      reviewedAt: null,
    });
    expect(value.sellers.save).not.toHaveBeenCalled();
  });

  it('records the admin call server-side and moves the request to follow-up', async () => {
    const value = setup();
    const application = {
      id: 'app-1',
      userId: 'user-1',
      status: BreederApplicationStatus.PENDING_CALL,
      user: activeUser,
    };
    value.txBreeders.findOne.mockResolvedValue(application);
    value.txUsers.findOne.mockResolvedValue({ ...activeUser });

    await value.service.recordBreederCall('app-1', 'admin', {
      outcome: BreederCallOutcome.SUCCESSFUL,
      privateCallNote: 'verified by phone',
    });

    expect(application.status).toBe(BreederApplicationStatus.FOLLOW_UP);
    expect(application.callOutcome).toBe(BreederCallOutcome.SUCCESSFUL);
    expect(application.contactedAt).toBeInstanceOf(Date);
    expect(value.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(value.txBreeders.findOne).toHaveBeenCalledWith({
      where: { id: 'app-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(value.txUsers.findOne).toHaveBeenCalledWith({
      where: { id: 'user-1' },
    });
    expect(value.txBreeders.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      value.txUsers.findOne.mock.invocationCallOrder[0],
    );
    expect(value.txBreeders.save).toHaveBeenCalledWith(application);
    expect(value.breeders.findOne).not.toHaveBeenCalled();
    expect(value.breeders.save).not.toHaveBeenCalled();
  });

  it('will not approve a breeder without a successful recorded call', async () => {
    const value = setup();
    value.txBreeders.findOne.mockResolvedValue({
      id: 'app-1',
      userId: 'user-1',
      status: BreederApplicationStatus.FOLLOW_UP,
      callOutcome: BreederCallOutcome.NO_ANSWER,
      contactedAt: new Date(),
      user: activeUser,
    });
    try {
      await value.service.approveBreeder('app-1', 'admin');
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getResponse()).toMatchObject({
        code: SellerErrorCode.BREEDER_CALL_REQUIRED,
      });
    }
    expect(value.txUsers.save).not.toHaveBeenCalled();
  });

  it('changes breeder application and user role inside one transaction', async () => {
    const value = setup();
    const application = {
      id: 'app-1',
      userId: 'user-1',
      status: BreederApplicationStatus.FOLLOW_UP,
      callOutcome: BreederCallOutcome.SUCCESSFUL,
      contactedAt: new Date(),
      user: activeUser,
    };
    const user = { ...activeUser };
    value.txBreeders.findOne.mockResolvedValue(application);
    value.txUsers.findOne.mockResolvedValue(user);
    value.txSellers.findOne.mockResolvedValue({
      userId: user.id,
      status: SellerVerificationStatus.APPROVED,
      birthDate: '2000-01-01',
    });

    await value.service.approveBreeder('app-1', 'authorized-admin');

    expect(value.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(value.txBreeders.findOne).toHaveBeenCalledWith({
      where: { id: 'app-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(value.txUsers.findOne).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(value.txBreeders.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      value.txUsers.findOne.mock.invocationCallOrder[0],
    );
    expect(user.role).toBe(UserRole.BREEDER);
    expect(application.status).toBe(BreederApplicationStatus.APPROVED);
    expect(value.txUsers.save).toHaveBeenCalledWith(user);
    expect(value.txBreeders.save).toHaveBeenCalledWith(application);
  });

  it.each([UserRole.BREEDER, UserRole.ADMIN])(
    'refuses to approve a breeder application when the locked user role is %s',
    async (role) => {
      const value = setup();
      const application = {
        id: 'app-1',
        userId: 'user-1',
        status: BreederApplicationStatus.FOLLOW_UP,
        callOutcome: BreederCallOutcome.SUCCESSFUL,
        contactedAt: new Date(),
        user: activeUser,
      };
      const user = { ...activeUser, role };
      value.txBreeders.findOne.mockResolvedValue(application);
      value.txUsers.findOne.mockResolvedValue(user);

      try {
        await value.service.approveBreeder('app-1', 'admin');
        throw new Error('expected role conflict');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(409);
        expect((error as HttpException).getResponse()).toMatchObject({
          code: SellerErrorCode.BREEDER_BASE_ROLE_REQUIRED,
        });
      }

      expect(user.role).toBe(role);
      expect(application.status).toBe(BreederApplicationStatus.FOLLOW_UP);
      expect(value.txUsers.save).not.toHaveBeenCalled();
      expect(value.txBreeders.save).not.toHaveBeenCalled();
      expect(value.txSellers.findOne).not.toHaveBeenCalled();
    },
  );

  it('rejects reject after approval without overwriting the approved application', async () => {
    const value = setup();
    const application = {
      id: 'app-1',
      userId: 'user-1',
      status: BreederApplicationStatus.FOLLOW_UP,
      callOutcome: BreederCallOutcome.SUCCESSFUL,
      contactedAt: new Date(),
      user: activeUser,
    };
    const user = { ...activeUser };
    value.txBreeders.findOne.mockResolvedValue(application);
    value.txUsers.findOne.mockResolvedValue(user);
    value.txSellers.findOne.mockResolvedValue({
      userId: user.id,
      status: SellerVerificationStatus.APPROVED,
      birthDate: '2000-01-01',
    });

    await value.service.approveBreeder('app-1', 'admin');
    await expectInvalidTransition(
      value.service.rejectBreeder('app-1', 'admin', {
        rejectionReason: 'late rejection',
      }),
    );

    expect(application.status).toBe(BreederApplicationStatus.APPROVED);
    expect(value.txBreeders.save).toHaveBeenCalledTimes(1);
  });

  it('rejects contact after approval without returning the application to follow-up', async () => {
    const value = setup();
    const application = {
      id: 'app-1',
      userId: 'user-1',
      status: BreederApplicationStatus.FOLLOW_UP,
      callOutcome: BreederCallOutcome.SUCCESSFUL,
      contactedAt: new Date(),
      user: activeUser,
    };
    const user = { ...activeUser };
    value.txBreeders.findOne.mockResolvedValue(application);
    value.txUsers.findOne.mockResolvedValue(user);
    value.txSellers.findOne.mockResolvedValue({
      userId: user.id,
      status: SellerVerificationStatus.APPROVED,
      birthDate: '2000-01-01',
    });

    await value.service.approveBreeder('app-1', 'admin');
    await expectInvalidTransition(
      value.service.recordBreederCall('app-1', 'admin', {
        outcome: BreederCallOutcome.NO_ANSWER,
      }),
    );

    expect(application.status).toBe(BreederApplicationStatus.APPROVED);
    expect(application.callOutcome).toBe(BreederCallOutcome.SUCCESSFUL);
    expect(value.txBreeders.save).toHaveBeenCalledTimes(1);
  });

  it('rejects approval after rejection', async () => {
    const value = setup();
    const application = {
      id: 'app-1',
      userId: 'user-1',
      status: BreederApplicationStatus.PENDING_CALL,
      callOutcome: null,
      contactedAt: null,
      privateCallNote: null,
      user: activeUser,
    };
    value.txBreeders.findOne.mockResolvedValue(application);
    value.txUsers.findOne.mockResolvedValue({ ...activeUser });

    await value.service.rejectBreeder('app-1', 'admin', {
      rejectionReason: 'not eligible',
    });
    expect(value.txBreeders.findOne).toHaveBeenCalledWith({
      where: { id: 'app-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(value.txUsers.findOne).toHaveBeenCalledWith({
      where: { id: 'user-1' },
    });
    expect(value.txBreeders.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      value.txUsers.findOne.mock.invocationCallOrder[0],
    );
    expect(value.breeders.findOne).not.toHaveBeenCalled();
    expect(value.breeders.save).not.toHaveBeenCalled();
    await expectInvalidTransition(
      value.service.approveBreeder('app-1', 'admin'),
    );

    expect(application.status).toBe(BreederApplicationStatus.REJECTED);
    expect(value.txBreeders.save).toHaveBeenCalledTimes(1);
    expect(value.txUsers.save).not.toHaveBeenCalled();
  });

  it('serializes stale approve and reject actions through transaction-scoped locks', async () => {
    const value = setup();
    const application = {
      id: 'app-1',
      userId: 'user-1',
      status: BreederApplicationStatus.FOLLOW_UP,
      callOutcome: BreederCallOutcome.SUCCESSFUL,
      contactedAt: new Date(),
      user: activeUser,
    };
    const user = { ...activeUser };
    let queue = Promise.resolve();
    value.dataSource.transaction.mockImplementation((work) => {
      const execution = queue.then(() => work(value.manager));
      queue = execution.then(
        () => undefined,
        () => undefined,
      );
      return execution;
    });
    value.txBreeders.findOne.mockImplementation(async () => application);
    value.txUsers.findOne.mockResolvedValue(user);
    value.txSellers.findOne.mockResolvedValue({
      userId: user.id,
      status: SellerVerificationStatus.APPROVED,
      birthDate: '2000-01-01',
    });

    const results = await Promise.allSettled([
      value.service.approveBreeder('app-1', 'admin-1'),
      value.service.rejectBreeder('app-1', 'admin-2', {
        rejectionReason: 'stale rejection',
      }),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(application.status).toBe(BreederApplicationStatus.APPROVED);
    expect(value.txBreeders.save).toHaveBeenCalledTimes(1);
  });

  it('keeps role and application unchanged when approval persistence fails', async () => {
    const value = setup();
    const application = {
      id: 'app-1',
      userId: 'user-1',
      status: BreederApplicationStatus.FOLLOW_UP,
      callOutcome: BreederCallOutcome.SUCCESSFUL,
      contactedAt: new Date(),
      user: activeUser,
    };
    const user = { ...activeUser };
    value.txBreeders.findOne.mockResolvedValue(application);
    value.txUsers.findOne.mockResolvedValue(user);
    value.txSellers.findOne.mockResolvedValue({
      userId: user.id,
      status: SellerVerificationStatus.APPROVED,
      birthDate: '2000-01-01',
    });
    value.txBreeders.save.mockRejectedValue(new Error('write failed'));
    const originalTransaction =
      value.dataSource.transaction.getMockImplementation();
    value.dataSource.transaction.mockImplementation(async (work) => {
      const originalRole = user.role;
      const originalStatus = application.status;
      try {
        return await originalTransaction!(work);
      } catch (error) {
        user.role = originalRole;
        application.status = originalStatus;
        throw error;
      }
    });

    await expect(
      value.service.approveBreeder('app-1', 'admin'),
    ).rejects.toThrow('write failed');

    expect(user.role).toBe(UserRole.CUSTOMER);
    expect(application.status).toBe(BreederApplicationStatus.FOLLOW_UP);
    expect(value.txUsers.save).toHaveBeenCalledTimes(1);
    expect(value.breeders.save).not.toHaveBeenCalled();
  });
});
