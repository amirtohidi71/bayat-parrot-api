import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccessToken,
  RoomServiceClient,
  ServerError,
} from 'livekit-server-sdk';
import {
  VET_LIVEKIT_VIDEO_PROVIDER,
  VetVideoAccessCredential,
  VetVideoParticipant,
  VetVideoProvider,
  VetVideoProviderConfigurationError,
  VetVideoProviderUnavailableError,
} from './vet-video-provider';

export const LIVEKIT_ROOM_TRANSPORT = Symbol('LIVEKIT_ROOM_TRANSPORT');

export type LiveKitConfig = {
  url: string;
  apiKey: string;
  apiSecret: string;
};

export interface LiveKitRoomTransport {
  ensureRoom(
    config: LiveKitConfig,
    roomName: string,
    providerEndDate: Date,
  ): Promise<void>;
}

@Injectable()
export class LiveKitSdkRoomTransport implements LiveKitRoomTransport {
  async ensureRoom(
    config: LiveKitConfig,
    roomName: string,
    providerEndDate: Date,
  ): Promise<void> {
    const serviceUrl = new URL(config.url);
    if (serviceUrl.protocol === 'wss:') serviceUrl.protocol = 'https:';
    const client = new RoomServiceClient(
      serviceUrl.toString().replace(/\/$/, ''),
      config.apiKey,
      config.apiSecret,
      { requestTimeout: 5 },
    );
    try {
      await client.createRoom({
        name: roomName,
        maxParticipants: 2,
        emptyTimeout: Math.max(
          60,
          Math.min(
            3600,
            Math.ceil((providerEndDate.getTime() - Date.now()) / 1000),
          ),
        ),
        departureTimeout: 60,
      });
    } catch (error) {
      if (
        error instanceof ServerError &&
        (error.status === 409 || error.code === 'already_exists')
      )
        return;
      throw error;
    }
  }
}

@Injectable()
export class LiveKitVetVideoProvider implements VetVideoProvider {
  readonly name = VET_LIVEKIT_VIDEO_PROVIDER;

  constructor(
    private readonly configService: ConfigService,
    @Inject(LIVEKIT_ROOM_TRANSPORT)
    private readonly rooms: LiveKitRoomTransport,
  ) {}

  meetingId(appointmentId: string): string {
    return `vet-${appointmentId.toLowerCase()}`;
  }

  async ensureMeeting(meetingId: string, providerEndDate: Date): Promise<void> {
    try {
      await this.rooms.ensureRoom(this.config(), meetingId, providerEndDate);
    } catch (error) {
      if (error instanceof VetVideoProviderConfigurationError) throw error;
      throw new VetVideoProviderUnavailableError('LiveKit room unavailable');
    }
  }

  async issueAccess(
    _roomId: string,
    appointmentId: string,
    meetingId: string,
    participant: VetVideoParticipant,
    now: Date,
    expiresAt: Date,
  ): Promise<VetVideoAccessCredential> {
    const config = this.config();
    const ttl = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
    if (ttl < 1)
      throw new VetVideoProviderUnavailableError('LiveKit token window closed');
    try {
      const token = new AccessToken(config.apiKey, config.apiSecret, {
        identity: `${participant.type.toLowerCase()}:${participant.id}`,
        ttl,
        attributes: {
          participantType: participant.type,
          appointmentId,
        },
      });
      token.addGrant({
        room: meetingId,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        canUpdateOwnMetadata: false,
        roomAdmin: false,
        roomCreate: false,
        roomList: false,
        roomRecord: false,
        ingressAdmin: false,
      });
      return {
        token: await token.toJwt(),
        expiresAt,
        serverUrl: config.url,
      };
    } catch (error) {
      if (error instanceof VetVideoProviderConfigurationError) throw error;
      throw new VetVideoProviderUnavailableError('LiveKit token unavailable');
    }
  }

  private config(): LiveKitConfig {
    const url = this.configService.get<string>('LIVEKIT_URL')?.trim() ?? '';
    const apiKey =
      this.configService.get<string>('LIVEKIT_API_KEY')?.trim() ?? '';
    const apiSecret =
      this.configService.get<string>('LIVEKIT_API_SECRET')?.trim() ?? '';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new VetVideoProviderConfigurationError(
        'LiveKit provider is not configured',
      );
    }
    if (
      !['wss:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/' ||
      !apiKey ||
      apiKey.length > 255 ||
      apiSecret.length < 16 ||
      apiSecret.length > 1024
    )
      throw new VetVideoProviderConfigurationError(
        'LiveKit provider is not configured',
      );
    return { url: parsed.toString().replace(/\/$/, ''), apiKey, apiSecret };
  }
}
