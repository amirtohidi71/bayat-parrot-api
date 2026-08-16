import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BirdPassportStatus } from '../entities/bird-passport.entity';

export class AdminListBirdPassportsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsEnum(BirdPassportStatus)
  status?: BirdPassportStatus;

  @IsOptional()
  @Transform((parameters: TransformFnParams) =>
    normalizeOptionalString(parameters.value as unknown),
  )
  @IsString()
  @MaxLength(100)
  search?: string;
}

function normalizeOptionalString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}
