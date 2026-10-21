import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { ListingSubmissionKind } from './listing-submission-kind';

@Entity({ name: 'parrot_sale_listing_creation_ledger', synchronize: false })
@Index('IDX_parrot_listing_creation_kind_week', () => ({
  sellerUserId: 1,
  submissionKind: 1,
  createdAt: -1,
}))
@Index('IDX_parrot_listing_creation_ledger_seller_created', () => ({
  sellerUserId: 1,
  createdAt: -1,
}))
export class ParrotSaleListingCreationLedger {
  @Column({
    type: 'varchar',
    length: 16,
    default: ListingSubmissionKind.ORDINARY,
  })
  submissionKind: ListingSubmissionKind;

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
