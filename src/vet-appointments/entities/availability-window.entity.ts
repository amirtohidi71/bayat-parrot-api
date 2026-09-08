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
import { VetAvailabilityStatus } from '../vet-appointment.enums';

// SQL migrations own these tables, including triggers and deferred constraints.
@Entity({ name: 'vet_availability_windows', synchronize: false })
@Check(
  'CHK_vet_windows_status',
  "\"status\" IN ('ACTIVE', 'CANCELLED', 'RETIRED')",
)
@Check(
  'CHK_vet_windows_time',
  'isfinite("startsAt") AND isfinite("endsAt") AND "startsAt" < "endsAt" AND "endsAt" - "startsAt" <= interval \'1 day\'',
)
@Check('CHK_vet_windows_timezone', '"timeZone" = \'Asia/Tehran\'')
@Check(
  'CHK_vet_windows_duration',
  '"slotDurationMinutes" BETWEEN 1 AND 1440 AND mod(extract(epoch FROM ("endsAt" - "startsAt")), "slotDurationMinutes" * 60) = 0',
)
@Check(
  'CHK_vet_windows_minutes',
  'extract(second FROM "startsAt") = 0 AND extract(second FROM "endsAt") = 0',
)
@Check('CHK_vet_windows_admin', 'length(btrim("createdByAdmin")) > 0')
@Unique('UQ_vet_windows_id_doctor', ['id', 'doctorId'])
@ForeignKey('vet_doctors', ['doctorId'], ['id'], {
  name: 'FK_vet_windows_doctor',
  onDelete: 'RESTRICT',
})
@Index('IDX_vet_windows_doctor_time', ['doctorId', 'startsAt'], {})
@Exclusion(
  'EX_vet_windows_doctor_overlap',
  'USING gist ("doctorId" WITH =, tstzrange("startsAt", "endsAt", \'[)\') WITH &&) WHERE ("status" = \'ACTIVE\')',
)
export class VetAvailabilityWindow {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'vet_availability_windows_pkey',
  })
  id: string;

  @Column({ type: 'uuid' })
  doctorId: string;

  @Column({ type: 'timestamptz' })
  startsAt: Date;

  @Column({ type: 'timestamptz' })
  endsAt: Date;

  @Column({ type: 'varchar', length: 64, default: 'Asia/Tehran' })
  timeZone: string;

  @Column({ type: 'integer' })
  slotDurationMinutes: number;

  @Column({ type: 'varchar', length: 32, default: 'ACTIVE' })
  status: VetAvailabilityStatus;

  @Column({ type: 'varchar', length: 50 })
  createdByAdmin: string;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
