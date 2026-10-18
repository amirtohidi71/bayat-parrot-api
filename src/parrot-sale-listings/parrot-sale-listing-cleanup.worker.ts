import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { ParrotSaleListingsService } from './parrot-sale-listings.service';

export const PARROT_LISTING_CLEANUP_BATCH_SIZE = 10;
export const PARROT_LISTING_CLEANUP_INTERVAL_MS = 60_000;
export const PARROT_LISTING_CLEANUP_LOCK_NAME =
  'parrot-sale-listing-cleanup-reconciliation-v1';

interface PendingCleanup {
  listingId: string;
  sellerUserId: string;
  deletedAt: Date;
}

@Injectable()
export class ParrotSaleListingCleanupWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ParrotSaleListingCleanupWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cursor: Pick<PendingCleanup, 'deletedAt' | 'listingId'> | null = null;

  constructor(
    private readonly source: DataSource,
    private readonly listings: ParrotSaleListingsService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(
      () => void this.runOnce(),
      PARROT_LISTING_CLEANUP_INTERVAL_MS,
    );
    this.timer.unref();
    void this.runOnce();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let runner: QueryRunner | null = null;
    let transactionStarted = false;
    let completed = 0;
    try {
      runner = this.source.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      transactionStarted = true;
      const [claim] = (await runner.query(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
        [PARROT_LISTING_CLEANUP_LOCK_NAME],
      )) as Array<{ acquired: boolean }>;
      if (!claim?.acquired) return 0;
      let pending = await this.loadPending(runner);
      if (pending.length === 0 && this.cursor) {
        this.cursor = null;
        pending = await this.loadPending(runner);
      }
      const last = pending.at(-1);
      if (last)
        this.cursor = { deletedAt: last.deletedAt, listingId: last.listingId };
      for (const item of pending) {
        try {
          await this.listings.delete(item.sellerUserId, item.listingId);
          completed++;
        } catch {
          this.logger.warn('Parrot sale listing cleanup will be retried');
        }
      }
      return completed;
    } catch {
      this.logger.warn('Parrot sale listing cleanup cycle failed');
      return completed;
    } finally {
      if (runner && transactionStarted) {
        try {
          await runner.rollbackTransaction();
        } catch {
          this.logger.warn(
            'Parrot sale listing cleanup transaction release failed',
          );
        }
      }
      try {
        if (runner) await runner.release();
      } catch {
        this.logger.warn(
          'Parrot sale listing cleanup connection release failed',
        );
      } finally {
        this.running = false;
      }
    }
  }

  private async loadPending(runner: QueryRunner): Promise<PendingCleanup[]> {
    return (await runner.query(
      `SELECT ledger."listingId", ledger."sellerUserId", ledger."deletedAt"
       FROM public.parrot_sale_listing_creation_ledger ledger
       LEFT JOIN public.parrot_sale_listings listing ON listing.id = ledger."listingId"
       WHERE ledger."deletedAt" IS NOT NULL AND ledger."cleanupCompletedAt" IS NULL
         AND (listing.id IS NULL OR listing.status = 'DELETED_BY_USER')
         AND ($1::timestamptz IS NULL OR (ledger."deletedAt", ledger."listingId") > ($1, $2::uuid))
       ORDER BY ledger."deletedAt", ledger."listingId"
       LIMIT $3`,
      [
        this.cursor?.deletedAt ?? null,
        this.cursor?.listingId ?? null,
        PARROT_LISTING_CLEANUP_BATCH_SIZE,
      ],
    )) as PendingCleanup[];
  }
}
