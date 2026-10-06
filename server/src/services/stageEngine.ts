import { audit } from '../audit';
import { one, many, type PoolClient } from '../db';
import { isStageId, stageIndex, stageLabel, statusForStage, type StageId } from '../../../shared/stages';
import { notifyOrg } from './notify';
import { refreshBatch } from './cases';
import { emitCaseWebhook } from './webhooks';
import { bookConsumption } from './materials';

/**
 * The stage engine. One place decides how a case moves through production, whatever the source:
 * factory system events (`mes`), a CSV import of such events (`csv`), a manual update by K Line staff (`kline`) or the Hub itself (`system`, for example the transfer gate).
 * Stages only move forward, HOLD and CANCEL are their own actions, and shipped fields are validated here.
 */
export type EngineSource = 'mes' | 'csv' | 'kline' | 'system';
export type StageTarget = StageId | 'hold' | 'cancelled';

export interface StageInput {
  target: StageTarget;
  source: EngineSource;
  occurredAt: Date;
  carrier?: string | null;
  trackingNumber?: string | null;
  alignersShipped?: number | null;
  holdReason?: string | null;
  note?: string | null;
  mesCaseId?: string | null;
  /** Extra fields for the case event (references and fixed codes only, never patient data or free text). */
  eventData?: Record<string, unknown>;
}

export interface EngineActor {
  actorType: 'user' | 'api_key' | 'service' | 'system';
  actorId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type Plan =
  | { kind: 'apply' }
  | { kind: 'ignored'; message: string }
  | { kind: 'error'; code: string; message: string };

export interface PlanRow {
  status: string;
  stage: string | null;
  manufacturing_mode?: string;
  mes_case_id?: string | null;
}

export const HOLD_REASON_MIN = 3;
export const HOLD_REASON_MAX = 500;
export const DEFAULT_MES_HOLD_REASON = 'The factory has put this case on hold. K Line will be in touch.';
export const CARRIER_MAX = 60;
export const TRACKING_MAX = 100;
export const ALIGNERS_SHIPPED_MAX = 5000;
export const CANCELLED_PURGE_DAYS = 30;
/** An event may be dated at most this long before the case was created (clocks of different systems differ a little). */
export const EVENT_BEFORE_CREATED_HOURS = 24;
/** An event older than this is never plausible. */
export const EVENT_MAX_AGE_YEARS = 3;
export const IMPLAUSIBLE_TIME_MESSAGE = 'The time is not plausible for this case.';

/** True when the time an event says it happened is believable for a case: not long before the case existed and not years ago. */
export function isPlausibleEventTime(occurredAt: Date, caseCreatedAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  const t = occurredAt.getTime();
  if (!Number.isFinite(t)) return false;
  const oldest = new Date(now);
  oldest.setUTCFullYear(oldest.getUTCFullYear() - EVENT_MAX_AGE_YEARS);
  if (t < oldest.getTime()) return false;
  const created = caseCreatedAt ? new Date(caseCreatedAt).getTime() : NaN;
  if (Number.isFinite(created) && t < created - EVENT_BEFORE_CREATED_HOURS * 3_600_000) return false;
  return true;
}

const FACTORY_STATUSES = ['ready', 'received', 'in_production', 'shipped', 'delivered'];

/** Clean free text: control characters out, spaces collapsed. */
export function cleanText(v: string | null | undefined): string {
  return (v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Pure decision: what would happen if this input arrived for a case in this state. No database access. */
export function planTransition(row: PlanRow, input: Pick<StageInput, 'target' | 'source' | 'carrier' | 'trackingNumber' | 'alignersShipped' | 'holdReason' | 'mesCaseId'>): Plan {
  if (row.manufacturing_mode === 'direct') {
    return { kind: 'error', code: 'direct_case', message: 'This case is produced through the K Line portal, not the factory system.' };
  }
  const s = row.status;

  if (input.target === 'cancelled') {
    if (s === 'cancelled') return { kind: 'ignored', message: 'The case is already cancelled.' };
    if (s === 'shipped' || s === 'delivered') return { kind: 'ignored', message: 'The case has already shipped, so it cannot be cancelled.' };
    if (s === 'draft') return { kind: 'error', code: 'case_not_submitted', message: 'The case has not been submitted yet.' };
    return { kind: 'apply' };
  }

  if (input.target === 'hold') {
    if (s === 'on_hold') return { kind: 'ignored', message: 'The case is already on hold.' };
    if (s === 'cancelled') return { kind: 'ignored', message: 'The case is cancelled.' };
    if (s === 'shipped' || s === 'delivered') return { kind: 'ignored', message: 'The case has already shipped, so it cannot be put on hold.' };
    if (s === 'draft') return { kind: 'error', code: 'case_not_submitted', message: 'The case has not been submitted yet.' };
    const reason = cleanText(input.holdReason);
    if (input.source === 'kline' && (reason.length < HOLD_REASON_MIN || reason.length > HOLD_REASON_MAX)) {
      return { kind: 'error', code: 'invalid_hold_reason', message: `Give a reason of ${HOLD_REASON_MIN} to ${HOLD_REASON_MAX} characters.` };
    }
    return { kind: 'apply' };
  }

  // A stage
  if (s === 'cancelled') return { kind: 'ignored', message: 'The case is cancelled.' };
  if (!FACTORY_STATUSES.includes(s)) {
    return { kind: 'error', code: 'case_not_in_production', message: s === 'on_hold' ? 'The case is on hold.' : 'The case has not been released to the factory yet.' };
  }
  if (input.mesCaseId && row.mes_case_id && row.mes_case_id !== input.mesCaseId) {
    return { kind: 'error', code: 'mes_case_id_mismatch', message: 'The factory case number does not match the one already recorded.' };
  }
  const current = s === 'ready' ? -1 : stageIndex(row.stage);
  const next = stageIndex(input.target);
  if (next <= current) return { kind: 'ignored', message: 'The case is already at or past that stage.' };
  // Delivery is only possible after shipping: SHIP records the carrier, tracking number and aligners shipped, and starts the retention clock.
  // A case is never allowed to jump to delivered without that, so DELIVERED before SHIP is ignored (not guessed).
  if (input.target === 'delivered' && s !== 'shipped') return { kind: 'ignored', message: 'Send SHIP before DELIVERED.' };
  if (input.target === 'shipped') {
    const carrier = cleanText(input.carrier);
    const tracking = cleanText(input.trackingNumber);
    const n = input.alignersShipped;
    if (!carrier || !tracking || !Number.isInteger(n) || (n as number) < 1) {
      return { kind: 'error', code: 'shipping_details_required', message: 'Shipping needs a carrier, a tracking number and the number of aligners shipped.' };
    }
    if (carrier.length > CARRIER_MAX || tracking.length > TRACKING_MAX || (n as number) > ALIGNERS_SHIPPED_MAX) {
      return { kind: 'error', code: 'invalid_shipping_details', message: 'The shipping details are too long or out of range.' };
    }
  }
  return { kind: 'apply' };
}

export interface ApplyResult {
  outcome: 'applied' | 'ignored' | 'error';
  code?: string;
  message?: string;
  /** The status after the change (applied) or the unchanged status. */
  status?: string;
  stage?: string | null;
}

const auditActionFor = (target: StageTarget) => (target === 'hold' ? 'case.on_hold' : target === 'cancelled' ? 'case.cancelled' : 'case.stage');

/** Tells the partner's users. Reference only: no patient data, no free text. */
export async function notifyPartner(c: PoolClient, row: any, title: string, kind: string, extra: Record<string, unknown> = {}): Promise<void> {
  const users = await many<{ id: string }>(c, `SELECT id FROM users WHERE org_id = $1 AND status = 'active'`, [row.org_id]);
  for (const u of users) {
    await notifyOrg(c, { orgId: row.org_id, userId: u.id, kind, title, body: `Case ${row.ref}`, data: { caseId: row.id, ref: row.ref, ...extra } });
  }
}

/**
 * Plans and applies one change to a case row that is already locked (FOR UPDATE) in this transaction.
 * Never throws for business outcomes: it returns applied, ignored or error so batch callers can report per event.
 */
export async function applyStage(c: PoolClient, row: any, input: StageInput, actor: EngineActor): Promise<ApplyResult> {
  const plan = planTransition(row, input);
  if (plan.kind === 'ignored') return { outcome: 'ignored', message: plan.message, status: row.status, stage: row.stage };
  if (plan.kind === 'error') return { outcome: 'error', code: plan.code, message: plan.message, status: row.status, stage: row.stage };

  const now = new Date();
  // A time that cannot be right for this case (long before it was created, or years old) is an error. A time in the future is treated as now.
  if (!isPlausibleEventTime(input.occurredAt, row.created_at, now)) {
    return { outcome: 'error', code: 'implausible_time', message: IMPLAUSIBLE_TIME_MESSAGE, status: row.status, stage: row.stage };
  }
  const at = input.occurredAt.getTime() > now.getTime() ? now : input.occurredAt;
  const sets: string[] = [];
  const params: unknown[] = [row.id];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  const sourceLabel = input.source === 'kline' ? 'K Line' : input.source === 'system' ? 'System' : 'Factory system';
  const eventData: Record<string, unknown> = { source: input.source, from: row.status };
  let eventType: string;
  let title: string;
  let notifyKind: string;
  let hook: string;
  let newStatus: string;
  let newStage: string | null = row.stage;
  /** Set when this change ships the case: the number of aligners whose materials are booked. */
  let consumeAligners: number | null = null;

  if (input.target === 'cancelled') {
    newStatus = 'cancelled';
    set('status', 'cancelled');
    set('cancelled_at', now);
    set('purge_after', new Date(now.getTime() + CANCELLED_PURGE_DAYS * 86_400_000));
    sets.push('hold_reason = NULL');
    eventType = 'cancelled';
    title = 'Case cancelled';
    notifyKind = 'case_cancelled';
    hook = 'case.cancelled';
  } else if (input.target === 'hold') {
    newStatus = 'on_hold';
    const reason = cleanText(input.holdReason).slice(0, HOLD_REASON_MAX);
    const finalReason = reason.length >= HOLD_REASON_MIN ? reason : DEFAULT_MES_HOLD_REASON;
    set('status', 'on_hold');
    set('hold_reason', finalReason);
    eventType = 'on_hold';
    eventData.reason = finalReason;
    title = 'Case on hold';
    notifyKind = 'case_on_hold';
    hook = 'case.on_hold';
  } else {
    const stage = input.target as StageId;
    newStatus = statusForStage(stage);
    newStage = stage;
    set('status', newStatus);
    set('stage', stage);
    sets.push('hold_reason = NULL');
    if (input.mesCaseId && !row.mes_case_id) set('mes_case_id', input.mesCaseId);
    sets.push(`received_at = COALESCE(received_at, ${(params.push(at), `$${params.length}`)})`);
    if (newStatus === 'in_production') sets.push(`started_at = COALESCE(started_at, ${(params.push(at), `$${params.length}`)})`);
    if (['packing', 'shipped', 'delivered'].includes(stage)) sets.push(`finished_at = COALESCE(finished_at, ${(params.push(at), `$${params.length}`)})`);
    eventType = input.source === 'kline' ? 'stage' : 'stage_reported';
    eventData.stage = stage;
    eventData.label = stageLabel(stage);
    eventData.status = newStatus;
    title = stageLabel(stage);
    notifyKind = stage === 'shipped' ? 'case_shipped' : stage === 'delivered' ? 'case_delivered' : 'case_stage';
    hook = stage === 'shipped' ? 'case.shipped' : stage === 'delivered' ? 'case.delivered' : 'case.stage_changed';

    const needsShipDate = stage === 'shipped';
    if (stage === 'shipped') {
      const carrier = cleanText(input.carrier);
      const tracking = cleanText(input.trackingNumber);
      set('carrier', carrier);
      set('tracking', tracking);
      set('aligners_shipped', input.alignersShipped);
      eventData.carrier = carrier;
      eventData.trackingNumber = tracking;
      eventData.alignersShipped = input.alignersShipped;
      consumeAligners = input.alignersShipped ?? 0;
    }
    if (needsShipDate) {
      const org = await one<{ retention_months: number }>(c, 'SELECT retention_months FROM organizations WHERE id = $1', [row.org_id]);
      set('shipped_at', at);
      params.push(at, org?.retention_months ?? 24);
      sets.push(`purge_after = $${params.length - 1}::timestamptz + make_interval(months => $${params.length})`);
    }
    if (stage === 'delivered') set('delivered_at', at);
  }
  if (input.note) eventData.note = cleanText(input.note).slice(0, 500);
  if (input.eventData) Object.assign(eventData, input.eventData);
  eventData.sourceLabel = sourceLabel;

  await c.query(`UPDATE cases SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  // Partner supplied materials used by this case are booked when it ships (once per case).
  if (consumeAligners !== null) await bookConsumption(c, row, consumeAligners);
  await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [
    row.org_id, row.id, eventType, actor.actorType, actor.actorId, JSON.stringify(eventData),
  ]);
  await audit(c, {
    actorType: actor.actorType, actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: row.org_id, action: auditActionFor(input.target),
    targetType: 'case', targetId: row.id, details: { ref: row.ref, from: row.status, to: newStatus, ...(isStageId(input.target) ? { stage: input.target } : {}), source: input.source },
  });
  await notifyPartner(c, row, title, notifyKind, isStageId(input.target) ? { stage: input.target } : {});
  await emitCaseWebhook(c, row.id, hook, { status: newStatus, stage: newStage });
  if (input.target === 'cancelled') await refreshBatch(c, row.bulk_batch_id);
  return { outcome: 'applied', status: newStatus, stage: newStage };
}

