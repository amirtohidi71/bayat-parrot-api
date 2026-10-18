import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'parrot_sale_listing_creation_ledger', synchronize: false })
@Index('IDX_parrot_listing_creation_ledger_seller_created', () => ({
  sellerUserId: 1,
  createdAt: -1,
}))
export class ParrotSaleListingCreationLedger {
  @PrimaryColumn('uuid')
  listingId: string;

  @Column('uuid')
  sellerUserId: string;

  @Column({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cleanupCompletedAt: Date | null;
}
