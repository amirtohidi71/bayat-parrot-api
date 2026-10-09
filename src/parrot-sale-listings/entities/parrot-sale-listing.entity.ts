import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  Product,
  ProductAgeStage,
  ProductGender,
} from '../../products/entities/product.entity';
import { User } from '../../users/entities/user.entity';
import { ParrotSaleListingImage } from './parrot-sale-listing-image.entity';

export enum ParrotSaleListingStatus {
  DRAFT = 'DRAFT',
  PENDING_REVIEW = 'PENDING_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  DELETED_BY_USER = 'DELETED_BY_USER',
}

@Entity({ name: 'parrot_sale_listings', synchronize: false })
@Index('IDX_parrot_sale_listings_seller_created', ['sellerUserId', 'createdAt'])
@Index('IDX_parrot_sale_listings_status_created', ['status', 'createdAt'])
@Index('UQ_parrot_sale_listings_product', ['productId'], { unique: true })
export class ParrotSaleListing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  sellerUserId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sellerUserId' })
  seller: User;

  @Column({
    type: 'enum',
    enum: ParrotSaleListingStatus,
    enumName: 'parrot_sale_listings_status_enum',
    default: ParrotSaleListingStatus.DRAFT,
  })
  status: ParrotSaleListingStatus;

  @Column({ length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  description: string | null;

  @Column({ length: 100 })
  species: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  subspecies: string | null;

  @Column({
    type: 'enum',
    enum: ProductGender,
    enumName: 'parrot_sale_listings_gender_enum',
    nullable: true,
  })
  gender: ProductGender | null;

  @Column({
    type: 'enum',
    enum: ProductAgeStage,
    enumName: 'parrot_sale_listings_age_stage_enum',
    nullable: true,
  })
  ageStage: ProductAgeStage | null;

  @Column('text', { array: true, nullable: true })
  colors: string[] | null;

  @Column({ default: false })
  tagPair: boolean;

  @Column({ default: false })
  tagHandTame: boolean;

  @Column('decimal', { precision: 15, scale: 2 })
  requestedPrice: number;

  @Column('decimal', { precision: 15, scale: 2, nullable: true })
  approvedPrice: number | null;

  @Column({ type: 'smallint', default: 1 })
  quantity: number;

  @Column('uuid', { nullable: true })
  productId: string | null;

  @OneToOne(() => Product, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'productId' })
  product: Product | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  internalAdminNote: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  reviewedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column('uuid', { nullable: true })
  resubmissionOfId: string | null;

  @ManyToOne(() => ParrotSaleListing, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'resubmissionOfId' })
  resubmissionOf: ParrotSaleListing | null;

  @OneToMany(() => ParrotSaleListingImage, (image) => image.listing, {
    eager: false,
  })
  images: ParrotSaleListingImage[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
