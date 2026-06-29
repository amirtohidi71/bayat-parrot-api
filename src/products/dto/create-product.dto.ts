import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  ProductAgeStage,
  ProductCategorySlug,
  ProductGender,
  ProductStatus,
} from '../entities/product.entity';

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
  stock?: number;

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
  @IsNumber()
  @Min(0)
  weight?: number;

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
  @IsArray()
  @IsString({ each: true })
  images?: string[];
}
