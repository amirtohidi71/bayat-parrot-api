import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { AdminManualVetAssignmentResponseDto } from './dto/admin-manual-assignment-response.dto';
import { VetAppointment } from './entities/appointment.entity';
import { VetAppointmentStatus, VetPricingKind } from './vet-appointment.enums';
import { VetManualAssignmentService } from './vet-manual-assignment.service';

describe('Vet manual assignment service boundary', () => {
  const config = () =>
    new ConfigService({
      VET_FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });

  it('returns an explicit response allowlist without private fields', () => {
    const response = AdminManualVetAssignmentResponseDto.from(
      {
        id: randomUUID(),
        publicReference: 'V1234567890AB',
        customerUserId: randomUUID(),
        ownerFullNameSnapshot: 'Selected Customer',
        bookingRequestId: randomUUID(),
        status: VetAppointmentStatus.CONFIRMED,
        pricingKind: VetPricingKind.FREE,
        feeAmountMinor: '0',
        currency: 'IRR',
        pricingRuleVersion: 'vet-admin-manual-v1',
        doctorId: randomUUID(),
        doctorNameSnapshot: 'Doctor',
        birdPassportId: null,
        passportCodeSnapshot: null,
        birdNameSnapshot: null,
        birdSpeciesSnapshot: null,
        confirmedAt: new Date('2030-01-02T10:00:00Z'),
        ownerMobileSnapshot: '09111111111',
        nationalIdCiphertext: 'private',
      } as VetAppointment,
      {
        id: randomUUID(),
        startsAt: new Date('2030-01-02T10:00:00Z'),
        endsAt: new Date('2030-01-02T10:15:00Z'),
      },
    );
    expect(response).toMatchObject({
      assignmentSource: 'ADMIN_MANUAL',
      status: VetAppointmentStatus.CONFIRMED,
      pricing: { kind: VetPricingKind.FREE, feeAmountMinor: '0' },
    });
    expect(response).not.toHaveProperty('bookingRequestId');
    expect(response).not.toHaveProperty('holdExpiresAt');
    expect(JSON.stringify(response)).not.toContain('09111111111');
    expect(JSON.stringify(response)).not.toContain('private');
  });

  it('rejects malformed identifiers/admin identity before transaction access', async () => {
    const transaction = jest.fn();
    const service = new VetManualAssignmentService(
      { transaction } as unknown as DataSource,
      config(),
    );
    await expect(
      service.create({ customerUserId: 'bad', slotId: randomUUID() }, 'admin'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create(
        { customerUserId: randomUUID(), slotId: randomUUID() },
        '',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(['23505', '23514', '40P01', '55P03', '57014'])(
    'maps PostgreSQL conflict %s without exposing SQL',
    async (code) => {
      const transaction = jest
        .fn()
        .mockRejectedValue(
          new QueryFailedError(
            'SECRET SQL',
            [],
            Object.assign(new Error('PRIVATE'), { code }),
          ),
        );
      const service = new VetManualAssignmentService(
        { transaction } as unknown as DataSource,
        config(),
      );
      await expect(
        service.create(
          { customerUserId: randomUUID(), slotId: randomUUID() },
          'admin',
        ),
      ).rejects.toEqual(
        new ConflictException(
          'Manual assignment conflicts with current scheduling state',
        ),
      );
      expect(transaction).toHaveBeenCalledTimes(
        ['40P01', '55P03'].includes(code) ? 3 : 1,
      );
    },
  );

  it('fails closed on unexpected database/isolation drift', async () => {
    const service = new VetManualAssignmentService(
      {
        transaction: jest
          .fn()
          .mockRejectedValue(
            new QueryFailedError(
              'SECRET SQL',
              [],
              Object.assign(new Error('PRIVATE'), { code: '25000' }),
            ),
          ),
      } as unknown as DataSource,
      config(),
    );
    await expect(
      service.create(
        { customerUserId: randomUUID(), slotId: randomUUID() },
        'admin',
      ),
    ).rejects.toThrow(InternalServerErrorException);
  });
});
