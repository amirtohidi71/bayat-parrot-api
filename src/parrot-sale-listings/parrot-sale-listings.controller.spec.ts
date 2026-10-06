import { BadRequestException, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CustomerCapabilityGuard } from '../auth/guards/customer-capability.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ParrotSaleListing,
  ParrotSaleListingStatus,
} from './entities/parrot-sale-listing.entity';
import { ParrotSaleListingsController } from './parrot-sale-listings.controller';

const SELLER_ID = '123e4567-e89b-42d3-a456-426614174000';
const LISTING_ID = '223e4567-e89b-42d3-a456-426614174000';

const listing = () =>
  Object.assign(new ParrotSaleListing(), {
    id: LISTING_ID,
    sellerUserId: SELLER_ID,
    status: ParrotSaleListingStatus.DRAFT,
    name: 'Bird',
    description: null,
    species: 'Grey',
    subspecies: null,
    gender: null,
    ageStage: null,
    colors: null,
    tagPair: false,
    tagHandTame: true,
    requestedPrice: 100,
    approvedPrice: 200,
    quantity: 1,
    productId: null,
    rejectionReason: null,
    internalAdminNote: 'private',
    reviewedBy: 'admin',
    reviewedAt: new Date(),
    resubmissionOfId: null,
    images: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

describe('ParrotSaleListingsController customer routes', () => {
  const service = {
    create: jest.fn().mockImplementation(() => Promise.resolve(listing())),
    listOwn: jest.fn().mockImplementation(() => Promise.resolve([listing()])),
    getOwn: jest.fn().mockImplementation(() => Promise.resolve(listing())),
    update: jest.fn().mockImplementation(() => Promise.resolve(listing())),
    addImage: jest.fn().mockImplementation(() => Promise.resolve(listing())),
    deleteImage: jest.fn().mockImplementation(() => Promise.resolve(listing())),
    submit: jest.fn().mockImplementation(() => Promise.resolve(listing())),
    readOwnImage: jest.fn().mockResolvedValue({
      buffer: Buffer.from('webp'),
      mimeType: 'image/webp',
      size: 4,
    }),
  };
  const controller = new ParrotSaleListingsController(service as never);
  const user = { id: SELLER_ID, phone: '09120000000', role: 'customer' };

  beforeEach(() => jest.clearAllMocks());

  it('wires all customer endpoints under the guarded route', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, ParrotSaleListingsController),
    ).toBe('parrot-sale-listings');
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ParrotSaleListingsController),
    ).toEqual([JwtAuthGuard, CustomerCapabilityGuard]);
    expect(route('create')).toEqual(['/', RequestMethod.POST]);
    expect(route('listOwn')).toEqual(['/', RequestMethod.GET]);
    expect(route('getOwn')).toEqual([':id', RequestMethod.GET]);
    expect(route('readOwnImage')).toEqual([
      ':id/images/:imageId/content',
      RequestMethod.GET,
    ]);
    expect(route('update')).toEqual([':id', RequestMethod.PATCH]);
    expect(route('addImage')).toEqual([':id/images', RequestMethod.POST]);
    expect(route('deleteImage')).toEqual([
      ':id/images/:imageId',
      RequestMethod.DELETE,
    ]);
    expect(route('submit')).toEqual([':id/submit', RequestMethod.POST]);
  });

  it('uses only authenticated identity and returns the seller allowlist', async () => {
    const response = await controller.create(user, {
      name: 'Bird',
      species: 'Grey',
      requestedPrice: 100,
    });
    expect(service.create).toHaveBeenCalledWith(
      SELLER_ID,
      expect.objectContaining({ name: 'Bird' }),
    );
    expect(response).toHaveProperty('requestedPrice', 100);
    expect(response).not.toHaveProperty('sellerUserId');
    expect(response).not.toHaveProperty('approvedPrice');
    expect(response).not.toHaveProperty('internalAdminNote');
    expect(response).not.toHaveProperty('reviewedBy');
    expect(response).not.toHaveProperty('reviewedAt');
  });

  it('passes ownership identity through detail, update, image and submit actions', async () => {
    await controller.getOwn(user, LISTING_ID);
    await controller.update(user, LISTING_ID, { quantity: 2 });
    await controller.addImage(user, LISTING_ID, {
      buffer: Buffer.from('image'),
      mimetype: 'image/png',
    } as Express.Multer.File);
    await controller.deleteImage(user, LISTING_ID, 'image-id');
    await controller.readOwnImage(user, LISTING_ID, 'image-id');
    await controller.submit(user, LISTING_ID);
    expect(service.getOwn).toHaveBeenCalledWith(SELLER_ID, LISTING_ID);
    expect(service.update).toHaveBeenCalledWith(
      SELLER_ID,
      LISTING_ID,
      expect.objectContaining({ quantity: 2 }),
    );
    expect(service.addImage).toHaveBeenCalledWith(
      SELLER_ID,
      LISTING_ID,
      Buffer.from('image'),
      'image/png',
    );
    expect(service.deleteImage).toHaveBeenCalledWith(
      SELLER_ID,
      LISTING_ID,
      'image-id',
    );
    expect(service.readOwnImage).toHaveBeenCalledWith(
      SELLER_ID,
      LISTING_ID,
      'image-id',
    );
    expect(service.submit).toHaveBeenCalledWith(SELLER_ID, LISTING_ID);
  });

  it('rejects an image request without an in-memory decoded payload', async () => {
    try {
      await controller.addImage(user, LISTING_ID, undefined);
      throw new Error('Expected missing image rejection');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse();
      expect(response).toMatchObject({
        code: 'PARROT_SALE_LISTING_IMAGE_REQUIRED',
      });
    }
    expect(service.addImage).not.toHaveBeenCalled();
  });
});

function route(method: keyof ParrotSaleListingsController): [string, number] {
  const handler = ParrotSaleListingsController.prototype[method];
  return [
    (Reflect.getMetadata(PATH_METADATA, handler) as string) || '/',
    Reflect.getMetadata(METHOD_METADATA, handler) as number,
  ];
}
