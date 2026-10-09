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

export enum SellerVerificationStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

@Entity({ name: 'seller_verifications', synchronize: false })
@Index('IDX_seller_verifications_user_created', ['userId', 'createdAt'])
export class SellerVerification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ length: 100 })
  firstName: string;

  @Column({ length: 100 })
  lastName: string;

  @Column({ type: 'date' })
  birthDate: string;

  @Column({ type: 'timestamptz' })
  consentAcceptedAt: Date;

  @Column({ length: 50 })
  consentVersion: string;

  @Column({
    type: 'enum',
    enum: SellerVerificationStatus,
    enumName: 'seller_verifications_status_enum',
  })
  status: SellerVerificationStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  internalAdminNote: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  reviewedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  revokedBy: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  revocationReason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
