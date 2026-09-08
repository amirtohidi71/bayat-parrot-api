import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { User, UserRole } from '../users/entities/user.entity';
import { VetVideoRoomResponseDto } from './dto/video-room-response.dto';
import { VetAppointmentSlot } from './entities/appointment-slot.entity';
import { VetAppointment } from './entities/appointment.entity';
import { VetDoctor } from './entities/doctor.entity';
import { VetVideoRoom } from './entities/video-room.entity';
import { VetAppointmentStatus, VetVideoStatus } from './vet-appointment.enums';
import {
  InternalVetVideoProvider,
  VET_INTERNAL_VIDEO_PROVIDER,
  VetVideoParticipant,
} from './vet-video-provider';

type JoinResult =
  | { denied: false; response: ReturnType<typeof VetVideoRoomResponseDto.from> }
  | { denied: true; message: string };

@Injectable()
export class VetVideoService {
  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
    private readonly provider: InternalVetVideoProvider,
  ) {}

  joinCustomer(appointmentId: string, customerUserId: string) {
    return this.join(appointmentId, { type: 'CUSTOMER', id: customerUserId });
  }

  joinDoctor(appointmentId: string, doctorId: string) {
    return this.join(appointmentId, { type: 'DOCTOR', id: doctorId });
  }

  async expireEndedRooms(batchSize = 100): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500)
      throw new BadRequestException('Invalid video expiry batch size');
    for (let attempt = 0; ; attempt++) {
      try {
        const rows = await this.source.transaction(
          'READ COMMITTED',
          async (manager) => {
            await this.timeouts(manager);
            return manager.query<Array<{ appointmentId: string }>>(
              `SELECT "appointmentId" FROM public.vet_video_rooms
               WHERE status='READY' AND "providerEndDate" <= transaction_timestamp()
               ORDER BY "providerEndDate",id LIMIT $1`,
              [batchSize],
            );
          },
        );
        let expired = 0;
        for (const row of rows)
          expired += await this.expireOne(row.appointmentId);
        return expired;
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const code = this.postgresCode(error);
        if (['40P01', '40001', '55P03'].includes(code ?? '') && attempt < 2)
          continue;
        if (['23514', '40P01', '40001', '55P03', '57014'].includes(code ?? ''))
          throw new ConflictException('Video room expiry is currently busy');
        throw new InternalServerErrorException('Video room expiry failed');
      }
    }
  }

  private async join(appointmentId: string, participant: VetVideoParticipant) {
    this.identifiers(appointmentId, participant.id);
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.source.transaction(
          'READ COMMITTED',
          async (manager) =>
            this.joinInTransaction(manager, appointmentId, participant),
        );
        if (result.denied) throw new ConflictException(result.message);
        return result.response;
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const code = this.postgresCode(error);
        if (['40P01', '40001', '55P03'].includes(code ?? '') && attempt < 2)
          continue;
        if (
          [
            '23505',
            '23514',
            '23503',
            '40P01',
            '40001',
            '55P03',
            '57014',
          ].includes(code ?? '')
        )
          throw new ConflictException(
            'Video room conflicts with current appointment state',
          );
        throw new InternalServerErrorException('Video room operation failed');
      }
    }
  }

  private async joinInTransaction(
    manager: EntityManager,
    appointmentId: string,
    participant: VetVideoParticipant,
  ): Promise<JoinResult> {
    await this.timeouts(manager);
    const appointment = await manager.getRepository(VetAppointment).findOne({
      select: {
        id: true,
        customerUserId: true,
        doctorId: true,
        slotId: true,
        status: true,
        confirmedAt: true,
      },
      where: { id: appointmentId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!appointment) throw new NotFoundException('Vet appointment not found');
    await this.authorize(manager, appointment, participant);

    const roomRepository = manager.getRepository(VetVideoRoom);
    const room = await roomRepository.findOne({
      select: {
        id: true,
        appointmentId: true,
        provider: true,
        providerMeetingId: true,
        status: true,
        providerEndDate: true,
        attemptCount: true,
        createdAt: true,
        updatedAt: true,
      },
      where: { appointmentId },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      appointment.status !== VetAppointmentStatus.CONFIRMED ||
      !appointment.confirmedAt ||
      !appointment.slotId
    ) {
      await this.expireRoom(roomRepository, room);
      return { denied: true, message: 'Appointment is not video-consultable' };
    }

    const slot = await manager.getRepository(VetAppointmentSlot).findOne({
      select: { id: true, doctorId: true, startsAt: true, endsAt: true },
      where: { id: appointment.slotId },
    });
    if (!slot || slot.doctorId !== appointment.doctorId)
      throw new ConflictException('Appointment scheduling state is invalid');
    const [{ now }] = await manager.query<Array<{ now: Date }>>(
      'SELECT transaction_timestamp() AS now',
    );
    const opensAt = new Date(
      slot.startsAt.getTime() -
        this.minutes('VET_VIDEO_JOIN_BEFORE_MINUTES', 15) * 60_000,
    );
    const closesAt = new Date(
      slot.endsAt.getTime() +
        this.minutes('VET_VIDEO_GRACE_AFTER_MINUTES', 15) * 60_000,
    );
    if (now < opensAt)
      return { denied: true, message: 'Video room is not open yet' };
    if (now > closesAt) {
      await this.expireRoom(roomRepository, room);
      return { denied: true, message: 'Video room access window has closed' };
    }

    const readyRoom = await this.readyRoom(
      roomRepository,
      room,
      appointment.id,
      closesAt,
    );
    if (readyRoom.provider !== VET_INTERNAL_VIDEO_PROVIDER) {
      await this.expireRoom(roomRepository, readyRoom);
      return { denied: true, message: 'Video provider is unavailable' };
    }
    if (!readyRoom.providerMeetingId) {
      await this.expireRoom(roomRepository, readyRoom);
      return { denied: true, message: 'Video room identity is unavailable' };
    }
    if (!readyRoom.providerEndDate) {
      await this.expireRoom(roomRepository, readyRoom);
      return { denied: true, message: 'Video room end time is unavailable' };
    }
    if (readyRoom.providerEndDate <= now) {
      await this.expireRoom(roomRepository, readyRoom);
      return { denied: true, message: 'Video room access window has closed' };
    }
    const tokenExpiresAt = new Date(
      Math.min(
        now.getTime() +
          this.seconds('VET_VIDEO_ACCESS_TOKEN_SECONDS', 60) * 1000,
        closesAt.getTime(),
        readyRoom.providerEndDate.getTime(),
      ),
    );
    if (tokenExpiresAt <= now)
      return { denied: true, message: 'Video room access window has closed' };
    const credential = this.provider.issueAccess(
      readyRoom.id,
      appointment.id,
      participant,
      now,
      tokenExpiresAt,
    );
    return {
      denied: false,
      response: VetVideoRoomResponseDto.from(
        readyRoom,
        slot,
        participant,
        credential,
        opensAt,
        closesAt,
      ),
    };
  }

  private async readyRoom(
    repository: Repository<VetVideoRoom>,
    room: VetVideoRoom | null,
    appointmentId: string,
    providerEndDate: Date,
  ): Promise<VetVideoRoom> {
    if (room?.status === VetVideoStatus.READY) return room;
    if (
      room &&
      ![VetVideoStatus.NOT_CREATED, VetVideoStatus.FAILED].includes(room.status)
    )
      throw new ConflictException('Video room is unavailable');
    const meetingId = this.provider.createMeeting();
    const ready = repository.create({
      ...(room ?? { id: randomUUID(), appointmentId }),
      provider: VET_INTERNAL_VIDEO_PROVIDER,
      providerMeetingId: meetingId,
      status: VetVideoStatus.READY,
      guestUrlCiphertext: null,
      hostUrlCiphertext: null,
      providerEndDate,
      creationLeaseExpiresAt: null,
      attemptCount: (room?.attemptCount ?? 0) + 1,
      lastErrorCode: null,
      deletedAt: null,
    });
    // Keep select:false meeting identity in memory; TypeORM's post-save reload
    // intentionally omits it and would make an immediately created room unusable.
    await repository.save(ready, { reload: false });
    ready.providerMeetingId = meetingId;
    return ready;
  }

  private async authorize(
    manager: EntityManager,
    appointment: Pick<VetAppointment, 'customerUserId' | 'doctorId'>,
    participant: VetVideoParticipant,
  ): Promise<void> {
    if (participant.type === 'CUSTOMER') {
      if (appointment.customerUserId !== participant.id)
        throw new ForbiddenException('Appointment does not belong to customer');
      const user = await manager.getRepository(User).findOne({
        select: { id: true, role: true },
        where: { id: participant.id },
        lock: { mode: 'pessimistic_read' },
      });
      if (!user || user.role !== UserRole.CUSTOMER)
        throw new ForbiddenException('Customer access required');
      return;
    }
    if (appointment.doctorId !== participant.id)
      throw new ForbiddenException('Appointment does not belong to doctor');
    const doctor = await manager.getRepository(VetDoctor).findOne({
      select: { id: true, active: true },
      where: { id: participant.id },
      lock: { mode: 'pessimistic_read' },
    });
    if (!doctor || !doctor.active)
      throw new ForbiddenException('Vet doctor access is unavailable');
  }

  private async expireOne(appointmentId: string): Promise<number> {
    return this.source.transaction('READ COMMITTED', async (manager) => {
      await this.timeouts(manager);
      const appointment = await manager.getRepository(VetAppointment).findOne({
        select: { id: true },
        where: { id: appointmentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!appointment) return 0;
      const repository = manager.getRepository(VetVideoRoom);
      const room = await repository.findOne({
        where: { appointmentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!room || room.status !== VetVideoStatus.READY) return 0;
      const [{ expired }] = await manager.query<Array<{ expired: boolean }>>(
        'SELECT $1::timestamptz <= transaction_timestamp() AS expired',
        [room.providerEndDate],
      );
      if (!expired) return 0;
      await this.expireRoom(repository, room);
      return 1;
    });
  }

  private async expireRoom(
    repository: Repository<VetVideoRoom>,
    room: VetVideoRoom | null,
  ): Promise<void> {
    if (
      !room ||
      [VetVideoStatus.EXPIRED, VetVideoStatus.DELETED].includes(room.status)
    )
      return;
    await repository.update(room.id, {
      status: VetVideoStatus.EXPIRED,
      deletedAt: () => 'statement_timestamp()',
    });
  }

  private identifiers(appointmentId: string, participantId: string): void {
    if (!isUUID(appointmentId) || !isUUID(participantId))
      throw new BadRequestException('Invalid video consultation identifier');
  }

  private minutes(key: string, fallback: number): number {
    return this.integer(key, fallback, 0, 1440);
  }

  private seconds(key: string, fallback: number): number {
    return this.integer(key, fallback, 15, 300);
  }

  private integer(
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const raw = this.config.get<string>(key)?.trim();
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new InternalServerErrorException(
        'Vet video configuration is invalid',
      );
    return value;
  }

  private timeouts(manager: EntityManager): Promise<unknown[]> {
    return manager.query(
      "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'",
    );
  }

  private postgresCode(error: unknown): string | undefined {
    return error instanceof QueryFailedError
      ? (error.driverError as { code?: string }).code
      : undefined;
  }
}
