import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';

export const VET_INTERNAL_VIDEO_PROVIDER = 'INTERNAL';
export const VET_VIDEO_ACCESS_SCOPE = 'vet-video-access';

export type VetVideoParticipant = {
  type: 'CUSTOMER' | 'DOCTOR';
  id: string;
};

export interface VetVideoAccessCredential {
  token: string;
  expiresAt: Date;
}

@Injectable()
export class InternalVetVideoProvider {
  constructor(private readonly jwt: JwtService) {}

  createMeeting(): string {
    return `vet_${randomUUID().replaceAll('-', '')}`;
  }

  issueAccess(
    roomId: string,
    appointmentId: string,
    participant: VetVideoParticipant,
    now: Date,
    expiresAt: Date,
  ): VetVideoAccessCredential {
    return {
      token: this.jwt.sign({
        scope: VET_VIDEO_ACCESS_SCOPE,
        roomId,
        appointmentId,
        participantType: participant.type,
        participantId: participant.id,
        iat: Math.floor(now.getTime() / 1000),
        exp: Math.floor(expiresAt.getTime() / 1000),
      }),
      expiresAt,
    };
  }
}
