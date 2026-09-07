import {
  Check,
  Column,
  Entity,
  PrimaryGeneratedColumn,
  Index,
  Unique,
  ForeignKey,
} from 'typeorm';
import { VetFreeScope } from '../vet-appointment.enums';

// SQL migrations own these tables, including triggers and deferred constraints.
@Entity({ name: 'vet_free_consultation_claims', synchronize: false })
@Check('CHK_vet_claims_scope', "\"subjectType\" IN ('OWNER', 'PASSPORT')")
@Check('CHK_vet_claims_policy', 'length(btrim("policyVersion")) > 0')
@Check(
  'CHK_vet_claims_subject',
  '("subjectType" = \'OWNER\' AND "ownerUserId" IS NOT NULL AND "birdPassportId" IS NULL) OR ("subjectType" = \'PASSPORT\' AND "ownerUserId" IS NULL AND "birdPassportId" IS NOT NULL)',
)
@Unique('UQ_vet_claims_appointment', ['appointmentId'])
@ForeignKey('vet_appointments', ['appointmentId'], ['id'], {
  name: 'FK_vet_claims_appointment',
  onDelete: 'RESTRICT',
})
@ForeignKey('users', ['ownerUserId'], ['id'], {
  name: 'FK_vet_claims_owner',
  onDelete: 'RESTRICT',
})
@ForeignKey('bird_passports', ['birdPassportId'], ['id'], {
  name: 'FK_vet_claims_passport',
  onDelete: 'RESTRICT',
})
@Index('UQ_vet_claims_owner_policy', ['policyVersion', 'ownerUserId'], {
  unique: true,
  where: '"subjectType" = \'OWNER\'',
})
@Index('UQ_vet_claims_passport_policy', ['policyVersion', 'birdPassportId'], {
  unique: true,
  where: '"subjectType" = \'PASSPORT\'',
})
export class VetFreeConsultationClaim {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'vet_free_consultation_claims_pkey',
  })
  id: string;

  @Column({ type: 'varchar', length: 64 })
  policyVersion: string;

  @Column({ type: 'varchar', length: 32, default: 'OWNER' })
  subjectType: VetFreeScope;

  @Column({ type: 'uuid', nullable: true })
  ownerUserId: string | null;

  @Column({ type: 'uuid', nullable: true })
  birdPassportId: string | null;

  @Column({ type: 'uuid' })
  appointmentId: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  claimedAt: Date;
}
