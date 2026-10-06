import { BadRequestException, Injectable } from '@nestjs/common';
import { DeepPartial, EntityManager, Repository } from 'typeorm';
import {
  Product,
  ProductAgeStage,
  ProductCategorySlug,
  ProductGender,
  ProductStatus,
} from './entities/product.entity';
import { getTehranJalaliDateCode } from './products.service';

export type SellerListingProductInput = {
  name: string;
  description: string | null;
  publicPrice: number;
  quantity: number;
  species: string;
  subspecies: string | null;
  gender: ProductGender | null;
  ageStage: ProductAgeStage | null;
  colors: string[] | null;
  tagPair: boolean;
  tagHandTame: boolean;
  images: string[];
};

@Injectable()
export class SellerListingProductPublisherService {
  async create(
    manager: EntityManager,
    input: SellerListingProductInput,
  ): Promise<Product> {
    const products = manager.getRepository(Product);
    const skuPrefix = `BP${getTehranJalaliDateCode()}`;
    await products.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      skuPrefix,
    ]);
    const sku = await this.generateNextSku(products, skuPrefix);
    const payload: DeepPartial<Product> = {
      sku,
      name: input.name,
      description: input.description ?? undefined,
      specifications: null,
      boughtTogetherProductIds: [],
      lastEditedByName: null,
      price: input.publicPrice,
      stock: input.quantity,
      colorVariants: null,
      status: ProductStatus.PUBLISHED,
      categorySlug: ProductCategorySlug.BUY_PARROT,
      species: input.species,
      subspecies: input.subspecies ?? undefined,
      gender: input.gender ?? undefined,
      ageStage: input.ageStage ?? undefined,
      colors: input.colors ?? undefined,
      tagPair: input.tagPair,
      tagHandTame: input.tagHandTame,
      tagCustom: false,
      tagLuxury: false,
      tagHealthGuarantee: false,
      tagFastShipping: false,
      tagFreeShipping: false,
      tagCarryCage: false,
      isAmazingOffer: false,
      isSellerListing: true,
      images: input.images,
    };
    return products.save(products.create(payload));
  }

  private async generateNextSku(
    products: Repository<Product>,
    prefix: string,
  ): Promise<string> {
    const result = await products
      .createQueryBuilder('product')
      .withDeleted()
      .select('MAX(CAST(RIGHT(product.sku, 4) AS integer))', 'max')
      .where('product.sku ~ :skuPattern', {
        skuPattern: `^${prefix}[0-9]{4}$`,
      })
      .getRawOne<{ max: string | null }>();
    const next = Number(result?.max ?? 0) + 1;
    if (next > 9999)
      throw new BadRequestException('Daily product SKU limit reached');
    return `${prefix}${String(next).padStart(4, '0')}`;
  }
}
