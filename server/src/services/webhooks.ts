import { randomUUID } from 'node:crypto';
import { many, one, type PoolClient } from '../db';
import { enqueue } from '../jobs';
import { simpleStatus, stageLabel } from '../../../shared/stages';

/**
 * Outgoing partner webhooks, the writing side (the outbox).
 *
 * Every business change that partners can subscribe to calls one of the emit functions below INSIDE its own transaction.
 * They write one `webhook_deliveries` row (and one `webhook.deliver` job) per active endpoint of the organisation that
 * subscribes to the event, so a rolled back change leaves nothing behind and a committed one is never lost.
 * Payloads hold references and counts only: never patient names, instructions, file names or any text people typed.
 *
 * The delivery itself (signing, HTTP, retries) lives in `webhookDelivery.ts`.
 */
export interface HookCall {
  kind: 'case' | 'claim' | 'spec' | 'materials';
  event: string;
  /** Case, claim or spec id, or the organisation id for material events. */
  id: string;
  data: Record<string, unknown>;
}

let observer: ((h: HookCall) => void) | null = null;
/** Lets tests see which hooks fired. Pass null to stop. Nothing else uses it. */
export function setHookObserver(fn: ((h: HookCall) => void) | null): void {
  observer = fn;
}

/** Event types a partner can subscribe to. */
export const WEBHOOK_EVENTS = [
  'case.submitted',
  'case.on_hold',
  'case.received',
  'case.stage_changed',
  'case.shipped',
  'case.delivered',
  'case.cancelled',
  'claim.updated',
  'materials.low_stock',
  'spec.updated',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const isWebhookEvent = (s: string): s is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(s);

/** The event sent for a test delivery. Not subscribable. */
export const TEST_EVENT = 'webhook.test';

/** Largest payload we will queue. Ours are far smaller; this is a hard safety net. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Writes the outbox rows for one event. `data` is called only when somebody subscribes. */
async function fanOut(c: PoolClient, orgId: string, type: WebhookEvent, data: () => Promise<Record<string, unknown> | null>): Promise<void> {
  const hooks = await many<{ id: string }>(c, `SELECT id FROM webhooks WHERE org_id = $1 AND active AND $2 = ANY(events) ORDER BY created_at, id`, [orgId, type]);
  if (!hooks.length) return;
  const body = await data();
  if (!body) return;
  const org = await one<{ code: string | null }>(c, 'SELECT code FROM organizations WHERE id = $1', [orgId]);
  const createdAt = new Date().toISOString();
  for (const h of hooks) {
    const id = randomUUID();
    const payload = { id, type, created_at: createdAt, org_code: org?.code ?? null, data: body };
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) continue;
    await c.query(
      `INSERT INTO webhook_deliveries (id, org_id, webhook_id, event, payload, status, next_attempt_at) VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', now())`,
      [id, orgId, h.id, type, JSON.stringify(payload)],
    );
    // max_attempts 1: retries are scheduled by the delivery row itself (1, 5, 30 ... minutes), not by the job queue.
    await enqueue(c, 'webhook.deliver', { deliveryId: id }, { orgId, maxAttempts: 1 });
  }
}

/** Which subscribable event an internal case hook becomes. Routing and release are not events partners can subscribe to. */
export function publicCaseEvent(event: string, stage: string | null): WebhookEvent | null {
  switch (event) {
    case 'case.submitted':
    case 'case.on_hold':
    case 'case.shipped':
    case 'case.delivered':
    case 'case.cancelled':
      return event;
    case 'case.stage_changed':
      // The factory's acknowledgement has its own event; later stages are stage changes.
      return stage === 'received' ? 'case.received' : 'case.stage_changed';
    default:
      return null;
  }
}

/** Reference data of a case for webhook payloads: identifiers, status and shipping details only. */
export function casePayload(row: any): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ref: row.ref,
    case_id: row.partner_case_id ?? null,
    status: row.status,
    simple_status: simpleStatus(row),
    stage: row.stage ?? null,
    stage_label: row.stage ? stageLabel(row.stage) : null,
    site: row.site_code ?? null,
  };
  if (row.status === 'shipped' || row.status === 'delivered') {
    if (row.carrier) out.carrier = row.carrier;
    if (row.tracking) out.tracking_number = row.tracking;
    if (row.aligners_shipped) out.aligners_shipped = Number(row.aligners_shipped);
  }
  return out;
}

/**
 * Events: case.submitted, case.on_hold, case.received (factory acknowledgement), case.stage_changed, case.shipped,
 * case.delivered, case.cancelled. Internal hooks case.ready, case.rerouted and case.released are seen by the observer only.
 */
export async function emitCaseWebhook(c: PoolClient, caseId: string, event: string, data: Record<string, unknown> = {}): Promise<void> {
  observer?.({ kind: 'case', event, id: caseId, data });
  const row = await one<any>(
    c,
    `SELECT c.org_id, c.ref, c.partner_case_id, c.status, c.stage, c.carrier, c.tracking, c.aligners_shipped, s.code AS site_code
       FROM cases c LEFT JOIN sites s ON s.id = c.site_id WHERE c.id = $1`,
    [caseId],
  );
  if (!row) return;
  const type = publicCaseEvent(event, row.stage ?? (typeof data.stage === 'string' ? data.stage : null));
  if (!type) return;
  await fanOut(c, row.org_id, type, async () => casePayload(row));
}

/** Events: claim.updated. */
export async function emitClaimWebhook(c: PoolClient, claimId: string, event: string, data: Record<string, unknown> = {}): Promise<void> {
  observer?.({ kind: 'claim', event, id: claimId, data });
  if (event !== 'claim.updated') return;
  const row = await one<any>(
    c,
    `SELECT cl.org_id, cl.number, cl.status, cl.resolution, cs.ref FROM claims cl JOIN cases cs ON cs.id = cl.case_id WHERE cl.id = $1`,
    [claimId],
  );
  if (!row) return;
  await fanOut(c, row.org_id, 'claim.updated', async () => ({
    claim_number: row.number,
    case_ref: row.ref,
    status: row.status,
    ...(row.resolution ? { resolution: row.resolution } : {}),
  }));
}

/** Events: spec.updated. */
export async function emitSpecWebhook(c: PoolClient, specId: string, event: string, data: Record<string, unknown> = {}): Promise<void> {
  observer?.({ kind: 'spec', event, id: specId, data });
  if (event !== 'spec.updated') return;
  const row = await one<any>(c, 'SELECT org_id, version, status FROM specs WHERE id = $1', [specId]);
  if (!row) return;
  await fanOut(c, row.org_id, 'spec.updated', async () => ({
    version: typeof data.version === 'number' ? data.version : row.version,
    status: typeof data.status === 'string' ? data.status : row.status,
  }));
}

/** Events: materials.low_stock. */
export async function emitMaterialsWebhook(c: PoolClient, orgId: string, event: string, data: Record<string, unknown> = {}): Promise<void> {
  observer?.({ kind: 'materials', event, id: orgId, data });
  if (event !== 'materials.low_stock' || typeof data.sku !== 'string') return;
  await fanOut(c, orgId, 'materials.low_stock', async () => ({
    sku: data.sku,
    site: data.siteCode ?? null,
    on_hand: Number(data.onHand ?? 0),
    min_stock: Number(data.minStock ?? 0),
  }));
}
