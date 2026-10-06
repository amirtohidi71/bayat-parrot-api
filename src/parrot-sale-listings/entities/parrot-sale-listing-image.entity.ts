import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ParrotSaleListing } from './parrot-sale-listing.entity';

@Entity({ name: 'parrot_sale_listing_images', synchronize: false })
@Unique('UQ_parrot_sale_listing_images_position', ['listingId', 'position'])
@Index('UQ_parrot_sale_listing_images_storage_key', ['storageKey'], {
  unique: true,
})
export class ParrotSaleListingImage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  listingId: string;

  @ManyToOne(() => ParrotSaleListing, (listing) => listing.images, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'listingId' })
  listing: ParrotSaleListing;

  @Column({ type: 'varchar', length: 255 })
  storageKey: string;

  @Column({ type: 'smallint' })
  position: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
