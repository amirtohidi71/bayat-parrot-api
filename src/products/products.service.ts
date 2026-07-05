import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Product, ProductStatus } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { FindProductsDto, ProductSortBy } from './dto/find-products.dto';
import { SearchProductsDto } from './dto/search-products.dto';

export interface PaginatedProducts {
  items: Product[];
  total: number;
  page: number;
  limit: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ProductEditorPayload = { lastEditedByName?: string | null };
export type ProductWithBoughtTogether = Product & { boughtTogetherProducts: Product[] };

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
  ) {}

  async create(createProductDto: CreateProductDto & ProductEditorPayload): Promise<Product> {
    const payload = {
      ...createProductDto,
      specifications: this.normalizeSpecifications(createProductDto.specifications),
      boughtTogetherProductIds: await this.normalizeBoughtTogetherIds(createProductDto.boughtTogetherProductIds),
    };
    this.validateAmazingOfferEnd(payload);
    const product = this.productsRepository.create(payload);
    return this.productsRepository.save(product);
  }

  findAllPublished(filterDto: FindProductsDto): Promise<PaginatedProducts> {
    return this.runFilteredQuery(filterDto, undefined, ProductStatus.PUBLISHED);
  }

  searchPublished(searchDto: SearchProductsDto): Promise<PaginatedProducts> {
    return this.runFilteredQuery(searchDto, searchDto.q, ProductStatus.PUBLISHED);
  }

  private async runFilteredQuery(
    filterDto: FindProductsDto,
    searchTerm?: string,
    status?: ProductStatus,
  ): Promise<PaginatedProducts> {
    const {
      category,
      species,
      subCategory,
      gender,
      ageStage,
      age,
      color,
      minPrice,
      maxPrice,
      sort,
      discount,
      inStock,
      amazingOffer,
      page = 1,
      limit = 10,
    } = filterDto;

    const query = this.productsRepository.createQueryBuilder('product');

    if (status) {
      query.andWhere('product.status = :status', { status });
    }

    // جستجوی کلمه‌به‌کلمه: هر کلمه‌ی جدا باید یک‌جا در نام یا توضیحات پیدا شود
    if (searchTerm) {
      const words = searchTerm.trim().split(/\s+/).filter(Boolean);
      words.forEach((word, i) => {
        query.andWhere(
          `(product.name ILIKE :term${i} OR product.description ILIKE :term${i})`,
          { [`term${i}`]: `%${word}%` },
        );
      });
    }

    if (category) {
      query.andWhere('product.categorySlug = :category', { category });
    }
    if (species) {
      const values = this.parseCsv(species);
      if (values.length > 0) {
        query.andWhere('product.species IN (:...species)', { species: values });
      }
    }
    if (subCategory) {
      const values = this.parseCsv(subCategory);
      if (values.length > 0) {
        query.andWhere('product.subCategory IN (:...subCategories)', { subCategories: values });
      }
    }
    if (gender) {
      query.andWhere('product.gender = :gender', { gender });
    }
    if (ageStage || age) {
      const values = this.parseCsv(ageStage ?? age);
      if (values.length > 0) {
        query.andWhere('product.ageStage IN (:...ageStages)', { ageStages: values });
      }
    }
    if (color) {
      const values = this.parseCsv(color);
      if (values.length > 0) {
        query.andWhere('product.colors && :colors', { colors: values });
      }
    }
    if (minPrice !== undefined) {
      query.andWhere('product.price >= :minPrice', { minPrice });
    }
    if (maxPrice !== undefined) {
      query.andWhere('product.price <= :maxPrice', { maxPrice });
    }
    if (amazingOffer) {
      query.andWhere('product.isAmazingOffer = true');
    }
    if (discount === 'true') {
      query.andWhere('(product.discountPrice IS NOT NULL OR product.discountPercent > 0)');
    }
    if (inStock === 'true') {
      query.andWhere('product.stock > 0');
    }

    switch (sort) {
      case ProductSortBy.PRICE_ASC:
        query.orderBy('product.price', 'ASC');
        break;
      case ProductSortBy.PRICE_DESC:
        query.orderBy('product.price', 'DESC');
        break;
      case ProductSortBy.OLDEST:
        query.orderBy('product.createdAt', 'ASC');
        break;
      default:
        query.orderBy('product.createdAt', 'DESC');
    }

    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return { items, total, page, limit };
  }

  private parseCsv(value?: string | null): string[] {
    if (!value) {
      return [];
    }

    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  /**
   * محصول را با UUID داخلی (id) یا با شناسه کالای خوانا (sku) پیدا می‌کند.
   * اگر ورودی شبیه UUID باشد با id جستجو می‌کند، در غیر این صورت با sku.
   */
  async findOne(idOrSku: string): Promise<Product> {
    const product = UUID_REGEX.test(idOrSku)
      ? await this.productsRepository.findOne({ where: { id: idOrSku } })
      : await this.productsRepository.findOne({ where: { sku: idOrSku } });
    if (!product) {
      throw new NotFoundException(`Product with id ${idOrSku} not found`);
    }
    return product;
  }

  /** نام دیگر برای findOne — سازگاری با کدهایی که این نام را صدا می‌زنند */
  async findOneByIdOrSku(idOrSku: string): Promise<Product> {
    return this.findOne(idOrSku);
  }

  async findOneForAdmin(idOrSku: string): Promise<ProductWithBoughtTogether> {
    const product = await this.findOne(idOrSku);
    const boughtTogetherProducts = await this.findProductsByIds(product.boughtTogetherProductIds ?? []);
    return Object.assign(product, { boughtTogetherProducts });
  }

  async findOnePublished(idOrSku: string): Promise<ProductWithBoughtTogether> {
    const product = await this.findOne(idOrSku);
    if (product.status !== ProductStatus.PUBLISHED) {
      throw new NotFoundException(`Product with id ${idOrSku} not found`);
    }
    const boughtTogetherProducts = await this.findPublishedProductsByIds(product.boughtTogetherProductIds ?? []);
    return Object.assign(product, { boughtTogetherProducts });
  }

  async update(id: string, updateProductDto: UpdateProductDto & ProductEditorPayload): Promise<Product> {
    const product = await this.findOne(id);
    const payload = {
      ...updateProductDto,
      ...(updateProductDto.specifications !== undefined
        ? { specifications: this.normalizeSpecifications(updateProductDto.specifications) }
        : {}),
      ...(updateProductDto.boughtTogetherProductIds !== undefined
        ? {
            boughtTogetherProductIds: await this.normalizeBoughtTogetherIds(
              updateProductDto.boughtTogetherProductIds,
              product.id,
            ),
          }
        : {}),
    };
    this.validateAmazingOfferEnd({ ...product, ...payload });
    Object.assign(product, payload);
    return this.productsRepository.save(product);
  }

  private normalizeSpecifications(
    specifications?: { label?: string; value?: string }[] | null,
  ): { label: string; value: string }[] | null {
    if (!Array.isArray(specifications)) {
      return null;
    }

    const normalized = specifications
      .map((spec) => ({
        label: String(spec?.label ?? '').trim(),
        value: String(spec?.value ?? '').trim(),
      }))
      .filter((spec) => spec.label !== '' || spec.value !== '');

    return normalized.length > 0 ? normalized : null;
  }

  private async normalizeBoughtTogetherIds(ids?: string[] | null, currentProductId?: string): Promise<string[]> {
    if (!Array.isArray(ids)) {
      return [];
    }

    const uniqueIds = Array.from(new Set(ids.map((id) => String(id).trim()).filter(Boolean)));
    const invalidId = uniqueIds.find((id) => !UUID_REGEX.test(id));
    if (invalidId) {
      throw new BadRequestException(`Invalid bought together product id: ${invalidId}`);
    }
    if (currentProductId && uniqueIds.includes(currentProductId)) {
      throw new BadRequestException('Product cannot be bought together with itself');
    }
    if (uniqueIds.length === 0) {
      return [];
    }

    const foundProducts = await this.productsRepository.find({
      where: { id: In(uniqueIds) },
      withDeleted: true,
    });
    const foundIds = new Set(foundProducts.map((foundProduct) => foundProduct.id));
    const missingId = uniqueIds.find((boughtTogetherId) => !foundIds.has(boughtTogetherId));
    if (missingId) {
      throw new BadRequestException(`Bought together product not found: ${missingId}`);
    }

    return uniqueIds;
  }

  private async findPublishedProductsByIds(ids: string[]): Promise<Product[]> {
    if (ids.length === 0) {
      return [];
    }

    const products = await this.productsRepository.find({
      where: { id: In(ids), status: ProductStatus.PUBLISHED },
    });
    const byId = new Map(products.map((product) => [product.id, product]));
    return ids.map((boughtTogetherId) => byId.get(boughtTogetherId)).filter((product): product is Product => Boolean(product));
  }

  private async findProductsByIds(ids: string[]): Promise<Product[]> {
    if (ids.length === 0) {
      return [];
    }

    const products = await this.productsRepository.find({
      where: { id: In(ids) },
    });
    const byId = new Map(products.map((product) => [product.id, product]));
    return ids.map((boughtTogetherId) => byId.get(boughtTogetherId)).filter((product): product is Product => Boolean(product));
  }

  private validateAmazingOfferEnd(product: { isAmazingOffer?: boolean; amazingOfferEndsAt?: string | Date | null }): void {
    if (!product.isAmazingOffer) {
      return;
    }

    if (!product.amazingOfferEndsAt) {
      throw new BadRequestException('Amazing offer end time is required');
    }

    const endsAt = new Date(product.amazingOfferEndsAt);
    if (Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException('Amazing offer end time is invalid');
    }

    if (endsAt.getTime() <= Date.now()) {
      throw new BadRequestException('Amazing offer end time must be in the future');
    }
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.productsRepository.softDelete(id);
  }

  async addImage(id: string, imageUrl: string): Promise<Product> {
    const product = await this.findOne(id);
    product.images = [...(product.images ?? []), imageUrl];
    return this.productsRepository.save(product);
  }

  findAllForAdmin(status?: ProductStatus | string): Promise<Product[]> {
    const normalizedStatus = Object.values(ProductStatus).includes(status as ProductStatus)
      ? (status as ProductStatus)
      : undefined;

    return this.productsRepository.find({
      where: normalizedStatus ? { status: normalizedStatus } : {},
      order: { createdAt: 'DESC' },
    });
  }

  findPending(): Promise<Product[]> {
    return this.productsRepository.find({
      where: { status: ProductStatus.PENDING },
      order: { createdAt: 'DESC' },
    });
  }

  async publishAllPending(): Promise<number> {
    const result = await this.productsRepository.update(
      { status: ProductStatus.PENDING },
      { status: ProductStatus.PUBLISHED },
    );
    return result.affected ?? 0;
  }

  async publishBySku(sku: string): Promise<Product> {
    const product = await this.productsRepository.findOne({ where: { sku } });
    if (!product) {
      throw new NotFoundException(`Product with sku ${sku} not found`);
    }
    product.status = ProductStatus.PUBLISHED;
    return this.productsRepository.save(product);
  }
}
