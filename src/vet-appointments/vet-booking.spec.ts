import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { VetBookingResponseDto } from './dto/booking-response.dto';
import { VetAppointment } from './entities/appointment.entity';
import { VetAppointmentStatus, VetPricingKind } from './vet-appointment.enums';
import { VetBookingPolicy } from './policies/vet-booking.policy';
import { VetBookingService } from './vet-booking.service';
import { VET_ADMIN_MANUAL_RULE } from './vet-manual-assignment.constants';

describe('Vet booking service boundary', () => {
  it('allowlists customer output and preserves bigint money as a string', () => {
    const response = VetBookingResponseDto.from(
      {
        id: randomUUID(),
        publicReference: 'V1234567890AB',
        bookingRequestId: randomUUID(),
        status: VetAppointmentStatus.CONFIRMED,
        pricingKind: VetPricingKind.FREE,
        feeAmountMinor: '0',
        currency: 'IRR',
        pricingRuleVersion: 'vet-first-free-v1',
        doctorId: randomUUID(),
        doctorNameSnapshot: 'Doctor',
        birdPassportId: null,
        passportCodeSnapshot: null,
        birdNameSnapshot: null,
        birdSpeciesSnapshot: null,
        confirmedAt: new Date('2030-01-02T10:00:00Z'),
        nationalIdCiphertext: 'private',
        ownerMobileSnapshot: '09111111111',
        ownerFullNameSnapshot: 'Private Owner',
      } as VetAppointment,
      {
        id: randomUUID(),
        startsAt: new Date('2030-01-02T10:00:00Z'),
        endsAt: new Date('2030-01-02T10:15:00Z'),
      },
    );
    expect(response.pricing.feeAmountMinor).toBe('0');
    expect(response).not.toHaveProperty('customerUserId');
    expect(response).not.toHaveProperty('nationalIdCiphertext');
    expect(JSON.stringify(response)).not.toContain('09111111111');
    expect(JSON.stringify(response)).not.toContain('Private Owner');
  });

  it('rejects malformed identifiers before database access', async () => {
    const transaction = jest.fn();
    const source = {
      manager: {},
      transaction,
    } as unknown as DataSource;
    const service = new VetBookingService(
      source,
      new ConfigService(),
      new VetBookingPolicy(new ConfigService()),
    );
    await expect(
      service.book('bad', {
        bookingRequestId: randomUUID(),
        slotId: randomUUID(),
      }),
    ).rejects.toThrow(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('does not treat an admin assignment as a customer booking retry', async () => {
    const customerUserId = randomUUID();
    const bookingRequestId = randomUUID();
    const slotId = randomUUID();
    const repository = {
      findOneBy: jest.fn().mockResolvedValue({
        customerUserId,
        bookingRequestId,
        slotId,
        pricingKind: VetPricingKind.FREE,
        pricingRuleVersion: VET_ADMIN_MANUAL_RULE,
        passportCodeSnapshot: null,
      }),
    };
    const transaction = jest.fn();
    const source = {
      manager: { getRepository: () => repository },
      transaction,
    } as unknown as DataSource;
    const service = new VetBookingService(
      source,
      new ConfigService(),
      new VetBookingPolicy(new ConfigService()),
    );

    await expect(
      service.book(customerUserId, { bookingRequestId, slotId }),
    ).rejects.toEqual(
      new ConflictException('Booking request identifier was already used'),
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(['23505', '23514', '40P01', '55P03', '57014'])(
    'maps PostgreSQL conflict %s without leaking details',
    async (code) => {
      const repository = { findOneBy: jest.fn().mockResolvedValue(null) };
      const source = {
        manager: { getRepository: () => repository },
        transaction: jest
          .fn()
          .mockRejectedValue(
            new QueryFailedError(
              'SECRET SQL',
              [],
              Object.assign(new Error('PRIVATE'), { code }),
            ),
          ),
      } as unknown as DataSource;
      const service = new VetBookingService(
        source,
        new ConfigService({
          VET_FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        }),
        new VetBookingPolicy(new ConfigService()),
      );
      await expect(
        service.book(randomUUID(), {
          bookingRequestId: randomUUID(),
          slotId: randomUUID(),
        }),
      ).rejects.toEqual(
        new ConflictException(
          'Booking conflicts with current scheduling state',
        ),
      );
    },
  );
});
