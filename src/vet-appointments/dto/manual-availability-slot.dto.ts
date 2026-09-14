import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { MAX_MANUAL_AVAILABILITY_SLOTS } from '../manual-availability-slot';

export class ManualAvailabilitySlotDto {
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  startsAt: string;

  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  endsAt: string;
}

export class CreateManualAvailabilitySlotsDto {
  @IsUUID()
  doctorId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MANUAL_AVAILABILITY_SLOTS)
  @ValidateNested({ each: true })
  @Type(() => ManualAvailabilitySlotDto)
  slots: ManualAvailabilitySlotDto[];
}
