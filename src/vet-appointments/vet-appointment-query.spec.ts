import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { VetAppointmentPeriod } from './dto/appointment-query.dto';
import { VetAppointmentDashboardRow } from './dto/appointment-dashboard-response.dto';
import {
  VetAppointmentStatus,
  VetPricingKind,
  VetVideoStatus,
} from './vet-appointment.enums';
import { VetAppointmentQueryService } from './vet-appointment-query.service';

describe('VetAppointmentQueryService', () => {
  const customerId = randomUUID();
  const doctorId = randomUUID();
  const appointmentId = randomUUID();
  const now = new Date('2030-01-02T10:00:00.000Z');

  const row = (
    overrides: Partial<VetAppointmentDashboardRow> = {},
  ): VetAppointmentDashboardRow => ({
    appointmentId,
    publicReference: 'VQUERYTEST0001',
    status: VetAppointmentStatus.CONFIRMED,
    pricingKind: VetPricingKind.FREE,
    source: 'CUSTOMER_FIRST_FREE',
    customerUserId: customerId,
    customerName: 'Safe Customer',
    doctorId,
    doctorName: 'Safe Doctor',
    slotId: randomUUID(),
    startsAt: new Date('2030-01-02T10:05:00.000Z'),
    endsAt: new Date('2030-01-02T10:35:00.000Z'),
    passportCode: 'B12345678',
    birdName: 'Bird',
    birdSpecies: 'Parrot',
    confirmedAt: new Date('2030-01-01T10:00:00.000Z'),
    createdAt: new Date('2030-01-01T09:00:00.000Z'),
    doctorActive: true,
    roomStatus: VetVideoStatus.READY,
    providerEndDate: new Date('2030-01-02T10:50:00.000Z'),
    dbNow: now,
    ...overrides,
  });

  function harness(options?: {
    rows?: VetAppointmentDashboardRow[];
    total?: string;
    doctorActive?: boolean;
    failure?: Error;
    config?: Record<string, string>;
  }) {
    const calls: Array<{ sql: string; parameters?: unknown[] }> = [];
    const query = jest.fn((sql: string, parameters?: unknown[]) => {
      calls.push({ sql, parameters });
      if (options?.failure && sql.includes('SELECT transaction_timestamp'))
        return Promise.reject(options.failure);
      if (sql.includes('SELECT active FROM vet_doctors'))
        return Promise.resolve(
          options?.doctorActive === false ? [] : [{ active: true }],
        );
      if (sql.includes('SELECT transaction_timestamp'))
        return Promise.resolve([{ now }]);
      if (sql.includes('COUNT(*)'))
        return Promise.resolve([{ total: options?.total ?? '1' }]);
      if (sql.includes('a.id AS "appointmentId"'))
        return Promise.resolve(options?.rows ?? [row()]);
      return Promise.resolve([]);
    });
    const manager = { query } as unknown as EntityManager;
    const transaction = jest.fn(
      async (
        _isolation: string,
        work: (entityManager: EntityManager) => Promise<unknown>,
      ) => work(manager),
    );
    const service = new VetAppointmentQueryService(
      { transaction } as unknown as DataSource,
      new ConfigService(options?.config),
    );
    return { service, calls, transaction };
  }

  it('scopes customer reads in SQL and returns a customer-safe video projection', async () => {
    const { service, calls } = harness();
    const response = await service.listCustomer(customerId, {
      page: 1,
      pageSize: 20,
      period: VetAppointmentPeriod.UPCOMING,
    });
    const serialized = JSON.stringify(response);

    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      appointmentId,
      video: { eligible: true, joinAllowedNow: true, state: 'OPEN' },
    });
    expect(response.items[0]).not.toHaveProperty('customer');
    expect(serialized).not.toContain('customerUserId');
    expect(serialized).not.toContain('providerEndDate');
    expect(serialized).not.toContain('nationalId');
    const select = calls.find((call) =>
      call.sql.includes('a.id AS "appointmentId"'),
    );
    expect(select?.sql).toContain('a."customerUserId" = $1');
    expect(select?.parameters?.[0]).toBe(customerId);
    expect(select?.sql).toContain('ORDER BY s."startsAt" ASC, a.id ASC');
  });

  it('scopes active doctors and does not expose a customer identifier', async () => {
    const { service, calls } = harness();
    const response = await service.listDoctor(doctorId, {
      page: 1,
      pageSize: 20,
    });
    expect(response.items[0]).toMatchObject({
      customer: { displayName: 'Safe Customer' },
    });
    const customer = (response.items[0] as Record<string, unknown>)
      .customer as Record<string, unknown>;
    expect(customer.id).toBeUndefined();
    const select = calls.find((call) =>
      call.sql.includes('a.id AS "appointmentId"'),
    );
    expect(select?.sql).toContain('a."doctorId" = $1');
    expect(select?.parameters?.[0]).toBe(doctorId);
  });

  it('allows only admin views to apply doctor/customer filters and show ids', async () => {
    const { service, calls } = harness({
      rows: [row({ source: 'ADMIN_MANUAL' })],
    });
    const response = await service.listAdmin({
      page: 2,
      pageSize: 5,
      doctorId,
      customerUserId: customerId,
      status: VetAppointmentStatus.CONFIRMED,
    });
    expect(response.items[0]).toMatchObject({
      source: 'ADMIN_MANUAL',
      customer: { id: customerId, displayName: 'Safe Customer' },
    });
    expect(response.pagination).toEqual({
      page: 2,
      pageSize: 5,
      total: 1,
      totalPages: 1,
    });
    const select = calls.find((call) =>
      call.sql.includes('a.id AS "appointmentId"'),
    );
    expect(select?.parameters).toEqual([
      VetAppointmentStatus.CONFIRMED,
      doctorId,
      customerId,
      5,
      5,
    ]);
  });

  it('returns 404 for an out-of-scope detail without revealing existence', async () => {
    const { service } = harness({ rows: [] });
    await expect(
      service.detailCustomer(customerId, appointmentId),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects invalid ranges and bounds before database access', async () => {
    const { service, transaction } = harness();
    await expect(
      service.listCustomer(customerId, {
        page: 10_001,
        pageSize: 20,
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.listCustomer(customerId, {
        page: Number.MAX_SAFE_INTEGER + 1,
        pageSize: 20,
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.listCustomer(customerId, {
        page: 1,
        pageSize: 101,
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.listAdmin({
        page: 1,
        pageSize: 20,
        from: '2030-01-03T00:00:00Z',
        to: '2030-01-02T00:00:00Z',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('accepts the full video-window range supported by VetVideoService', async () => {
    const { service } = harness({
      config: {
        VET_VIDEO_JOIN_BEFORE_MINUTES: '1440',
        VET_VIDEO_GRACE_AFTER_MINUTES: '1440',
      },
    });
    const response = await service.detailCustomer(customerId, appointmentId);
    expect(response).toMatchObject({
      video: {
        eligible: true,
        joinAllowedNow: true,
        state: 'OPEN',
      },
    });
  });

  it('maps unexpected database errors to a stable generic 500', async () => {
    const { service } = harness({ failure: new Error('PRIVATE SQL DETAIL') });
    await expect(service.listAdmin({ page: 1, pageSize: 20 })).rejects.toEqual(
      new InternalServerErrorException('Unable to read vet appointments'),
    );
  });
});
