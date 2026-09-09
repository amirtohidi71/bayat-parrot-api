import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';

export const VET_VIDEO_PROVIDER = Symbol('VET_VIDEO_PROVIDER');
export const VET_INTERNAL_VIDEO_PROVIDER = 'INTERNAL';
export const VET_LIVEKIT_VIDEO_PROVIDER = 'LIVEKIT';
export const VET_VIDEO_ACCESS_SCOPE = 'vet-video-access';

export type VetVideoProviderName =
  | typeof VET_INTERNAL_VIDEO_PROVIDER
  | typeof VET_LIVEKIT_VIDEO_PROVIDER;

export type VetVideoParticipant = {
  type: 'CUSTOMER' | 'DOCTOR';
  id: string;
};

export interface VetVideoAccessCredential {
  token: string;
  expiresAt: Date;
  serverUrl: string | null;
}

export interface VetVideoProvider {
  readonly name: VetVideoProviderName;
  meetingId(appointmentId: string): string;
  ensureMeeting(meetingId: string, providerEndDate: Date): Promise<void>;
  issueAccess(
    roomId: string,
    appointmentId: string,
    meetingId: string,
    participant: VetVideoParticipant,
    now: Date,
    expiresAt: Date,
  ): Promise<VetVideoAccessCredential>;
}

@Injectable()
export class InternalVetVideoProvider implements VetVideoProvider {
  readonly name = VET_INTERNAL_VIDEO_PROVIDER;

  constructor(private readonly jwt: JwtService) {}

  meetingId(_appointmentId: string): string {
    void _appointmentId;
    return `vet_${randomUUID().replaceAll('-', '')}`;
  }

  ensureMeeting(_meetingId: string, _providerEndDate: Date): Promise<void> {
    void _meetingId;
    void _providerEndDate;
    return Promise.resolve();
  }

  issueAccess(
    roomId: string,
    appointmentId: string,
    _meetingId: string,
    participant: VetVideoParticipant,
    now: Date,
    expiresAt: Date,
  ): Promise<VetVideoAccessCredential> {
    void _meetingId;
    return Promise.resolve({
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
      serverUrl: null,
    });
  }
}

export class VetVideoProviderConfigurationError extends Error {}
export class VetVideoProviderUnavailableError extends Error {}
