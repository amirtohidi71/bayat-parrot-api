import {
  Check,
  Column,
  Entity,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  Unique,
  ForeignKey,
} from 'typeorm';
import { VetActorType, VetAppointmentStatus } from '../vet-appointment.enums';

// SQL migrations own these tables, including triggers and deferred constraints.
@Entity({ name: 'vet_appointment_events', synchronize: false })
@Check(
  'CHK_vet_events_actor',
  "\"actorType\" IN ('CUSTOMER', 'DOCTOR', 'ADMIN', 'SYSTEM')",
)
@Check(
  'CHK_vet_events_previous',
  "\"previousStatus\" IN ('PAYMENT_UNAVAILABLE', 'PAYMENT_PENDING', 'EXPIRED', 'PAYMENT_REVIEW', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')",
)
@Check(
  'CHK_vet_events_new',
  "\"newStatus\" IN ('PAYMENT_UNAVAILABLE', 'PAYMENT_PENDING', 'EXPIRED', 'PAYMENT_REVIEW', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')",
)
@Check(
  'CHK_vet_events_actor_id',
  '("actorType" = \'SYSTEM\' AND "actorId" IS NULL) OR ("actorType" <> \'SYSTEM\' AND "actorId" IS NOT NULL)',
)
@Check(
  'CHK_vet_events_type',
  '"eventType" ~ \'^[A-Z][A-Z0-9_]{1,63}$\' AND length(btrim("eventKey")) > 0',
)
@Check(
  'CHK_vet_events_metadata',
  "jsonb_typeof(\"metadata\") = 'object' AND NOT (\"metadata\" ?| ARRAY['nationalId', 'nationalIdCiphertext', 'password', 'passwordHash', 'guestUrl', 'hostUrl', 'roomUrl', 'token'])",
)
@Unique('UQ_vet_events_key', ['appointmentId', 'eventKey'])
@ForeignKey('vet_appointments', ['appointmentId'], ['id'], {
  name: 'FK_vet_events_appointment',
  onDelete: 'RESTRICT',
})
@Index('IDX_vet_events_timeline', ['appointmentId', 'createdAt', 'id'], {})
export class VetAppointmentEvent {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'vet_appointment_events_pkey',
  })
  id: string;

  @Column({ type: 'uuid' })
  appointmentId: string;

  @Column({ type: 'varchar', length: 64 })
  eventType: string;

  @Column({ type: 'varchar', length: 100 })
  eventKey: string;

  @Column({ type: 'varchar', length: 32 })
  actorType: VetActorType;

  @Column({ type: 'varchar', length: 100, nullable: true })
  actorId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  previousStatus: VetAppointmentStatus | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  newStatus: VetAppointmentStatus | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
