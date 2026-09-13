import { IsISO8601, Matches } from 'class-validator';

export class ListBookableVetSlotsDto {
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  from: string;

  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  to: string;
}

export type BookableVetSlotRow = {
  slotId: string;
  doctorId: string;
  doctorDisplayName: string;
  startsAt: Date;
  endsAt: Date;
};

export class BookableVetSlotResponseDto {
  static from(this: void, slot: BookableVetSlotRow) {
    return {
      slotId: slot.slotId,
      doctorId: slot.doctorId,
      doctorDisplayName: slot.doctorDisplayName.trim(),
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
    };
  }
}
