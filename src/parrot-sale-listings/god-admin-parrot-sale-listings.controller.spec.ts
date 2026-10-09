import { ForbiddenException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { GodAdminAuthGuard } from '../admin/guards/god-admin-auth.guard';
import { Product, ProductStatus } from '../products/entities/product.entity';
import { GodAdminParrotSaleListingsController } from './god-admin-parrot-sale-listings.controller';
import {
  ParrotSaleListing,
  ParrotSaleListingStatus,
} from './entities/parrot-sale-listing.entity';

describe('GodAdminParrotSaleListingsController', () => {
  it('exposes owner approval and private image routes', async () => {
    const listing = Object.assign(new ParrotSaleListing(), {
      id: '223e4567-e89b-42d3-a456-426614174000',
      status: ParrotSaleListingStatus.PENDING_REVIEW,
      name: 'Grey parrot',
      species: 'African Grey',
      subspecies: null,
      quantity: 1,
      requestedPrice: 100,
      createdAt: new Date('2026-10-05T00:00:00Z'),
      images: [],
      seller: {
        id: 'seller',
        phone: '09120000000',
        firstName: null,
        lastName: null,
        role: 'customer',
        profileCompleted: true,
      },
    });
    const product = Object.assign(new Product(), {
      id: '323e4567-e89b-42d3-a456-426614174000',
      sku: 'BP-1',
      name: 'Published bird',
      price: 120,
      stock: 1,
      status: ProductStatus.PUBLISHED,
      isSellerListing: true,
    });
    listing.product = product;
    const approval = {
      approve: jest.fn().mockResolvedValue({ listing, product }),
    };
    const listings = {
      listForGodAdmin: jest.fn().mockResolvedValue([listing]),
      getForGodAdmin: jest.fn().mockResolvedValue(listing),
      readReviewImage: jest.fn().mockResolvedValue({
        buffer: Buffer.from('webp'),
        mimeType: 'image/webp',
        size: 4,
      }),
    };
    const controller = new GodAdminParrotSaleListingsController(
      approval as never,
      listings as never,
    );
    const approvalResponse = await controller.approve(
      listing.id,
      { publicPrice: 120 },
      {
        godAdmin: {
          scope: 'god-admin-panel',
          role: 'owner',
          username: 'owner',
        },
      },
    );
    expect(approval.approve).toHaveBeenCalledWith(listing.id, 'owner', {
      publicPrice: 120,
    });
    expect(approvalResponse.product).toEqual({
      id: product.id,
      sku: product.sku,
      name: product.name,
      price: product.price,
      stock: product.stock,
      status: product.status,
      isSellerListing: true,
    });
    await controller.readReviewImage(listing.id, listing.id);
    expect(listings.readReviewImage).toHaveBeenCalledWith(
      listing.id,
      listing.id,
    );
    const summaries = await controller.list({});
    expect(listings.listForGodAdmin).toHaveBeenCalledWith(
      ParrotSaleListingStatus.PENDING_REVIEW,
    );
    expect(summaries[0]).toMatchObject({
      id: listing.id,
      title: listing.name,
      imageCount: 0,
    });
    await controller.list({ status: ParrotSaleListingStatus.APPROVED });
    expect(listings.listForGodAdmin).toHaveBeenLastCalledWith(
      ParrotSaleListingStatus.APPROVED,
    );
    const detail = await controller.detail(listing.id);
    expect(listings.getForGodAdmin).toHaveBeenCalledWith(listing.id);
    expect(detail.linkedProduct).toEqual({
      id: product.id,
      sku: product.sku,
      name: product.name,
      price: product.price,
      stock: product.stock,
      status: product.status,
      isSellerListing: true,
    });
    expect(JSON.stringify(detail)).not.toContain('storageKey');
    expect(
      Reflect.getMetadata(PATH_METADATA, GodAdminParrotSaleListingsController),
    ).toBe('god-admin-panel/parrot-sale-listings');
    const guards = Reflect.getMetadata(
      '__guards__',
      GodAdminParrotSaleListingsController,
    ) as unknown;
    expect(guards).toEqual([GodAdminAuthGuard]);
    const prototype =
      GodAdminParrotSaleListingsController.prototype as unknown as Record<
        string,
        unknown
      >;
    expect(Reflect.getMetadata(PATH_METADATA, prototype.approve)).toBe(
      ':id/approve',
    );
    expect(Reflect.getMetadata(PATH_METADATA, prototype.readReviewImage)).toBe(
      ':id/images/:imageId/content',
    );
    expect(Reflect.getMetadata(PATH_METADATA, prototype.detail)).toBe(':id');
    expect(Reflect.getMetadata(PATH_METADATA, prototype.list)).toBe('/');
    expect(
      Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        controller.constructor,
        'approve',
      ),
    ).toBeDefined();
  });

  it('rejects a regular admin token through the real owner guard', () => {
    const jwt = {
      verify: jest.fn().mockReturnValue({
        scope: 'admin-panel',
        username: 'regular-admin',
      }),
    };
    const guard = new GodAdminAuthGuard(jwt as never);
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: 'Bearer regular-admin-token' },
        }),
      }),
    };
    expect(() => guard.canActivate(context as never)).toThrow(
      ForbiddenException,
    );
  });
});
