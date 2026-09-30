import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum BreederApplicationStatus {
  PENDING_CALL = 'PENDING_CALL',
  FOLLOW_UP = 'FOLLOW_UP',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum BreederCallOutcome {
  SUCCESSFUL = 'SUCCESSFUL',
  NO_ANSWER = 'NO_ANSWER',
  FOLLOW_UP_REQUIRED = 'FOLLOW_UP_REQUIRED',
  NOT_ELIGIBLE = 'NOT_ELIGIBLE',
}

@Entity({ name: 'breeder_applications', synchronize: false })
@Index('IDX_breeder_applications_user_created', ['userId', 'createdAt'])
export class BreederApplication {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ length: 150 })
  breederName: string;

  @Column({ length: 100 })
  city: string;

  @Column({ type: 'jsonb' })
  species: string[];

  @Column({ type: 'smallint' })
  experienceYears: number;

  @Column({ type: 'integer' })
  approximateBirdCount: number;

  @Column({ length: 200 })
  preferredContactTime: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  instagramUrl: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  websiteUrl: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  description: string | null;

  @Column({
    type: 'enum',
    enum: BreederApplicationStatus,
    enumName: 'breeder_applications_status_enum',
  })
  status: BreederApplicationStatus;

  @Column({
    type: 'enum',
    enum: BreederCallOutcome,
    enumName: 'breeder_applications_call_outcome_enum',
    nullable: true,
  })
  callOutcome: BreederCallOutcome | null;

  @Column({ type: 'timestamptz', nullable: true })
  contactedAt: Date | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  privateCallNote: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  reviewedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
