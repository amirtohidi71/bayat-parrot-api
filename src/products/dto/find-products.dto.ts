import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ProductAgeStage, ProductCategorySlug, ProductGender } from '../entities/product.entity';

export enum ProductSortBy {
  BEST_SELLING = 'best_selling',
  PRICE_ASC = 'price_asc',
  PRICE_DESC = 'price_desc',
  NEWEST = 'newest',
  OLDEST = 'oldest',
}

export class FindProductsDto {
  @IsOptional()
  @IsEnum(ProductCategorySlug)
  category?: ProductCategorySlug;

  @IsOptional()
  @IsString()
  species?: string;

  @IsOptional()
  @IsEnum(ProductGender)
  gender?: ProductGender;

  @IsOptional()
  @IsEnum(ProductAgeStage)
  ageStage?: ProductAgeStage;

  @IsOptional()
  @IsString()
  age?: string;

  @IsOptional()
  @IsString()
  subCategory?: string;

  @IsOptional()
  @IsString()
  discount?: string;

  @IsOptional()
  @IsString()
  inStock?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @IsOptional()
  @IsIn(Object.values(ProductSortBy))
  sort?: ProductSortBy;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  amazingOffer?: boolean;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  handTame?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number = 10;
}
