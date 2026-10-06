import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  ProductAgeStage,
  ProductGender,
} from '../../products/entities/product.entity';
import {
  PARROT_SALE_LISTING_MAX_QUANTITY,
  PARROT_SALE_LISTING_MIN_QUANTITY,
} from '../parrot-sale-listing.constants';
import { ParrotSaleListingStatus } from '../entities/parrot-sale-listing.entity';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const optionalTrimmedString = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  return normalized.length ? normalized : undefined;
};

const trimStringArray = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? value.map((item: unknown) =>
        typeof item === 'string' ? item.trim() : item,
      )
    : value;

const strictInteger = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  return /^\d+$/.test(normalized) ? Number(normalized) : value;
};

const strictMoney = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  return /^\d+(?:\.\d{1,2})?$/.test(normalized) ? Number(normalized) : value;
};

export class ListParrotSaleListingsDto {
  @IsOptional()
  @IsEnum(ParrotSaleListingStatus)
  status?: ParrotSaleListingStatus;
}

export class CreateParrotSaleListingDto {
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name: string;

  @Transform(optionalTrimmedString)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  species: string;

  @Transform(optionalTrimmedString)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(100)
  subspecies?: string;

  @IsOptional()
  @IsEnum(ProductGender)
  gender?: ProductGender;

  @IsOptional()
  @IsEnum(ProductAgeStage)
  ageStage?: ProductAgeStage;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(50, { each: true })
  @Transform(trimStringArray)
  colors?: string[];

  @IsOptional()
  @IsBoolean()
  tagPair?: boolean;

  @IsOptional()
  @IsBoolean()
  tagHandTame?: boolean;

  @Transform(strictMoney)
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9_999_999_999_999.99)
  requestedPrice: number;

  @IsOptional()
  @Transform(strictInteger)
  @IsInt()
  @Min(PARROT_SALE_LISTING_MIN_QUANTITY)
  @Max(PARROT_SALE_LISTING_MAX_QUANTITY)
  quantity?: number;
}

export class UpdateParrotSaleListingDto {
  @Transform(optionalTrimmedString)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @Transform(optionalTrimmedString)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @Transform(optionalTrimmedString)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  species?: string;

  @Transform(optionalTrimmedString)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(100)
  subspecies?: string;

  @IsOptional()
  @IsEnum(ProductGender)
  gender?: ProductGender;

  @IsOptional()
  @IsEnum(ProductAgeStage)
  ageStage?: ProductAgeStage;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(50, { each: true })
  @Transform(trimStringArray)
  colors?: string[];

  @IsOptional()
  @IsBoolean()
  tagPair?: boolean;

  @IsOptional()
  @IsBoolean()
  tagHandTame?: boolean;

  @IsOptional()
  @Transform(strictMoney)
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9_999_999_999_999.99)
  requestedPrice?: number;

  @IsOptional()
  @Transform(strictInteger)
  @IsInt()
  @Min(PARROT_SALE_LISTING_MIN_QUANTITY)
  @Max(PARROT_SALE_LISTING_MAX_QUANTITY)
  quantity?: number;
}

export class ApproveParrotSaleListingDto {
  @Transform(strictMoney)
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9_999_999_999_999.99)
  publicPrice: number;
}

export class RejectParrotSaleListingDto {
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  rejectionReason: string;

  @Transform(optionalTrimmedString)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  internalAdminNote?: string;
}
