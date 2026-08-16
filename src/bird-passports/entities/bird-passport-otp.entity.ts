import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BirdPassport } from './bird-passport.entity';

export const BIRD_PASSPORT_OTP_PURPOSE = 'bird-passport-lookup';

@Entity('bird_passport_otps')
@Index('IDX_bird_passport_otps_lookup', [
  'birdPassportId',
  'phone',
  'consumed',
  'createdAt',
])
@Index('IDX_bird_passport_otps_expiry', ['expiresAt'])
@Check('CHK_bird_passport_otps_phone_format', '"phone" ~ \'^09[0-9]{9}$\'')
@Check('CHK_bird_passport_otps_attempts', '"attempts" >= 0')
@Check(
  'CHK_bird_passport_otps_purpose',
  `"purpose" = '${BIRD_PASSPORT_OTP_PURPOSE}'`,
)
export class BirdPassportOtp {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'bird_passport_otps_pkey',
  })
  id: string;

  @Column({ type: 'uuid' })
  birdPassportId: string;

  @ManyToOne(() => BirdPassport, (passport) => passport.otps, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'birdPassportId',
    foreignKeyConstraintName: 'FK_bird_passport_otps_passport',
  })
  birdPassport: BirdPassport;

  @Column({ type: 'varchar', length: 11 })
  phone: string;

  @Column({ type: 'varchar', default: BIRD_PASSPORT_OTP_PURPOSE })
  purpose: string;

  @Column({ type: 'varchar' })
  codeHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ type: 'boolean', default: false })
  consumed: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
