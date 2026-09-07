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
  VetRecipientType,
  VetNotificationStatus,
} from '../vet-appointment.enums';

// SQL migrations own these tables, including triggers and deferred constraints.
@Entity({ name: 'vet_notification_outbox', synchronize: false })
@Check(
  'CHK_vet_outbox_recipient',
  "\"recipientType\" IN ('CUSTOMER', 'DOCTOR', 'ADMIN')",
)
@Check(
  'CHK_vet_outbox_status',
  "\"status\" IN ('PENDING', 'SENDING', 'DELIVERED', 'FAILED')",
)
@Check('CHK_vet_outbox_phone', '"recipientPhoneSnapshot" ~ \'^09[0-9]{9}$\'')
@Check('CHK_vet_outbox_attempts', '"attemptCount" >= 0')
@Check(
  'CHK_vet_outbox_type',
  'length(btrim("notificationType")) > 0 AND length(btrim("template")) > 0',
)
@Check(
  'CHK_vet_outbox_payload',
  "jsonb_typeof(\"payload\") = 'object' AND NOT (\"payload\" ?| ARRAY['nationalId', 'nationalIdCiphertext', 'password', 'passwordHash', 'guestUrl', 'hostUrl', 'roomUrl', 'token'])",
)
@Check(
  'CHK_vet_outbox_delivery',
  '("status" = \'DELIVERED\' AND "deliveredAt" IS NOT NULL) OR ("status" <> \'DELIVERED\' AND "deliveredAt" IS NULL)',
)
@Check(
  'CHK_vet_outbox_lease',
  '"status" <> \'SENDING\' OR "leaseExpiresAt" IS NOT NULL',
)
@Unique('UQ_vet_outbox_delivery', [
  'appointmentId',
  'notificationType',
  'recipientType',
  'recipientPhoneSnapshot',
])
@ForeignKey('vet_appointments', ['appointmentId'], ['id'], {
  name: 'FK_vet_outbox_appointment',
  onDelete: 'RESTRICT',
})
@Index('IDX_vet_outbox_due', ['nextAttemptAt', 'id'], {
  where: "\"status\" IN ('PENDING', 'FAILED')",
})
@Index('IDX_vet_outbox_lease', ['leaseExpiresAt'], {
  where: '"status" = \'SENDING\'',
})
export class VetNotificationOutbox {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'vet_notification_outbox_pkey',
  })
  id: string;

  @Column({ type: 'uuid' })
  appointmentId: string;

  @Column({ type: 'varchar', length: 32 })
  recipientType: VetRecipientType;

  @Column({ type: 'varchar', length: 11, select: false })
  recipientPhoneSnapshot: string;

  @Column({ type: 'varchar', length: 64 })
  notificationType: string;

  @Column({ type: 'varchar', length: 100 })
  template: string;

  @Column({ type: 'jsonb', select: false, default: () => "'{}'::jsonb" })
  payload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 32, default: 'PENDING' })
  status: VetNotificationStatus;

  @Column({ type: 'integer', default: 0 })
  attemptCount: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastErrorCode: string | null;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
