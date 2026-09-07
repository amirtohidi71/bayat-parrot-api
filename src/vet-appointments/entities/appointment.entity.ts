import {
  Check,
  Column,
  Entity,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
  ForeignKey,
} from 'typeorm';
import {
  VetAppointmentStatus,
  VetPricingKind,
  VetActorType,
} from '../vet-appointment.enums';

// SQL migrations own these tables, including triggers and deferred constraints.
@Entity({ name: 'vet_appointments', synchronize: false })
@Check(
  'CHK_vet_appointments_status',
  "\"status\" IN ('PAYMENT_UNAVAILABLE', 'PAYMENT_PENDING', 'EXPIRED', 'PAYMENT_REVIEW', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')",
)
@Check('CHK_vet_appointments_pricing', "\"pricingKind\" IN ('FREE', 'PAID')")
@Check(
  'CHK_vet_appointments_cancel_actor',
  "\"cancelledByType\" IN ('CUSTOMER', 'DOCTOR', 'ADMIN', 'SYSTEM')",
)
@Check(
  'CHK_vet_appointments_reference',
  '"publicReference" ~ \'^V[A-Z0-9]{12,39}$\'',
)
@Check('CHK_vet_appointments_currency', '"currency" ~ \'^[A-Z]{3}$\'')
@Check('CHK_vet_appointments_rule', 'length(btrim("pricingRuleVersion")) > 0')
@Check(
  'CHK_vet_appointments_names',
  'length(btrim("ownerFullNameSnapshot")) > 0 AND length(btrim("doctorNameSnapshot")) > 0',
)
@Check(
  'CHK_vet_appointments_mobile',
  '"ownerMobileSnapshot" ~ \'^09[0-9]{9}$\'',
)
@Check(
  'CHK_vet_appointments_national_id',
  '"nationalIdLast4" ~ \'^[0-9]{4}$\' AND "nationalIdCiphertext" ~ \'^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{14}$\'',
)
@Check(
  'CHK_vet_appointments_passport',
  '("birdPassportId" IS NULL AND "passportCodeSnapshot" IS NULL AND "birdNameSnapshot" IS NULL AND "birdSpeciesSnapshot" IS NULL AND "passportOwnerFullNameSnapshot" IS NULL) OR ("birdPassportId" IS NOT NULL AND "passportCodeSnapshot" IS NOT NULL AND "passportCodeSnapshot" ~ \'^B[0-9]{8}$\' AND "birdNameSnapshot" IS NOT NULL AND length(btrim("birdNameSnapshot")) > 0 AND "birdSpeciesSnapshot" IS NOT NULL AND length(btrim("birdSpeciesSnapshot")) > 0 AND "passportOwnerFullNameSnapshot" IS NOT NULL AND length(btrim("passportOwnerFullNameSnapshot")) > 0)',
)
@Check(
  'CHK_vet_appointments_pricing_amount',
  '("pricingKind" = \'FREE\' AND "feeAmountMinor" = 0) OR ("pricingKind" = \'PAID\' AND "feeAmountMinor" > 0)',
)
@Check(
  'CHK_vet_appointments_v1_no_gateway',
  '("pricingKind" = \'FREE\' AND "slotId" IS NOT NULL AND "status" IN (\'CONFIRMED\', \'COMPLETED\', \'CANCELLED\', \'NO_SHOW\') AND "confirmedAt" IS NOT NULL AND "holdExpiresAt" IS NULL) OR ("pricingKind" = \'PAID\' AND "status" = \'PAYMENT_UNAVAILABLE\' AND "slotId" IS NULL AND "holdExpiresAt" IS NULL AND "confirmedAt" IS NULL)',
)
@Check(
  'CHK_vet_appointments_completion',
  '("status" = \'COMPLETED\' AND "completedAt" IS NOT NULL AND "completedAt" >= "confirmedAt") OR ("status" <> \'COMPLETED\' AND "completedAt" IS NULL)',
)
@Check(
  'CHK_vet_appointments_cancellation',
  '("status" = \'CANCELLED\' AND "cancelledAt" IS NOT NULL AND "cancelledByType" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancellationReason" IS NOT NULL AND length(btrim("cancellationReason")) > 0) OR ("status" <> \'CANCELLED\' AND "cancelledAt" IS NULL AND "cancelledByType" IS NULL AND "cancelledById" IS NULL AND "cancellationReason" IS NULL)',
)
@Unique('UQ_vet_appointments_reference', ['publicReference'])
@Unique('UQ_vet_appointments_booking_retry', [
  'customerUserId',
  'bookingRequestId',
])
@ForeignKey('users', ['customerUserId'], ['id'], {
  name: 'FK_vet_appointments_customer',
  onDelete: 'RESTRICT',
})
@ForeignKey('vet_doctors', ['doctorId'], ['id'], {
  name: 'FK_vet_appointments_doctor',
  onDelete: 'RESTRICT',
})
@ForeignKey(
  'vet_appointment_slots',
  ['slotId', 'doctorId'],
  ['id', 'doctorId'],
  { name: 'FK_vet_appointments_slot_doctor', onDelete: 'RESTRICT' },
)
@ForeignKey('bird_passports', ['birdPassportId'], ['id'], {
  name: 'FK_vet_appointments_passport',
  onDelete: 'RESTRICT',
})
@Index('UQ_vet_appointments_slot_occupant', ['slotId'], {
  unique: true,
  where:
    "\"status\" IN ('PAYMENT_PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW')",
})
@Index(
  'IDX_vet_appointments_customer',
  ['customerUserId', 'createdAt', 'id'],
  {},
)
@Index('IDX_vet_appointments_doctor', ['doctorId', 'status', 'createdAt'], {})
@Index('IDX_vet_appointments_hold_expiry', ['holdExpiresAt'], {
  where: '"status" = \'PAYMENT_PENDING\'',
})
@Index('IDX_vet_appointments_passport', ['birdPassportId'], {})
export class VetAppointment {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'vet_appointments_pkey',
  })
  id: string;

  @Column({ type: 'varchar', length: 40 })
  publicReference: string;

  @Column({ type: 'uuid' })
  bookingRequestId: string;

  @Column({ type: 'uuid' })
  customerUserId: string;

  @Column({ type: 'uuid', nullable: true })
  slotId: string | null;

  @Column({ type: 'uuid' })
  doctorId: string;

  @Column({ type: 'uuid', nullable: true })
  birdPassportId: string | null;

  @Column({ type: 'varchar', length: 32 })
  status: VetAppointmentStatus;

  @Column({ type: 'varchar', length: 32 })
  pricingKind: VetPricingKind;

  @Column({ type: 'bigint' })
  // PostgreSQL bigint is returned as a string; never round money through Number.
  feeAmountMinor: string;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 64 })
  pricingRuleVersion: string;

  @Column({ type: 'timestamptz', nullable: true })
  holdExpiresAt: Date | null;

  @Column({ type: 'varchar', length: 150 })
  ownerFullNameSnapshot: string;

  @Column({ type: 'varchar', length: 11 })
  ownerMobileSnapshot: string;

  @Column({ type: 'varchar', length: 150 })
  doctorNameSnapshot: string;

  @Column({ type: 'varchar', length: 9, nullable: true })
  passportCodeSnapshot: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  birdNameSnapshot: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  birdSpeciesSnapshot: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  passportOwnerFullNameSnapshot: string | null;

  @Column({ type: 'varchar', length: 500, select: false })
  nationalIdCiphertext: string;

  @Column({ type: 'varchar', length: 4 })
  nationalIdLast4: string;

  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  cancelledByType: VetActorType | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  cancelledById: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  cancellationReason: string | null;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
