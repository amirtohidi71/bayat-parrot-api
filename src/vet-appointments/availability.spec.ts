import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { generateAvailabilitySlots } from './availability-slot-generation';
import { VetAvailabilityService } from './availability.service';
import {
  AvailabilityResponseDto,
  AvailabilitySlotResponseDto,
} from './dto/availability-response.dto';
import { VetAvailabilityWindow } from './entities/availability-window.entity';
import { VetAppointmentSlot } from './entities/appointment-slot.entity';
import {
  MAX_MANUAL_AVAILABILITY_SLOTS,
  parseManualAvailabilitySlots,
} from './manual-availability-slot';

const input = {
  doctorId: randomUUID(),
  startsAt: '2030-01-02T10:00:00Z',
  endsAt: '2030-01-02T11:00:00Z',
  slotDurationMinutes: 15,
  timeZone: 'Asia/Tehran',
};

describe('Vet availability generation and service boundary', () => {
  const manualSlots = [
    {
      startsAt: '2030-01-02T09:00:00+03:30',
      endsAt: '2030-01-02T09:30:00+03:30',
    },
    {
      startsAt: '2030-01-02T18:00:00+03:30',
      endsAt: '2030-01-02T18:15:00+03:30',
    },
  ];

  it('accepts manual slots with mixed durations and gaps on one Tehran day', () => {
    const slots = parseManualAvailabilitySlots(manualSlots);
    expect(slots).toEqual([
      {
        startsAt: new Date('2030-01-02T05:30:00.000Z'),
        endsAt: new Date('2030-01-02T06:00:00.000Z'),
      },
      {
        startsAt: new Date('2030-01-02T14:30:00.000Z'),
        endsAt: new Date('2030-01-02T14:45:00.000Z'),
      },
    ]);
  });

  it.each([
    { slots: [] },
    {
      slots: Array.from(
        { length: MAX_MANUAL_AVAILABILITY_SLOTS + 1 },
        () => manualSlots[0],
      ),
    },
    { slots: [{ ...manualSlots[0], startsAt: '2030-01-02T09:00:00' }] },
    {
      slots: [{ ...manualSlots[0], startsAt: '2030-01-02T09:00:01+03:30' }],
    },
    { slots: [{ ...manualSlots[0], endsAt: manualSlots[0].startsAt }] },
    {
      slots: [
        manualSlots[0],
        {
          startsAt: '2030-01-03T09:00:00+03:30',
          endsAt: '2030-01-03T09:30:00+03:30',
        },
      ],
    },
    {
      slots: [
        {
          startsAt: '2030-01-02T23:30:00+03:30',
          endsAt: '2030-01-03T00:15:00+03:30',
        },
      ],
    },
  ])('rejects invalid manual slot batch %#', ({ slots }) => {
    expect(() => parseManualAvailabilitySlots(slots)).toThrow(
      BadRequestException,
    );
  });

  it('generates every contiguous boundary including the exact final end', () => {
    const slots = generateAvailabilitySlots(input);
    expect(slots).toHaveLength(4);
    expect(slots[0].startsAt.toISOString()).toBe(
      input.startsAt.replace('Z', '.000Z'),
    );
    expect(slots[3].endsAt.toISOString()).toBe(
      input.endsAt.replace('Z', '.000Z'),
    );
    slots
      .slice(1)
      .forEach((slot, i) => expect(slot.startsAt).toEqual(slots[i].endsAt));
  });

  it('uses absolute instants across offsets and midnight', () => {
    expect(
      generateAvailabilitySlots({
        ...input,
        startsAt: '2030-01-02T13:30:00+03:30',
        endsAt: '2030-01-02T14:30:00+03:30',
      }),
    ).toEqual(generateAvailabilitySlots(input));
    expect(
      generateAvailabilitySlots({
        ...input,
        startsAt: '2030-01-02T23:30:00Z',
        endsAt: '2030-01-03T00:30:00Z',
      }),
    ).toHaveLength(4);
  });

  it.each([
    { slotDurationMinutes: 0 },
    { slotDurationMinutes: -1 },
    { slotDurationMinutes: 1441 },
    { slotDurationMinutes: 1.5 },
    { slotDurationMinutes: 17 },
    { endsAt: input.startsAt },
    { endsAt: '2030-01-02T09:00:00Z' },
    { endsAt: '2030-01-03T11:00:00Z' },
    { startsAt: '2030-01-02T10:00:01Z' },
    { startsAt: '2030-01-02T10:00:00' },
    { startsAt: '2030-02-30T10:00:00Z' },
    { startsAt: 'infinity' },
    { startsAt: '2030-01-02T10:00:00.000001Z' },
    { timeZone: 'UTC' },
  ])('rejects invalid geometry %j', (change) => {
    expect(() => generateAvailabilitySlots({ ...input, ...change })).toThrow(
      BadRequestException,
    );
  });

  it('supports both minimum and maximum database durations', () => {
    const day = { ...input, endsAt: '2030-01-03T10:00:00Z' };
    expect(
      generateAvailabilitySlots({ ...day, slotDurationMinutes: 1 }),
    ).toHaveLength(1440);
    expect(
      generateAvailabilitySlots({ ...day, slotDurationMinutes: 1440 }),
    ).toHaveLength(1);
  });

  it('omits retained cells and refuses to split protected geometry', () => {
    const retained = [
      {
        startsAt: new Date(input.startsAt),
        endsAt: new Date('2030-01-02T10:15:00Z'),
      },
    ];
    expect(generateAvailabilitySlots(input, retained)).toHaveLength(3);
    expect(() =>
      generateAvailabilitySlots(
        { ...input, slotDurationMinutes: 30 },
        retained,
      ),
    ).toThrow(ConflictException);
  });

  it('allowlists window and slot output, ignoring relations and unexpected fields', () => {
    const privateFields = {
      passwordHash: 'secret',
      doctor: { mobile: 'private' },
      appointment: { nationalId: 'private' },
    };
    for (const value of [
      AvailabilityResponseDto.from({
        ...input,
        ...privateFields,
      } as unknown as VetAvailabilityWindow),
      AvailabilitySlotResponseDto.from({
        ...input,
        ...privateFields,
      } as unknown as VetAppointmentSlot),
    ]) {
      expect(value).not.toHaveProperty('passwordHash');
      expect(value).not.toHaveProperty('doctor');
      expect(value).not.toHaveProperty('appointment');
    }
  });

  it.each([
    '23505',
    '23P01',
    '23514',
    '23503',
    '40P01',
    '40001',
    '55P03',
    '57014',
  ])('maps database conflict %s without leaking SQL', async (code) => {
    const transaction = jest
      .fn()
      .mockRejectedValue(
        new QueryFailedError(
          'SECRET SQL',
          [],
          Object.assign(new Error('PRIVATE'), { code }),
        ),
      );
    const service = new VetAvailabilityService({
      transaction,
    } as unknown as DataSource);
    await expect(service.create(input, 'test-admin')).rejects.toThrow(
      ConflictException,
    );
    await expect(service.create(input, 'test-admin')).rejects.toThrow(
      'Availability conflicts with current scheduling state',
    );
    expect(transaction).toHaveBeenCalledWith(
      'READ COMMITTED',
      expect.any(Function),
    );
    expect(transaction).toHaveBeenCalledTimes(
      ['40P01', '40001', '55P03'].includes(code) ? 6 : 2,
    );
  });

  it.each(['22007', '22008', '22P02', '22003'])(
    'maps invalid database value %s to 400',
    async (code) => {
      const service = new VetAvailabilityService({
        transaction: jest
          .fn()
          .mockRejectedValue(
            new QueryFailedError(
              'SECRET SQL',
              [],
              Object.assign(new Error('PRIVATE'), { code }),
            ),
          ),
      } as unknown as DataSource);
      await expect(service.create(input, 'test-admin')).rejects.toThrow(
        BadRequestException,
      );
    },
  );

  it('maps manual overlap and duplicate database conflicts to a stable 409', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValue(
        new QueryFailedError(
          'SECRET SQL',
          [],
          Object.assign(new Error('PRIVATE'), { code: '23P01' }),
        ),
      );
    const service = new VetAvailabilityService({
      transaction,
    } as unknown as DataSource);
    await expect(
      service.createManualSlots(
        { doctorId: input.doctorId, slots: manualSlots },
        'test-admin',
      ),
    ).rejects.toThrow(
      'Manual availability slots conflict with current scheduling state',
    );
    expect(transaction).toHaveBeenCalledWith(
      'READ COMMITTED',
      expect.any(Function),
    );
  });

  it.each(['25000', '42P01', '42703', undefined])(
    'fails closed for unexpected drift/isolation %s',
    async (code) => {
      const service = new VetAvailabilityService({
        transaction: jest
          .fn()
          .mockRejectedValue(
            new QueryFailedError(
              'SECRET SQL',
              [],
              Object.assign(new Error('PRIVATE'), { code }),
            ),
          ),
      } as unknown as DataSource);
      await expect(service.create(input, 'test-admin')).rejects.toThrow(
        InternalServerErrorException,
      );
    },
  );

  it('validates admin identity and identifiers before starting writes', async () => {
    const transaction = jest.fn();
    const service = new VetAvailabilityService({
      transaction,
    } as unknown as DataSource);
    await expect(service.create(input, '')).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.create({ ...input, doctorId: 'bad' }, 'admin'),
    ).rejects.toThrow(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });
});
