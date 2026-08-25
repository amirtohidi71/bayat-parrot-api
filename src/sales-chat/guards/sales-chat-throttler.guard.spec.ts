import { getTrustedProxyClientIp } from '../../common/security/trusted-proxy-client-ip';

describe('Sales Chat trusted proxy client tracking', () => {
  it('uses a direct client address and ignores spoofed forwarding headers', () => {
    expect(
      getTrustedProxyClientIp({
        socket: { remoteAddress: '203.0.113.10' },
        headers: { 'x-forwarded-for': '198.51.100.7' },
      }),
    ).toBe('203.0.113.10');
  });

  it('uses the rightmost valid client reported by a loopback proxy', () => {
    expect(
      getTrustedProxyClientIp({
        socket: { remoteAddress: '::1' },
        headers: {
          'x-forwarded-for': '198.51.100.20, 203.0.113.21',
        },
      }),
    ).toBe('203.0.113.21');
  });

  it('falls back to the loopback peer for malformed forwarding data', () => {
    expect(
      getTrustedProxyClientIp({
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-forwarded-for': '198.51.100.20, not-an-ip' },
      }),
    ).toBe('127.0.0.1');
  });

  it('gives distinct proxied clients distinct trackers', () => {
    const first = getTrustedProxyClientIp({
      socket: { remoteAddress: '::ffff:127.0.0.1' },
      headers: { 'x-forwarded-for': '198.51.100.30' },
    });
    const second = getTrustedProxyClientIp({
      socket: { remoteAddress: '::ffff:127.0.0.1' },
      headers: { 'x-forwarded-for': '198.51.100.31' },
    });
    expect(first).not.toBe(second);
  });
});
