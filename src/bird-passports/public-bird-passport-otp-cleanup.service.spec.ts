import { Logger } from '@nestjs/common';
import {
  PUBLIC_BIRD_PASSPORT_OTP_CLEANUP_BATCH_SIZE,
  PUBLIC_BIRD_PASSPORT_OTP_RETENTION_HOURS,
  PublicBirdPassportOtpCleanupService,
} from './public-bird-passport-otp-cleanup.service';

function context(rows: Array<{ id: number; expiresAt: Date }> = []) {
  let scheduledTask: (() => Promise<void>) | undefined;
  const scheduler = {
    schedule: jest.fn((task: () => Promise<void>) => {
      scheduledTask = task;
    }),
  };
  const dataSource = {
    query: jest.fn((_sql: string, [cutoff, limit]: [Date, number]) => {
      const eligible = rows
        .filter((row) => row.expiresAt < cutoff)
        .sort(
          (left, right) => left.expiresAt.getTime() - right.expiresAt.getTime(),
        )
        .slice(0, limit);
      const ids = new Set(eligible.map((row) => row.id));
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (ids.has(rows[index].id)) rows.splice(index, 1);
      }
      return Promise.resolve([]);
    }),
  };
  const service = new PublicBirdPassportOtpCleanupService(
    dataSource as never,
    scheduler,
  );
  return {
    service,
    dataSource,
    scheduler,
    rows,
    run: () => {
      if (!scheduledTask) throw new Error('Cleanup task was not scheduled');
      return scheduledTask();
    },
  };
}

describe('PublicBirdPassportOtpCleanupService', () => {
  it('uses expiresAt, a 24-hour cutoff and a parameterized 500-row batch', async () => {
    const value = context();
    value.service.schedule();
    await value.run();
    const [sql, [cutoff, limit]] = value.dataSource.query.mock.calls[0];
    expect(sql).toContain('WHERE "expiresAt" < $1');
    expect(sql).toContain('LIMIT $2');
    expect(sql).toContain('ORDER BY "expiresAt" ASC');
    expect(limit).toBe(PUBLIC_BIRD_PASSPORT_OTP_CLEANUP_BATCH_SIZE);
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(
      PUBLIC_BIRD_PASSPORT_OTP_RETENTION_HOURS * 60 * 60 * 1000 - 1_000,
    );
  });

  it('deletes only OTPs expired more than 24 hours ago', async () => {
    const now = Date.now();
    const rows = [
      { id: 1, expiresAt: new Date(now - 25 * 60 * 60 * 1000) },
      { id: 2, expiresAt: new Date(now - 23 * 60 * 60 * 1000) },
      { id: 3, expiresAt: new Date(now + 60 * 1000) },
    ];
    const value = context(rows);
    value.service.schedule();
    await value.run();
    expect(rows.map((row) => row.id)).toEqual([2, 3]);
  });

  it('never deletes more than one bounded batch', async () => {
    const rows = Array.from({ length: 510 }, (_, id) => ({
      id,
      expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    }));
    const value = context(rows);
    value.service.schedule();
    await value.run();
    expect(rows).toHaveLength(10);
  });

  it('coalesces concurrent cleanup scheduling', () => {
    const value = context();
    value.service.schedule();
    value.service.schedule();
    expect(value.scheduler.schedule).toHaveBeenCalledTimes(1);
  });

  it('contains cleanup failure and permits a later cleanup', async () => {
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const value = context();
    value.dataSource.query.mockRejectedValueOnce(
      new Error('private DB detail'),
    );
    value.service.schedule();
    await expect(value.run()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith('Bird passport OTP cleanup failed');
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      'private DB detail',
    );
    value.service.schedule();
    expect(value.scheduler.schedule).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
});
