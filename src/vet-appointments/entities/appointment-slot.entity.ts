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
  Exclusion,
} from 'typeorm';
import { VetSlotStatus } from '../vet-appointment.enums';

// SQL migrations own these tables, including triggers and deferred constraints.
@Entity({ name: 'vet_appointment_slots', synchronize: false })
@Check(
  'CHK_vet_slots_status',
  "\"status\" IN ('AVAILABLE', 'BLOCKED', 'CANCELLED')",
)
@Check(
  'CHK_vet_slots_time',
  'isfinite("startsAt") AND isfinite("endsAt") AND "startsAt" < "endsAt"',
)
@Index('UQ_vet_slots_doctor_start_non_cancelled', ['doctorId', 'startsAt'], {
  unique: true,
  where: '"status" <> \'CANCELLED\'',
})
@Unique('UQ_vet_slots_id_doctor', ['id', 'doctorId'])
@ForeignKey(
  'vet_availability_windows',
  ['availabilityWindowId', 'doctorId'],
  ['id', 'doctorId'],
  { name: 'FK_vet_slots_window_doctor', onDelete: 'RESTRICT' },
)
@Index('IDX_vet_slots_window', ['availabilityWindowId', 'startsAt'], {})
@Index('IDX_vet_slots_available', ['startsAt', 'doctorId'], {
  where: '"status" = \'AVAILABLE\'',
})
@Exclusion(
  'EX_vet_slots_doctor_overlap',
  'USING gist ("doctorId" WITH =, tstzrange("startsAt", "endsAt", \'[)\') WITH &&) WHERE ("status" <> \'CANCELLED\')',
)
export class VetAppointmentSlot {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'vet_appointment_slots_pkey',
  })
  id: string;

  @Column({ type: 'uuid' })
  availabilityWindowId: string;

  @Column({ type: 'uuid' })
  doctorId: string;

  @Column({ type: 'timestamptz' })
  startsAt: Date;

  @Column({ type: 'timestamptz' })
  endsAt: Date;

  @Column({ type: 'varchar', length: 32, default: 'AVAILABLE' })
  status: VetSlotStatus;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
