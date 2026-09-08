import { VetAvailabilityWindow } from '../entities/availability-window.entity';
import { VetAppointmentSlot } from '../entities/appointment-slot.entity';

// Explicit projections also protect against accidentally loaded relations.
export class AvailabilityResponseDto {
  static from(this: void, w: VetAvailabilityWindow) {
    return {
      id: w.id,
      doctorId: w.doctorId,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      slotDurationMinutes: w.slotDurationMinutes,
      timeZone: w.timeZone,
      status: w.status,
      createdByAdmin: w.createdByAdmin,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  }
}

export class AvailabilitySlotResponseDto {
  static from(this: void, s: VetAppointmentSlot) {
    return {
      id: s.id,
      availabilityWindowId: s.availabilityWindowId,
      doctorId: s.doctorId,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }
}
