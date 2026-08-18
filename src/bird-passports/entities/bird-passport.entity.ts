import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { BirdFeedingRecord } from './bird-feeding-record.entity';
import { BirdPassportOtp } from './bird-passport-otp.entity';
import { BirdVaccineRecord } from './bird-vaccine-record.entity';
import { BirdVeterinaryVisit } from './bird-veterinary-visit.entity';
import {
  BIRD_PASSPORT_BIRD_NAME_MAX_LENGTH,
  BIRD_PASSPORT_OWNER_FULL_NAME_MAX_LENGTH,
} from '../bird-passport-metadata';

export enum BirdPassportStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

@Entity('bird_passports')
@Unique('UQ_bird_passports_code', ['code'])
@Index('IDX_bird_passports_status', ['status'])
@Check('CHK_bird_passports_code_format', '"code" ~ \'^B[0-9]{8}$\'')
@Check(
  'CHK_bird_passports_owner_mobile_format',
  '"ownerMobile" ~ \'^09[0-9]{9}$\'',
)
export class BirdPassport {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'bird_passports_pkey',
  })
  id: string;

  @Column({ type: 'varchar', length: 9 })
  code: string;

  @Column({ type: 'varchar', length: 11 })
  ownerMobile: string;

  @Column({
    type: 'varchar',
    length: BIRD_PASSPORT_OWNER_FULL_NAME_MAX_LENGTH,
    nullable: true,
  })
  ownerFullName: string | null;

  @Column({
    type: 'varchar',
    length: BIRD_PASSPORT_BIRD_NAME_MAX_LENGTH,
    nullable: true,
  })
  birdName: string | null;

  @Column({ type: 'text', nullable: true })
  imagePath: string | null;

  @Column({ type: 'date' })
  birthDate: string;

  @Column({ type: 'varchar' })
  species: string;

  @Column({ type: 'varchar' })
  subspecies: string;

  @Column({
    type: 'enum',
    enum: BirdPassportStatus,
    enumName: 'bird_passports_status_enum',
    default: BirdPassportStatus.DRAFT,
  })
  status: BirdPassportStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => BirdVaccineRecord, (record) => record.passport)
  vaccineRecords: BirdVaccineRecord[];

  @OneToMany(() => BirdFeedingRecord, (record) => record.passport)
  feedingRecords: BirdFeedingRecord[];

  @OneToMany(() => BirdVeterinaryVisit, (visit) => visit.passport)
  veterinaryVisits: BirdVeterinaryVisit[];

  @OneToMany(() => BirdPassportOtp, (otp) => otp.birdPassport)
  otps: BirdPassportOtp[];
}
