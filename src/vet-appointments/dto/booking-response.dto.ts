import { VetAppointment } from '../entities/appointment.entity';
import { VetAppointmentSlot } from '../entities/appointment-slot.entity';

/** Explicit customer allowlist. Never serialize a vet appointment entity. */
export class VetBookingResponseDto {
  static from(
    this: void,
    appointment: VetAppointment,
    slot: Pick<VetAppointmentSlot, 'id' | 'startsAt' | 'endsAt'>,
  ) {
    return {
      appointmentId: appointment.id,
      publicReference: appointment.publicReference,
      bookingRequestId: appointment.bookingRequestId,
      status: appointment.status,
      pricing: {
        kind: appointment.pricingKind,
        feeAmountMinor: appointment.feeAmountMinor,
        currency: appointment.currency,
        ruleVersion: appointment.pricingRuleVersion,
      },
      slot: {
        id: slot.id,
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
      },
      doctor: {
        id: appointment.doctorId,
        displayName: appointment.doctorNameSnapshot,
      },
      passport: appointment.birdPassportId
        ? {
            code: appointment.passportCodeSnapshot,
            birdName: appointment.birdNameSnapshot,
            species: appointment.birdSpeciesSnapshot,
          }
        : null,
      confirmedAt: appointment.confirmedAt?.toISOString() ?? null,
    };
  }
}
