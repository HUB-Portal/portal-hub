import { randomBytes } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { SYSTEM, tx, type PoolClient } from '../db';
import { hmacHex, safeEqual } from '../crypto/keys';
import { unauthorized } from '../http/errors';
import { KLINE_API_SCOPES, PARTNER_API_SCOPES, type Permission } from '../../../shared/roles';

const KEY_RE = /^kph_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
export const MAX_KEY_LIFETIME_DAYS = 730;

export function isApiKeyFormat(s: string): boolean {
  return KEY_RE.test(s);
}
export function apiKeyPrefix(s: string): string | null {
  const m = KEY_RE.exec(s);
  return m ? 'kph_' + m[1] : null;
}

export function hashApiKeySecret(secret: string): string {
  return hmacHex('api-key', secret);
}

/** Generates kph_<12 hex>_<43 base64url>. The full key is shown once; only the hash is stored. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const hex = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { key: `kph_${hex}_${secret}`, prefix: `kph_${hex}`, hash: hashApiKeySecret(secret) };
}

/** Which permissions a scope grants when a key is used. Service scopes are checked by the MES routes themselves. */
const SCOPE_PERMISSIONS: Record<string, Permission[]> = {
  'cases:read': ['case.read', 'file.download'],
  'cases:write': ['case.write'],
  'patients:read': ['case.reveal_name'],
  'claims:read': ['claim.read'],
  'materials:read': ['material.read'],
};
export function permissionsForScopes(scopes: string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const s of scopes) for (const p of SCOPE_PERMISSIONS[s] ?? []) out.add(p);
  return out;
}

export function validScopes(orgKind: 'kline' | 'partner', scopes: string[]): boolean {
  const allowed = (orgKind === 'kline' ? KLINE_API_SCOPES : PARTNER_API_SCOPES) as readonly string[];
  return scopes.length > 0 && scopes.every((s) => allowed.includes(s));
}

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function ipAllowed(cidrs: string[], ip: string): boolean {
  if (!cidrs.length) return true;
  const addr = normalizeIp(ip);
  const fam = isIP(addr);
  if (!fam) return false;
  const bl = new BlockList();
  for (const entry of cidrs) {
    const [base, bits] = entry.split('/');
    const f = isIP(base);
    if (!f) continue;
    const family = f === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) bl.addAddress(base, family);
    else bl.addSubnet(base, Number(bits), family);
  }
  return bl.check(addr, fam === 4 ? 'ipv4' : 'ipv6');
}

export function validCidr(entry: string): boolean {
  const [base, bits] = entry.split('/');
  const f = isIP(base);
  if (!f) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return Number.isInteger(n) && n >= 0 && n <= (f === 4 ? 32 : 128);
}

export interface CreatedApiKey {
  id: string;
  key: string;
  prefix: string;
  expiresAt: Date;
}

export async function createApiKey(
  c: PoolClient,
  p: { orgId: string; orgKind: 'kline' | 'partner'; name: string; scopes: string[]; cidrs?: string[]; expiresInDays: number; createdBy?: string | null },
): Promise<CreatedApiKey> {
  if (!validScopes(p.orgKind, p.scopes)) throw new Error('Invalid scopes');
  if (p.expiresInDays < 1 || p.expiresInDays > MAX_KEY_LIFETIME_DAYS) throw new Error('Expiry must be between 1 and 730 days');
  if ((p.cidrs ?? []).some((x) => !validCidr(x))) throw new Error('Invalid CIDR');
  const g = generateApiKey();
  const r = await c.query(
    `INSERT INTO api_keys (org_id, name, prefix, secret_hash, scopes, cidrs, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7), $8) RETURNING id, expires_at`,
    [p.orgId, p.name, g.prefix, g.hash, p.scopes, p.cidrs ?? [], p.expiresInDays, p.createdBy ?? null],
  );
  return { id: r.rows[0].id, key: g.key, prefix: g.prefix, expiresAt: r.rows[0].expires_at };
}

export interface ApiKeyIdentity {
  id: string;
  orgId: string;
  orgKind: 'kline' | 'partner';
  orgStatus: string;
  scopes: string[];
}

/** Validates a presented key: hash, revocation, expiry, CIDR allow list. Same error for every failure. */
export async function authenticateApiKey(raw: string, ip: string): Promise<ApiKeyIdentity> {
  const m = KEY_RE.exec(raw);
  if (!m) throw unauthorized('The API key is not valid.', 'invalid_api_key');
  const prefix = 'kph_' + m[1];
  const row = await tx(SYSTEM, async (c) => {
    const r = await c.query(
      `SELECT k.id, k.org_id, k.secret_hash, k.scopes, k.cidrs, k.last_used_at, o.kind AS org_kind, o.status AS org_status
         FROM api_keys k JOIN organizations o ON o.id = k.org_id
        WHERE k.prefix = $1 AND k.revoked_at IS NULL AND k.expires_at > now()`,
      [prefix],
    );
    const k = r.rows[0];
    const ok = k && safeEqual(k.secret_hash, hashApiKeySecret(m[2])) && ipAllowed(k.cidrs, ip) && k.org_status !== 'suspended';
    if (!ok) return null;
    // Last use (time and address) is written at most once a minute per key, so busy integrations do not cause a write storm.
    // The condition is part of the UPDATE, so parallel requests cannot all write.
    await c.query(
      `UPDATE api_keys SET last_used_at = now(), last_used_ip = $2 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [k.id, normalizeIp(ip).slice(0, 64)],
    );
    return k;
  });
  if (!row) throw unauthorized('The API key is not valid.', 'invalid_api_key');
  return { id: row.id, orgId: row.org_id, orgKind: row.org_kind, orgStatus: row.org_status, scopes: row.scopes };
}
