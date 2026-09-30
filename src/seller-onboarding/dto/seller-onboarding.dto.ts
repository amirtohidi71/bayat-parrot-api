import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import {
  BreederApplicationStatus,
  BreederCallOutcome,
} from '../entities/breeder-application.entity';
import { SellerVerificationStatus } from '../entities/seller-verification.entity';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const optionalTrimmedString = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  return normalized.length ? normalized : undefined;
};

const IsCredentialFreeHttpUrl = () =>
  ValidateBy({
    name: 'isCredentialFreeHttpUrl',
    validator: {
      validate(value: unknown): boolean {
        if (typeof value !== 'string') return false;
        try {
          const url = new URL(value);
          return (
            ['http:', 'https:'].includes(url.protocol) &&
            !url.username &&
            !url.password
          );
        } catch {
          return false;
        }
      },
    },
  });

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
  return /^-?\d+$/.test(normalized) ? Number(normalized) : value;
};

export class ListSellerVerificationsDto {
  @IsOptional()
  @IsEnum(SellerVerificationStatus)
  status?: SellerVerificationStatus;
}

export class ListBreederApplicationsDto {
  @IsOptional()
  @IsEnum(BreederApplicationStatus)
  status?: BreederApplicationStatus;
}

export class SubmitSellerVerificationDto {
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  firstName: string;

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  lastName: string;

  @Transform(trim)
  @IsString()
  @Length(10, 10)
  birthDate: string;

  @IsBoolean()
  consent: boolean;
}

export class SubmitBreederApplicationDto {
  @Transform(trim)
  @IsString()
  @Length(1, 150)
  breederName: string;

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  city: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  @Transform(trimStringArray)
  species: string[];

  @Transform(strictInteger)
  @IsInt()
  @Min(0)
  @Max(100)
  experienceYears: number;

  @Transform(strictInteger)
  @IsInt()
  @Min(0)
  @Max(100000)
  approximateBirdCount: number;

  @Transform(trim)
  @IsString()
  @Length(1, 200)
  preferredContactTime: string;

  @Transform(optionalTrimmedString)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @IsCredentialFreeHttpUrl()
  @MaxLength(500)
  instagramUrl?: string;

  @Transform(optionalTrimmedString)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @IsCredentialFreeHttpUrl()
  @MaxLength(500)
  websiteUrl?: string;

  @Transform(optionalTrimmedString)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class AdminNoteDto {
  @Transform(optionalTrimmedString)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  internalAdminNote?: string;
}

export class AdminRejectDto {
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

export class AdminBreederCallDto {
  @IsEnum(BreederCallOutcome)
  outcome: BreederCallOutcome;

  @Transform(optionalTrimmedString)
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  privateCallNote?: string;
}
