import { VetAppointment } from '../entities/appointment.entity';
import { VetAppointmentSlot } from '../entities/appointment-slot.entity';

export class AdminManualVetAssignmentResponseDto {
  static from(
    this: void,
    appointment: VetAppointment,
    slot: Pick<VetAppointmentSlot, 'id' | 'startsAt' | 'endsAt'>,
  ) {
    return {
      appointmentId: appointment.id,
      publicReference: appointment.publicReference,
      assignmentSource: 'ADMIN_MANUAL',
      status: appointment.status,
      customer: {
        id: appointment.customerUserId,
        fullName: appointment.ownerFullNameSnapshot,
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
      pricing: {
        kind: appointment.pricingKind,
        feeAmountMinor: appointment.feeAmountMinor,
        currency: appointment.currency,
        ruleVersion: appointment.pricingRuleVersion,
      },
      confirmedAt: appointment.confirmedAt?.toISOString() ?? null,
    };
  }
}
