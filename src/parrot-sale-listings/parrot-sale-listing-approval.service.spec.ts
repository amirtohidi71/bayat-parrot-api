/* eslint-disable @typescript-eslint/require-await -- transaction/repository mocks mirror async TypeORM APIs. */
import { HttpException } from '@nestjs/common';
import { Product, ProductStatus } from '../products/entities/product.entity';
import {
  SellerListingProductInput,
  SellerListingProductPublisherService,
} from '../products/seller-listing-product-publisher.service';
import { ProductsService } from '../products/products.service';
import { SellerEligibilityPolicy } from '../seller-onboarding/seller-eligibility.policy';
import { User, UserRole } from '../users/entities/user.entity';
import { ParrotSaleListingImage } from './entities/parrot-sale-listing-image.entity';
import {
  ParrotSaleListing,
  ParrotSaleListingStatus,
} from './entities/parrot-sale-listing.entity';
import { ParrotSaleListingApprovalService } from './parrot-sale-listing-approval.service';
import { ParrotSaleListingErrorCode } from './parrot-sale-listing.errors';

const LISTING_ID = '223e4567-e89b-42d3-a456-426614174000';
const SELLER_ID = '123e4567-e89b-42d3-a456-426614174000';
const PRODUCT_ID = '423e4567-e89b-42d3-a456-426614174000';

function listing() {
  return Object.assign(new ParrotSaleListing(), {
    id: LISTING_ID,
    sellerUserId: SELLER_ID,
    status: ParrotSaleListingStatus.PENDING_REVIEW,
    name: 'Grey parrot',
    description: 'Healthy bird',
    species: 'African Grey',
    subspecies: 'Congo',
    gender: null,
    ageStage: null,
    colors: ['grey'],
    tagPair: false,
    tagHandTame: true,
    requestedPrice: 100,
    approvedPrice: null,
    quantity: 1,
    productId: null,
    rejectionReason: null,
    internalAdminNote: 'private review note',
    reviewedBy: null,
    reviewedAt: null,
  });
}

function context() {
  const row = listing();
  const image = Object.assign(new ParrotSaleListingImage(), {
    id: '323e4567-e89b-42d3-a456-426614174000',
    listingId: LISTING_ID,
    storageKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    position: 0,
  });
  const seller = Object.assign(new User(), {
    id: SELLER_ID,
    role: UserRole.CUSTOMER,
    isActive: true,
    phoneVerifiedAt: new Date(),
  });
  const product = Object.assign(new Product(), {
    id: PRODUCT_ID,
    sku: 'BP140507170001',
    name: row.name,
    price: 120,
    stock: row.quantity,
    status: ProductStatus.PUBLISHED,
    isSellerListing: true,
    colorVariants: null,
    tagHealthGuarantee: false,
    tagFastShipping: false,
    tagFreeShipping: false,
    tagCarryCage: false,
    images: ['/uploads/parrot-sale-listings/public.webp'],
    boughtTogetherProductIds: [],
  });
  const txListings = {
    findOne: jest.fn(async () => row),
    save: jest.fn(async (value: ParrotSaleListing) => value),
  };
  const txImages = { find: jest.fn().mockResolvedValue([image]) };
  const txUsers = { findOne: jest.fn().mockResolvedValue(seller) };
  const manager = {
    getRepository: jest.fn((target: unknown) => {
      if (target === ParrotSaleListing) return txListings;
      if (target === ParrotSaleListingImage) return txImages;
      if (target === User) return txUsers;
      throw new Error('Unexpected repository');
    }),
  };
  let transactionQueue: Promise<unknown> = Promise.resolve();
  const dataSource = {
    transaction: jest.fn(
      (callback: (value: typeof manager) => Promise<unknown>) => {
        const result = transactionQueue.then(() => callback(manager));
        transactionQueue = result.catch(() => undefined);
        return result;
      },
    ),
  };
  const eligibility = {
    assertEligibleSellerInTransaction: jest.fn().mockResolvedValue(seller),
  };
  const privateImages = {
    read: jest.fn().mockResolvedValue({
      buffer: Buffer.from('sanitized-webp'),
      mimeType: 'image/webp',
      size: 14,
    }),
  };
  const publicImages = {
    publish: jest
      .fn()
      .mockResolvedValue(['/uploads/parrot-sale-listings/public.webp']),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  let capturedProductInput: SellerListingProductInput | undefined;
  const products = {
    create: jest.fn(
      async (_manager: unknown, input: SellerListingProductInput) => {
        capturedProductInput = input;
        return product;
      },
    ),
    republish: jest.fn(
      async (
        _manager: unknown,
        _productId: string,
        input: SellerListingProductInput,
      ) => {
        capturedProductInput = input;
        return {
          product,
          replacedImages: ['/uploads/parrot-sale-listings/old.webp'],
        };
      },
    ),
  };
  const service = new ParrotSaleListingApprovalService(
    dataSource as never,
    eligibility as unknown as SellerEligibilityPolicy,
    privateImages as never,
    publicImages as never,
    products as unknown as SellerListingProductPublisherService,
  );
  return {
    service,
    row,
    manager,
    txListings,
    txImages,
    eligibility,
    privateImages,
    publicImages,
    products,
    getCapturedProductInput: () => capturedProductInput,
  };
}

async function expectCode(
  action: Promise<unknown>,
  status: number,
  code: string,
) {
  try {
    await action;
    throw new Error('Expected approval to fail');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HttpException);
    const exception = error as HttpException;
    expect(exception.getStatus()).toBe(status);
    expect(exception.getResponse()).toMatchObject({ code });
  }
}

describe('ParrotSaleListingApprovalService', () => {
  it('locks, rechecks eligibility, publishes images, creates one product, and links the listing', async () => {
    const value = context();
    const result = await value.service.approve(LISTING_ID, ' owner ', {
      publicPrice: 120,
    });

    expect(value.txListings.findOne).toHaveBeenCalledWith({
      where: { id: LISTING_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(
      value.eligibility.assertEligibleSellerInTransaction,
    ).toHaveBeenCalledWith(SELLER_ID, value.manager);
    expect(value.privateImages.read).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    );
    expect(value.products.create).toHaveBeenCalledWith(
      value.manager,
      expect.objectContaining({
        publicPrice: 120,
        quantity: 1,
        images: ['/uploads/parrot-sale-listings/public.webp'],
      }),
    );
    const productInput = value.getCapturedProductInput();
    expect(productInput).not.toHaveProperty('sellerUserId');
    expect(productInput).not.toHaveProperty('requestedPrice');
    expect(productInput).not.toHaveProperty('internalAdminNote');
    expect(value.row).toMatchObject({
      status: ParrotSaleListingStatus.APPROVED,
      productId: PRODUCT_ID,
      approvedPrice: 120,
      reviewedBy: 'owner',
    });
    expect(result.product).toMatchObject({
      id: PRODUCT_ID,
      price: 120,
      stock: 1,
      status: ProductStatus.PUBLISHED,
      isSellerListing: true,
      tagHealthGuarantee: false,
      tagFastShipping: false,
      tagFreeShipping: false,
      tagCarryCage: false,
    });
    expect(value.publicImages.remove).not.toHaveBeenCalled();
  });

  it('rejects a public price below the private requested price before publication', async () => {
    const value = context();
    await expectCode(
      value.service.approve(LISTING_ID, 'owner', { publicPrice: 99 }),
      400,
      ParrotSaleListingErrorCode.PRICE_BELOW_REQUESTED,
    );
    expect(value.publicImages.publish).not.toHaveBeenCalled();
    expect(value.products.create).not.toHaveBeenCalled();
  });

  it('never approves a listing deleted by its owner', async () => {
    const value = context();
    value.row.status = ParrotSaleListingStatus.DELETED_BY_USER;
    await expectCode(
      value.service.approve(LISTING_ID, 'owner', { publicPrice: 120 }),
      409,
      ParrotSaleListingErrorCode.INVALID_TRANSITION,
    );
    expect(value.products.create).not.toHaveBeenCalled();
    expect(value.products.republish).not.toHaveBeenCalled();
  });

  it('never publishes a private image that fails the safe read validation', async () => {
    const value = context();
    value.privateImages.read.mockRejectedValueOnce(
      new Error('private image validation failed'),
    );
    await expect(
      value.service.approve(LISTING_ID, 'owner', { publicPrice: 120 }),
    ).rejects.toThrow('private image validation failed');
    expect(value.publicImages.publish).not.toHaveBeenCalled();
    expect(value.products.create).not.toHaveBeenCalled();
  });

  it('removes newly published copies when the database transaction fails', async () => {
    const value = context();
    value.txListings.save.mockRejectedValueOnce(
      new Error('transaction failed'),
    );
    await expect(
      value.service.approve(LISTING_ID, 'owner', { publicPrice: 120 }),
    ).rejects.toThrow('transaction failed');
    expect(value.publicImages.remove).toHaveBeenCalledWith([
      '/uploads/parrot-sale-listings/public.webp',
    ]);
  });

  it('serializes concurrent approvals so only one product is created', async () => {
    const value = context();
    const results = await Promise.allSettled([
      value.service.approve(LISTING_ID, 'owner', { publicPrice: 120 }),
      value.service.approve(LISTING_ID, 'owner', { publicPrice: 120 }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(value.products.create).toHaveBeenCalledTimes(1);
    expect(value.publicImages.publish).toHaveBeenCalledTimes(1);
    expect(value.row.productId).toBe(PRODUCT_ID);
  });

  it('reuses and republishes the linked Product after an approved listing edit', async () => {
    const value = context();
    value.row.productId = PRODUCT_ID;
    const result = await value.service.approve(LISTING_ID, 'owner', {
      publicPrice: 130,
    });
    expect(value.products.republish).toHaveBeenCalledWith(
      value.manager,
      PRODUCT_ID,
      expect.objectContaining({ publicPrice: 130 }),
    );
    expect(value.products.create).not.toHaveBeenCalled();
    expect(result.listing).toMatchObject({
      productId: PRODUCT_ID,
      status: ParrotSaleListingStatus.APPROVED,
      approvedPrice: 130,
    });
    expect(value.publicImages.remove).toHaveBeenCalledWith([
      '/uploads/parrot-sale-listings/old.webp',
    ]);
  });
});

describe('ProductsService seller-listing product helper', () => {
  it('uses the caller transaction, SKU advisory lock, and public-only product fields', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const getRawOne = jest.fn().mockResolvedValue({ max: '3' });
    const repository = {
      query,
      createQueryBuilder: jest.fn(() => ({
        withDeleted: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne,
      })),
      create: jest.fn((input: Partial<Product>) =>
        Object.assign(new Product(), input),
      ),
      save: jest.fn(async (input: Product) => input),
    };
    const manager = { getRepository: jest.fn(() => repository) };
    const service = new SellerListingProductPublisherService();

    const product = await service.create(manager as never, {
      name: 'Bird',
      description: null,
      publicPrice: 120,
      quantity: 1,
      species: 'Grey',
      subspecies: null,
      gender: null,
      ageStage: null,
      colors: null,
      tagPair: false,
      tagHandTame: true,
      images: ['/uploads/parrot-sale-listings/image.webp'],
    });

    expect(query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [expect.stringMatching(/^BP\d{8}$/)],
    );
    expect(product).toMatchObject({
      categorySlug: 'buy-parrot',
      status: ProductStatus.PUBLISHED,
      stock: 1,
      price: 120,
      isSellerListing: true,
      colorVariants: null,
      tagHealthGuarantee: false,
      tagFastShipping: false,
      tagFreeShipping: false,
      tagCarryCage: false,
      images: ['/uploads/parrot-sale-listings/image.webp'],
    });
    expect(product.stock).toBeGreaterThan(0);
    expect(product).not.toHaveProperty('sellerUserId');
    expect(product).not.toHaveProperty('requestedPrice');
    expect(product).not.toHaveProperty('internalAdminNote');
  });

  it('locks and republishes an existing linked seller Product without changing its identity', async () => {
    const product = Object.assign(new Product(), {
      id: PRODUCT_ID,
      sku: 'BP140507170001',
      status: ProductStatus.DRAFT,
      isSellerListing: true,
      images: ['/uploads/parrot-sale-listings/old.webp'],
    });
    const repository = {
      findOne: jest.fn().mockResolvedValue(product),
      save: jest.fn(async (value: Product) => value),
    };
    const manager = { getRepository: jest.fn(() => repository) };
    const service = new SellerListingProductPublisherService();
    const result = await service.republish(manager as never, PRODUCT_ID, {
      name: 'Updated bird',
      description: null,
      publicPrice: 140,
      quantity: 2,
      species: 'Grey',
      subspecies: null,
      gender: null,
      ageStage: null,
      colors: null,
      tagPair: false,
      tagHandTame: true,
      images: ['/uploads/parrot-sale-listings/new.webp'],
    });
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(result.replacedImages).toEqual([
      '/uploads/parrot-sale-listings/old.webp',
    ]);
    expect(result.product).toMatchObject({
      id: PRODUCT_ID,
      sku: 'BP140507170001',
      name: 'Updated bird',
      price: 140,
      stock: 2,
      status: ProductStatus.PUBLISHED,
    });
  });

  it('returns every field used by the normal public price and shipping card', async () => {
    const product = Object.assign(new Product(), {
      id: PRODUCT_ID,
      sku: 'BP140507170001',
      name: 'Bird',
      price: 120,
      stock: 1,
      status: ProductStatus.PUBLISHED,
      isSellerListing: true,
      colorVariants: null,
      tagHealthGuarantee: false,
      tagFastShipping: false,
      tagFreeShipping: false,
      tagCarryCage: false,
      images: ['/uploads/parrot-sale-listings/image.webp'],
      boughtTogetherProductIds: [],
    });
    const repository = { findOne: jest.fn().mockResolvedValue(product) };
    const service = new ProductsService(
      repository as never,
      {} as never,
      {} as never,
    );

    const publicProduct = await service.findOnePublished(PRODUCT_ID);

    expect(publicProduct).toMatchObject({
      id: PRODUCT_ID,
      name: 'Bird',
      price: 120,
      stock: 1,
      status: ProductStatus.PUBLISHED,
      isSellerListing: true,
      colorVariants: null,
      tagHealthGuarantee: false,
      tagFastShipping: false,
      tagFreeShipping: false,
      tagCarryCage: false,
      images: ['/uploads/parrot-sale-listings/image.webp'],
      boughtTogetherProducts: [],
    });
    expect(publicProduct).not.toHaveProperty('sellerUserId');
    expect(publicProduct).not.toHaveProperty('requestedPrice');
    expect(publicProduct).not.toHaveProperty('internalAdminNote');
  });
});
