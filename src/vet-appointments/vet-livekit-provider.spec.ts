import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { TokenVerifier } from 'livekit-server-sdk';
import {
  LiveKitRoomTransport,
  LiveKitVetVideoProvider,
} from './vet-livekit-provider';
import {
  VetVideoProviderConfigurationError,
  VetVideoProviderUnavailableError,
} from './vet-video-provider';

describe('LiveKit vet video provider', () => {
  const apiKey = 'test-api-key';
  const apiSecret = 'test-api-secret-with-at-least-32-characters';
  const values = {
    LIVEKIT_URL: 'wss://video.example.test',
    LIVEKIT_API_KEY: apiKey,
    LIVEKIT_API_SECRET: apiSecret,
  };

  function subject(overrides: Record<string, string> = {}) {
    const ensureRoom: jest.MockedFunction<LiveKitRoomTransport['ensureRoom']> =
      jest.fn().mockResolvedValue(undefined);
    const transport: LiveKitRoomTransport = { ensureRoom };
    return {
      provider: new LiveKitVetVideoProvider(
        new ConfigService({ ...values, ...overrides }),
        transport,
      ),
      ensureRoom,
    };
  }

  it('uses deterministic appointment-linked room identity and idempotent transport', async () => {
    const { provider, ensureRoom } = subject();
    const appointmentId = randomUUID();
    const end = new Date(Date.now() + 60_000);
    const first = provider.meetingId(appointmentId);
    const retry = provider.meetingId(appointmentId.toUpperCase());
    expect(first).toBe(`vet-${appointmentId}`);
    expect(retry).toBe(first);
    await provider.ensureMeeting(first, end);
    await provider.ensureMeeting(retry, end);
    expect(ensureRoom).toHaveBeenCalledTimes(2);
    expect(new Set(ensureRoom.mock.calls.map((call) => call[1]))).toEqual(
      new Set([first]),
    );
  });

  it.each(['CUSTOMER', 'DOCTOR'] as const)(
    'issues least-privilege %s participant grants',
    async (type) => {
      const { provider } = subject();
      const appointmentId = randomUUID();
      const participantId = randomUUID();
      const room = provider.meetingId(appointmentId);
      const now = new Date();
      const credential = await provider.issueAccess(
        randomUUID(),
        appointmentId,
        room,
        { type, id: participantId },
        now,
        new Date(now.getTime() + 60_000),
      );
      const claims = await new TokenVerifier(apiKey, apiSecret).verify(
        credential.token,
      );
      expect(claims.sub).toBe(`${type.toLowerCase()}:${participantId}`);
      expect(claims.attributes).toMatchObject({
        participantType: type,
        appointmentId,
      });
      expect(claims.video).toMatchObject({
        room,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
      });
      expect(claims.video?.roomAdmin).not.toBe(true);
      expect(claims.video?.roomCreate).not.toBe(true);
      expect(claims.video?.roomList).not.toBe(true);
      expect(claims.video?.roomRecord).not.toBe(true);
      expect(claims.video?.ingressAdmin).not.toBe(true);
      expect(credential.serverUrl).toBe(values.LIVEKIT_URL);
      expect(credential.token).not.toContain(apiSecret);
    },
  );

  it.each([
    { LIVEKIT_URL: '' },
    { LIVEKIT_URL: 'http://insecure.example.test' },
    { LIVEKIT_API_KEY: '' },
    { LIVEKIT_API_SECRET: '' },
  ])('fails safely for missing or invalid config: %j', async (override) => {
    const { provider, ensureRoom } = subject(override);
    await expect(
      provider.ensureMeeting(provider.meetingId(randomUUID()), new Date()),
    ).rejects.toThrow(VetVideoProviderConfigurationError);
    expect(ensureRoom).not.toHaveBeenCalled();
  });

  it('normalizes transport failures without exposing provider details', async () => {
    const transport = {
      ensureRoom: jest.fn().mockRejectedValue(new Error('PRIVATE PROVIDER')),
    } as LiveKitRoomTransport;
    const provider = new LiveKitVetVideoProvider(
      new ConfigService(values),
      transport,
    );
    await expect(
      provider.ensureMeeting(provider.meetingId(randomUUID()), new Date()),
    ).rejects.toEqual(
      new VetVideoProviderUnavailableError('LiveKit room unavailable'),
    );
  });
});
