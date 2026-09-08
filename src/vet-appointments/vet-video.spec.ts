import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { VetVideoRoomResponseDto } from './dto/video-room-response.dto';
import { VetVideoStatus } from './vet-appointment.enums';
import {
  InternalVetVideoProvider,
  VET_INTERNAL_VIDEO_PROVIDER,
} from './vet-video-provider';
import { VetVideoService } from './vet-video.service';

describe('Vet video consultation boundary', () => {
  const provider = () =>
    new InternalVetVideoProvider(new JwtService({ secret: 'test-secret' }));

  it('allowlists room access and keeps internal meeting identity private', () => {
    const jwt = provider();
    const now = new Date('2030-01-02T10:00:00Z');
    const expiresAt = new Date('2030-01-02T10:01:00Z');
    const participant = { type: 'CUSTOMER' as const, id: randomUUID() };
    const meetingId = jwt.createMeeting();
    const credential = jwt.issueAccess(
      randomUUID(),
      randomUUID(),
      participant,
      now,
      expiresAt,
    );
    const response = VetVideoRoomResponseDto.from(
      {
        id: randomUUID(),
        appointmentId: randomUUID(),
        provider: VET_INTERNAL_VIDEO_PROVIDER,
        providerMeetingId: meetingId,
        status: VetVideoStatus.READY,
        guestUrlCiphertext: 'private-guest',
        hostUrlCiphertext: 'private-host',
        lastErrorCode: 'private-error',
      } as never,
      {
        startsAt: now,
        endsAt: new Date('2030-01-02T10:15:00Z'),
      },
      participant,
      credential,
      new Date('2030-01-02T09:45:00Z'),
      new Date('2030-01-02T10:30:00Z'),
    );
    expect(response).toMatchObject({
      provider: 'INTERNAL',
      status: 'READY',
      accessRole: 'CUSTOMER',
    });
    expect(response.accessToken).toEqual(expect.any(String));
    expect(new JwtService().decode(response.accessToken)).not.toHaveProperty(
      'meetingId',
    );
    expect(response).not.toHaveProperty('providerMeetingId');
    expect(JSON.stringify(response)).not.toContain('private-guest');
    expect(JSON.stringify(response)).not.toContain('private-host');
    expect(JSON.stringify(response)).not.toContain('private-error');
  });

  it('rejects malformed identities before database access', async () => {
    const transaction = jest.fn();
    const service = new VetVideoService(
      { transaction } as unknown as DataSource,
      new ConfigService(),
      provider(),
    );
    await expect(service.joinCustomer('bad', randomUUID())).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.joinDoctor(randomUUID(), 'bad')).rejects.toThrow(
      BadRequestException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(['23505', '23514', '40P01', '55P03', '57014'])(
    'maps PostgreSQL conflict %s without leaking details',
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
      const service = new VetVideoService(
        { transaction } as unknown as DataSource,
        new ConfigService(),
        provider(),
      );
      await expect(
        service.joinCustomer(randomUUID(), randomUUID()),
      ).rejects.toEqual(
        new ConflictException(
          'Video room conflicts with current appointment state',
        ),
      );
      expect(transaction).toHaveBeenCalledTimes(
        ['40P01', '55P03'].includes(code) ? 3 : 1,
      );
    },
  );

  it('maps unexpected failures to a generic 500', async () => {
    const service = new VetVideoService(
      {
        transaction: jest.fn().mockRejectedValue(new Error('PRIVATE')),
      } as unknown as DataSource,
      new ConfigService(),
      provider(),
    );
    await expect(
      service.joinCustomer(randomUUID(), randomUUID()),
    ).rejects.toThrow(InternalServerErrorException);
  });
});
