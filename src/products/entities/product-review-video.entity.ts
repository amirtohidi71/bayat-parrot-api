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
import { Product } from './product.entity';

@Entity('product_review_videos')
@Index('IDX_product_review_videos_product_order', [
  'productId',
  'displayOrder',
  'id',
])
@Index('UQ_product_review_videos_video_path', ['videoPath'], { unique: true })
@Index('UQ_product_review_videos_cover_path', ['coverPath'], { unique: true })
@Check('CHK_product_review_videos_display_order', '"displayOrder" >= 0')
export class ProductReviewVideo {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  productId: string;

  @ManyToOne(() => Product, (product) => product.reviewVideos, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'productId' })
  product: Product;

  @Column('text')
  videoPath: string;

  @Column('text')
  coverPath: string;

  @Column({ type: 'varchar', length: 50 })
  videoMimeType: string;

  @Column('integer')
  displayOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
