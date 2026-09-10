import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { VetAppointmentStatus } from '../vet-appointment.enums';

export const VET_APPOINTMENT_MAX_PAGE = 10_000;

export enum VetAppointmentPeriod {
  UPCOMING = 'upcoming',
  PAST = 'past',
}

export class ListVetAppointmentsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(VET_APPOINTMENT_MAX_PAGE)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @IsOptional()
  @IsEnum(VetAppointmentPeriod)
  period?: VetAppointmentPeriod;

  @IsOptional()
  @IsEnum(VetAppointmentStatus)
  status?: VetAppointmentStatus;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  to?: string;
}

export class AdminListVetAppointmentsDto extends ListVetAppointmentsDto {
  @IsOptional()
  @IsUUID()
  doctorId?: string;

  @IsOptional()
  @IsUUID()
  customerUserId?: string;
}
