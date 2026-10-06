import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { createApiKey, validCidr } from '../auth/apikeys';
import { many, one, tx } from '../db';
import { badRequest, conflict, notFound } from '../http/errors';
import { PARTNER_API_SCOPES } from '../../../shared/roles';
import { partnerApproved, partnerOnly } from './org';

type Req = { ip?: string; headers?: Record<string, any> };

export const MAX_ACTIVE_KEYS = 20;
export const MAX_CIDRS = 20;
export const DEFAULT_EXPIRY_DAYS = 365;

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? null);
const uaOf = (req?: Req) => (typeof req?.headers?.['user-agent'] === 'string' ? (req!.headers!['user-agent'] as string).slice(0, 300) : null);

export function apiKeyDto(row: any) {
  return {
    id: row.id as string,
    name: row.name as string,
    prefix: row.prefix as string,
    scopes: row.scopes as string[],
    cidrs: row.cidrs as string[],
    expiresAt: iso(row.expires_at),
    lastUsedAt: iso(row.last_used_at),
    lastUsedIp: (row.last_used_ip as string | null) ?? null,
    createdAt: iso(row.created_at),
    createdByName: (row.created_by_name as string | null) ?? null,
    revokedAt: iso(row.revoked_at),
    status: row.status as 'active' | 'expired' | 'revoked',
  };
}

const SELECT = `SELECT k.id, k.name, k.prefix, k.scopes, k.cidrs, k.expires_at, k.last_used_at, k.last_used_ip, k.created_at, k.revoked_at, u.name AS created_by_name,
    CASE WHEN k.revoked_at IS NOT NULL THEN 'revoked' WHEN k.expires_at <= now() THEN 'expired' ELSE 'active' END AS status
  FROM api_keys k LEFT JOIN users u ON u.id = k.created_by`;

/** Normalises a CIDR entry: trims, validates, and keeps a bare address as written. */
export function cleanCidrs(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim();
    if (!v || !validCidr(v)) throw badRequest('One of the IP ranges is not valid. Use an address such as 203.0.113.7 or a range such as 203.0.113.0/24.', 'invalid_cidr');
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > MAX_CIDRS) throw badRequest(`Add at most ${MAX_CIDRS} IP ranges.`, 'invalid_cidr');
  return out;
}

export async function listKeys(a: AuthContext) {
  partnerOnly(a);
  return tx({ orgId: a.orgId, bypass: false }, async (c) => {
    const rows = await many<any>(c, `${SELECT} WHERE k.org_id = $1 ORDER BY k.created_at DESC, k.id`, [a.orgId]);
    return { scopes: PARTNER_API_SCOPES, limits: { maxActive: MAX_ACTIVE_KEYS, maxCidrs: MAX_CIDRS, maxExpiryDays: 730, defaultExpiryDays: DEFAULT_EXPIRY_DAYS }, items: rows.map(apiKeyDto) };
  });
}

export interface CreateKeyInput {
  name: string;
  scopes: string[];
  cidrs?: string[];
  expiresInDays: number;
}

export async function createKey(a: AuthContext, req: Req, input: CreateKeyInput) {
  partnerApproved(a);
  const scopes = [...new Set(input.scopes)];
  if (scopes.includes('patients:read') && !scopes.includes('cases:read')) {
    throw badRequest('The patients:read scope needs cases:read as well.', 'scope_dependency');
  }
  const cidrs = cleanCidrs(input.cidrs ?? []);
  return tx({ orgId: a.orgId, bypass: false }, async (c) => {
    // One at a time per organisation, so the limit cannot be beaten by parallel requests.
    await c.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [a.orgId]);
    const n = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM api_keys WHERE org_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [a.orgId]);
    if ((n?.n ?? 0) >= MAX_ACTIVE_KEYS) throw conflict(`You can have at most ${MAX_ACTIVE_KEYS} active API keys. Revoke one first.`, 'too_many_keys');
    const k = await createApiKey(c, { orgId: a.orgId, orgKind: 'partner', name: input.name, scopes, cidrs, expiresInDays: input.expiresInDays, createdBy: a.userId });
    await audit(c, {
      actorType: 'user', actorId: a.userId, ip: req.ip ?? null, userAgent: uaOf(req), orgId: a.orgId, action: 'api_key.created', targetType: 'api_key', targetId: k.id,
      details: { prefix: k.prefix, name: input.name, scopes, cidrs: cidrs.length, expiresAt: k.expiresAt.toISOString() },
    });
    return { id: k.id, key: k.key, prefix: k.prefix, expiresAt: k.expiresAt.toISOString() };
  });
}

export async function revokeKey(a: AuthContext, req: Req, id: string): Promise<void> {
  partnerOnly(a);
  await tx({ orgId: a.orgId, bypass: false }, async (c) => {
    const k = await one<any>(c, 'SELECT id, prefix, scopes, revoked_at FROM api_keys WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, a.orgId]);
    if (!k) throw notFound('That API key could not be found.');
    if (k.revoked_at) throw conflict('That API key is already revoked.', 'already_revoked');
    await c.query('UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [id, a.userId]);
    await audit(c, {
      actorType: 'user', actorId: a.userId, ip: req.ip ?? null, userAgent: uaOf(req), orgId: a.orgId, action: 'api_key.revoked', targetType: 'api_key', targetId: id,
      details: { prefix: k.prefix, scopes: k.scopes },
    });
  });
}
