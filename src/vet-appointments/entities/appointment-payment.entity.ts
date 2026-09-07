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
import { VetPaymentStatus } from '../vet-appointment.enums';

// SQL migrations own these tables, including triggers and deferred constraints.
@Entity({ name: 'vet_appointment_payments', synchronize: false })
@Check(
  'CHK_vet_payments_status',
  "\"status\" IN ('CREATED', 'PENDING', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'REFUND_REQUIRED', 'REFUNDED')",
)
@Check('CHK_vet_payments_amount', '"amountMinor" > 0')
@Check('CHK_vet_payments_currency', '"currency" ~ \'^[A-Z]{3}$\'')
@Check('CHK_vet_payments_provider', 'length(btrim("provider")) > 0')
@Check(
  'CHK_vet_payments_verified',
  '"status" NOT IN (\'SUCCEEDED\', \'REFUND_REQUIRED\', \'REFUNDED\') OR ("verifiedAt" IS NOT NULL AND "providerReference" IS NOT NULL)',
)
@Unique('UQ_vet_payments_retry', ['appointmentId', 'clientRequestId'])
@ForeignKey('vet_appointments', ['appointmentId'], ['id'], {
  name: 'FK_vet_payments_appointment',
  onDelete: 'RESTRICT',
})
@Index('UQ_vet_payments_authority', ['provider', 'providerAuthority'], {
  unique: true,
  where: '"providerAuthority" IS NOT NULL',
})
@Index('UQ_vet_payments_reference', ['provider', 'providerReference'], {
  unique: true,
  where: '"providerReference" IS NOT NULL',
})
@Index('UQ_vet_payments_success', ['appointmentId'], {
  unique: true,
  where: '"status" = \'SUCCEEDED\'',
})
@Index('IDX_vet_payments_reconcile', ['status', 'updatedAt'], {})
export class VetAppointmentPayment {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'vet_appointment_payments_pkey',
  })
  id: string;

  @Column({ type: 'uuid' })
  appointmentId: string;

  @Column({ type: 'uuid' })
  clientRequestId: string;

  @Column({ type: 'varchar', length: 50 })
  provider: string;

  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  providerAuthority: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  providerReference: string | null;

  @Column({ type: 'bigint' })
  // PostgreSQL bigint is returned as a string; never round money through Number.
  amountMinor: string;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 32, default: 'CREATED' })
  status: VetPaymentStatus;

  @Column({ type: 'varchar', length: 100, nullable: true })
  failureCode: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  requestedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  verificationLeaseExpiresAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
