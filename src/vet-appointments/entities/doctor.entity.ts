import {
  Check,
  Column,
  Entity,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

// SQL migrations own these tables, including triggers and deferred constraints.
@Entity({ name: 'vet_doctors', synchronize: false })
@Check('CHK_vet_doctors_username', '"username" ~ \'^[A-Za-z0-9_]{3,50}$\'')
@Check(
  'CHK_vet_doctors_password_hash',
  '"passwordHash" ~ \'^\\$2[aby]\\$(1[0-6])\\$[./A-Za-z0-9]{53}$\'',
)
@Check('CHK_vet_doctors_display_name', 'length(btrim("displayName")) > 0')
@Check('CHK_vet_doctors_mobile', '"mobile" ~ \'^09[0-9]{9}$\'')
@Check('CHK_vet_doctors_fee', '"consultationFeeMinor" >= 0')
@Check('CHK_vet_doctors_currency', '"currency" ~ \'^[A-Z]{3}$\'')
@Unique('UQ_vet_doctors_mobile', ['mobile'])
@Index('UQ_vet_doctors_username_ci', { synchronize: false })
@Index('IDX_vet_doctors_active', ['active', 'id'], {})
export class VetDoctor {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'vet_doctors_pkey',
  })
  id: string;

  @Column({ type: 'varchar', length: 50 })
  username: string;

  @Column({ type: 'varchar', length: 60, select: false })
  passwordHash: string;

  @Column({ type: 'varchar', length: 150 })
  displayName: string;

  @Column({ type: 'varchar', length: 11 })
  mobile: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'bigint', default: 0 })
  // PostgreSQL bigint is returned as a string; never round money through Number.
  consultationFeeMinor: string;

  @Column({ type: 'varchar', length: 3, default: 'IRR' })
  currency: string;

  @CreateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
