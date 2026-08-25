import { isIP } from 'node:net';

export type TrustedProxyClientIpRequest = {
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: string | null };
};

function normalizeIp(value: string): string | undefined {
  const candidate = value.trim();
  const mappedIpv4 = candidate.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const normalized = mappedIpv4 ?? candidate;
  return isIP(normalized) ? normalized.toLowerCase() : undefined;
}

export function isLoopbackPeer(value: string): boolean {
  const ip = normalizeIp(value);
  if (!ip) return false;
  if (ip === '::1') return true;
  if (isIP(ip) !== 4) return false;
  return ip.split('.')[0] === '127';
}

export function getTrustedProxyClientIp(
  request: TrustedProxyClientIpRequest,
): string {
  const remoteAddress = request.socket?.remoteAddress ?? '';
  const peer = normalizeIp(remoteAddress) ?? 'unknown';
  if (!isLoopbackPeer(remoteAddress)) return peer;

  const forwarded = request.headers?.['x-forwarded-for'];
  if (typeof forwarded !== 'string') return peer;
  const chain = forwarded.split(',').map((part) => part.trim());
  const proxyReportedClient = normalizeIp(chain.at(-1) ?? '');
  return proxyReportedClient ?? peer;
}
