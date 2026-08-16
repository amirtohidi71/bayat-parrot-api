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

@Entity('bird_veterinary_visits')
@Index('IDX_bird_veterinary_visits_passport_sort', ['passportId', 'sortOrder'])
@Index('IDX_bird_veterinary_visits_passport_date', ['passportId', 'visitDate'])
@Check('CHK_bird_veterinary_visits_sort_order', '"sortOrder" >= 0')
export class BirdVeterinaryVisit {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'bird_veterinary_visits_pkey',
  })
  id: string;

  @Column({ type: 'uuid' })
  passportId: string;

  @ManyToOne(() => BirdPassport, (passport) => passport.veterinaryVisits, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'passportId',
    foreignKeyConstraintName: 'FK_bird_veterinary_visits_passport',
  })
  passport: BirdPassport;

  @Column({ type: 'date' })
  visitDate: string;

  @Column({ type: 'text' })
  clinicalNotes: string;

  @Column({ type: 'text' })
  veterinaryActions: string;

  @Column({ type: 'integer', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
