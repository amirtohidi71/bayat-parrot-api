import { Type } from 'class-transformer';
import {
  Equals,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { VetAvailabilityStatus } from '../vet-appointment.enums';

export class AvailabilityGeometryDto {
  @IsISO8601({ strict: true })
  @Matches(/T\d{2}:\d{2}(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:\d{2})$/)
  startsAt: string;

  @IsISO8601({ strict: true })
  @Matches(/T\d{2}:\d{2}(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:\d{2})$/)
  endsAt: string;

  @IsInt()
  @Min(1)
  @Max(1440)
  slotDurationMinutes: number;

  @Equals('Asia/Tehran')
  timeZone: string = 'Asia/Tehran';
}

export class CreateAvailabilityDto extends AvailabilityGeometryDto {
  @IsUUID()
  doctorId: string;
}

export class ListAvailabilityDto {
  @IsOptional()
  @IsUUID()
  doctorId?: string;

  @IsOptional()
  @IsEnum(VetAvailabilityStatus)
  status?: VetAvailabilityStatus;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  to?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
