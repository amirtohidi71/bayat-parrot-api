import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateAdminVetDoctorDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  displayName: string;

  @Transform(trim)
  @IsString()
  @Matches(/^09[0-9]{9}$/)
  mobile: string;

  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9_]{3,50}$/)
  username: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password: string;

  @IsString()
  @Matches(/^(0|[1-9][0-9]{0,18})$/)
  consultationFeeMinor: string;

  @Transform(upper)
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateAdminVetDoctorDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  displayName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^09[0-9]{9}$/)
  mobile?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9_]{3,50}$/)
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(0|[1-9][0-9]{0,18})$/)
  consultationFeeMinor?: string;

  @IsOptional()
  @Transform(upper)
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
