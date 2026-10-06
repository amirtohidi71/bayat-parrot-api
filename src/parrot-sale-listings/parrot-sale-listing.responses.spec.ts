import { Product, ProductStatus } from '../products/entities/product.entity';
import { UserRole } from '../users/entities/user.entity';
import { ParrotSaleListingImage } from './entities/parrot-sale-listing-image.entity';
import {
  ParrotSaleListing,
  ParrotSaleListingStatus,
} from './entities/parrot-sale-listing.entity';
import {
  parrotSaleListingGodAdminDetailResponse,
  parrotSaleListingGodAdminSummaryResponse,
} from './parrot-sale-listing.responses';

describe('Parrot sale listing God Admin response contract', () => {
  it('allowlists review detail, safe image metadata and linked Product summary', () => {
    const listing = Object.assign(new ParrotSaleListing(), {
      id: '223e4567-e89b-42d3-a456-426614174000',
      sellerUserId: '123e4567-e89b-42d3-a456-426614174000',
      seller: {
        id: '123e4567-e89b-42d3-a456-426614174000',
        phone: '09120000000',
        firstName: 'Seller',
        lastName: 'Bird',
        role: UserRole.BREEDER,
        profileCompleted: true,
        passwordHash: 'never-return',
      },
      status: ParrotSaleListingStatus.APPROVED,
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
      approvedPrice: 120,
      quantity: 1,
      productId: '323e4567-e89b-42d3-a456-426614174000',
      product: Object.assign(new Product(), {
        id: '323e4567-e89b-42d3-a456-426614174000',
        sku: 'BP-1',
        name: 'Grey parrot',
        price: 120,
        stock: 1,
        status: ProductStatus.PUBLISHED,
        isSellerListing: true,
        description: 'not-required-in-review-result',
      }),
      rejectionReason: null,
      internalAdminNote: 'owner-visible-note',
      reviewedBy: 'owner',
      reviewedAt: new Date('2026-10-05T00:00:00Z'),
      resubmissionOfId: null,
      images: [
        Object.assign(new ParrotSaleListingImage(), {
          id: '423e4567-e89b-42d3-a456-426614174000',
          position: 0,
          storageKey: 'never-return.webp',
        }),
      ],
      createdAt: new Date('2026-10-04T00:00:00Z'),
      updatedAt: new Date('2026-10-05T00:00:00Z'),
    });

    const response = parrotSaleListingGodAdminDetailResponse(listing);
    expect(response.images).toEqual([
      { id: '423e4567-e89b-42d3-a456-426614174000', position: 0 },
    ]);
    expect(response.linkedProduct).toEqual({
      id: listing.product.id,
      sku: 'BP-1',
      name: 'Grey parrot',
      price: 120,
      stock: 1,
      status: ProductStatus.PUBLISHED,
      isSellerListing: true,
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('storageKey');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('not-required-in-review-result');

    const summary = parrotSaleListingGodAdminSummaryResponse(listing);
    expect(Object.keys(summary).sort()).toEqual([
      'createdAt',
      'id',
      'imageCount',
      'quantity',
      'requestedPrice',
      'seller',
      'species',
      'status',
      'subspecies',
      'title',
    ]);
    expect(Object.keys(summary.seller).sort()).toEqual([
      'firstName',
      'id',
      'lastName',
      'phone',
      'role',
    ]);
    expect(JSON.stringify(summary)).not.toContain('storageKey');
    expect(JSON.stringify(summary)).not.toContain('internalAdminNote');
  });

  it('returns a null linked result before approval', () => {
    const listing = Object.assign(new ParrotSaleListing(), {
      seller: {
        id: '123e4567-e89b-42d3-a456-426614174000',
        phone: '09120000000',
        firstName: null,
        lastName: null,
        role: UserRole.CUSTOMER,
        profileCompleted: true,
      },
      images: [],
      product: null,
    });
    expect(
      parrotSaleListingGodAdminDetailResponse(listing).linkedProduct,
    ).toBeNull();
  });
});
