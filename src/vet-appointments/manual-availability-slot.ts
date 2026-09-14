import { BadRequestException } from '@nestjs/common';
import { parseInstant, SlotGeometry } from './availability-slot-generation';
import type { ManualAvailabilitySlotDto } from './dto/manual-availability-slot.dto';

export const MAX_MANUAL_AVAILABILITY_SLOTS = 50;

export function parseManualAvailabilitySlots(
  input: ManualAvailabilitySlotDto[],
): SlotGeometry[] {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > MAX_MANUAL_AVAILABILITY_SLOTS
  )
    throw new BadRequestException('Invalid manual availability slot batch');

  let selectedDay: string | undefined;
  return input.map((slot) => {
    if (!slot || typeof slot !== 'object')
      throw new BadRequestException('Invalid manual availability slot');
    const start = parseInstant(slot.startsAt);
    const end = parseInstant(slot.endsAt);
    if (
      start % 60_000 !== 0 ||
      end % 60_000 !== 0 ||
      start >= end ||
      end - start > 24 * 60 * 60 * 1000
    )
      throw new BadRequestException('Invalid manual availability slot');

    const startDay = tehranCalendarDay(start);
    const endDay = tehranCalendarDay(end);
    selectedDay ??= startDay;
    if (startDay !== selectedDay || endDay !== selectedDay)
      throw new BadRequestException(
        'Manual availability slots must belong to one Tehran calendar day',
      );
    return { startsAt: new Date(start), endsAt: new Date(end) };
  });
}

function tehranCalendarDay(value: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
