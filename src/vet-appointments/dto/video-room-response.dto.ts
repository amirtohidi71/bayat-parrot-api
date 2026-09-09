import { VetAppointmentSlot } from '../entities/appointment-slot.entity';
import { VetVideoRoom } from '../entities/video-room.entity';
import type { VetVideoAccessCredential } from '../vet-video-provider';
import type { VetVideoParticipant } from '../vet-video-provider';

export class VetVideoRoomResponseDto {
  static from(
    this: void,
    room: VetVideoRoom,
    slot: Pick<VetAppointmentSlot, 'startsAt' | 'endsAt'>,
    participant: VetVideoParticipant,
    credential: VetVideoAccessCredential,
    opensAt: Date,
    closesAt: Date,
  ) {
    return {
      roomId: room.id,
      appointmentId: room.appointmentId,
      provider: room.provider,
      status: room.status,
      accessRole: participant.type,
      accessToken: credential.token,
      accessTokenExpiresAt: credential.expiresAt.toISOString(),
      serverUrl: credential.serverUrl,
      appointmentWindow: {
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
        opensAt: opensAt.toISOString(),
        closesAt: closesAt.toISOString(),
      },
    };
  }
}
