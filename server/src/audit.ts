import type { FastifyRequest } from 'fastify';
import { SYSTEM, tx, type PoolClient } from './db';

export interface AuditEntry {
  actorType: 'user' | 'api_key' | 'service' | 'system';
  actorId?: string | null;
  /** Organisation the action concerns. Partners read entries for their own org. */
  orgId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Never put patient data, names, tokens or secrets in details. */
  details?: Record<string, unknown>;
}

/** Appends to the hash chained audit log inside the caller's transaction. Returns the sequence number. */
export async function audit(c: PoolClient, e: AuditEntry): Promise<number> {
  const r = await c.query('SELECT kph_audit_append($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) AS seq', [
    e.actorType,
    e.actorId ?? null,
    e.orgId ?? null,
    e.action,
    e.targetType ?? null,
    e.targetId ?? null,
    e.ip ?? null,
    e.userAgent ?? null,
    JSON.stringify(e.details ?? {}),
  ]);
  return r.rows[0].seq as number;
}

/** Same as audit but takes actor, IP and user agent from the request's auth context. */
export function auditReq(c: PoolClient, req: FastifyRequest, e: Omit<AuditEntry, 'actorType' | 'actorId' | 'ip' | 'userAgent'> & Partial<AuditEntry>): Promise<number> {
  const a = req.auth;
  return audit(c, {
    actorType: a ? (a.kind === 'user' ? 'user' : 'api_key') : 'system',
    actorId: a ? (a.userId ?? a.apiKeyId) : null,
    ip: req.ip,
    userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 300) ?? null,
    ...e,
    orgId: e.orgId === undefined ? (a?.orgId ?? null) : e.orgId,
  });
}

/** Own transaction, for events where no other work is being done (failed logins and the like). */
export function auditStandalone(e: AuditEntry): Promise<number> {
  return tx(SYSTEM, (c) => audit(c, e));
}
