export enum VetAvailabilityStatus {
  ACTIVE = 'ACTIVE',
  CANCELLED = 'CANCELLED',
  RETIRED = 'RETIRED',
}

export enum VetSlotStatus {
  AVAILABLE = 'AVAILABLE',
  BLOCKED = 'BLOCKED',
  CANCELLED = 'CANCELLED',
}

export enum VetAppointmentStatus {
  PAYMENT_UNAVAILABLE = 'PAYMENT_UNAVAILABLE',
  PAYMENT_PENDING = 'PAYMENT_PENDING',
  EXPIRED = 'EXPIRED',
  PAYMENT_REVIEW = 'PAYMENT_REVIEW',
  CONFIRMED = 'CONFIRMED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  NO_SHOW = 'NO_SHOW',
}

export enum VetPricingKind {
  FREE = 'FREE',
  PAID = 'PAID',
}

export enum VetFreeScope {
  OWNER = 'OWNER',
  PASSPORT = 'PASSPORT',
}

export enum VetPaymentStatus {
  CREATED = 'CREATED',
  PENDING = 'PENDING',
  VERIFYING = 'VERIFYING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  REFUND_REQUIRED = 'REFUND_REQUIRED',
  REFUNDED = 'REFUNDED',
}

export enum VetVideoStatus {
  NOT_CREATED = 'NOT_CREATED',
  CREATING = 'CREATING',
  READY = 'READY',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
  DELETED = 'DELETED',
}

export enum VetNotificationStatus {
  PENDING = 'PENDING',
  SENDING = 'SENDING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}

export enum VetRecipientType {
  CUSTOMER = 'CUSTOMER',
  DOCTOR = 'DOCTOR',
  ADMIN = 'ADMIN',
}

export enum VetActorType {
  CUSTOMER = 'CUSTOMER',
  DOCTOR = 'DOCTOR',
  ADMIN = 'ADMIN',
  SYSTEM = 'SYSTEM',
}
