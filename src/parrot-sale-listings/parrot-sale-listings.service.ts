import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { SellerEligibilityPolicy } from '../seller-onboarding/seller-eligibility.policy';
import { User } from '../users/entities/user.entity';
import {
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
import { ParrotSaleListingOptionsService } from './parrot-sale-listing-options.service';
import { ParrotSaleListingImageStorageService } from './images/parrot-sale-listing-image-storage.service';
import { PARROT_SALE_LISTING_MAX_IMAGES } from './parrot-sale-listing.constants';
import {
  ParrotSaleListingErrorCode,
  parrotSaleListingError,
} from './parrot-sale-listing.errors';
import { assertParrotSaleListingImageCount } from './parrot-sale-listing.validation';

@Injectable()
export class ParrotSaleListingsService {
  private readonly logger = new Logger(ParrotSaleListingsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(ParrotSaleListing)
    private readonly listings: Repository<ParrotSaleListing>,
    private readonly eligibility: SellerEligibilityPolicy,
    private readonly storage: ParrotSaleListingImageStorageService,
    private readonly options: ParrotSaleListingOptionsService,
  ) {}

  getOptions() {
    return this.options.getOptions();
  }

  async create(sellerUserId: string, input: CreateParrotSaleListingDto) {
    await this.eligibility.assertEligibleSeller(sellerUserId);
    return this.dataSource.transaction(async (manager) => {
      await this.options.assertValidSelection(input, manager);
      const listings = manager.getRepository(ParrotSaleListing);
      const listing = listings.create({
        sellerUserId,
        status: ParrotSaleListingStatus.DRAFT,
        name: input.name,
        description: input.description ?? null,
        species: input.species,
        subspecies: input.subspecies ?? null,
        gender:
          input.gender === PARROT_SALE_LISTING_PAIR_GENDER
            ? null
            : (input.gender ?? null),
        ageStage: input.ageStage ?? null,
        colors: input.colors ?? null,
        tagPair:
          input.gender === PARROT_SALE_LISTING_PAIR_GENDER
            ? true
            : (input.tagPair ?? false),
        tagHandTame: input.tagHandTame ?? false,
        requestedPrice: input.requestedPrice,
        approvedPrice: null,
        quantity: input.quantity ?? 1,
        productId: null,
        rejectionReason: null,
        internalAdminNote: null,
        reviewedBy: null,
        reviewedAt: null,
        resubmissionOfId: null,
      });
      const saved = await listings.save(listing);
      saved.images = [];
      return saved;
    });
  }

  async listOwn(sellerUserId: string) {
    const values = await this.listings.find({
      where: { sellerUserId },
      relations: { images: true },
      order: { createdAt: 'DESC' },
    });
    return values.map((value) => this.sortImages(value));
  }

  async listForAdmin(status?: ParrotSaleListingStatus) {
    const values = await this.listings.find({
      where: status ? { status } : {},
      relations: { images: true, seller: true },
      order: { createdAt: 'DESC' },
    });
    return values.map((value) => this.sortImages(value));
  }

  async listForGodAdmin(
    status: ParrotSaleListingStatus = ParrotSaleListingStatus.PENDING_REVIEW,
  ) {
    const values = await this.listings.find({
      where: { status },
      relations: { images: true, seller: true },
      order: { createdAt: 'DESC' },
    });
    return values.map((value) => this.sortImages(value));
  }

  async getForAdmin(id: string) {
    const value = await this.listings.findOne({
      where: { id },
      relations: { images: true, seller: true },
    });
    if (!value) this.notFound();
    return this.sortImages(value);
  }

  async getForGodAdmin(id: string) {
    const value = await this.listings.findOne({
      where: { id },
      relations: { images: true, seller: true, product: true },
    });
    if (!value) this.notFound();
    return this.sortImages(value);
  }

  async getOwn(sellerUserId: string, id: string) {
    const value = await this.listings.findOne({
      where: { id, sellerUserId },
      relations: { images: true },
    });
    if (!value) this.notFound();
    return this.sortImages(value);
  }

  async readOwnImage(sellerUserId: string, listingId: string, imageId: string) {
    const listing = await this.listings.findOne({
      where: { id: listingId, sellerUserId },
      select: { id: true },
    });
    if (!listing) this.notFound();
    return this.readPrivateImage(listingId, imageId);
  }

  async readReviewImage(listingId: string, imageId: string) {
    const listing = await this.listings.findOne({
      where: { id: listingId },
      select: { id: true },
    });
    if (!listing) this.notFound();
    return this.readPrivateImage(listingId, imageId);
  }

  async update(
    sellerUserId: string,
    id: string,
    input: UpdateParrotSaleListingDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const listings = manager.getRepository(ParrotSaleListing);
      const listing = await this.lockedOwned(listings, sellerUserId, id);
      this.assertDraft(listing);
      await this.eligibility.assertEligibleSellerInTransaction(
        sellerUserId,
        manager,
      );
      await this.options.assertValidSelection(
        {
          species: input.species ?? listing.species,
          subspecies: input.subspecies ?? listing.subspecies,
          colors: input.colors ?? listing.colors,
        },
        manager,
      );
      this.applyUpdate(listing, input);
      const saved = await listings.save(listing);
      return this.withImages(saved, manager);
    });
  }

  async addImage(
    sellerUserId: string,
    id: string,
    buffer: Buffer,
    suppliedMimeType?: string,
  ) {
    this.assertDraft(await this.getOwn(sellerUserId, id));
    const storageKey = await this.storage.save(buffer, suppliedMimeType);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const listings = manager.getRepository(ParrotSaleListing);
        const images = manager.getRepository(ParrotSaleListingImage);
        const listing = await this.lockedOwned(listings, sellerUserId, id);
        this.assertDraft(listing);
        const existing = await images.find({
          where: { listingId: listing.id },
          order: { position: 'ASC' },
        });
        if (existing.length >= PARROT_SALE_LISTING_MAX_IMAGES)
          throw parrotSaleListingError(
            HttpStatus.CONFLICT,
            ParrotSaleListingErrorCode.IMAGE_LIMIT_REACHED,
            'A parrot sale listing can have at most 8 images',
          );
        const occupied = new Set(existing.map((image) => image.position));
        const position = Array.from(
          { length: PARROT_SALE_LISTING_MAX_IMAGES },
          (_value, index) => index,
        ).find((value) => !occupied.has(value));
        if (position === undefined)
          throw parrotSaleListingError(
            HttpStatus.CONFLICT,
            ParrotSaleListingErrorCode.IMAGE_LIMIT_REACHED,
            'A parrot sale listing can have at most 8 images',
          );
        const image = images.create({
          listingId: listing.id,
          storageKey,
          position,
        });
        await images.save(image);
        listing.images = [...existing, image];
        return this.sortImages(listing);
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async deleteImage(sellerUserId: string, id: string, imageId: string) {
    const result = await this.dataSource.transaction(async (manager) => {
      const listings = manager.getRepository(ParrotSaleListing);
      const images = manager.getRepository(ParrotSaleListingImage);
      const listing = await this.lockedOwned(listings, sellerUserId, id);
      this.assertDraft(listing);
      const image = await images.findOne({
        where: { id: imageId, listingId: listing.id },
      });
      if (!image)
        throw parrotSaleListingError(
          HttpStatus.NOT_FOUND,
          ParrotSaleListingErrorCode.IMAGE_NOT_FOUND,
          'Parrot sale listing image not found',
        );
      await images.remove(image);
      return {
        listing: await this.withImages(listing, manager),
        storageKey: image.storageKey,
      };
    });
    await this.storage.delete(result.storageKey).catch(() => {
      this.logger.warn(
        'A removed parrot sale listing image could not be deleted',
      );
    });
    return result.listing;
  }

  async submit(sellerUserId: string, id: string) {
    return this.dataSource.transaction(async (manager) => {
      const listings = manager.getRepository(ParrotSaleListing);
      const images = manager.getRepository(ParrotSaleListingImage);
      const listing = await this.lockedOwned(listings, sellerUserId, id);
      this.assertDraft(listing);
      await this.eligibility.assertEligibleSellerInTransaction(
        sellerUserId,
        manager,
      );
      const imageCount = await images.count({
        where: { listingId: listing.id },
      });
      assertParrotSaleListingImageCount(imageCount);
      listing.status = ParrotSaleListingStatus.PENDING_REVIEW;
      const saved = await listings.save(listing);
      return this.withImages(saved, manager);
    });
  }

  async reject(
    id: string,
    reviewer: string,
    input: RejectParrotSaleListingDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const listings = manager.getRepository(ParrotSaleListing);
      const listing = await listings.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!listing) this.notFound();
      if (listing.status !== ParrotSaleListingStatus.PENDING_REVIEW)
        throw parrotSaleListingError(
          HttpStatus.CONFLICT,
          ParrotSaleListingErrorCode.INVALID_TRANSITION,
          'Only pending parrot sale listings can be rejected',
        );
      const reviewedBy = this.reviewer(reviewer);
      listing.status = ParrotSaleListingStatus.REJECTED;
      listing.rejectionReason = input.rejectionReason;
      listing.internalAdminNote = input.internalAdminNote ?? null;
      listing.reviewedBy = reviewedBy;
      listing.reviewedAt = new Date();
      const saved = await listings.save(listing);
      return this.withAdminRelations(saved, manager);
    });
  }

  private async lockedOwned(
    listings: Repository<ParrotSaleListing>,
    sellerUserId: string,
    id: string,
  ) {
    const value = await listings.findOne({
      where: { id, sellerUserId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!value) this.notFound();
    return value;
  }

  private async readPrivateImage(listingId: string, imageId: string) {
    const image = await this.dataSource
      .getRepository(ParrotSaleListingImage)
      .findOne({
        where: { id: imageId, listingId },
        select: { id: true, storageKey: true },
      });
    if (!image)
      throw parrotSaleListingError(
        HttpStatus.NOT_FOUND,
        ParrotSaleListingErrorCode.IMAGE_NOT_FOUND,
        'Parrot sale listing image not found',
      );
    return this.storage.read(image.storageKey);
  }

  private async withImages(listing: ParrotSaleListing, manager: EntityManager) {
    listing.images = await manager.getRepository(ParrotSaleListingImage).find({
      where: { listingId: listing.id },
      order: { position: 'ASC' },
    });
    return listing;
  }

  private async withAdminRelations(
    listing: ParrotSaleListing,
    manager: EntityManager,
  ) {
    const seller = await manager.getRepository(User).findOne({
      where: { id: listing.sellerUserId },
    });
    if (!seller) this.notFound();
    listing.seller = seller;
    return this.withImages(listing, manager);
  }

  private applyUpdate(
    listing: ParrotSaleListing,
    input: UpdateParrotSaleListingDto,
  ): void {
    if (input.name !== undefined) listing.name = input.name;
    if (input.description !== undefined)
      listing.description = input.description;
    if (input.species !== undefined) listing.species = input.species;
    if (input.subspecies !== undefined) listing.subspecies = input.subspecies;
    if (input.gender !== undefined) {
      listing.gender =
        input.gender === PARROT_SALE_LISTING_PAIR_GENDER ? null : input.gender;
    }
    if (input.ageStage !== undefined) listing.ageStage = input.ageStage;
    if (input.colors !== undefined) listing.colors = input.colors;
    if (input.tagPair !== undefined) listing.tagPair = input.tagPair;
    if (input.gender === PARROT_SALE_LISTING_PAIR_GENDER)
      listing.tagPair = true;
    if (input.tagHandTame !== undefined)
      listing.tagHandTame = input.tagHandTame;
    if (input.requestedPrice !== undefined)
      listing.requestedPrice = input.requestedPrice;
    if (input.quantity !== undefined) listing.quantity = input.quantity;
  }

  private assertDraft(listing: ParrotSaleListing): void {
    if (listing.status !== ParrotSaleListingStatus.DRAFT)
      throw parrotSaleListingError(
        HttpStatus.CONFLICT,
        ParrotSaleListingErrorCode.NOT_EDITABLE,
        'Only draft parrot sale listings can be changed',
      );
  }

  private sortImages(listing: ParrotSaleListing): ParrotSaleListing {
    listing.images = [...(listing.images ?? [])].sort(
      (left, right) => left.position - right.position,
    );
    return listing;
  }

  private notFound(): never {
    throw parrotSaleListingError(
      HttpStatus.NOT_FOUND,
      ParrotSaleListingErrorCode.NOT_FOUND,
      'Parrot sale listing not found',
    );
  }

  private reviewer(value: string): string {
    const normalized = value?.trim();
    if (!normalized || normalized.length > 100)
      throw parrotSaleListingError(
        HttpStatus.BAD_REQUEST,
        ParrotSaleListingErrorCode.INVALID_REVIEWER,
        'Admin reviewer identity is invalid',
      );
    return normalized;
  }
}
