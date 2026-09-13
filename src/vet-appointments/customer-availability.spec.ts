import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { VetAvailabilityService } from './availability.service';

describe('Customer bookable vet slots service', () => {
  const query = {
    from: '2030-01-01T00:00:00Z',
    to: '2030-02-01T00:00:00Z',
  };

  function harness(rows: unknown[] = []) {
    const builder: Record<string, jest.Mock> = {};
    for (const method of [
      'innerJoin',
      'select',
      'addSelect',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
    ])
      builder[method] = jest.fn().mockReturnValue(builder);
    builder.getRawMany = jest.fn().mockResolvedValue(rows);
    const createQueryBuilder = jest.fn().mockReturnValue(builder);
    const source = {
      getRepository: jest.fn().mockReturnValue({ createQueryBuilder }),
    } as unknown as DataSource;
    return { service: new VetAvailabilityService(source), builder, source };
  }

  it('uses the booking availability rules and returns only the public allowlist', async () => {
    const row = {
      slotId: randomUUID(),
      doctorId: randomUUID(),
      doctorDisplayName: '  Test Doctor  ',
      startsAt: new Date('2030-01-02T10:00:00Z'),
      endsAt: new Date('2030-01-02T10:15:00Z'),
      availabilityWindowId: randomUUID(),
      status: 'AVAILABLE',
      mobile: '09111111111',
      createdByAdmin: 'private',
    };
    const { service, builder } = harness([row]);

    await expect(service.bookableSlots(query)).resolves.toEqual([
      {
        slotId: row.slotId,
        doctorId: row.doctorId,
        doctorDisplayName: 'Test Doctor',
        startsAt: row.startsAt,
        endsAt: row.endsAt,
      },
    ]);
    const predicates = builder.andWhere.mock.calls
      .map(([predicate]) => predicate)
      .join('\n');
    expect(predicates).toContain('w.status = :windowStatus');
    expect(predicates).toContain('d.active = TRUE');
    expect(predicates).toContain('s.startsAt > transaction_timestamp()');
    expect(predicates).toContain('NOT EXISTS');
    expect(predicates).toContain(
      "'PAYMENT_PENDING','CONFIRMED','COMPLETED','NO_SHOW'",
    );
    expect(builder.where).toHaveBeenCalledWith('s.status = :slotStatus', {
      slotStatus: 'AVAILABLE',
    });
  });

  it.each([
    [{ ...query, from: query.to }, 'Filter start must precede end'],
    [
      { ...query, to: '2030-02-01T00:00:00.001Z' },
      'Availability range cannot exceed 31 days',
    ],
    [{ ...query, from: '2030-01-01T00:00:00' }, 'Timestamp must be'],
  ])('rejects an invalid or unbounded range', async (input, message) => {
    const { service, source } = harness();
    await expect(service.bookableSlots(input)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.bookableSlots(input)).rejects.toThrow(message);
    expect(source.getRepository).not.toHaveBeenCalled();
  });
});
