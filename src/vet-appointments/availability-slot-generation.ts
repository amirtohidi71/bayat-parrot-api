import { BadRequestException, ConflictException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { AvailabilityGeometryDto } from './dto/availability-request.dto';

export type SlotGeometry = { startsAt: Date; endsAt: Date };

export function generateAvailabilitySlots(
  input: AvailabilityGeometryDto,
  retained: SlotGeometry[] = [],
): SlotGeometry[] {
  const start = parseInstant(input.startsAt);
  const end = parseInstant(input.endsAt);
  const step = input.slotDurationMinutes * 60_000;
  if (
    (input.timeZone !== undefined && input.timeZone !== 'Asia/Tehran') ||
    !/T\d{2}:\d{2}(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      input.startsAt,
    ) ||
    !/T\d{2}:\d{2}(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.endsAt) ||
    !Number.isInteger(input.slotDurationMinutes) ||
    input.slotDurationMinutes < 1 ||
    input.slotDurationMinutes > 1440 ||
    end <= start ||
    end - start > 86_400_000 ||
    start % 60_000 !== 0 ||
    end % 60_000 !== 0 ||
    (end - start) % step !== 0
  )
    throw new BadRequestException(
      'Invalid availability range, duration or timezone',
    );

  const protectedRanges = retained.filter(
    (s) => +s.startsAt < end && +s.endsAt > start,
  );
  // Keep an exact grid: never silently shorten a slot or leave part of a cell unused.
  for (const s of protectedRanges) {
    if (
      (Math.max(start, +s.startsAt) - start) % step !== 0 ||
      (Math.min(end, +s.endsAt) - start) % step !== 0
    ) {
      throw new ConflictException(
        'Replacement grid intersects retained slot boundaries',
      );
    }
  }
  const slots: SlotGeometry[] = [];
  for (let at = start; at < end; at += step) {
    if (
      !protectedRanges.some((s) => +s.startsAt < at + step && +s.endsAt > at)
    ) {
      slots.push({ startsAt: new Date(at), endsAt: new Date(at + step) });
    }
  }
  return slots;
}

export function parseInstant(value: string): number {
  if (
    typeof value !== 'string' ||
    !isISO8601(value, { strict: true }) ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new BadRequestException(
      'Timestamp must be a valid ISO instant with an explicit offset',
    );
  }
  return Date.parse(value);
}
