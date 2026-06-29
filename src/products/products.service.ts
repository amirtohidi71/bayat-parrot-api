import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
  ) {}

  create(createProductDto: CreateProductDto): Promise<Product> {
    const product = this.productsRepository.create(createProductDto);
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
      gender,
      ageStage,
      color,
      minPrice,
      maxPrice,
      sort,
      page = 1,
      limit = 10,
    } = filterDto;

    const query = this.productsRepository.createQueryBuilder('product');

    if (status) {
      query.andWhere('product.status = :status', { status });
    }
    if (searchTerm) {
      query.andWhere('(product.name ILIKE :term OR product.description ILIKE :term)', {
        term: `%${searchTerm}%`,
      });
    }
    if (category) {
      query.andWhere('product.categorySlug = :category', { category });
    }
    if (species) {
      query.andWhere('product.species ILIKE :species', { species });
    }
    if (gender) {
      query.andWhere('product.gender = :gender', { gender });
    }
    if (ageStage) {
      query.andWhere('product.ageStage = :ageStage', { ageStage });
    }
    if (color) {
      query.andWhere(':color = ANY(product.colors)', { color });
    }
    if (minPrice !== undefined) {
      query.andWhere('product.price >= :minPrice', { minPrice });
    }
    if (maxPrice !== undefined) {
      query.andWhere('product.price <= :maxPrice', { maxPrice });
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

  async findOne(id: string): Promise<Product> {
    const product = await this.productsRepository.findOne({ where: { id } });
    if (!product) {
      throw new NotFoundException(`Product with id ${id} not found`);
    }
    return product;
  }

  async findOnePublished(id: string): Promise<Product> {
    const product = await this.findOne(id);
    if (product.status !== ProductStatus.PUBLISHED) {
      throw new NotFoundException(`Product with id ${id} not found`);
    }
    return product;
  }

  async update(id: string, updateProductDto: UpdateProductDto): Promise<Product> {
    const product = await this.findOne(id);
    Object.assign(product, updateProductDto);
    return this.productsRepository.save(product);
  }

  async remove(id: string): Promise<void> {
    const product = await this.findOne(id);
    await this.productsRepository.remove(product);
  }

  async addImage(id: string, imageUrl: string): Promise<Product> {
    const product = await this.findOne(id);
    product.images = [...(product.images ?? []), imageUrl];
    return this.productsRepository.save(product);
  }

  findAllForAdmin(): Promise<Product[]> {
    return this.productsRepository.find({ order: { createdAt: 'DESC' } });
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
