// Types, validation and text for the ERP and API page (phase 6). Response shapes follow docs/PHASE6_CONTRACT.md.
// Readers accept both camelCase and snake_case names so a small difference on the server does not break the page.
import { humanise, type Tone } from './format';

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function pick(r: Record<string, any>, ...names: string[]): unknown {
  for (const n of names) if (r[n] !== undefined && r[n] !== null) return r[n];
  return undefined;
}

export function listOf(raw: unknown, ...keys: string[]): Record<string, any>[] {
  const arr = Array.isArray(raw) ? raw : isObj(raw) ? ['items', ...keys].map((k) => (raw as Record<string, unknown>)[k]).find(Array.isArray) : undefined;
  return ((arr as unknown[] | undefined) ?? []).filter(isObj);
}

// ---- API keys -----------------------------------------------------------------------------------------------------------

export type KeyStatus = 'active' | 'expired' | 'revoked';

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  cidrs: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string | null;
  createdByName: string | null;
  revokedAt: string | null;
  status: KeyStatus;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function normalizeKeys(raw: unknown): ApiKeyRow[] {
  return listOf(raw, 'keys', 'apiKeys').map((r) => {
    const expiresAt = str(pick(r, 'expiresAt', 'expires_at'));
    const revokedAt = str(pick(r, 'revokedAt', 'revoked_at'));
    const given = str(r.status);
    const status: KeyStatus = given === 'active' || given === 'expired' || given === 'revoked'
      ? given
      : revokedAt ? 'revoked' : expiresAt && new Date(expiresAt).getTime() < Date.now() ? 'expired' : 'active';
    return {
      id: String(r.id),
      name: str(r.name) ?? 'Unnamed key',
      prefix: str(r.prefix) ?? '',
      scopes: strings(r.scopes),
      cidrs: strings(r.cidrs),
      expiresAt,
      lastUsedAt: str(pick(r, 'lastUsedAt', 'last_used_at')),
      lastUsedIp: str(pick(r, 'lastUsedIp', 'last_used_ip')),
      createdAt: str(pick(r, 'createdAt', 'created_at')),
      createdByName: str(pick(r, 'createdByName', 'created_by_name')),
      revokedAt,
      status,
    };
  });
}

export function keyStatusBadge(s: KeyStatus): { label: string; tone: Tone } {
  return s === 'revoked' ? { label: 'Revoked', tone: 'bad' } : s === 'expired' ? { label: 'Expired', tone: 'warn' } : { label: 'Active', tone: 'good' };
}

export const SCOPE_INFO: Record<string, { label: string; text: string; warn?: string }> = {
  'cases:read': { label: 'Read cases', text: 'See your cases, their status, file lists and shipments. Patient names are not included.' },
  'cases:write': { label: 'Create and submit cases', text: 'Create draft cases, upload files and submit cases for production.' },
  'patients:read': {
    label: 'Read patient names',
    text: 'Adds the first and last name of the patient to case data.',
    warn: 'This shares patient names with whatever system holds the key. Only choose it if that system really needs names. Every read is recorded in your access log. It also needs Read cases.',
  },
  'claims:read': { label: 'Read quality claims', text: 'See the list of your claims and their status.' },
  'materials:read': { label: 'Read material stock', text: 'See the stock levels at each K Line site.' },
};

export const EXPIRY_CHOICES: { days: number; label: string }[] = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
  { days: 730, label: '2 years (longest)' },
];

export function daysUntil(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.ceil((t - now) / 86_400_000);
}

// ---- allowed addresses (CIDR) ---------------------------------------------------------------------------------------

function isIPv4(s: string): boolean {
  const p = s.split('.');
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
}

function isIPv6(s: string): boolean {
  if (!s.includes(':') || !/^[0-9a-fA-F:.]+$/.test(s)) return false;
  let str = s;
  const last = s.slice(s.lastIndexOf(':') + 1);
  if (last.includes('.')) {
    if (!isIPv4(last)) return false;
    str = `${s.slice(0, s.lastIndexOf(':') + 1)}0:0`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return false;
  const groups = (x: string) => (x === '' ? [] : x.split(':'));
  const all = [...groups(halves[0] ?? ''), ...(halves.length === 2 ? groups(halves[1] ?? '') : [])];
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  return halves.length === 2 ? all.length <= 7 : all.length === 8;
}

export interface CidrResult { list: string[]; bad: string | null; tooMany: boolean }

/** Reads one address or range per line (commas and spaces also work). A single address becomes a /32 or /128 range. */
export function parseCidrs(text: string): CidrResult {
  const seen = new Set<string>();
  let bad: string | null = null;
  for (const token of text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)) {
    const [addr = '', bits, ...extra] = token.split('/');
    const v4 = isIPv4(addr);
    const v6 = !v4 && isIPv6(addr);
    const max = v4 ? 32 : 128;
    const bitsOk = bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= max);
    if ((!v4 && !v6) || !bitsOk || extra.length) { bad = bad ?? token; continue; }
    seen.add(`${addr.toLowerCase()}/${bits ?? String(max)}`);
  }
  return { list: [...seen], bad, tooMany: seen.size > 20 };
}

// ---- webhooks -----------------------------------------------------------------------------------------------------------

export const WEBHOOK_EVENTS: { id: string; label: string; text: string }[] = [
  { id: 'case.submitted', label: 'Case submitted', text: 'A case was submitted for production.' },
  { id: 'case.on_hold', label: 'Case put on hold', text: 'K Line put a case on hold. The reason is in the platform.' },
  { id: 'case.received', label: 'Case received', text: 'The factory confirmed it has the files.' },
  { id: 'case.stage_changed', label: 'Production stage changed', text: 'A case moved to another production stage.' },
  { id: 'case.shipped', label: 'Case shipped', text: 'A case left the factory. Carrier and tracking number are included.' },
  { id: 'case.delivered', label: 'Case delivered', text: 'The carrier delivered a case.' },
  { id: 'case.cancelled', label: 'Case cancelled', text: 'A case was cancelled.' },
  { id: 'claim.updated', label: 'Claim updated', text: 'A quality claim changed status or got a decision.' },
  { id: 'materials.low_stock', label: 'Low material stock', text: 'Stock of a material fell below its minimum.' },
  { id: 'spec.updated', label: 'Specification updated', text: 'A production specification was proposed, rejected or activated.' },
];
export const eventLabel = (id: string): string => WEBHOOK_EVENTS.find((e) => e.id === id)?.label ?? (id === 'webhook.test' ? 'Test message' : humanise(id));

export interface WebhookRow {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  disabledReason: string | null;
  disabledAt: string | null;
  failures: number;
  lastDeliveryAt: string | null;
  lastStatus: string | null;
  lastStatusCode: number | null;
  createdAt: string | null;
}

export function normalizeWebhooks(raw: unknown): WebhookRow[] {
  return listOf(raw, 'webhooks').map((r) => {
    const last = isObj(r.lastDelivery) ? r.lastDelivery : isObj(r.last_delivery) ? r.last_delivery : null;
    const disabledReason = str(pick(r, 'disabledReason', 'disabled_reason'));
    const active = typeof r.active === 'boolean' ? r.active : !disabledReason;
    return {
      id: String(r.id),
      url: str(r.url) ?? '',
      description: str(r.description),
      events: strings(r.events),
      active,
      disabledReason,
      disabledAt: str(pick(r, 'disabledAt', 'disabled_at')),
      failures: num(pick(r, 'consecutiveFailures', 'consecutive_failures', 'failures', 'failureCount')) ?? 0,
      lastDeliveryAt: str(pick(r, 'lastDeliveryAt', 'last_delivery_at', 'lastAttemptAt')) ?? (last ? str(pick(last, 'at', 'createdAt', 'created_at', 'deliveredAt', 'delivered_at')) : null),
      lastStatus: str(pick(r, 'lastDeliveryStatus', 'last_delivery_status', 'lastOutcome')) ?? (last ? str(last.status) : null),
      lastStatusCode: num(pick(r, 'lastStatusCode', 'last_status_code')) ?? (last ? num(pick(last, 'statusCode', 'status_code', 'lastStatusCode')) : null),
      createdAt: str(pick(r, 'createdAt', 'created_at')),
    };
  });
}

/** Plain words for why a webhook was switched off. Anything unknown gets a safe general sentence. */
export function disabledText(reason: string | null): string {
  if (!reason) return 'This webhook is switched off.';
  if (/fail/i.test(reason)) return 'We switched this webhook off after 25 failed deliveries in a row.';
  if (/manual|user|admin/i.test(reason)) return 'This webhook was switched off by someone in your team.';
  return 'This webhook is switched off.';
}

function privateIPv4(h: string): boolean {
  const [a = 0, b = 0] = h.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A friendly reason why a webhook address would be refused, or null when it looks fine. The server checks again. */
export function webhookUrlProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.length > 500) return 'The address is too long. Use at most 500 characters.';
  let u: URL;
  try { u = new URL(v); } catch { return 'This is not a full web address. It should look like https://erp.example.com/hooks/kline.'; }
  if (u.protocol !== 'https:') return 'The address must start with https://. Plain http is not allowed.';
  if (u.username || u.password) return 'Do not put a user name or password in the address.';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !host.startsWith('[')) {
    return 'Use a public address. Local and internal names are not allowed.';
  }
  if (isIPv4(host) && privateIPv4(host)) return 'Use a public address. Private network addresses are not allowed.';
  if (host.startsWith('[')) {
    const inner = host.slice(1, -1);
    if (inner === '::1' || inner === '::' || /^f[cd]/.test(inner) || /^fe[89ab]/.test(inner) || /^ff/.test(inner) || inner.startsWith('::ffff:')) return 'Use a public address. Private network addresses are not allowed.';
  }
  return null;
}

export interface DeliveryRow {
  id: string;
  event: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string | null;
  deliveredAt: string | null;
}

export interface DeliveryPage { items: DeliveryRow[]; total: number; page: number; pageSize: number }

export function normalizeDeliveries(raw: unknown): DeliveryPage {
  const items = listOf(raw, 'deliveries').map((r): DeliveryRow => ({
    id: String(r.id),
    event: str(pick(r, 'event', 'type')) ?? '',
    status: str(r.status) ?? 'pending',
    attempts: num(r.attempts) ?? 0,
    lastStatusCode: num(pick(r, 'lastStatusCode', 'last_status_code', 'statusCode', 'status_code')),
    lastError: str(pick(r, 'lastError', 'last_error')),
    nextAttemptAt: str(pick(r, 'nextAttemptAt', 'next_attempt_at', 'nextAttempt')),
    createdAt: str(pick(r, 'createdAt', 'created_at')),
    deliveredAt: str(pick(r, 'deliveredAt', 'delivered_at')),
  }));
  const o = isObj(raw) ? raw : {};
  return { items, total: num(o.total) ?? items.length, page: num(o.page) ?? 1, pageSize: num(pick(o, 'pageSize', 'page_size')) ?? 25 };
}

export const DELIVERY_FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'pending', label: 'Waiting' },
  { id: 'retrying', label: 'Failed, will retry' },
  { id: 'dead', label: 'Gave up' },
];

export function deliveryBadge(status: string): { label: string; tone: Tone } {
  switch (status) {
    case 'delivered': return { label: 'Delivered', tone: 'good' };
    case 'pending': case 'sending': case 'queued': return { label: 'Waiting', tone: 'info' };
    case 'failed': case 'retrying': return { label: 'Failed, will retry', tone: 'warn' };
    case 'dead': return { label: 'Gave up', tone: 'bad' };
    default: return { label: humanise(status), tone: 'neutral' };
  }
}

/** The stored payload can come back bare or wrapped in an object with a "payload" key. */
export function unwrapPayload(raw: unknown): unknown {
  if (isObj(raw) && 'payload' in raw && !('type' in raw)) return raw.payload;
  return raw;
}

export interface TestResult { ok: boolean; status: number | null; durationMs: number | null; error: string | null }

export function normalizeTest(raw: unknown): TestResult {
  const o = isObj(raw) ? raw : {};
  return { ok: o.ok === true, status: num(o.status), durationMs: num(pick(o, 'durationMs', 'duration_ms')), error: str(o.error) ?? str(o.message) };
}

// ---- exports ------------------------------------------------------------------------------------------------------------

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function periodPreset(id: 'this-month' | 'last-month' | 'last-90', now = new Date()): { from: string; to: string } {
  if (id === 'this-month') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
  if (id === 'last-month') return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) };
  return { from: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89)), to: ymd(now) };
}

// ---- developer notes ----------------------------------------------------------------------------------------------------

export const apiBaseUrl = (): string => `${window.location.origin}/api/v1`;

export function curlSnippets(base: string): { title: string; text: string }[] {
  const h = '-H "Authorization: Bearer $KPH_API_KEY"';
  return [
    {
      title: 'List your cases',
      text: `# Put your key in an environment variable first. Never paste it into scripts you share.\nexport KPH_API_KEY="kph_..."\n\ncurl ${h} \\\n  "${base}/cases?simple_status=submitted&page=1&page_size=50"`,
    },
    {
      title: 'Create a draft case and upload a file',
      text: `# 1. Create a draft case\ncurl -X POST ${h} \\\n  -H "Content-Type: application/json" \\\n  -d '{"case_id":"ERP-1001"}' \\\n  "${base}/cases"\n\n# 2. Register a file. The answer has file_id, chunk_size and chunk_count.\ncurl -X POST ${h} \\\n  -H "Content-Type: application/json" \\\n  -d '{"purpose":"case","name":"U01.stl","size":20480000,"arch":"upper","step":1}' \\\n  "${base}/cases/ACME-000001/files"\n\n# 3. Send each chunk (index starts at 0) with its SHA-256\nCHUNK=chunk-0.bin\ncurl -X PUT ${h} \\\n  -H "Content-Type: application/octet-stream" \\\n  -H "x-chunk-sha256: $(sha256sum $CHUNK | cut -d' ' -f1)" \\\n  --data-binary @$CHUNK \\\n  "${window.location.origin}/api/uploads/FILE_ID/chunks/0"\n\n# 4. Finish the upload, then check the file state\ncurl -X POST ${h} "${window.location.origin}/api/uploads/FILE_ID/complete"\ncurl ${h} "${base}/files/FILE_ID"`,
    },
  ];
}

export const NODE_VERIFY = `import crypto from 'node:crypto';

// rawBody: the exact text you received, before any JSON parsing.
// header: the value of the x-kph-signature header.
// secret: the whsec_ secret of this webhook.
export function verifyKphSignature(rawBody, header, secret) {
  const parts = Object.fromEntries(
    String(header).split(',').map((p) => p.trim().split('=')),
  );
  const t = parts.t ?? '';
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!/^\\d+$/.test(t) || age > 300) return false; // older than 5 minutes

  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1 ?? '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}`;

export const PYTHON_VERIFY = `import hashlib
import hmac
import time


def verify_kph_signature(raw_body: bytes, header: str, secret: str) -> bool:
    """raw_body: the exact bytes received. header: the x-kph-signature value."""
    parts = dict(p.strip().split("=", 1) for p in header.split(",") if "=" in p)
    t, v1 = parts.get("t", ""), parts.get("v1", "")
    if not t.isdigit() or abs(time.time() - int(t)) > 300:  # older than 5 minutes
        return False
    signed = t.encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)`;

/** Hub status, the simple status the API and the portal show, and what it means. */
export const STATUS_MAP: { simple: string; api: string; hub: string; text: string }[] = [
  { simple: 'Draft', api: 'draft', hub: 'draft', text: 'Files can still be added. Nothing is sent to K Line.' },
  { simple: 'Submitted', api: 'submitted', hub: 'submitted, on_hold, ready', text: 'K Line has the case. It may be waiting for checks or on hold.' },
  { simple: 'Production', api: 'production', hub: 'received, in_production', text: 'The factory has received the case and is working on it.' },
  { simple: 'Shipped', api: 'shipped', hub: 'shipped, delivered', text: 'The case has left the factory. Carrier and tracking number are set.' },
];
