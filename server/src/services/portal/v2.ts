import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { Agent, request } from 'undici';
import { config } from '../../config';
import type { CaseAddress } from '../../../../shared/caseAddress';
import { PortalError, toPortalShipping, type PortalCaseInfo, type PortalCaseInput, type PortalClient, type PortalField } from './client';

// ---------------------------------------------------------------------------
// Address safety: partners choose the portal URL, so it must never reach our own network.
// ---------------------------------------------------------------------------
const PRIVATE_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'];
const PRIVATE_V6 = ['::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8', '2001:db8::/32', '64:ff9b::/96'];
const blocked = (() => {
  const b = new BlockList();
  for (const c of PRIVATE_V4) {
    const [n, p] = c.split('/');
    b.addSubnet(n!, Number(p), 'ipv4');
  }
  for (const c of PRIVATE_V6) {
    const [n, p] = c.split('/');
    b.addSubnet(n!, Number(p), 'ipv6');
  }
  return b;
})();

export function isPrivateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return isPrivateAddress(mapped[1]!);
  const fam = isIP(addr);
  if (fam === 4) return blocked.check(addr, 'ipv4');
  if (fam === 6) return blocked.check(addr, 'ipv6');
  return true;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface UrlRules {
  /** Allow http and private addresses for localhost (development and tests only). */
  allowLocal: boolean;
}
export const defaultUrlRules = (): UrlRules => ({ allowLocal: !config.isProd });

/** Validates a portal base URL and returns it without a trailing slash or `/api/v2`. Throws PortalError('blocked_url'). */
export function assertSafePortalUrl(raw: string, rules: UrlRules = defaultUrlRules()): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new PortalError('blocked_url');
  }
  const host = u.hostname.toLowerCase();
  const local = LOCAL_HOSTS.has(host) || LOCAL_HOSTS.has(u.host.toLowerCase());
  if (u.username || u.password || u.search || u.hash) throw new PortalError('blocked_url');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && rules.allowLocal)) throw new PortalError('blocked_url');
  if (local) {
    if (!rules.allowLocal) throw new PortalError('blocked_url');
  } else {
    if (isIP(host.replace(/^\[|\]$/g, '')) && isPrivateAddress(host)) throw new PortalError('blocked_url');
    if (/(^|\.)(local|localhost|internal|intranet|lan|home|corp)$/.test(host) || !host.includes('.')) throw new PortalError('blocked_url');
  }
  return (u.origin + u.pathname).replace(/\/+$/, '').replace(/\/api\/v2$/i, '');
}

/** DNS lookup that refuses private addresses (also protects against DNS rebinding, because it runs at connect time). */
function safeLookup(allowLocal: boolean) {
  return (hostname: string, options: any, cb: (err: Error | null, address?: any, family?: number) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs: any) => {
      if (err) return cb(err);
      const list: { address: string; family: number }[] = Array.isArray(addrs) ? addrs : [addrs];
      if (!allowLocal && list.some((a) => isPrivateAddress(a.address))) {
        const e: any = new Error('blocked address');
        e.code = 'KPH_BLOCKED_ADDRESS';
        return cb(e);
      }
      if (options?.all) return cb(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

// ---------------------------------------------------------------------------
export interface PortalV2Options {
  baseUrl: string;
  apiKey: string;
  userUuid: string;
  doctorId?: string | null;
  rules?: UrlRules;
  /** Milliseconds. */
  timeouts?: { json?: number; upload?: number };
}

const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 200) || 'file';

export class PortalV2Client implements PortalClient {
  private base: string;
  private agent: Agent;
  private json: number;
  private upload: number;

  constructor(private o: PortalV2Options) {
    const rules = o.rules ?? defaultUrlRules();
    this.base = assertSafePortalUrl(o.baseUrl, rules);
    const local = LOCAL_HOSTS.has(new URL(this.base).hostname.toLowerCase());
    this.agent = new Agent({ connect: { lookup: safeLookup(rules.allowLocal && local) as any }, keepAliveTimeout: 10_000 });
    this.json = o.timeouts?.json ?? 30_000;
    this.upload = o.timeouts?.upload ?? 20 * 60_000;
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'x-kline-api-key': this.o.apiKey, 'x-kline-api-user-uuid': this.o.userUuid };
    if (this.o.doctorId) h['x-kline-doctor-id'] = this.o.doctorId;
    return h;
  }

  private async call(method: 'GET' | 'POST' | 'PATCH', path: string, opts: { body?: unknown; headers?: Record<string, string>; stream?: Readable; timeout?: number } = {}): Promise<any> {
    const headers: Record<string, string> = { accept: 'application/json', ...this.authHeaders(), ...(opts.headers ?? {}) };
    let body: any;
    if (opts.stream) body = opts.stream;
    else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    } else if (method !== 'GET') {
      headers['content-type'] = 'application/json';
    }
    const timeout = opts.timeout ?? this.json;
    let res;
    try {
      res = await request(`${this.base}/api/v2/${path}`, { method, headers, body, dispatcher: this.agent, headersTimeout: timeout, bodyTimeout: timeout, maxRedirections: 0 } as any);
    } catch (e: any) {
      const code = String(e?.code ?? e?.cause?.code ?? '');
      if (code === 'KPH_BLOCKED_ADDRESS') throw new PortalError('blocked_url');
      if (/TIMEOUT/.test(code) || e?.name === 'TimeoutError') throw new PortalError('timeout');
      throw new PortalError('network');
    }
    let text = '';
    try {
      text = await res.body.text();
    } catch {
      throw new PortalError('network');
    }
    const s = res.statusCode;
    if ([200, 201, 202, 204, 301, 302].includes(s)) {
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new PortalError('unexpected', s);
      }
    }
    if (s === 401 || s === 403) throw new PortalError('auth', s);
    if (s === 404) throw new PortalError('not_found', s);
    if (s === 408) throw new PortalError('timeout', s);
    if (s === 429) throw new PortalError('rate_limited', s);
    if (s >= 500) throw new PortalError('server', s);
    if (s >= 400) throw new PortalError('validation', s);
    throw new PortalError('unexpected', s);
  }

  async ping(): Promise<void> {
    const r = await this.call('GET', 'ping');
    const msg = r?.data?.message ?? r?.message;
    if (msg !== 'pong') throw new PortalError('unexpected');
  }

  async createCase(input: PortalCaseInput): Promise<{ uuid: string }> {
    const r = await this.call('POST', 'cases', {
      body: {
        first_name: input.firstName,
        last_name: input.lastName,
        gender: input.gender,
        product_type: input.productType,
        ...(input.doctorInstructions ? { doctor_instructions: input.doctorInstructions } : {}),
      },
    });
    const d = Array.isArray(r?.data) ? r.data[0] : r?.data;
    const uuid = d?.uuid ?? d?.case_uuid;
    if (typeof uuid !== 'string' || !uuid) throw new PortalError('unexpected');
    return { uuid };
  }

  async uploadFile(caseUuid: string, field: PortalField, name: string, stream: Readable, size: number): Promise<{ fileUuid: string | null }> {
    if (!/^[0-9a-f-]{8,64}$/i.test(caseUuid) || !/^field_case_[a-z0-9_]+$/.test(field)) throw new PortalError('validation');
    const r = await this.call('POST', `cases/${encodeURIComponent(caseUuid)}/files/${field}`, {
      stream,
      timeout: this.upload,
      headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${asciiName(name)}"`, 'content-length': String(size) },
    });
    return { fileUuid: r?.file_uuid ?? r?.data?.file_uuid ?? null };
  }

  async setShippingAddress(caseUuid: string, address: CaseAddress): Promise<void> {
    if (!/^[0-9a-f-]{8,64}$/i.test(caseUuid)) throw new PortalError('validation');
    // Company and recipient details only: no patient data. Same error mapping and timeouts as every other JSON call.
    await this.call('PATCH', `cases/${encodeURIComponent(caseUuid)}/shipping-address`, { body: toPortalShipping(address) });
  }

  async submitCase(caseUuid: string): Promise<void> {
    if (!/^[0-9a-f-]{8,64}$/i.test(caseUuid)) throw new PortalError('validation');
    await this.call('PATCH', `cases/${encodeURIComponent(caseUuid)}/submit`, { body: {} });
  }

  async getCase(caseUuid: string): Promise<PortalCaseInfo> {
    if (!/^[0-9a-f-]{8,64}$/i.test(caseUuid)) throw new PortalError('validation');
    const r = await this.call('GET', `cases/${encodeURIComponent(caseUuid)}`);
    const d = Array.isArray(r?.data) ? r.data[0] : r?.data;
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return {
      uuid: d?.uuid ?? caseUuid,
      status: text(d?.case_status ?? d?.field_case_status),
      trackingNumber: text(d?.tracking_number),
      expectedShippingDate: text(d?.expected_shipping_date),
    };
  }
}
