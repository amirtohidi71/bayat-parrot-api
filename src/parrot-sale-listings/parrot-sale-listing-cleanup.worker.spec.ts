import { DataSource } from 'typeorm';
import {
  ParrotSaleListingCleanupWorker,
  PARROT_LISTING_CLEANUP_BATCH_SIZE,
} from './parrot-sale-listing-cleanup.worker';
import { ParrotSaleListingsService } from './parrot-sale-listings.service';

const first = {
  listingId: '123e4567-e89b-42d3-a456-426614174000',
  sellerUserId: '223e4567-e89b-42d3-a456-426614174000',
  deletedAt: new Date('2026-10-17T00:00:00Z'),
};

function context(rows = [first]) {
  const query = jest.fn((sql: string) => {
    if (sql.includes('pg_try_advisory_xact_lock'))
      return Promise.resolve([{ acquired: true }]);
    return Promise.resolve(rows);
  });
  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    query,
    release: jest.fn().mockResolvedValue(undefined),
  };
  const source = { createQueryRunner: jest.fn(() => runner) };
  const listings = { delete: jest.fn().mockResolvedValue(null) };
  const worker = new ParrotSaleListingCleanupWorker(
    source as unknown as DataSource,
    listings as unknown as ParrotSaleListingsService,
  );
  return { worker, runner, listings };
}

describe('ParrotSaleListingCleanupWorker', () => {
  it('starts reconciliation automatically and stops its timer on shutdown', () => {
    const value = context();
    const run = jest.spyOn(value.worker, 'runOnce').mockResolvedValue(0);
    value.worker.onApplicationBootstrap();
    expect(run).toHaveBeenCalledTimes(1);
    value.worker.onApplicationShutdown();
    run.mockRestore();
  });

  it('selects only pending deletions in a bounded batch and releases the DB lock', async () => {
    const value = context();
    await expect(value.worker.runOnce()).resolves.toBe(1);
    expect(value.runner.query).toHaveBeenCalledWith(
      expect.stringContaining(
        'ledger."deletedAt" IS NOT NULL AND ledger."cleanupCompletedAt" IS NULL',
      ),
      [null, null, PARROT_LISTING_CLEANUP_BATCH_SIZE],
    );
    expect(value.listings.delete).toHaveBeenCalledWith(
      first.sellerUserId,
      first.listingId,
    );
    expect(value.runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(value.runner.release).toHaveBeenCalledTimes(1);
  });

  it('prevents overlapping runs in one process', async () => {
    const value = context();
    let finish: (() => void) | undefined;
    value.listings.delete.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const firstRun = value.worker.runOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(value.worker.runOnce()).resolves.toBe(0);
    expect(value.runner.connect).toHaveBeenCalledTimes(1);
    finish?.();
    await expect(firstRun).resolves.toBe(1);
  });

  it('does not process rows when another API instance owns the advisory lock', async () => {
    const value = context();
    value.runner.query.mockResolvedValueOnce([{ acquired: false }]);
    await expect(value.worker.runOnce()).resolves.toBe(0);
    expect(value.listings.delete).not.toHaveBeenCalled();
    expect(value.runner.release).toHaveBeenCalledTimes(1);
  });

  it('keeps failed rows pending for retry while processing the rest of the batch', async () => {
    const second = {
      listingId: '323e4567-e89b-42d3-a456-426614174000',
      sellerUserId: first.sellerUserId,
      deletedAt: first.deletedAt,
    };
    const value = context([first, second]);
    value.listings.delete.mockRejectedValueOnce(
      new Error('private storage unavailable'),
    );
    await expect(value.worker.runOnce()).resolves.toBe(1);
    expect(value.listings.delete).toHaveBeenCalledTimes(2);
    await expect(value.worker.runOnce()).resolves.toBe(2);
  });
});
