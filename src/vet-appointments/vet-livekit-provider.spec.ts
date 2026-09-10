import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { RoomServiceClient, TokenVerifier } from 'livekit-server-sdk';
import {
  LiveKitRoomTransport,
  LiveKitSdkRoomTransport,
  LiveKitVetVideoProvider,
} from './vet-livekit-provider';
import {
  VetVideoProviderConfigurationError,
  VetVideoProviderUnavailableError,
} from './vet-video-provider';

jest.mock('livekit-server-sdk', () => {
  const actual = jest.requireActual('livekit-server-sdk');
  return { ...actual, RoomServiceClient: jest.fn() };
});

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

  beforeEach(() => jest.mocked(RoomServiceClient).mockReset());

  it.each([
    ['ws://127.0.0.1:7880', 'http://127.0.0.1:7880'],
    ['wss://video.example.test', 'https://video.example.test'],
  ])(
    'passes %s to RoomServiceClient as %s',
    async (configuredUrl, expectedServiceUrl) => {
      const createRoom = jest.fn().mockResolvedValue({});
      jest
        .mocked(RoomServiceClient)
        .mockImplementation(() => ({ createRoom }) as never);
      const transport = new LiveKitSdkRoomTransport();
      await transport.ensureRoom(
        {
          url: configuredUrl,
          apiKey,
          apiSecret,
        },
        'test-room',
        new Date(Date.now() + 60_000),
      );

      expect(RoomServiceClient).toHaveBeenCalledWith(
        expectedServiceUrl,
        apiKey,
        apiSecret,
        { requestTimeout: 5 },
      );
      expect(createRoom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'test-room' }),
      );
    },
  );

  it.each(['ws://127.0.0.1:7880', 'ws://localhost:7880'])(
    'allows built-in development credentials for loopback URL %s',
    async (url) => {
      const { provider, ensureRoom } = subject({
        NODE_ENV: 'development',
        LIVEKIT_URL: url,
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'secret',
      });
      const appointmentId = randomUUID();
      const meetingId = provider.meetingId(appointmentId);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);

      await provider.ensureMeeting(meetingId, expiresAt);
      const credential = await provider.issueAccess(
        randomUUID(),
        appointmentId,
        meetingId,
        { type: 'DOCTOR', id: randomUUID() },
        now,
        expiresAt,
      );

      expect(ensureRoom).toHaveBeenCalledWith(
        expect.objectContaining({ url }),
        meetingId,
        expiresAt,
      );
      expect(credential.serverUrl).toBe(url);
      await expect(
        new TokenVerifier('devkey', 'secret').verify(credential.token),
      ).resolves.toBeDefined();
    },
  );

  it.each(['production', 'staging', 'preview', 'unknown'])(
    'rejects built-in development credentials in %s',
    async (environment) => {
      const { provider, ensureRoom } = subject({
        NODE_ENV: environment,
        LIVEKIT_URL: 'ws://127.0.0.1:7880',
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'secret',
      });
      await expect(
        provider.ensureMeeting(provider.meetingId(randomUUID()), new Date()),
      ).rejects.toThrow(VetVideoProviderConfigurationError);
      expect(ensureRoom).not.toHaveBeenCalled();
    },
  );

  it('rejects non-loopback insecure WebSocket URLs in development', async () => {
    const { provider, ensureRoom } = subject({
      NODE_ENV: 'development',
      LIVEKIT_URL: 'ws://192.0.2.10:7880',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
    });
    await expect(
      provider.ensureMeeting(provider.meetingId(randomUUID()), new Date()),
    ).rejects.toThrow(VetVideoProviderConfigurationError);
    expect(ensureRoom).not.toHaveBeenCalled();
  });

  it.each(['wss://video.example.test', 'https://video.example.test'])(
    'preserves secure URL support for %s',
    async (url) => {
      const { provider, ensureRoom } = subject({ LIVEKIT_URL: url });
      await provider.ensureMeeting(
        provider.meetingId(randomUUID()),
        new Date(),
      );
      expect(ensureRoom).toHaveBeenCalledWith(
        expect.objectContaining({ url }),
        expect.any(String),
        expect.any(Date),
      );
    },
  );

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
