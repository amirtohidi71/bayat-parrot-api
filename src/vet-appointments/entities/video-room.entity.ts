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
import { VetVideoStatus } from '../vet-appointment.enums';

// SQL migrations own these tables, including triggers and deferred constraints.
@Entity({ name: 'vet_video_rooms', synchronize: false })
@Check(
  'CHK_vet_video_status',
  "\"status\" IN ('NOT_CREATED', 'CREATING', 'READY', 'FAILED', 'EXPIRED', 'DELETED')",
)
@Check('CHK_vet_video_attempts', '"attemptCount" >= 0')
@Check('CHK_vet_video_provider', "\"provider\" IN ('WHEREBY', 'INTERNAL')")
@Check(
  'CHK_vet_video_ready',
  '"status" <> \'READY\' OR ("providerMeetingId" IS NOT NULL AND "providerEndDate" IS NOT NULL AND (("provider" = \'WHEREBY\' AND "guestUrlCiphertext" IS NOT NULL AND "hostUrlCiphertext" IS NOT NULL) OR ("provider" = \'INTERNAL\' AND "guestUrlCiphertext" IS NULL AND "hostUrlCiphertext" IS NULL)))',
)
@Check(
  'CHK_vet_video_ciphertexts',
  '("guestUrlCiphertext" IS NULL OR "guestUrlCiphertext" ~ \'^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$\') AND ("hostUrlCiphertext" IS NULL OR "hostUrlCiphertext" ~ \'^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$\')',
)
@Check(
  'CHK_vet_video_lease',
  '"status" <> \'CREATING\' OR "creationLeaseExpiresAt" IS NOT NULL',
)
@Unique('UQ_vet_video_appointment', ['appointmentId'])
@ForeignKey('vet_appointments', ['appointmentId'], ['id'], {
  name: 'FK_vet_video_appointment',
  onDelete: 'RESTRICT',
})
@Index('UQ_vet_video_meeting', ['provider', 'providerMeetingId'], {
  unique: true,
  where: '"providerMeetingId" IS NOT NULL',
})
@Index('IDX_vet_video_cleanup', ['status', 'providerEndDate'], {})
export class VetVideoRoom {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'vet_video_rooms_pkey',
  })
  id: string;

  @Column({ type: 'uuid' })
  appointmentId: string;

  @Column({ type: 'varchar', length: 50, default: 'WHEREBY' })
  provider: string;

  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  providerMeetingId: string | null;

  @Column({ type: 'varchar', length: 32, default: 'NOT_CREATED' })
  status: VetVideoStatus;

  @Column({ type: 'text', nullable: true, select: false })
  guestUrlCiphertext: string | null;

  @Column({ type: 'text', nullable: true, select: false })
  hostUrlCiphertext: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  providerEndDate: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  creationLeaseExpiresAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  attemptCount: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastErrorCode: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
