import {
  BadRequestException,
  HttpException,
  ValidationPipe,
} from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import {
  Product,
  ProductAgeStage,
  ProductGender,
} from '../products/entities/product.entity';
import {
  ApproveParrotSaleListingDto,
  CreateParrotSaleListingDto,
  PARROT_SALE_LISTING_PAIR_GENDER,
  RejectParrotSaleListingDto,
  UpdateParrotSaleListingDto,
} from './dto/parrot-sale-listing.dto';
import { ParrotSaleListingImage } from './entities/parrot-sale-listing-image.entity';
import {
  ParrotSaleListing,
  ParrotSaleListingStatus,
} from './entities/parrot-sale-listing.entity';
import {
  PARROT_SALE_LISTING_MAX_IMAGES,
  PARROT_SALE_LISTING_MAX_QUANTITY,
  PARROT_SALE_LISTING_MIN_IMAGES,
  PARROT_SALE_LISTING_MIN_QUANTITY,
} from './parrot-sale-listing.constants';
import {
  parrotSaleListingAdminResponse,
  parrotSaleListingSellerResponse,
} from './parrot-sale-listing.responses';
import { assertParrotSaleListingImageCount } from './parrot-sale-listing.validation';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

const transform = async <T extends object>(
  metatype: new () => T,
  value: Record<string, unknown>,
): Promise<T> => {
  const result: unknown = await pipe.transform(value, {
    type: 'body',
    metatype,
  });
  return result as T;
};

const validCreate = () => ({
  name: ' کاسکو سخنگو ',
  description: ' پرنده سالم ',
  species: ' African Grey ',
  subspecies: ' Congo ',
  gender: ProductGender.UNKNOWN,
  ageStage: ProductAgeStage.DANE_KHOR,
  colors: [' خاکستری ', 'قرمز'],
  tagPair: false,
  tagHandTame: true,
  requestedPrice: '12500000.50',
  quantity: '1',
});

describe('parrot sale listing schema and DTO contracts', () => {
  it('keeps both SQL-owned entities out of TypeORM synchronization', () => {
    const tables = getMetadataArgsStorage().tables;
    expect(tables.find((table) => table.target === ParrotSaleListing)).toEqual(
      expect.objectContaining({
        name: 'parrot_sale_listings',
        synchronize: false,
      }),
    );
    expect(
      tables.find((table) => table.target === ParrotSaleListingImage),
    ).toEqual(
      expect.objectContaining({
        name: 'parrot_sale_listing_images',
        synchronize: false,
      }),
    );
  });

  it('uses the exact migration-owned enum names', () => {
    const columns = getMetadataArgsStorage().columns.filter(
      (column) => column.target === ParrotSaleListing,
    );
    const optionFor = (propertyName: string) =>
      columns.find((column) => column.propertyName === propertyName)?.options;
    expect(optionFor('status')?.enumName).toBe(
      'parrot_sale_listings_status_enum',
    );
    expect(optionFor('gender')?.enumName).toBe(
      'parrot_sale_listings_gender_enum',
    );
    expect(optionFor('ageStage')?.enumName).toBe(
      'parrot_sale_listings_age_stage_enum',
    );
  });

  it('defines the approved state and bounded quantity/image contracts', () => {
    expect(Object.values(ParrotSaleListingStatus)).toEqual([
      'DRAFT',
      'PENDING_REVIEW',
      'APPROVED',
      'REJECTED',
      'DELETED_BY_USER',
    ]);
    expect(PARROT_SALE_LISTING_MIN_IMAGES).toBe(1);
    expect(PARROT_SALE_LISTING_MAX_IMAGES).toBe(8);
    expect(PARROT_SALE_LISTING_MIN_QUANTITY).toBe(1);
    expect(PARROT_SALE_LISTING_MAX_QUANTITY).toBe(100);
    expect(() => assertParrotSaleListingImageCount(1)).not.toThrow();
    expect(() => assertParrotSaleListingImageCount(8)).not.toThrow();
    expect(() => assertParrotSaleListingImageCount(0)).toThrow(HttpException);
    expect(() => assertParrotSaleListingImageCount(9)).toThrow(HttpException);
  });

  it('normalizes a valid seller candidate without accepting workflow fields', async () => {
    const result = await transform(CreateParrotSaleListingDto, validCreate());
    expect(result).toMatchObject({
      name: 'کاسکو سخنگو',
      description: 'پرنده سالم',
      species: 'African Grey',
      subspecies: 'Congo',
      colors: ['خاکستری', 'قرمز'],
      requestedPrice: 12500000.5,
      quantity: 1,
    });
    await expect(
      transform(CreateParrotSaleListingDto, {
        ...validCreate(),
        status: ParrotSaleListingStatus.APPROVED,
        sellerUserId: '123e4567-e89b-42d3-a456-426614174000',
        productId: '123e4567-e89b-42d3-a456-426614174000',
        resubmissionOfId: '123e4567-e89b-42d3-a456-426614174000',
        approvedPrice: 20,
        reviewedBy: 'admin',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts pair as a listing-only gender selection', async () => {
    await expect(
      transform(CreateParrotSaleListingDto, {
        ...validCreate(),
        gender: PARROT_SALE_LISTING_PAIR_GENDER,
      }),
    ).resolves.toMatchObject({ gender: PARROT_SALE_LISTING_PAIR_GENDER });
    await expect(
      transform(UpdateParrotSaleListingDto, {
        gender: PARROT_SALE_LISTING_PAIR_GENDER,
      }),
    ).resolves.toMatchObject({ gender: PARROT_SALE_LISTING_PAIR_GENDER });
  });

  it.each([
    ['', 1],
    ['   ', 1],
    [true, 1],
    [1, 0],
    [1, 101],
    [1, 1.5],
    ['1e2', 1],
    ['12abc', 1],
  ])('rejects invalid money %p or quantity %p', async (price, quantity) => {
    await expect(
      transform(CreateParrotSaleListingDto, {
        ...validCreate(),
        requestedPrice: price,
        quantity,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps approval and rejection DTOs narrowly allowlisted', async () => {
    await expect(
      transform(ApproveParrotSaleListingDto, {
        publicPrice: '14000000.00',
      }),
    ).resolves.toMatchObject({ publicPrice: 14000000 });
    await expect(
      transform(ApproveParrotSaleListingDto, {
        approvedPrice: '14000000.00',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      transform(ApproveParrotSaleListingDto, {
        publicPrice: '14000000.00',
        status: ParrotSaleListingStatus.APPROVED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      transform(RejectParrotSaleListingDto, {
        rejectionReason: '  اطلاعات کافی نیست  ',
      }),
    ).resolves.toMatchObject({ rejectionReason: 'اطلاعات کافی نیست' });
  });

  it('keeps private review data out of the seller response allowlist', () => {
    const listing = Object.assign(new ParrotSaleListing(), {
      id: 'listing-id',
      sellerUserId: 'seller-id',
      seller: {
        id: 'seller-id',
        phone: '09120000000',
        firstName: 'Seller',
        lastName: 'Bird',
        role: 'customer',
        profileCompleted: true,
      },
      status: ParrotSaleListingStatus.REJECTED,
      name: 'bird',
      description: null,
      species: 'grey',
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
      rejectionReason: 'reason',
      internalAdminNote: 'private',
      reviewedBy: 'admin',
      reviewedAt: new Date('2026-10-03T00:00:00Z'),
      resubmissionOfId: null,
      images: [
        Object.assign(new ParrotSaleListingImage(), {
          id: 'image-b',
          storageKey: 'private-b.webp',
          position: 1,
        }),
        Object.assign(new ParrotSaleListingImage(), {
          id: 'image-a',
          storageKey: 'private-a.webp',
          position: 0,
        }),
      ],
      createdAt: new Date('2026-10-03T00:00:00Z'),
      updatedAt: new Date('2026-10-03T00:00:00Z'),
    });
    const seller = parrotSaleListingSellerResponse(listing);
    expect(seller.images).toEqual([
      { id: 'image-a', position: 0 },
      { id: 'image-b', position: 1 },
    ]);
    expect(seller).not.toHaveProperty('sellerUserId');
    expect(seller).not.toHaveProperty('approvedPrice');
    expect(seller).not.toHaveProperty('internalAdminNote');
    expect(seller).not.toHaveProperty('reviewedBy');
    expect(seller).not.toHaveProperty('reviewedAt');
    expect(JSON.stringify(seller)).not.toContain('private-a.webp');
    expect(parrotSaleListingAdminResponse(listing)).toMatchObject({
      sellerUserId: 'seller-id',
      seller: {
        id: 'seller-id',
        phone: '09120000000',
        firstName: 'Seller',
        lastName: 'Bird',
        role: 'customer',
        profileCompleted: true,
      },
      requestedPrice: 100,
      internalAdminNote: 'private',
      reviewedBy: 'admin',
    });

    const metadata = getMetadataArgsStorage();
    const productColumns = metadata.columns
      .filter((column) => column.target === Product)
      .map((column) => column.propertyName);
    expect(productColumns).not.toEqual(
      expect.arrayContaining([
        'sellerUserId',
        'requestedPrice',
        'approvedPrice',
        'internalAdminNote',
        'reviewedBy',
      ]),
    );
    expect(productColumns).toContain('isSellerListing');
  });

  it('defines a guarded, public-schema migration and rollback', () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        'scripts/migrations/20261003-create-parrot-sale-listings-v1.sql',
      ),
      'utf8',
    );
    const rollback = readFileSync(
      join(
        process.cwd(),
        'scripts/migrations/20261003-rollback-parrot-sale-listings-v1.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('CREATE TABLE public.parrot_sale_listings');
    expect(migration).toContain(
      'CREATE TABLE public.parrot_sale_listing_images',
    );
    expect(migration).toContain('position BETWEEN 0 AND 7');
    expect(migration).toContain('quantity BETWEEN 1 AND 100');
    expect(migration).toContain(
      'ADD COLUMN "isSellerListing" boolean NOT NULL DEFAULT false',
    );
    expect(migration).toContain(
      'CONSTRAINT "UQ_parrot_sale_listing_images_position"',
    );
    expect(migration).toContain(
      "RAISE EXCEPTION 'Parrot sale listings migration is already or partially applied'",
    );
    expect(rollback).toContain(
      "RAISE EXCEPTION 'Rollback refused: parrot sale listing history exists'",
    );
    expect(rollback).toContain('DROP TABLE public.parrot_sale_listing_images');
    expect(rollback).toContain(
      'ALTER TABLE public.products DROP COLUMN "isSellerListing"',
    );
    expect(rollback).not.toContain('CASCADE');
  });

  it('defines the guarded lifecycle migration and refuses destructive rollback', () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        'scripts/migrations/20261009-add-parrot-sale-listing-lifecycle-v1.sql',
      ),
      'utf8',
    );
    const rollback = readFileSync(
      join(
        process.cwd(),
        'scripts/migrations/20261009-rollback-parrot-sale-listing-lifecycle-v1.sql',
      ),
      'utf8',
    );
    expect(migration).toContain("ADD VALUE 'DELETED_BY_USER'");
    expect(migration).toContain('ADD COLUMN "revokedAt" timestamptz');
    expect(migration).toContain('CHK_seller_verifications_revocation');
    expect(migration).toContain("status = 'PENDING_REVIEW'");
    expect(migration).toContain(
      `status = 'REJECTED'
      AND "approvedPrice" IS NULL
      AND length(btrim("rejectionReason")) > 0`,
    );
    expect(migration).toContain(
      `status = 'DELETED_BY_USER'
      AND ("approvedPrice" IS NULL OR "productId" IS NOT NULL)`,
    );
    expect(rollback).toContain(
      'Rollback refused: listing lifecycle or seller revocation history exists',
    );
    expect(rollback).toContain("status IN ('PENDING_REVIEW', 'REJECTED')");
    expect(rollback).not.toContain('CASCADE');
  });
});
