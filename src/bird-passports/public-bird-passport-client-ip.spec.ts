import {
  getBirdPassportClientIp,
  isLoopbackPeer,
} from './public-bird-passport-client-ip';

describe('public Bird Passport client IP', () => {
  it('ignores spoofed forwarding headers from a direct non-loopback peer', () => {
    const request = {
      socket: { remoteAddress: '203.0.113.10' },
      headers: { 'x-forwarded-for': '198.51.100.1' },
    };
    expect(getBirdPassportClientIp(request)).toBe('203.0.113.10');
    request.headers['x-forwarded-for'] = '198.51.100.2';
    expect(getBirdPassportClientIp(request)).toBe('203.0.113.10');
  });

  it('uses the rightmost proxy-appended address from a loopback peer', () => {
    expect(
      getBirdPassportClientIp({
        socket: { remoteAddress: '::1' },
        headers: { 'x-forwarded-for': '192.0.2.1, 198.51.100.7' },
      }),
    ).toBe('198.51.100.7');
  });

  it('falls back to the trusted peer for a malformed forwarding header', () => {
    expect(
      getBirdPassportClientIp({
        socket: { remoteAddress: '::ffff:127.0.0.1' },
        headers: { 'x-forwarded-for': 'not-an-ip' },
      }),
    ).toBe('127.0.0.1');
  });

  it('recognizes only loopback peers as trusted reverse proxies', () => {
    expect(isLoopbackPeer('127.20.30.40')).toBe(true);
    expect(isLoopbackPeer('::1')).toBe(true);
    expect(isLoopbackPeer('10.0.0.1')).toBe(false);
    expect(isLoopbackPeer('203.0.113.10')).toBe(false);
  });
});
