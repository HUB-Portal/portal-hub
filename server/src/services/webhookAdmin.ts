import { randomBytes, randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { many, one, tx } from '../db';
import { decryptField, encryptField, fieldAad } from '../crypto/keys';
import { badRequest, conflict, notFound } from '../http/errors';
import { enqueue } from '../jobs';
import { RETRY_MINUTES, MAX_ATTEMPTS, sendTestEvent } from './webhookDelivery';
import { UrlProblem, validateTargetUrl } from './netSafety';
import { WEBHOOK_EVENTS, isWebhookEvent } from './webhooks';

type Req = { ip?: string; headers?: Record<string, any> };

export const MAX_WEBHOOKS_PER_ORG = 10;
export const WEBHOOK_DESCRIPTION_MAX = 200;

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? null);
const uaOf = (req?: Req) => (typeof req?.headers?.['user-agent'] === 'string' ? (req!.headers!['user-agent'] as string).slice(0, 300) : null);

const auditWh = (a: AuthContext, req: Req | undefined, c: Parameters<typeof audit>[0], action: string, id: string | null, details: Record<string, unknown> = {}) =>
  audit(c, { actorType: 'user', actorId: a.userId, ip: req?.ip ?? null, userAgent: uaOf(req), orgId: a.orgId, action, targetType: 'webhook', targetId: id, details });

export function webhookDto(row: any) {
  return {
    id: row.id as string,
    url: row.url as string,
    events: row.events as string[],
    description: (row.description as string | null) ?? null,
    active: row.active as boolean,
    status: row.active ? ('active' as const) : ('disabled' as const),
    disabledReason: (row.disabled_reason as string | null) ?? null,
    disabledAt: iso(row.disabled_at),
    consecutiveFailures: row.consecutive_failures as number,
    lastAttemptAt: iso(row.last_attempt_at),
    lastSuccessAt: iso(row.last_success_at),
    lastStatusCode: (row.last_status_code as number | null) ?? null,
    lastOutcome: (row.last_outcome as 'delivered' | 'failed' | null) ?? null,
    openDeliveries: (row.open_deliveries as number | undefined) ?? 0,
    secretRotatedAt: iso(row.secret_rotated_at),
    createdByName: (row.created_by_name as string | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function deliveryDto(row: any) {
  return {
    id: row.id as string,
    event: row.event as string,
    status: row.status as 'pending' | 'retrying' | 'delivered' | 'dead',
    attempts: row.attempts as number,
    maxAttempts: MAX_ATTEMPTS,
    lastStatusCode: (row.last_status_code as number | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    nextAttemptAt: iso(row.next_attempt_at),
    lastAttemptAt: iso(row.last_attempt_at),
    createdAt: iso(row.created_at),
    deliveredAt: iso(row.delivered_at),
  };
}

const SELECT = `SELECT w.*, u.name AS created_by_name,
    (SELECT count(*)::int FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status IN ('pending', 'retrying')) AS open_deliveries
  FROM webhooks w LEFT JOIN users u ON u.id = w.created_by`;

async function loadOwn(c: Parameters<typeof audit>[0], a: AuthContext, id: string, lock = false): Promise<any> {
  const row = await one<any>(c, `${SELECT} WHERE w.id = $1 AND w.org_id = $2${lock ? ' FOR UPDATE OF w' : ''}`, [id, a.orgId]);
  if (!row) throw notFound('That webhook could not be found.');
  return row;
}

export const newSecret = () => 'whsec_' + randomBytes(32).toString('base64url');

async function checkUrl(raw: string): Promise<string> {
  try {
    return (await validateTargetUrl(raw)).toString();
  } catch (e) {
    if (e instanceof UrlProblem) throw badRequest(e.message, 'invalid_webhook_url', { reason: e.code });
    throw e;
  }
}

function checkEvents(events: string[]): string[] {
  const out = [...new Set(events)];
  if (!out.length) throw badRequest('Choose at least one event.', 'invalid_request');
  const bad = out.find((e) => !isWebhookEvent(e));
  if (bad) throw badRequest('One of the events is not known.', 'invalid_event', { allowed: WEBHOOK_EVENTS });
  return out;
}

const cleanDescription = (v: string | null | undefined) => {
  const t = (v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, WEBHOOK_DESCRIPTION_MAX) : null;
};

/** The URL is never written to the audit log (it may carry a token): only the host and the path length. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

export async function listWebhooks(a: AuthContext) {
  return tx({ orgId: a.orgId, bypass: false }, async (c) => {
    const rows = await many<any>(c, `${SELECT} WHERE w.org_id = $1 ORDER BY w.created_at, w.id`, [a.orgId]);
    return { items: rows.map(webhookDto), events: WEBHOOK_EVENTS, limits: { maxWebhooks: MAX_WEBHOOKS_PER_ORG }, retryMinutes: RETRY_MINUTES, maxAttempts: MAX_ATTEMPTS };
  });
}

export async function createWebhook(a: AuthContext, req: Req, input: { url: string; events: string[]; description?: string | null }) {
  const events = checkEvents(input.events);
  const url = await checkUrl(input.url);
  const id = randomUUID();
  const secret = newSecret();
  return tx({ orgId: a.orgId, bypass: false }, async (c) => {
    await c.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [a.orgId]);
    const n = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM webhooks WHERE org_id = $1', [a.orgId]);
    if ((n?.n ?? 0) >= MAX_WEBHOOKS_PER_ORG) throw conflict(`You can have at most ${MAX_WEBHOOKS_PER_ORG} webhooks. Delete one first.`, 'too_many_webhooks');
    await c.query(`INSERT INTO webhooks (id, org_id, url, events, description, secret_enc, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      id, a.orgId, url, events, cleanDescription(input.description), encryptField(secret, fieldAad.webhook(id)), a.userId,
    ]);
    await auditWh(a, req, c, 'webhook.created', id, { host: hostOf(url), events });
    return { id, secret, webhook: webhookDto(await loadOwn(c, a, id)) };
  });
}

export async function updateWebhook(a: AuthContext, req: Req, id: string, input: { url?: string; events?: string[]; active?: boolean; description?: string | null }) {
  const url = input.url !== undefined ? await checkUrl(input.url) : undefined;
  const events = input.events !== undefined ? checkEvents(input.events) : undefined;
  return tx({ orgId: a.orgId, bypass: false }, async (c) => {
    const row = await loadOwn(c, a, id, true);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    const changed: string[] = [];
    if (url !== undefined && url !== row.url) {
      set('url', url);
      changed.push('url');
    }
    if (events !== undefined && events.join() !== [...row.events].join()) {
      set('events', events);
      changed.push('events');
    }
    if (input.description !== undefined && cleanDescription(input.description) !== row.description) {
      set('description', cleanDescription(input.description));
      changed.push('description');
    }
    let reenabled = false;
    if (input.active !== undefined && input.active !== row.active) {
      changed.push('active');
      if (input.active) {
        // Switching back on re-checks where the endpoint points and starts counting failures again.
        if (url === undefined) await checkUrl(row.url);
        sets.push('active = true', 'disabled_reason = NULL', 'disabled_at = NULL', 'consecutive_failures = 0');
        reenabled = true;
      } else {
        sets.push('active = false', `disabled_reason = 'switched_off'`, 'disabled_at = now()');
      }
    }
    if (sets.length) {
      await c.query(`UPDATE webhooks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
      const onlyActive = changed.length === 1 && changed[0] === 'active';
      await auditWh(a, req, c, onlyActive ? (reenabled ? 'webhook.enabled' : 'webhook.disabled') : 'webhook.updated', id, {
        changed,
        host: hostOf((url ?? row.url) as string),
      });
    }
    return { webhook: webhookDto(await loadOwn(c, a, id)) };
  });
}

export async function rotateSecret(a: AuthContext, req: Req, id: string) {
  const secret = newSecret();
  return tx({ orgId: a.orgId, bypass: false }, async (c) => {
    await loadOwn(c, a, id, true);
    await c.query(`UPDATE webhooks SET secret_enc = $2, secret_rotated_at = now(), updated_at = now() WHERE id = $1`, [id, encryptField(secret, fieldAad.webhook(id))]);
    await auditWh(a, req, c, 'webhook.secret_rotated', id);
    return { id, secret };
  });
}

export async function deleteWebhook(a: AuthContext, req: Req, id: string): Promise<void> {
  await tx({ orgId: a.orgId, bypass: false }, async (c) => {
    const row = await loadOwn(c, a, id, true);
    await c.query('DELETE FROM webhooks WHERE id = $1', [id]);
    await auditWh(a, req, c, 'webhook.deleted', id, { host: hostOf(row.url) });
  });
}

export const DELIVERY_STATUSES = ['pending', 'retrying', 'delivered', 'dead'] as const;

export async function listDeliveries(a: AuthContext, id: string, q: { status?: (typeof DELIVERY_STATUSES)[number]; event?: string; page: number; pageSize: number }) {
  return tx({ orgId: a.orgId, bypass: false }, async (c) => {
    await loadOwn(c, a, id);
    const params: unknown[] = [id];
    const where = ['d.webhook_id = $1'];
    if (q.status) {
      params.push(q.status);
      where.push(`d.status = $${params.length}`);
    }
    if (q.event) {
      params.push(q.event);
      where.push(`d.event = $${params.length}`);
    }
    const w = where.join(' AND ');
    const total = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM webhook_deliveries d WHERE ${w}`, params);
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await many<any>(
      c,
      `SELECT d.id, d.event, d.status, d.attempts, d.last_status_code, d.last_error, d.next_attempt_at, d.last_attempt_at, d.created_at, d.delivered_at
         FROM webhook_deliveries d WHERE ${w} ORDER BY d.created_at DESC, d.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows.map(deliveryDto), total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
  });
}

export async function getDelivery(a: AuthContext, id: string, deliveryId: string) {
  return tx({ orgId: a.orgId, bypass: false }, async (c) => {
    await loadOwn(c, a, id);
    const d = await one<any>(c, `SELECT d.*, d.payload AS payload_json FROM webhook_deliveries d WHERE d.id = $1 AND d.webhook_id = $2`, [deliveryId, id]);
    if (!d) throw notFound('That delivery could not be found.');
    return { delivery: deliveryDto(d), payload: d.payload_json };
  });
}

/** Queues a delivery again, now, as a fresh cycle of attempts. The payload and its id stay the same, so receivers can de-duplicate. */
export async function retryDelivery(a: AuthContext, req: Req, id: string, deliveryId: string) {
  return tx({ orgId: a.orgId, bypass: false }, async (c) => {
    const w = await loadOwn(c, a, id);
    if (!w.active) throw conflict('This webhook is switched off. Switch it back on first.', 'webhook_disabled');
    const d = await one<any>(c, `SELECT id, status, locked_until IS NOT NULL AND locked_until > now() AS locked FROM webhook_deliveries WHERE id = $1 AND webhook_id = $2 FOR UPDATE`, [deliveryId, id]);
    if (!d) throw notFound('That delivery could not be found.');
    if (d.locked) throw conflict('This delivery is being sent right now. Try again in a minute.', 'delivery_in_progress');
    await c.query(
      `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL, last_error = NULL, delivered_at = NULL WHERE id = $1`,
      [deliveryId],
    );
    await enqueue(c, 'webhook.deliver', { deliveryId }, { orgId: a.orgId, maxAttempts: 1 });
    await auditWh(a, req, c, 'webhook.delivery_retried', id, { deliveryId });
    const row = await one<any>(c, 'SELECT * FROM webhook_deliveries WHERE id = $1', [deliveryId]);
    return { delivery: deliveryDto(row) };
  });
}

/** Sends a `webhook.test` event at once and reports the result. Nothing is stored except the audit entry. */
export async function testWebhook(a: AuthContext, req: Req, id: string) {
  const w = await tx({ orgId: a.orgId, bypass: false }, async (c) => {
    const row = await loadOwn(c, a, id);
    const org = await one<{ code: string | null }>(c, 'SELECT code FROM organizations WHERE id = $1', [a.orgId]);
    return { url: row.url as string, secret: decryptField(row.secret_enc, fieldAad.webhook(id)), orgCode: org?.code ?? null };
  });
  const r = await sendTestEvent({ id, ...w });
  await tx({ orgId: a.orgId, bypass: false }, (c) => auditWh(a, req, c, 'webhook.tested', id, { ok: r.ok, status: r.status }));
  return { ok: r.ok, status: r.status, durationMs: r.durationMs, ...(r.error ? { error: r.error } : {}) };
}
