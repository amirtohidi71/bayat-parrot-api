import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ProductReview } from '../../products/entities/product-review.entity';

export enum UserRole {
  ADMIN = 'admin',
  CUSTOMER = 'customer',
  BREEDER = 'breeder',
}

export function isCustomerRole(role: string): boolean {
  return [UserRole.CUSTOMER, UserRole.BREEDER].includes(role as UserRole);
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  phone: string;

  @Column({ nullable: true })
  firstName: string;

  @Column({ nullable: true })
  lastName: string;

  @Column({ nullable: true, unique: true })
  email: string;

  @Column({ nullable: true })
  nationalId: string;

  @Column({ default: false })
  profileCompleted: boolean;

  @Column({ default: 0 })
  loyaltyPoints: number;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  phoneVerifiedAt: Date | null;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.CUSTOMER })
  role: UserRole;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => ProductReview, (review) => review.user)
  productReviews: ProductReview[];

  @OneToMany(() => ProductReview, (review) => review.reviewedBy)
  reviewedProductReviews: ProductReview[];
}
