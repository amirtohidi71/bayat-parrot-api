import {
  VetAppointmentStatus,
  VetPricingKind,
  VetVideoStatus,
} from '../vet-appointment.enums';

export type VetAppointmentSource =
  | 'ADMIN_MANUAL'
  | 'CUSTOMER_FIRST_FREE'
  | 'CUSTOMER_PAID';

export type VetVideoEligibilityState =
  | 'NOT_ELIGIBLE'
  | 'TOO_EARLY'
  | 'OPEN'
  | 'UNAVAILABLE'
  | 'CLOSED';

export interface VetAppointmentDashboardRow {
  appointmentId: string;
  publicReference: string;
  status: VetAppointmentStatus;
  pricingKind: VetPricingKind;
  source: VetAppointmentSource;
  customerUserId: string;
  customerName: string;
  doctorId: string;
  doctorName: string;
  slotId: string | null;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  passportCode: string | null;
  birdName: string | null;
  birdSpecies: string | null;
  confirmedAt: Date | string | null;
  createdAt: Date | string;
  doctorActive: boolean;
  roomStatus: VetVideoStatus | null;
  providerEndDate: Date | string | null;
  dbNow: Date | string;
}

export interface VetVideoProjection {
  eligible: boolean;
  joinAllowedNow: boolean;
  state: VetVideoEligibilityState;
  roomStatus: VetVideoStatus | null;
  opensAt: string | null;
  closesAt: string | null;
}

type DashboardAudience = 'customer' | 'doctor' | 'admin';

/** Explicit dashboard allowlist. Raw query rows and entities are never serialized. */
export class VetAppointmentDashboardResponseDto {
  static from(
    row: VetAppointmentDashboardRow,
    audience: DashboardAudience,
    video: VetVideoProjection,
  ) {
    const result: Record<string, unknown> = {
      appointmentId: row.appointmentId,
      publicReference: row.publicReference,
      status: row.status,
      source: row.source,
      pricingKind: row.pricingKind,
      slot: row.slotId
        ? {
            id: row.slotId,
            startsAt: VetAppointmentDashboardResponseDto.iso(row.startsAt),
            endsAt: VetAppointmentDashboardResponseDto.iso(row.endsAt),
          }
        : null,
      doctor: {
        id: row.doctorId,
        displayName: row.doctorName,
      },
      passport: row.passportCode
        ? {
            code: row.passportCode,
            birdName: row.birdName,
            species: row.birdSpecies,
          }
        : null,
      video,
      confirmedAt: VetAppointmentDashboardResponseDto.iso(row.confirmedAt),
      createdAt: VetAppointmentDashboardResponseDto.iso(row.createdAt),
    };

    if (audience === 'doctor') {
      result.customer = { displayName: row.customerName };
    } else if (audience === 'admin') {
      result.customer = {
        id: row.customerUserId,
        displayName: row.customerName,
      };
    }

    return result;
  }

  private static iso(value: Date | string | null): string | null {
    return value ? new Date(value).toISOString() : null;
  }
}

export class VetAppointmentDashboardListResponseDto {
  static from(items: unknown[], page: number, pageSize: number, total: number) {
    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      },
    };
  }
}
