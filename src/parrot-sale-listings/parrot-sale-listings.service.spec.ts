/* eslint-disable @typescript-eslint/require-await -- transaction and repository mocks intentionally mirror async TypeORM APIs. */
import { HttpException } from '@nestjs/common';
import { SellerEligibilityPolicy } from '../seller-onboarding/seller-eligibility.policy';
import { User, UserRole } from '../users/entities/user.entity';
import { ParrotSaleListingImage } from './entities/parrot-sale-listing-image.entity';
import {
  ParrotSaleListing,
  ParrotSaleListingStatus,
} from './entities/parrot-sale-listing.entity';
import { ParrotSaleListingErrorCode } from './parrot-sale-listing.errors';
import { ParrotSaleListingsService } from './parrot-sale-listings.service';

const SELLER_ID = '123e4567-e89b-42d3-a456-426614174000';
const LISTING_ID = '223e4567-e89b-42d3-a456-426614174000';
const IMAGE_ID = '323e4567-e89b-42d3-a456-426614174000';
const STORAGE_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';

function listing(status = ParrotSaleListingStatus.DRAFT) {
  return Object.assign(new ParrotSaleListing(), {
    id: LISTING_ID,
    sellerUserId: SELLER_ID,
    status,
    name: 'Grey parrot',
    description: null,
    species: 'African Grey',
    subspecies: null,
    gender: null,
    ageStage: null,
    colors: null,
    tagPair: false,
    tagHandTame: true,
    requestedPrice: 100,
    approvedPrice: null,
    quantity: 1,
    productId: null,
    rejectionReason: null,
    internalAdminNote: null,
    reviewedBy: null,
    reviewedAt: null,
    resubmissionOfId: null,
    images: [],
    createdAt: new Date('2026-10-03T00:00:00Z'),
    updatedAt: new Date('2026-10-03T00:00:00Z'),
  });
}

function image(position = 0) {
  return Object.assign(new ParrotSaleListingImage(), {
    id: IMAGE_ID,
    listingId: LISTING_ID,
    storageKey: STORAGE_KEY,
    position,
    createdAt: new Date('2026-10-03T00:00:00Z'),
  });
}

function context(status = ParrotSaleListingStatus.DRAFT) {
  const row = listing(status);
  const seller = Object.assign(new User(), {
    id: SELLER_ID,
    phone: '09120000000',
    firstName: 'Seller',
    lastName: 'Bird',
    role: UserRole.CUSTOMER,
    profileCompleted: true,
  });
  row.seller = seller;
  const globalListings = {
    find: jest.fn().mockResolvedValue([row]),
    findOne: jest.fn().mockResolvedValue(row),
  };
  const txListings = {
    findOne: jest.fn().mockResolvedValue(row),
    create: jest.fn((value: Partial<ParrotSaleListing>) =>
      Object.assign(listing(), value),
    ),
    save: jest.fn(async (value: ParrotSaleListing) => value),
  };
  const txImages = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(image()),
    count: jest.fn().mockResolvedValue(1),
    create: jest.fn((value: Partial<ParrotSaleListingImage>) =>
      Object.assign(image(), value),
    ),
    save: jest.fn(async (value: ParrotSaleListingImage) => value),
    remove: jest.fn(async (value: ParrotSaleListingImage) => value),
  };
  const txUsers = {
    findOne: jest.fn().mockResolvedValue(seller),
  };
  const manager = {
    getRepository: jest.fn((target: unknown) => {
      if (target === ParrotSaleListing) return txListings;
      if (target === ParrotSaleListingImage) return txImages;
      if (target === User) return txUsers;
      throw new Error('Unexpected repository');
    }),
  };
  const dataSource = {
    getRepository: jest.fn((target: unknown) => {
      if (target === ParrotSaleListingImage) return txImages;
      throw new Error('Unexpected global repository');
    }),
    transaction: jest.fn(
      async (callback: (value: typeof manager) => Promise<unknown>) =>
        callback(manager),
    ),
  };
  const eligibility = {
    assertEligibleSeller: jest.fn().mockResolvedValue({}),
    assertEligibleSellerInTransaction: jest.fn().mockResolvedValue({}),
  };
  const storage = {
    save: jest.fn().mockResolvedValue(STORAGE_KEY),
    read: jest.fn().mockResolvedValue({
      buffer: Buffer.from('webp'),
      mimeType: 'image/webp',
      size: 4,
    }),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const options = {
    getOptions: jest.fn().mockResolvedValue({}),
    assertValidSelection: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ParrotSaleListingsService(
    dataSource as never,
    globalListings as never,
    eligibility as unknown as SellerEligibilityPolicy,
    storage as never,
    options as never,
  );
  return {
    service,
    row,
    globalListings,
    txListings,
    txImages,
    txUsers,
    manager,
    dataSource,
    eligibility,
    storage,
    options,
  };
}

async function expectCode(
  action: Promise<unknown>,
  status: number,
  code: string,
) {
  try {
    await action;
    throw new Error('Expected request to fail');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HttpException);
    const exception = error as HttpException;
    expect(exception.getStatus()).toBe(status);
    expect(exception.getResponse()).toMatchObject({ code });
  }
}

describe('ParrotSaleListingsService customer workflow', () => {
  it('creates an eligible seller listing as a transaction-scoped DRAFT', async () => {
    const value = context();
    const result = await value.service.create(SELLER_ID, {
      name: 'Bird',
      species: 'Grey',
      requestedPrice: 100,
    });
    expect(value.eligibility.assertEligibleSeller).toHaveBeenCalledWith(
      SELLER_ID,
    );
    expect(value.txListings.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerUserId: SELLER_ID,
        status: ParrotSaleListingStatus.DRAFT,
        quantity: 1,
        productId: null,
        approvedPrice: null,
        reviewedBy: null,
      }),
    );
    expect(value.options.assertValidSelection).toHaveBeenCalledWith(
      expect.objectContaining({ species: 'Grey' }),
      value.manager,
    );
    expect(result.images).toEqual([]);
  });

  it('does not create a listing when a real product option is invalid', async () => {
    const value = context();
    value.options.assertValidSelection.mockRejectedValueOnce(
      new HttpException(
        {
          statusCode: 400,
          code: ParrotSaleListingErrorCode.INVALID_OPTION,
          message: 'Invalid parrot sale listing species option',
        },
        400,
      ),
    );
    await expectCode(
      value.service.create(SELLER_ID, {
        name: 'Bird',
        species: 'guessed-species',
        requestedPrice: 100,
      }),
      400,
      ParrotSaleListingErrorCode.INVALID_OPTION,
    );
    expect(value.txListings.create).not.toHaveBeenCalled();
    expect(value.txListings.save).not.toHaveBeenCalled();
  });

  it('scopes list and detail reads to the authenticated seller', async () => {
    const value = context();
    await value.service.listOwn(SELLER_ID);
    await value.service.getOwn(SELLER_ID, LISTING_ID);
    expect(value.globalListings.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sellerUserId: SELLER_ID } }),
    );
    expect(value.globalListings.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: LISTING_ID, sellerUserId: SELLER_ID },
      }),
    );
  });

  it('lists and loads admin review data with optional status filtering', async () => {
    const value = context(ParrotSaleListingStatus.PENDING_REVIEW);
    await value.service.listForAdmin(ParrotSaleListingStatus.PENDING_REVIEW);
    await value.service.getForAdmin(LISTING_ID);
    expect(value.globalListings.find).toHaveBeenCalledWith({
      where: { status: ParrotSaleListingStatus.PENDING_REVIEW },
      relations: { images: true, seller: true },
      order: { createdAt: 'DESC' },
    });
    expect(value.globalListings.findOne).toHaveBeenCalledWith({
      where: { id: LISTING_ID },
      relations: { images: true, seller: true },
    });
  });

  it('locks an owned listing before applying an allowlisted DRAFT update', async () => {
    const value = context();
    const result = await value.service.update(SELLER_ID, LISTING_ID, {
      name: 'Updated',
      quantity: 100,
    });
    expect(value.txListings.findOne).toHaveBeenCalledWith({
      where: { id: LISTING_ID, sellerUserId: SELLER_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(result).toMatchObject({ name: 'Updated', quantity: 100 });
  });

  it('validates the effective species, subspecies and colors before update', async () => {
    const value = context();
    value.row.species = 'african-grey';
    value.row.subspecies = 'red-tail';
    value.row.colors = ['gray'];
    await value.service.update(SELLER_ID, LISTING_ID, {
      colors: ['silver'],
    });
    expect(value.options.assertValidSelection).toHaveBeenCalledWith(
      {
        species: 'african-grey',
        subspecies: 'red-tail',
        colors: ['silver'],
      },
      value.manager,
    );
    expect(
      value.options.assertValidSelection.mock.invocationCallOrder[0],
    ).toBeLessThan(value.txListings.save.mock.invocationCallOrder[0]);
  });

  it.each([
    ParrotSaleListingStatus.PENDING_REVIEW,
    ParrotSaleListingStatus.APPROVED,
    ParrotSaleListingStatus.REJECTED,
  ])('keeps %s listings immutable', async (status) => {
    const value = context(status);
    await expectCode(
      value.service.update(SELLER_ID, LISTING_ID, { name: 'No' }),
      409,
      ParrotSaleListingErrorCode.NOT_EDITABLE,
    );
    expect(value.txListings.save).not.toHaveBeenCalled();
  });

  it('returns the same 404 for a missing or another seller listing', async () => {
    const value = context();
    value.globalListings.findOne.mockResolvedValueOnce(null);
    await expectCode(
      value.service.getOwn(SELLER_ID, LISTING_ID),
      404,
      ParrotSaleListingErrorCode.NOT_FOUND,
    );
  });

  it('reads a private image only after server-authoritative ownership lookup', async () => {
    const value = context();
    const result = await value.service.readOwnImage(
      SELLER_ID,
      LISTING_ID,
      IMAGE_ID,
    );
    expect(value.globalListings.findOne).toHaveBeenCalledWith({
      where: { id: LISTING_ID, sellerUserId: SELLER_ID },
      select: { id: true },
    });
    expect(value.txImages.findOne).toHaveBeenCalledWith({
      where: { id: IMAGE_ID, listingId: LISTING_ID },
      select: { id: true, storageKey: true },
    });
    expect(value.storage.read).toHaveBeenCalledWith(STORAGE_KEY);
    expect(result).toMatchObject({ mimeType: 'image/webp', size: 4 });
  });

  it('loads God Admin review detail with only the required relations', async () => {
    const value = context(ParrotSaleListingStatus.APPROVED);
    value.row.images = [image(1), image(0)];
    const result = await value.service.getForGodAdmin(LISTING_ID);
    expect(value.globalListings.findOne).toHaveBeenCalledWith({
      where: { id: LISTING_ID },
      relations: { images: true, seller: true, product: true },
    });
    expect(result.images.map((item) => item.position)).toEqual([0, 1]);
  });

  it('lists pending God Admin reviews by default with review relations', async () => {
    const value = context(ParrotSaleListingStatus.PENDING_REVIEW);
    await value.service.listForGodAdmin();
    expect(value.globalListings.find).toHaveBeenCalledWith({
      where: { status: ParrotSaleListingStatus.PENDING_REVIEW },
      relations: { images: true, seller: true },
      order: { createdAt: 'DESC' },
    });
  });

  it('honors an explicit validated God Admin status filter', async () => {
    const value = context(ParrotSaleListingStatus.APPROVED);
    await value.service.listForGodAdmin(ParrotSaleListingStatus.APPROVED);
    expect(value.globalListings.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: ParrotSaleListingStatus.APPROVED },
      }),
    );
  });

  it('returns the stable listing 404 for missing God Admin detail', async () => {
    const value = context();
    value.globalListings.findOne.mockResolvedValueOnce(null);
    await expectCode(
      value.service.getForGodAdmin(LISTING_ID),
      404,
      ParrotSaleListingErrorCode.NOT_FOUND,
    );
  });

  it('conceals another seller listing and never reads its private image', async () => {
    const value = context();
    value.globalListings.findOne.mockResolvedValueOnce(null);
    await expectCode(
      value.service.readOwnImage(SELLER_ID, LISTING_ID, IMAGE_ID),
      404,
      ParrotSaleListingErrorCode.NOT_FOUND,
    );
    expect(value.txImages.findOne).not.toHaveBeenCalled();
    expect(value.storage.read).not.toHaveBeenCalled();
  });

  it('returns a stable image 404 without disclosing a storage key', async () => {
    const value = context();
    value.txImages.findOne.mockResolvedValueOnce(null);
    await expectCode(
      value.service.readReviewImage(LISTING_ID, IMAGE_ID),
      404,
      ParrotSaleListingErrorCode.IMAGE_NOT_FOUND,
    );
    expect(value.storage.read).not.toHaveBeenCalled();
  });

  it('stores privately, locks the listing, then assigns the first free image slot', async () => {
    const value = context();
    value.txImages.find.mockResolvedValueOnce([image(0), image(2)]);
    const result = await value.service.addImage(
      SELLER_ID,
      LISTING_ID,
      Buffer.from('image'),
      'image/png',
    );
    expect(value.storage.save).toHaveBeenCalledWith(
      Buffer.from('image'),
      'image/png',
    );
    expect(value.txListings.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(value.txImages.create).toHaveBeenCalledWith({
      listingId: LISTING_ID,
      storageKey: STORAGE_KEY,
      position: 1,
    });
    expect(value.txListings.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      value.txImages.find.mock.invocationCallOrder[0],
    );
    expect(result.images.map((item) => item.position)).toEqual([0, 1, 2]);
  });

  it('enforces the eight-image cap under the listing lock and cleans the new file', async () => {
    const value = context();
    value.txImages.find.mockResolvedValueOnce(
      Array.from({ length: 8 }, (_unused, position) => image(position)),
    );
    await expectCode(
      value.service.addImage(SELLER_ID, LISTING_ID, Buffer.from('image')),
      409,
      ParrotSaleListingErrorCode.IMAGE_LIMIT_REACHED,
    );
    expect(value.storage.delete).toHaveBeenCalledWith(STORAGE_KEY);
    expect(value.txImages.save).not.toHaveBeenCalled();
  });

  it('does not store or mutate images for a final listing', async () => {
    const add = context(ParrotSaleListingStatus.APPROVED);
    await expectCode(
      add.service.addImage(SELLER_ID, LISTING_ID, Buffer.from('image')),
      409,
      ParrotSaleListingErrorCode.NOT_EDITABLE,
    );
    expect(add.storage.save).not.toHaveBeenCalled();

    const remove = context(ParrotSaleListingStatus.REJECTED);
    await expectCode(
      remove.service.deleteImage(SELLER_ID, LISTING_ID, IMAGE_ID),
      409,
      ParrotSaleListingErrorCode.NOT_EDITABLE,
    );
    expect(remove.txImages.remove).not.toHaveBeenCalled();
  });

  it('locks ownership before deleting an image and deletes storage after commit', async () => {
    const value = context();
    await value.service.deleteImage(SELLER_ID, LISTING_ID, IMAGE_ID);
    expect(value.txImages.findOne).toHaveBeenCalledWith({
      where: { id: IMAGE_ID, listingId: LISTING_ID },
    });
    expect(value.txImages.remove).toHaveBeenCalled();
    expect(value.storage.delete).toHaveBeenCalledWith(STORAGE_KEY);
    expect(
      value.dataSource.transaction.mock.invocationCallOrder[0],
    ).toBeLessThan(value.storage.delete.mock.invocationCallOrder[0]);
  });

  it('submits only after transaction-scoped eligibility and image rechecks', async () => {
    const value = context();
    const result = await value.service.submit(SELLER_ID, LISTING_ID);
    expect(
      value.eligibility.assertEligibleSellerInTransaction,
    ).toHaveBeenCalledWith(SELLER_ID, value.manager);
    expect(value.txImages.count).toHaveBeenCalledWith({
      where: { listingId: LISTING_ID },
    });
    expect(result.status).toBe(ParrotSaleListingStatus.PENDING_REVIEW);
  });

  it('rejects submit without an image and leaves the listing DRAFT', async () => {
    const value = context();
    value.txImages.count.mockResolvedValueOnce(0);
    await expectCode(
      value.service.submit(SELLER_ID, LISTING_ID),
      400,
      ParrotSaleListingErrorCode.INVALID_IMAGE_COUNT,
    );
    expect(value.row.status).toBe(ParrotSaleListingStatus.DRAFT);
    expect(value.txListings.save).not.toHaveBeenCalled();
  });

  it('rejects stale submit attempts after the listing leaves DRAFT', async () => {
    const value = context(ParrotSaleListingStatus.PENDING_REVIEW);
    await expectCode(
      value.service.submit(SELLER_ID, LISTING_ID),
      409,
      ParrotSaleListingErrorCode.NOT_EDITABLE,
    );
    expect(
      value.eligibility.assertEligibleSellerInTransaction,
    ).not.toHaveBeenCalled();
    expect(value.txListings.save).not.toHaveBeenCalled();
  });

  it('rejects a pending listing under lock and records the authenticated reviewer', async () => {
    const value = context(ParrotSaleListingStatus.PENDING_REVIEW);
    const result = await value.service.reject(LISTING_ID, '  pahlevan  ', {
      rejectionReason: 'Missing bird details',
      internalAdminNote: 'Call seller if resubmitted',
    });
    expect(value.txListings.findOne).toHaveBeenCalledWith({
      where: { id: LISTING_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(result).toMatchObject({
      status: ParrotSaleListingStatus.REJECTED,
      rejectionReason: 'Missing bird details',
      internalAdminNote: 'Call seller if resubmitted',
      reviewedBy: 'pahlevan',
      seller: { id: SELLER_ID },
    });
    expect(result.reviewedAt).toBeInstanceOf(Date);
    expect(value.txUsers.findOne).toHaveBeenCalledWith({
      where: { id: SELLER_ID },
    });
  });

  it.each([
    ParrotSaleListingStatus.DRAFT,
    ParrotSaleListingStatus.APPROVED,
    ParrotSaleListingStatus.REJECTED,
  ])('rejects admin rejection from immutable state %s', async (status) => {
    const value = context(status);
    await expectCode(
      value.service.reject(LISTING_ID, 'pahlevan', {
        rejectionReason: 'No',
      }),
      409,
      ParrotSaleListingErrorCode.INVALID_TRANSITION,
    );
    expect(value.txListings.save).not.toHaveBeenCalled();
  });

  it('rejects an invalid reviewer identity with a stable 400', async () => {
    const value = context(ParrotSaleListingStatus.PENDING_REVIEW);
    await expectCode(
      value.service.reject(LISTING_ID, '   ', {
        rejectionReason: 'Missing details',
      }),
      400,
      ParrotSaleListingErrorCode.INVALID_REVIEWER,
    );
    expect(value.txListings.save).not.toHaveBeenCalled();
  });
});
