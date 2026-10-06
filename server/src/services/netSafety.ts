import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, buildConnector } from 'undici';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Address safety for everything that calls a URL a partner chose (webhooks).
// Partners must never be able to make the Hub talk to its own network, the cloud metadata service or a neighbour.
// ---------------------------------------------------------------------------
const V4_BLOCKED = [
  '0.0.0.0/8', // "this" network
  '10.0.0.0/8', // private
  '100.64.0.0/10', // carrier grade NAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link local, includes the cloud metadata address 169.254.169.254
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // documentation
  '192.88.99.0/24', // 6to4 relay anycast
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // documentation
  '203.0.113.0/24', // documentation
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, includes broadcast
];
const V6_BLOCKED = [
  '::/128', // unspecified
  '::1/128', // loopback
  '64:ff9b::/96', // NAT64 (embeds an IPv4 address)
  '64:ff9b:1::/48', // local use NAT64
  '100::/64', // discard only
  '2001::/32', // Teredo
  '2001:db8::/32', // documentation
  'fc00::/7', // unique local
  'fe80::/10', // link local
  'fec0::/10', // site local (deprecated)
  'ff00::/8', // multicast
];

const blocked = (() => {
  const b = new BlockList();
  for (const c of V4_BLOCKED) {
    const [n, p] = c.split('/');
    b.addSubnet(n!, Number(p), 'ipv4');
  }
  for (const c of V6_BLOCKED) {
    const [n, p] = c.split('/');
    b.addSubnet(n!, Number(p), 'ipv6');
  }
  return b;
})();

/** Expands an IPv6 address to its 8 groups, or null when it is not valid. Handles `::` and a dotted IPv4 tail. */
function v6Groups(addr: string): number[] | null {
  if (isIP(addr) !== 6) return null;
  let a = addr.toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (tail) {
    const hi = ((Number(tail[1]) << 8) | Number(tail[2])).toString(16);
    const lo = ((Number(tail[3]) << 8) | Number(tail[4])).toString(16);
    a = a.slice(0, tail.index) + hi + ':' + lo;
  }
  const [head, rest] = a.split('::');
  const h = head ? head.split(':') : [];
  const r = rest === undefined ? [] : rest ? rest.split(':') : [];
  if (rest === undefined) return h.length === 8 ? h.map((x) => parseInt(x, 16)) : null;
  const fill = 8 - h.length - r.length;
  if (fill < 0) return null;
  return [...h, ...Array(fill).fill('0'), ...r].map((x) => parseInt(x, 16));
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * True when a connection to this address must be refused: private, loopback, link local, multicast, carrier grade NAT,
 * metadata, reserved, and anything that embeds such an IPv4 address (mapped, compatible, 6to4, NAT64). Anything that is
 * not an IP address counts as blocked.
 */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '');
  const fam = isIP(addr);
  if (fam === 4) return blocked.check(addr, 'ipv4');
  if (fam !== 6) return true;
  const g = v6Groups(addr);
  if (!g) return true;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated): judge the embedded IPv4 address
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && g[7]! <= 1) return true; // :: and ::1
    return blocked.check(v4Of(g[6]!, g[7]!), 'ipv4');
  }
  // 2002::/16 (6to4) is obsolete and embeds an IPv4 address that could be private: refused as a whole
  if (g[0] === 0x2002) return true;
  return blocked.check(addr, 'ipv6');
}

// ---------------------------------------------------------------------------
// Options (tests replace the resolver and the local allowance)
// ---------------------------------------------------------------------------
export interface ResolvedAddress {
  address: string;
  family: number;
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const systemResolver: Resolver = async (hostname) => {
  const r = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return r.map((x) => ({ address: x.address, family: x.family }));
};

interface NetOptions {
  resolver: Resolver;
  /** Development and tests: http and loopback targets on localhost, 127.0.0.1 and [::1]. Never in production. */
  allowLocal: boolean;
}
const defaults = (): NetOptions => ({ resolver: systemResolver, allowLocal: !config.isProd });
let overrides: Partial<NetOptions> = {};

/** For tests: replace the DNS resolver and/or the local allowance. Production never allows local targets, whatever is set. */
export function setNetOptions(o: Partial<NetOptions>): void {
  overrides = { ...overrides, ...o };
}
export function resetNetOptions(): void {
  overrides = {};
}
function opts(): NetOptions {
  const o = { ...defaults(), ...overrides };
  if (config.isProd) o.allowLocal = false;
  return o;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
/** localhost, 127.0.0.1 and [::1] only: the hosts the development allowance covers. */
export const isLocalHost = (host: string) => LOCAL_HOSTS.has(host.toLowerCase().replace(/^\[|\]$/g, ''));

// ---------------------------------------------------------------------------
// URL rules
// ---------------------------------------------------------------------------
export class UrlProblem extends Error {
  constructor(
    public code: 'invalid_url' | 'not_https' | 'has_credentials' | 'blocked_host' | 'blocked_address' | 'unresolvable',
    message: string,
  ) {
    super(message);
  }
}

export const WEBHOOK_URL_MAX = 500;
const INTERNAL_NAME = /(^|\.)(local|localhost|internal|intranet|lan|home|corp|localdomain)$/;

/**
 * Checks the shape of a target URL without touching the network: https, no credentials, no fragment, no internal names,
 * no private IP literal. Returns the parsed URL. With the development allowance, http to localhost is accepted.
 */
export function checkUrlShape(raw: string): URL {
  if (raw.length > WEBHOOK_URL_MAX) throw new UrlProblem('invalid_url', `The address can be at most ${WEBHOOK_URL_MAX} characters.`);
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new UrlProblem('invalid_url', 'That is not a valid web address.');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local = isLocalHost(host) && opts().allowLocal;
  if (u.username || u.password) throw new UrlProblem('has_credentials', 'Do not put a user name or password in the address.');
  if (u.hash) throw new UrlProblem('invalid_url', 'Leave out the part of the address after #.');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new UrlProblem('not_https', 'The address must start with https://.');
  if (!host) throw new UrlProblem('invalid_url', 'That is not a valid web address.');
  if (local) return u;
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new UrlProblem('blocked_address', 'That address points to a private or reserved network, which is not allowed.');
  } else if (INTERNAL_NAME.test(host) || !host.includes('.')) {
    throw new UrlProblem('blocked_host', 'That address is an internal name, which is not allowed.');
  }
  return u;
}

/** Shape check plus a DNS lookup that refuses private targets. A courtesy at save time: delivery checks again when it connects. */
export async function validateTargetUrl(raw: string): Promise<URL> {
  const u = checkUrlShape(raw);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host) || (isLocalHost(host) && opts().allowLocal)) return u;
  let addrs: ResolvedAddress[];
  try {
    addrs = await opts().resolver(host);
  } catch {
    throw new UrlProblem('unresolvable', 'We could not find that address. Check the spelling of the host name.');
  }
  if (!addrs.length) throw new UrlProblem('unresolvable', 'We could not find that address. Check the spelling of the host name.');
  if (addrs.some((a) => isBlockedAddress(a.address))) throw new UrlProblem('blocked_address', 'That address points to a private or reserved network, which is not allowed.');
  return u;
}

// ---------------------------------------------------------------------------
// The connection itself
// ---------------------------------------------------------------------------
export class BlockedAddressError extends Error {
  code = 'KPH_BLOCKED_ADDRESS';
  constructor() {
    super('blocked address');
  }
}

/**
 * The DNS step of every new connection. It runs at connect time, and the address it returns is the one Node connects to,
 * so a name that answered with a public address when it was saved and answers with a private one now (DNS rebinding) is refused here.
 * Every address the name resolves to must be public: a mixed answer is refused as a whole.
 */
function guardedLookup(hostname: string, options: { all?: boolean } | undefined, cb: (err: Error | null, address?: any, family?: number) => void): void {
  const o = opts();
  void (async () => {
    try {
      const list = await o.resolver(hostname);
      if (!list.length) throw new Error('no address');
      const allowPrivate = o.allowLocal && isLocalHost(hostname);
      if (!allowPrivate && list.some((a) => isBlockedAddress(a.address))) throw new BlockedAddressError();
      if (options?.all) return cb(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    } catch (e) {
      cb(e instanceof Error ? e : new Error('lookup failed'));
    }
  })();
}

let agent: Agent | undefined;
/** One shared agent: own DNS step, 10 second connect timeout, no redirects are followed by the callers. */
export function safeAgent(): Agent {
  if (agent) return agent;
  const base = buildConnector({ timeout: 10_000, lookup: guardedLookup as any });
  agent = new Agent({
    keepAliveTimeout: 5_000,
    connections: 50,
    connect: (connectOpts: any, cb: any) => {
      // IP literals skip DNS, so they are judged here, at connect time, as well.
      const host = String(connectOpts.hostname ?? '').replace(/^\[|\]$/g, '');
      if (isIP(host) && !(opts().allowLocal && isLocalHost(host)) && isBlockedAddress(host)) return cb(new BlockedAddressError(), null);
      base(connectOpts, (err: Error | null, socket: any) => {
        if (err) return cb(err, null);
        // Belt and braces where the platform reports the peer: never keep a socket that ended up on a blocked address.
        const peer = socket?.remoteAddress;
        if (peer && isIP(peer) && !(opts().allowLocal && isLocalHost(host)) && isBlockedAddress(peer)) {
          socket.destroy();
          return cb(new BlockedAddressError(), null);
        }
        cb(null, socket);
      });
    },
  } as any);
  return agent;
}

export async function closeSafeAgent(): Promise<void> {
  const a = agent;
  agent = undefined;
  await a?.close();
}
