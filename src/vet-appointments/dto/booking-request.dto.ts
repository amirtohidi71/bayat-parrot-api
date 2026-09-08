import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { IsString, IsUUID, Matches, ValidateIf } from 'class-validator';

export class BookVetAppointmentDto {
  @IsUUID()
  bookingRequestId: string;

  @IsUUID()
  slotId: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Transform((params: TransformFnParams) => {
    const value: unknown = params.value;
    return typeof value === 'string' ? value.trim().toUpperCase() : value;
  })
  @Matches(/^B[0-9]{8}$/)
  passportCode?: string;
}
