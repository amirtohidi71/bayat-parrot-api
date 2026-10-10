import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SellerListingProductPublisherService } from '../products/seller-listing-product-publisher.service';
import { SellerEligibilityPolicy } from '../seller-onboarding/seller-eligibility.policy';
import { User } from '../users/entities/user.entity';
import { ApproveParrotSaleListingDto } from './dto/parrot-sale-listing.dto';
import { ParrotSaleListingImage } from './entities/parrot-sale-listing-image.entity';
import {
  ParrotSaleListing,
  ParrotSaleListingStatus,
} from './entities/parrot-sale-listing.entity';
import { ParrotSaleListingImageStorageService } from './images/parrot-sale-listing-image-storage.service';
import { ParrotSaleListingPublicImageService } from './images/parrot-sale-listing-public-image.service';
import {
  PARROT_SALE_LISTING_MAX_QUANTITY,
  PARROT_SALE_LISTING_MIN_QUANTITY,
} from './parrot-sale-listing.constants';
import {
  ParrotSaleListingErrorCode,
  parrotSaleListingError,
} from './parrot-sale-listing.errors';
import { assertParrotSaleListingImageCount } from './parrot-sale-listing.validation';

@Injectable()
export class ParrotSaleListingApprovalService {
  private readonly logger = new Logger(ParrotSaleListingApprovalService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly eligibility: SellerEligibilityPolicy,
    private readonly privateImages: ParrotSaleListingImageStorageService,
    private readonly publicImages: ParrotSaleListingPublicImageService,
    private readonly products: SellerListingProductPublisherService,
  ) {}

  async approve(
    id: string,
    reviewer: string,
    input: ApproveParrotSaleListingDto,
  ) {
    const publishedPaths: string[] = [];
    let replacedPaths: string[] = [];
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const listings = manager.getRepository(ParrotSaleListing);
        const listing = await listings.findOne({
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!listing)
          throw parrotSaleListingError(
            HttpStatus.NOT_FOUND,
            ParrotSaleListingErrorCode.NOT_FOUND,
            'Parrot sale listing not found',
          );
        if (listing.status !== ParrotSaleListingStatus.PENDING_REVIEW)
          throw parrotSaleListingError(
            HttpStatus.CONFLICT,
            ParrotSaleListingErrorCode.INVALID_TRANSITION,
            'Only pending parrot sale listings can be approved',
          );

        const requestedPrice = Number(listing.requestedPrice);
        if (
          !Number.isFinite(requestedPrice) ||
          input.publicPrice < requestedPrice
        )
          throw parrotSaleListingError(
            HttpStatus.BAD_REQUEST,
            ParrotSaleListingErrorCode.PRICE_BELOW_REQUESTED,
            'Public price must be at least the seller requested price',
          );
        if (
          !Number.isInteger(listing.quantity) ||
          listing.quantity < PARROT_SALE_LISTING_MIN_QUANTITY ||
          listing.quantity > PARROT_SALE_LISTING_MAX_QUANTITY
        )
          throw parrotSaleListingError(
            HttpStatus.CONFLICT,
            ParrotSaleListingErrorCode.PUBLICATION_CONFLICT,
            'Parrot sale listing quantity is invalid',
          );

        await this.eligibility.assertEligibleSellerInTransaction(
          listing.sellerUserId,
          manager,
        );
        const images = await manager
          .getRepository(ParrotSaleListingImage)
          .find({
            where: { listingId: listing.id },
            order: { position: 'ASC' },
          });
        assertParrotSaleListingImageCount(images.length);
        const privateFiles = await Promise.all(
          images.map((image) => this.privateImages.read(image.storageKey)),
        );
        publishedPaths.push(
          ...(await this.publicImages.publish(
            privateFiles.map((image) => image.buffer),
          )),
        );

        const reviewedBy = this.reviewer(reviewer);
        const productInput = {
          name: listing.name,
          description: listing.description,
          publicPrice: input.publicPrice,
          quantity: listing.quantity,
          species: listing.species,
          subspecies: listing.subspecies,
          gender: listing.gender,
          ageStage: listing.ageStage,
          colors: listing.colors,
          tagPair: listing.tagPair,
          tagHandTame: listing.tagHandTame,
          images: publishedPaths,
        };
        const publication = listing.productId
          ? await this.products.republish(
              manager,
              listing.productId,
              productInput,
            )
          : {
              product: await this.products.create(manager, productInput),
              replacedImages: [] as string[],
            };
        const product = publication.product;
        replacedPaths = publication.replacedImages;
        if (
          product.images?.length !== publishedPaths.length ||
          product.images.some((path, index) => path !== publishedPaths[index])
        )
          throw parrotSaleListingError(
            HttpStatus.CONFLICT,
            ParrotSaleListingErrorCode.PUBLICATION_CONFLICT,
            'Published seller listing product images are unavailable',
          );

        listing.status = ParrotSaleListingStatus.APPROVED;
        listing.productId = product.id;
        listing.approvedPrice = input.publicPrice;
        listing.rejectionReason = null;
        listing.reviewedBy = reviewedBy;
        listing.reviewedAt = new Date();
        const saved = await listings.save(listing);
        const seller = await manager.getRepository(User).findOne({
          where: { id: saved.sellerUserId },
        });
        if (!seller)
          throw parrotSaleListingError(
            HttpStatus.CONFLICT,
            ParrotSaleListingErrorCode.PUBLICATION_CONFLICT,
            'Parrot sale listing seller is unavailable',
          );
        saved.seller = seller;
        saved.images = images;
        return { listing: saved, product };
      });
      if (replacedPaths.length)
        await this.publicImages.remove(replacedPaths).catch(() => {
          this.logger.warn(
            'Replaced seller listing images could not be removed',
          );
        });
      return result;
    } catch (error) {
      await this.publicImages.remove(publishedPaths).catch(() => undefined);
      throw error;
    }
  }

  private reviewer(value: string): string {
    const normalized = value?.trim();
    if (!normalized || normalized.length > 100)
      throw parrotSaleListingError(
        HttpStatus.BAD_REQUEST,
        ParrotSaleListingErrorCode.INVALID_REVIEWER,
        'Owner reviewer identity is invalid',
      );
    return normalized;
  }
}
