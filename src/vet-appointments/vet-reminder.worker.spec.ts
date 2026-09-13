import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SmsService } from '../common/sms/sms.service';
import {
  buildVetReminderMessage,
  retryDelaySeconds,
  VET_REMINDER_BATCH_SIZE,
  VET_REMINDER_LEAD_HOURS,
  VET_REMINDER_LEASE_SECONDS,
  VET_REMINDER_MAX_ATTEMPTS,
  VET_REMINDER_NOTIFICATION_TYPE,
  VET_REMINDER_SCHEDULE_HORIZON_DAYS,
  VetReminderWorker,
} from './vet-reminder.worker';

describe('VetReminderWorker', () => {
  it('schedules a bounded 24-hour reminder with DB time and idempotency', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'notification-id' }]);
    const worker = new VetReminderWorker(
      { query } as unknown as DataSource,
      {} as SmsService,
      new ConfigService({ NODE_ENV: 'test' }),
    );

    await expect(worker.scheduleReminders()).resolves.toBe(1);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("appointment.status = 'CONFIRMED'");
    expect(sql).toContain('transaction_timestamp()');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain("'{}'::jsonb");
    expect(parameters).toEqual([
      VET_REMINDER_NOTIFICATION_TYPE,
      'vet.appointment-reminder-24h',
      VET_REMINDER_LEAD_HOURS,
      VET_REMINDER_SCHEDULE_HORIZON_DAYS,
      VET_REMINDER_BATCH_SIZE,
    ]);
  });

  it('claims only eligible due rows with a bounded lease and attempts', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const worker = new VetReminderWorker(
      { query } as unknown as DataSource,
      {} as SmsService,
      new ConfigService({ NODE_ENV: 'test' }),
    );

    await worker.claimDueRows();
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FOR UPDATE OF notification SKIP LOCKED');
    expect(sql).toContain("notification.status IN ('PENDING', 'FAILED')");
    expect(sql).toContain("appointment.status = 'CONFIRMED'");
    expect(parameters).toEqual([
      VET_REMINDER_NOTIFICATION_TYPE,
      VET_REMINDER_MAX_ATTEMPTS,
      VET_REMINDER_BATCH_SIZE,
      VET_REMINDER_LEASE_SECONDS,
    ]);
  });

  it('uses bounded exponential retry delays', () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(120);
    expect(retryDelaySeconds(5)).toBe(960);
    expect(retryDelaySeconds(100)).toBe(3_600);
  });

  it('builds a safe Tehran-time SMS without outbox or access secrets', () => {
    const message = buildVetReminderMessage(
      'دکتر نمونه',
      new Date('2030-01-02T06:30:00.000Z'),
    );
    expect(message).toContain('دکتر نمونه');
    expect(message).not.toMatch(/token|https?:|room|0912/i);
    expect(() => buildVetReminderMessage(' ', new Date())).toThrow();
  });
});
