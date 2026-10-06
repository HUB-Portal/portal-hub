import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { config } from '../config';

/**
 * Headers that a reverse proxy or a tunnel (for example cloudflared) adds. A request that carries any of them did not come straight
 * from a person on this computer or network, whatever address the socket shows (a tunnel connects from 127.0.0.1).
 */
export const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'x-real-ip'] as const;

export function hasProxyHeaders(headers: Record<string, unknown>): boolean {
  return PROXY_HEADERS.some((h) => headers[h] !== undefined);
}

/** Loopback, private (RFC 1918), link local and unique local addresses: the places a person using the Hub directly can be. */
const LOCAL = (() => {
  const b = new BlockList();
  for (const [n, p] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16]] as const) b.addSubnet(n, p, 'ipv4');
  for (const [n, p] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) b.addSubnet(n, p, 'ipv6');
  return b;
})();

/** True when the socket peer is a loopback or private address (never the forwarded client address). */
export function isLocalPeer(address: string | undefined | null): boolean {
  if (!address) return false;
  let a = address.replace(/^\[|\]$/g, '');
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1]!;
  const fam = isIP(a);
  if (fam === 4) return LOCAL.check(a, 'ipv4');
  if (fam === 6) return LOCAL.check(a, 'ipv6');
  return false;
}

/**
 * Demo helpers (accounts with the password and live authenticator codes, the development mailbox, registration links, hints in
 * /api/auth/me) are for direct local use only: demo mode on, no proxy headers, and a loopback or private peer.
 */
export function demoAllowed(req: Pick<FastifyRequest, 'headers' | 'socket'>): boolean {
  if (!config.demoMode) return false;
  if (hasProxyHeaders(req.headers as Record<string, unknown>)) return false;
  return isLocalPeer(req.socket?.remoteAddress);
}
