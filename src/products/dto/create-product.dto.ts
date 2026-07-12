import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ProductAgeStage,
  ProductCategorySlug,
  ProductGender,
  ProductStatus,
} from '../entities/product.entity';

class ProductSpecificationDto {
  @IsString()
  label: string;

  @IsString()
  value: string;
}

class ProductColorVariantDto {
  @IsString()
  colorName: string;

  @IsOptional()
  @IsString()
  colorCode?: string;

  @IsNumber()
  @Min(0)
  stock: number;
}

export class CreateProductDto {
  @Matches(/^BP\d+$/, { message: 'sku must match the format BP followed by digits' })
  sku: string;

  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  shortDescription?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductSpecificationDto)
  specifications?: ProductSpecificationDto[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  boughtTogetherProductIds?: string[];

  @IsNumber()
  @Min(0)
  price: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  stock?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductColorVariantDto)
  colorVariants?: ProductColorVariantDto[];

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsEnum(ProductCategorySlug)
  categorySlug: ProductCategorySlug;

  @IsOptional()
  @IsString()
  subCategory?: string;

  @IsOptional()
  @IsString()
  species?: string;

  @IsOptional()
  @IsString()
  subspecies?: string;

  @IsOptional()
  @IsEnum(ProductGender)
  gender?: ProductGender;

  @IsOptional()
  @IsEnum(ProductAgeStage)
  ageStage?: ProductAgeStage;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  colors?: string[];

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  weight?: string;

  @IsOptional()
  @IsString()
  productType?: string;

  @IsOptional()
  @IsString()
  size?: string;

  @IsOptional()
  @IsString()
  material?: string;

  @IsOptional()
  @IsBoolean()
  tagPair?: boolean;

  @IsOptional()
  @IsBoolean()
  tagHandTame?: boolean;

  @IsOptional()
  @IsBoolean()
  tagCustom?: boolean;

  @IsOptional()
  @IsBoolean()
  tagLuxury?: boolean;

  @IsOptional()
  @IsBoolean()
  tagHealthGuarantee?: boolean;

  @IsOptional()
  @IsBoolean()
  tagFastShipping?: boolean;

  @IsOptional()
  @IsBoolean()
  tagFreeShipping?: boolean;

  @IsOptional()
  @IsBoolean()
  tagCarryCage?: boolean;

  @IsOptional()
  @IsBoolean()
  isAmazingOffer?: boolean;

  @IsOptional()
  @IsDateString()
  amazingOfferEndsAt?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsString()
  lastEditedByName?: string | null;
}
