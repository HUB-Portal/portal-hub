import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { config } from '../config';
import { SYSTEM, one, tx, type PoolClient } from '../db';
import { decryptField, encryptField, fieldAad } from '../crypto/keys';
import { notFound } from '../http/errors';
import { enqueue, registerJob } from '../jobs';
import { ELIGIBLE_SQL, runPortalSync } from './portalSync';

/**
 * Receiver for the K Line portal's webhooks ("instant updates").
 *
 * The portal POSTs {event, type, uuid, data} to the address of an organisation's receiver. The body holds patient names, so it is
 * treated as an untrusted hint only: it is never logged, stored or echoed. The only things taken from it are the entity type and uuid,
 * and only to decide whether to queue a normal status check of one of the organisation's own cases. That check reads the real status
 * from the portal API with the organisation's own credentials, so a forged message cannot change anything.
 */

export const HOOK_PATH_PREFIX = '/api/hooks/kline-portal/';
export const HOOK_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const HOOK_BODY_LIMIT = 256 * 1024;
export const HOOK_RATE_PER_IP = 120;
export const HOOK_RATE_PER_HOOK = 600;
/** At most one audit entry per receiver and minute for wrong secrets. */
export const BAD_SECRET_AUDIT_SECONDS = 60;
export const SYNC_CASE_JOB = 'portal.sync.case';

export type HookResult = 'ok' | 'ignored' | 'bad_secret';

type Req = { ip?: string; headers?: Record<string, any> };

export const newHookId = () => randomBytes(24).toString('base64url');
/** whsec style token, shown once. 32 random bytes give 43 characters after the prefix. */
export const newHookSecret = () => 'whsec_' + randomBytes(32).toString('base64url');
export const hookUrl = (hookId: string) => `${config.publicUrl}${HOOK_PATH_PREFIX}${hookId}`;

/** True when the portal could not reach PUBLIC_URL from the internet: not https, or a local or private address. */
export function publicUrlWarning(url: string = config.publicUrl): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.protocol !== 'https:') return true;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test')) return true;
  if (host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return true;
  }
  return !host.includes('.') && !host.includes(':');
}

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? null);

export interface WebhookView {
  configured: boolean;
  url: string | null;
  lastReceivedAt: string | null;
  receivedCount: number;
  lastResult: HookResult | null;
  publicUrlWarning: boolean;
  createdAt: string | null;
  rotatedAt: string | null;
}

/** What the settings page shows. Never the secret. */
export async function webhookView(c: PoolClient, orgId: string): Promise<WebhookView> {
  const r = await one<any>(c, 'SELECT hook_id, created_at, rotated_at, last_received_at, received_count, last_result FROM portal_hooks WHERE org_id = $1', [orgId]);
  return {
    configured: !!r,
    url: r ? hookUrl(r.hook_id) : null,
    lastReceivedAt: iso(r?.last_received_at),
    receivedCount: r ? Number(r.received_count) : 0,
    lastResult: (r?.last_result as HookResult | null) ?? null,
    publicUrlWarning: publicUrlWarning(),
    createdAt: iso(r?.created_at),
    rotatedAt: iso(r?.rotated_at),
  };
}

const uaOf = (req?: Req) => (typeof req?.headers?.['user-agent'] === 'string' ? (req!.headers!['user-agent'] as string).slice(0, 300) : null);

/** Creates the receiver or, when there is one, gives it a new secret (the old one stops working at once). The address stays the same. */
export async function createOrRotateHook(a: AuthContext, req: Req): Promise<{ url: string; secret: string; rotated: boolean }> {
  const secret = newHookSecret();
  return tx({ orgId: a.orgId, bypass: false }, async (c) => {
    await c.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [a.orgId]);
    const enc = encryptField(secret, fieldAad.portalHook(a.orgId));
    const existing = await one<any>(c, 'SELECT hook_id FROM portal_hooks WHERE org_id = $1 FOR UPDATE', [a.orgId]);
    let hookId: string;
    if (existing) {
      hookId = existing.hook_id;
      await c.query('UPDATE portal_hooks SET secret_enc = $2, rotated_at = now() WHERE org_id = $1', [a.orgId, enc]);
    } else {
      hookId = newHookId();
      await c.query('INSERT INTO portal_hooks (org_id, hook_id, secret_enc, created_by) VALUES ($1, $2, $3, $4)', [a.orgId, hookId, enc, a.userId]);
    }
    await audit(c, {
      actorType: 'user', actorId: a.userId, orgId: a.orgId, ip: req.ip ?? null, userAgent: uaOf(req),
      action: existing ? 'portal_hook.rotated' : 'portal_hook.created', targetType: 'organization', targetId: a.orgId, details: {},
    });
    return { url: hookUrl(hookId), secret, rotated: !!existing };
  });
}

export async function deleteHook(a: AuthContext, req: Req): Promise<void> {
  await tx({ orgId: a.orgId, bypass: false }, async (c) => {
    const r = await c.query('DELETE FROM portal_hooks WHERE org_id = $1', [a.orgId]);
    if (!r.rowCount) throw notFound('There is no instant update address to remove.');
    await audit(c, {
      actorType: 'user', actorId: a.userId, orgId: a.orgId, ip: req.ip ?? null, userAgent: uaOf(req),
      action: 'portal_hook.deleted', targetType: 'organization', targetId: a.orgId, details: {},
    });
  });
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

/** Constant time compare of two tokens of any length: both are hashed first, so neither length nor content leaks through timing. */
export function tokensMatch(sent: unknown, expected: string): boolean {
  // A header value is trimmed: some senders add a space or a line break at the end.
  const value = typeof sent === 'string' ? sent.trim() : '';
  if (value.length === 0 || value.length > 512) return false;
  const a = createHash('sha256').update(value).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The only two things read from a message: what kind of entity it is about and which one. Anything else is dropped here. */
export function readHint(raw: unknown): { type: string; uuid: string } | null {
  let text: string;
  if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
  else if (typeof raw === 'string') text = raw;
  else return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { type, uuid } = body as Record<string, unknown>;
  if (typeof type !== 'string' || typeof uuid !== 'string') return null;
  if (!/^[0-9a-fA-F-]{8,64}$/.test(uuid)) return null;
  return { type: type.slice(0, 32), uuid };
}

export type ReceiveOutcome = { status: 200; body: { ok: true } } | { status: 401; body: { code: string; message: string } } | { status: 404; body: { code: string; message: string } };

const NOT_FOUND: ReceiveOutcome = { status: 404, body: { code: 'not_found', message: 'That could not be found.' } };
const OK: ReceiveOutcome = { status: 200, body: { ok: true } };
const UNAUTHORISED: ReceiveOutcome = { status: 401, body: { code: 'unauthorised', message: 'Not authorised.' } };

/**
 * Queues a status check for one case unless one is already queued or running for it. A job waiting out a retry delay is
 * brought forward instead. The lock makes two messages that arrive together queue one job.
 */
async function queueCaseSync(c: PoolClient, orgId: string, caseId: string): Promise<'queued' | 'coalesced'> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${SYNC_CASE_JOB}:${caseId}`]);
  const open = await one<{ id: number; status: string }>(c, `SELECT id, status FROM jobs WHERE kind = $1 AND status IN ('queued', 'running') AND payload->>'caseId' = $2 ORDER BY id LIMIT 1`, [SYNC_CASE_JOB, caseId]);
  if (open) {
    if (open.status === 'queued') await c.query(`UPDATE jobs SET run_at = now() WHERE id = $1 AND run_at > now()`, [open.id]);
    return 'coalesced';
  }
  await enqueue(c, SYNC_CASE_JOB, { caseId }, { orgId });
  return 'queued';
}

async function recordBadSecret(orgId: string, ip: string | null, seen: string): Promise<void> {
  await tx(SYSTEM, async (c) => {
    const row = await one<{ n: number; due: boolean }>(
      c,
      `SELECT bad_secret_count AS n, (last_bad_audit_at IS NULL OR last_bad_audit_at < now() - make_interval(secs => $2)) AS due FROM portal_hooks WHERE org_id = $1 FOR UPDATE`,
      [orgId, BAD_SECRET_AUDIT_SECONDS],
    );
    if (!row) return;
    await c.query(
      `UPDATE portal_hooks SET bad_secret_count = bad_secret_count + 1, last_bad_secret_at = now(), last_result = 'bad_secret',
              last_bad_audit_at = CASE WHEN $2::boolean THEN now() ELSE last_bad_audit_at END WHERE org_id = $1`,
      [orgId, row.due],
    );
    // A counter and the result only. Nothing the sender supplied goes into the entry.
    if (row.due) {
      await audit(c, { actorType: 'system', orgId, ip, action: 'portal_hook.bad_secret', targetType: 'organization', targetId: orgId, details: { badSecretAttempts: Number(row.n) + 1, tokenHeader: seen } });
    }
  });
}

/** Per receiver counters for the traffic limit (600 a minute). In memory, so each process counts its own. */
const windows = new Map<string, { start: number; n: number }>();
export function hookRateAllowed(hookId: string, now = Date.now()): boolean {
  if (windows.size > 5000) for (const [k, w] of windows) if (now - w.start >= 60_000) windows.delete(k);
  const w = windows.get(hookId);
  if (!w || now - w.start >= 60_000) {
    windows.set(hookId, { start: now, n: 1 });
    return true;
  }
  w.n++;
  return w.n <= HOOK_RATE_PER_HOOK;
}
export function resetHookRates(): void {
  windows.clear();
}

/**
 * Handles one message. `token` is the X-KLINE-SECRET-TOKEN header and `raw` the unparsed body.
 * Unknown address: 404. Wrong or missing secret: 401. Everything else: 200, whether or not anything was done.
 */
export async function receiveHook(hookId: string, token: unknown, raw: unknown, ip: string | null, allowed: () => boolean = () => hookRateAllowed(hookId), seen: string = 'unknown'): Promise<ReceiveOutcome | 'rate_limited'> {
  if (!HOOK_ID_PATTERN.test(hookId)) return NOT_FOUND;
  const hook = await tx(SYSTEM, (c) => one<{ org_id: string; secret_enc: string }>(c, 'SELECT org_id, secret_enc FROM portal_hooks WHERE hook_id = $1', [hookId]));
  if (!hook) return NOT_FOUND;
  // Counted for known receivers only, before the secret is checked, so a flood of wrong secrets is limited too.
  if (!allowed()) return 'rate_limited';

  let secret: string | null = null;
  try {
    secret = decryptField(hook.secret_enc, fieldAad.portalHook(hook.org_id));
  } catch {
    secret = null;
  }
  if (!secret || !tokensMatch(token, secret)) {
    await recordBadSecret(hook.org_id, ip, seen).catch(() => undefined);
    return UNAUTHORISED;
  }

  const hint = readHint(raw);
  // From here on everything runs as the receiver's own organisation, so row level security keeps it to that organisation's rows.
  await tx({ orgId: hook.org_id, bypass: false }, async (c) => {
    let result: HookResult = 'ignored';
    const org = await one<{ status: string }>(c, 'SELECT status FROM organizations WHERE id = $1', [hook.org_id]);
    if (org?.status === 'active' && hint?.type === 'case') {
      const own = await one<{ id: string }>(c, `SELECT c.id FROM cases c WHERE c.org_id = $1 AND lower(c.portal_case_uuid) = lower($2) AND ${ELIGIBLE_SQL}`, [hook.org_id, hint.uuid]);
      if (own) {
        await queueCaseSync(c, hook.org_id, own.id);
        result = 'ok';
      }
    }
    await c.query(`UPDATE portal_hooks SET last_received_at = now(), received_count = received_count + 1, last_result = $2 WHERE org_id = $1`, [hook.org_id, result]);
  });
  return OK;
}

/** Reads the real status of one case from the portal. A failure is raised so the job is retried with the normal backoff. */
registerJob(SYNC_CASE_JOB, async (job) => {
  const caseId = job.payload?.caseId;
  if (typeof caseId !== 'string' || !/^[0-9a-f-]{36}$/i.test(caseId)) return;
  const s = await runPortalSync({ caseId });
  if (s.failed > 0) throw new Error('The status check for the case failed.');
});
