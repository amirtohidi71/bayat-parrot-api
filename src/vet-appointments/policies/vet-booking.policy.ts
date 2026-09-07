import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VetFreeScope } from '../vet-appointment.enums';

export const VET_PAYMENT_COMING_SOON = 'VET_PAYMENT_COMING_SOON';
export const VET_PAYMENT_COMING_SOON_MESSAGE =
  'پرداخت آنلاین به‌زودی فعال می‌شود';
export const VET_DEFAULT_POLICY_VERSION = 'vet-first-free-v1';

/** Day 2 consumes this configuration inside a transaction, never from a client DTO. */
@Injectable()
export class VetBookingPolicy {
  readonly firstFreeScope: VetFreeScope;
  readonly version: string;
  // Intentionally not configurable until the gateway and its DB migration exist.
  readonly paymentsAvailable = false;

  constructor(config: ConfigService) {
    const scope =
      config.get<string>('VET_FIRST_FREE_SCOPE') ?? VetFreeScope.OWNER;
    if (!Object.values(VetFreeScope).includes(scope as VetFreeScope)) {
      throw new Error('VET_FIRST_FREE_SCOPE must be OWNER or PASSPORT');
    }
    this.firstFreeScope = scope as VetFreeScope;
    this.version =
      config.get<string>('VET_FIRST_FREE_POLICY_VERSION') ??
      VET_DEFAULT_POLICY_VERSION;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(this.version)) {
      throw new Error('VET_FIRST_FREE_POLICY_VERSION is invalid');
    }
  }

  paymentUnavailableResult() {
    return {
      code: VET_PAYMENT_COMING_SOON,
      message: VET_PAYMENT_COMING_SOON_MESSAGE,
      paymentRequired: true,
      paymentAvailable: false,
      appointmentId: null,
      holdExpiresAt: null,
    } as const;
  }
}
