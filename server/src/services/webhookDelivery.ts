import { createHmac, randomUUID } from 'node:crypto';
import { request } from 'undici';
import { audit } from '../audit';
import { SYSTEM, many, one, tx, type PoolClient } from '../db';
import { decryptField, fieldAad } from '../crypto/keys';
import { enqueue, registerJob } from '../jobs';
import { permissionsFor } from '../../../shared/roles';
import { notifyOrg } from './notify';
import { UrlProblem, checkUrlShape, safeAgent } from './netSafety';
import { MAX_PAYLOAD_BYTES, TEST_EVENT } from './webhooks';

/**
 * Sends outbox rows to partner endpoints.
 *
 * One HTTPS POST per attempt with a signature header, a 10 second limit, no redirects and no stored response body. The safe
 * agent (netSafety.ts) checks the address at connect time. Failed attempts are retried after 1, 5, 30, 120, 360, 720 and
 * 1440 minutes (8 attempts in all), then the delivery is `dead`. An endpoint that fails 25 attempts in a row is switched off.
 */
export const RETRY_MINUTES = [1, 5, 30, 120, 360, 720, 1440] as const;
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
export const DISABLE_AFTER_FAILURES = 25;
export const DELIVERY_TIMEOUT_MS = 10_000;
/** How long one worker owns a delivery that is in flight. */
const LOCK_SECONDS = 60;

export const USER_AGENT = 'KPH-Webhooks/1';

/** Hex HMAC-SHA256 of "<t>.<body>" with the whole secret string (including the whsec_ prefix) as the key. */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
export const signatureHeader = (secret: string, timestamp: number, body: string) => `t=${timestamp},v1=${signPayload(secret, timestamp, body)}`;

export interface PostResult {
  ok: boolean;
  /** HTTP status when the endpoint answered. */
  status: number | null;
  /** Fixed short text, never the endpoint's own answer. */
  error: string | null;
  durationMs: number;
}

const MESSAGES = {
  blocked: 'The address is not allowed because it points to a private or reserved network.',
  timeout: 'The endpoint did not answer within 10 seconds.',
  tls: 'The secure connection could not be set up. Check the certificate of the endpoint.',
  dns: 'The host name of the endpoint could not be found.',
  connect: 'Could not connect to the endpoint.',
  redirect: 'The endpoint answered with a redirect, which is not followed.',
  disabled: 'The endpoint was switched off before this could be sent.',
} as const;
const statusMessage = (s: number) => `The endpoint answered with status ${s}.`;

function describeError(e: any): string {
  const code = String(e?.code ?? e?.cause?.code ?? '');
  const name = String(e?.name ?? '');
  if (code === 'KPH_BLOCKED_ADDRESS' || e?.cause?.code === 'KPH_BLOCKED_ADDRESS') return MESSAGES.blocked;
  if (code === 'ABORT_ERR' || name === 'TimeoutError' || name === 'AbortError' || /TIMEOUT/i.test(code)) return MESSAGES.timeout;
  if (/^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_OSSL|HOSTNAME_MISMATCH)/i.test(code)) return MESSAGES.tls;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') return MESSAGES.dns;
  return MESSAGES.connect;
}

/** Builds the exact JSON text that is signed and sent (natural key order). */
export function bodyOf(payload: { id: string; type: string; created_at: string; org_code: string | null; data: unknown }): string {
  return JSON.stringify({ id: payload.id, type: payload.type, created_at: payload.created_at, org_code: payload.org_code, data: payload.data });
}

/** One signed POST. Never throws. 2xx is success; anything else, including a redirect, is a failure. */
export async function postSigned(p: { url: string; secret: string; event: string; deliveryId: string; body: string }): Promise<PostResult> {
  const started = Date.now();
  const t = Math.floor(started / 1000);
  try {
    // The rules are applied again at delivery: https only, no credentials, no private IP literals.
    try {
      checkUrlShape(p.url);
    } catch (e) {
      if (e instanceof UrlProblem) return { ok: false, status: null, error: e.message, durationMs: 0 };
      throw e;
    }
    const res = await request(p.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        'x-kph-event': p.event,
        'x-kph-delivery': p.deliveryId,
        'x-kph-signature': signatureHeader(p.secret, t, p.body),
      },
      body: p.body,
      dispatcher: safeAgent(),
      headersTimeout: DELIVERY_TIMEOUT_MS,
      bodyTimeout: DELIVERY_TIMEOUT_MS,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    } as any);
    // The answer is never stored or read further than this.
    await res.body.dump({ limit: 4096 }).catch(() => undefined);
    const s = res.statusCode;
    const durationMs = Date.now() - started;
    if (s >= 200 && s < 300) return { ok: true, status: s, error: null, durationMs };
    return { ok: false, status: s, error: s >= 300 && s < 400 ? MESSAGES.redirect : statusMessage(s), durationMs };
  } catch (e) {
    return { ok: false, status: null, error: describeError(e), durationMs: Date.now() - started };
  }
}

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------
async function disableAfterFailures(c: PoolClient, webhookId: string, orgId: string): Promise<void> {
  const r = await c.query(
    `UPDATE webhooks SET active = false, disabled_reason = 'too_many_failures', disabled_at = now(), updated_at = now() WHERE id = $1 AND active RETURNING id`,
    [webhookId],
  );
  if (!r.rowCount) return;
  await audit(c, { actorType: 'system', orgId, action: 'webhook.auto_disabled', targetType: 'webhook', targetId: webhookId, details: { failures: DISABLE_AFTER_FAILURES } });
  const users = await many<{ id: string; roles: string[] }>(c, `SELECT id, roles FROM users WHERE org_id = $1 AND status = 'active'`, [orgId]);
  for (const u of users) {
    if (!permissionsFor(u.roles).has('integration.manage')) continue;
    await notifyOrg(c, {
      orgId,
      userId: u.id,
      kind: 'webhook_disabled',
      title: 'A webhook was switched off',
      body: `An endpoint failed ${DISABLE_AFTER_FAILURES} times in a row and was switched off. Check it, then switch it back on.`,
      data: { webhookId },
    });
  }
}

/** Sends one delivery if it is due. Safe to call twice or from two workers: the row is claimed first. */
export async function deliverOne(deliveryId: string): Promise<'delivered' | 'retry' | 'dead' | 'skipped'> {
  const claim = await tx(SYSTEM, async (c) => {
    const d = await one<any>(
      c,
      `SELECT d.id, d.org_id, d.webhook_id, d.event, d.payload, d.status, d.attempts,
              d.next_attempt_at > now() AS early, d.locked_until IS NOT NULL AND d.locked_until > now() AS locked,
              w.url, w.secret_enc, w.active
         FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
        WHERE d.id = $1 FOR UPDATE OF d`,
      [deliveryId],
    );
    if (!d || d.status === 'delivered' || d.status === 'dead' || d.locked || d.early) return null;
    if (!d.active) {
      await c.query(`UPDATE webhook_deliveries SET status = 'dead', last_error = $2, next_attempt_at = NULL, locked_until = NULL WHERE id = $1`, [d.id, MESSAGES.disabled]);
      return null;
    }
    await c.query(`UPDATE webhook_deliveries SET locked_until = now() + make_interval(secs => $2) WHERE id = $1`, [d.id, LOCK_SECONDS]);
    return d;
  });
  if (!claim) return 'skipped';

  let result: PostResult;
  try {
    const secret = decryptField(claim.secret_enc, fieldAad.webhook(claim.webhook_id));
    result = await postSigned({ url: claim.url, secret, event: claim.event, deliveryId: claim.id, body: bodyOf(claim.payload) });
  } catch {
    result = { ok: false, status: null, error: MESSAGES.connect, durationMs: 0 };
  }

  return tx(SYSTEM, async (c) => {
    const attempts = claim.attempts + 1;
    if (result.ok) {
      await c.query(
        `UPDATE webhook_deliveries SET status = 'delivered', attempts = $2, last_attempt_at = now(), delivered_at = now(), last_status_code = $3, last_error = NULL, next_attempt_at = NULL, locked_until = NULL WHERE id = $1`,
        [claim.id, attempts, result.status],
      );
      await c.query(
        `UPDATE webhooks SET consecutive_failures = 0, last_attempt_at = now(), last_success_at = now(), last_status_code = $2, last_outcome = 'delivered' WHERE id = $1`,
        [claim.webhook_id, result.status],
      );
      return 'delivered';
    }
    const w = await one<{ consecutive_failures: number }>(
      c,
      `UPDATE webhooks SET consecutive_failures = consecutive_failures + 1, last_attempt_at = now(), last_status_code = $2, last_outcome = 'failed' WHERE id = $1 RETURNING consecutive_failures`,
      [claim.webhook_id, result.status],
    );
    let outcome: 'retry' | 'dead' = 'retry';
    if (attempts >= MAX_ATTEMPTS) {
      outcome = 'dead';
      await c.query(
        `UPDATE webhook_deliveries SET status = 'dead', attempts = $2, last_attempt_at = now(), last_status_code = $3, last_error = $4, next_attempt_at = NULL, locked_until = NULL WHERE id = $1`,
        [claim.id, attempts, result.status, result.error],
      );
    } else {
      const minutes = RETRY_MINUTES[attempts - 1]!;
      const next = await one<{ at: Date }>(
        c,
        `UPDATE webhook_deliveries SET status = 'retrying', attempts = $2, last_attempt_at = now(), last_status_code = $3, last_error = $4, next_attempt_at = now() + make_interval(mins => $5), locked_until = NULL
          WHERE id = $1 RETURNING next_attempt_at AS at`,
        [claim.id, attempts, result.status, result.error, minutes],
      );
      await enqueue(c, 'webhook.deliver', { deliveryId: claim.id }, { orgId: claim.org_id, runAt: next!.at, maxAttempts: 1 });
    }
    if ((w?.consecutive_failures ?? 0) >= DISABLE_AFTER_FAILURES) await disableAfterFailures(c, claim.webhook_id, claim.org_id);
    return outcome;
  });
}

registerJob('webhook.deliver', async (job) => {
  const id = (job.payload as { deliveryId?: string }).deliveryId;
  if (typeof id === 'string') await deliverOne(id);
});

/**
 * Safety net: queues a job for every due delivery that has none (a lost job, a crashed worker). Runs every minute in the
 * worker. Harmless to run twice, because the delivery claims its own row.
 */
export async function sweepDueDeliveries(limit = 500): Promise<number> {
  return tx(SYSTEM, async (c) => {
    const rows = await many<{ id: string; org_id: string }>(
      c,
      `SELECT d.id, d.org_id FROM webhook_deliveries d
        WHERE d.status IN ('pending', 'retrying') AND d.next_attempt_at <= now() - interval '2 minutes' AND (d.locked_until IS NULL OR d.locked_until < now())
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'webhook.deliver' AND j.status IN ('queued', 'running') AND j.payload->>'deliveryId' = d.id::text)
        ORDER BY d.next_attempt_at LIMIT $1`,
      [limit],
    );
    for (const r of rows) await enqueue(c, 'webhook.deliver', { deliveryId: r.id }, { orgId: r.org_id, maxAttempts: 1 });
    return rows.length;
  });
}

// ---------------------------------------------------------------------------
// Test delivery (synchronous, nothing is stored)
// ---------------------------------------------------------------------------
export async function sendTestEvent(w: { id: string; url: string; secret: string; orgCode: string | null }): Promise<PostResult> {
  const id = randomUUID();
  const body = bodyOf({ id, type: TEST_EVENT, created_at: new Date().toISOString(), org_code: w.orgCode, data: { message: 'This is a test event from the Portal Hub.' } });
  if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) return { ok: false, status: null, error: MESSAGES.connect, durationMs: 0 };
  return postSigned({ url: w.url, secret: w.secret, event: TEST_EVENT, deliveryId: id, body });
}
