import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ProductReview } from './product-review.entity';

export enum ProductStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  PUBLISHED = 'published',
}

export enum ProductCategorySlug {
  BUY_PARROT = 'buy-parrot',
  PARROT_FOOD = 'parrot-food',
  PARROT_SERLAK = 'parrot-serlak',
  PARROT_SUPPLEMENTS = 'parrot-supplements',
  PARROT_TOYS = 'parrot-toys',
  PARROT_ACCESSORIES = 'parrot-accessories',
  PARROT_CAGE = 'parrot-cage',
}

export enum ProductGender {
  MALE = 'male',
  FEMALE = 'female',
  UNKNOWN = 'unknown',
}

export enum ProductAgeStage {
  SERLAKI = 'serlaki',
  DANE_KHOR = 'dane-khor',
  PISH_MOLID = 'pish-molid',
  MOLID = 'molid',
}

export type ProductSpecification = {
  label: string;
  value: string;
};

export type ProductColorVariant = {
  colorName: string;
  colorCode?: string;
  stock: number;
};

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Nullable at the DB level so synchronize doesn't choke on rows created
  // before this column existed; DTOs still require it for new products.
  @Column({ unique: true, nullable: true })
  sku: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ nullable: true })
  shortDescription: string;

  @Column({ type: 'jsonb', nullable: true })
  specifications: ProductSpecification[] | null;

  @Column('uuid', { array: true, default: () => "'{}'" })
  boughtTogetherProductIds: string[];

  @Column({ type: 'varchar', nullable: true })
  lastEditedByName: string | null;

  @Column('decimal', { precision: 15, scale: 2 })
  price: number;

  @Column({ nullable: true })
  discountPercent: number;

  @Column('decimal', { precision: 15, scale: 2, nullable: true })
  discountPrice: number;

  @Column({ default: 0 })
  stock: number;

  @Column({ type: 'jsonb', nullable: true })
  colorVariants: ProductColorVariant[] | null;

  @Column({ type: 'enum', enum: ProductStatus, default: ProductStatus.DRAFT })
  status: ProductStatus;

  @Column({ type: 'enum', enum: ProductCategorySlug, nullable: true })
  categorySlug: ProductCategorySlug;

  @Column({ nullable: true })
  subCategory: string;

  @Column({ nullable: true })
  species: string;

  @Column({ nullable: true })
  subspecies: string;

  @Column({ type: 'enum', enum: ProductGender, nullable: true })
  gender: ProductGender;

  @Column({ type: 'enum', enum: ProductAgeStage, nullable: true })
  ageStage: ProductAgeStage;

  @Column('text', { array: true, nullable: true })
  colors: string[];

  @Column({ nullable: true })
  brand: string;

  @Column({ nullable: true })
  weight: string;

  @Column({ nullable: true })
  productType: string;

  @Column({ nullable: true })
  size: string;

  @Column({ nullable: true })
  material: string;

  @Column({ default: false })
  tagPair: boolean;

  @Column({ default: false })
  tagHandTame: boolean;

  @Column({ default: false })
  tagCustom: boolean;

  @Column({ default: false })
  tagLuxury: boolean;

  @Column({ default: false })
  tagHealthGuarantee: boolean;

  @Column({ default: false })
  tagFastShipping: boolean;

  @Column({ default: false })
  tagFreeShipping: boolean;

  @Column({ default: false })
  tagCarryCage: boolean;

  @Column({ default: false })
  isAmazingOffer: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  amazingOfferEndsAt: Date;

  @Column('text', { array: true, nullable: true })
  images: string[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn({ nullable: true })
  deletedAt: Date;

  @OneToMany(() => ProductReview, (review) => review.product)
  reviews: ProductReview[];
}
