import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BirdPassport } from './bird-passport.entity';

@Entity('bird_feeding_records')
@Index('IDX_bird_feeding_records_passport_sort', ['passportId', 'sortOrder'])
@Check('CHK_bird_feeding_records_sort_order', '"sortOrder" >= 0')
export class BirdFeedingRecord {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'bird_feeding_records_pkey',
  })
  id: string;

  @Column({ type: 'uuid' })
  passportId: string;

  @ManyToOne(() => BirdPassport, (passport) => passport.feedingRecords, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'passportId',
    foreignKeyConstraintName: 'FK_bird_feeding_records_passport',
  })
  passport: BirdPassport;

  @Column({ type: 'varchar' })
  ageRange: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'integer', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
