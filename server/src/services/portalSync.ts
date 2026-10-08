import { audit } from '../audit';
import { SYSTEM, many, one, tx, type DbCtx, type PoolClient } from '../db';
import type { AuthContext } from '../auth/context';
import { conflict } from '../http/errors';
import { registerJob } from '../jobs';
import { portalStatusLabel, portalStatusToHub } from '../../../shared/stages';
import { CARRIER_MAX, TRACKING_MAX, cleanText, notifyPartner } from './stageEngine';
import { caseDto, loadCase, partnerView } from './cases';
import { PortalError, getPortalClient, isDemoPortal, type PortalCaseInfo, type PortalClient } from './portal';
import { emitCaseWebhook } from './webhooks';

/** Most cases checked in one run. The ones checked longest ago go first, so every case gets its turn. */
export const PORTAL_SYNC_CAP = 200;
export const PORTAL_SYNC_INTERVAL_MINUTES = 10;
const SAFE_SYNC_ERROR = 'The status check failed because of an internal problem.';

export interface SyncSummary {
  checked: number;
  changed: number;
  failed: number;
  skipped: number;
}

/**
 * Splits the portal's tracking_number. The API doc allows the tracking number alone, or "courier tracking number" separated by spaces.
 * Leading words without digits are the courier (up to three); the rest is the tracking number. Without such words the whole value is the tracking number.
 */
export function splitTracking(raw: string | null | undefined): { carrier: string | null; tracking: string | null } {
  const text = cleanText(raw);
  if (!text) return { carrier: null, tracking: null };
  const words = text.split(' ');
  let i = 0;
  while (i < words.length - 1 && i < 3 && !/\d/.test(words[i]!)) i++;
  const carrier = i > 0 ? words.slice(0, i).join(' ') : null;
  const tracking = words.slice(i).join(' ');
  return { carrier: carrier ? carrier.slice(0, CARRIER_MAX) : null, tracking: tracking.slice(0, TRACKING_MAX) };
}

/** "2026-10-05T00:00:00+00:00" to "2026-10-05", or null when it is not a date. */
export function portalDate(raw: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw ?? '');
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Cases that still need watching: pushed direct cases that have not shipped, plus a just shipped case that has no tracking number yet. */
export const ELIGIBLE_SQL =`c.manufacturing_mode = 'direct' AND c.portal_case_uuid IS NOT NULL AND c.portal_push->>'status' = 'pushed'
  AND COALESCE(c.portal_push->>'demo', 'false') <> 'true' AND c.purged_at IS NULL
  AND (c.status NOT IN ('shipped', 'delivered', 'cancelled') OR (c.status = 'shipped' AND c.tracking IS NULL AND c.shipped_at > now() - interval '7 days'))`;

/**
 * Applies what the portal said about one case. Runs in one transaction with the case row locked, so a second run
 * (or a click on Refresh at the same moment) sees the first one's result and adds nothing. Returns true when the Hub case changed.
 */
export async function applyPortalInfo(c: PoolClient, caseId: string, info: PortalCaseInfo): Promise<boolean> {
  const row = await one<any>(c, `SELECT c.* FROM cases c WHERE c.id = $1 AND ${ELIGIBLE_SQL} FOR UPDATE OF c`, [caseId]);
  if (!row) return false;
  const push = row.portal_push ?? {};
  const portalStatus = info.status && portalStatusToHub(info.status) ? info.status : null;
  const target = portalStatusToHub(portalStatus);
  const previous: string = push.portalStatus ?? 'New';
  const portalChanged = !!portalStatus && portalStatus !== previous;

  const sets: string[] = [];
  const params: unknown[] = [caseId];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };

  // The Hub status only moves forward, and only to Production or Shipped. Earlier portal statuses leave a submitted case as Submitted.
  let newStatus: 'in_production' | 'shipped' | null = null;
  if (target === 'shipped' && !['shipped', 'delivered'].includes(row.status)) newStatus = 'shipped';
  else if (target === 'production' && ['submitted', 'ready', 'on_hold', 'received'].includes(row.status)) newStatus = 'in_production';

  const now = new Date();
  if (newStatus === 'in_production') {
    set('status', 'in_production');
    sets.push('stage = NULL', 'hold_reason = NULL', 'started_at = COALESCE(started_at, now())');
  } else if (newStatus === 'shipped') {
    set('status', 'shipped');
    sets.push('stage = NULL', 'hold_reason = NULL', 'started_at = COALESCE(started_at, now())', 'finished_at = COALESCE(finished_at, now())', 'shipped_at = COALESCE(shipped_at, now())');
  }

  let carrier: string | null = null;
  let tracking: string | null = null;
  if (target === 'shipped' && !row.tracking) {
    ({ carrier, tracking } = splitTracking(info.trackingNumber));
    if (tracking) {
      set('tracking', tracking);
      if (carrier) set('carrier', carrier);
    }
  }
  const expected = portalDate(info.expectedShippingDate);
  if (expected && expected !== row.due_date) set('due_date', expected);

  const stamp = { portalStatus: portalStatus ?? push.portalStatus ?? null, syncedAt: now.toISOString(), checkedAt: now.toISOString() };
  params.push(JSON.stringify(stamp));
  sets.push(`portal_push = (COALESCE(portal_push, '{}'::jsonb) - 'syncError') || $${params.length}::jsonb`);
  if (newStatus || expected || tracking) sets.push('updated_at = now()');
  await c.query(`UPDATE cases SET ${sets.join(', ')} WHERE id = $1`, params);

  if (portalChanged) {
    const label = portalStatusLabel(portalStatus);
    const data: Record<string, unknown> = {
      source: 'portal',
      portalStatus,
      label,
      message: `Status from the K Line portal: ${label}`,
      from: row.status,
      status: newStatus ?? row.status,
    };
    if (carrier) data.carrier = carrier;
    if (tracking) data.trackingNumber = tracking;
    if (expected) data.expectedShipDate = expected;
    await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, data) VALUES ($1, $2, 'stage', 'system', $3::jsonb)`, [row.org_id, caseId, JSON.stringify(data)]);
    await audit(c, {
      actorType: 'system', orgId: row.org_id, action: 'case.portal_status', targetType: 'case', targetId: caseId,
      details: { ref: row.ref, portalStatus, from: row.status, to: newStatus ?? row.status },
    });
  }
  if (newStatus) {
    const shipped = newStatus === 'shipped';
    await notifyPartner(c, row, shipped ? 'Case shipped' : 'Case in production', shipped ? 'case_shipped' : 'case_stage', { source: 'portal' });
    await emitCaseWebhook(c, caseId, shipped ? 'case.shipped' : 'case.stage_changed', { status: newStatus, stage: null });
  }
  return !!newStatus || portalChanged || !!tracking;
}

async function recordFailure(caseId: string, message: string): Promise<void> {
  await tx(SYSTEM, (c) =>
    c.query(
      `UPDATE cases SET portal_push = COALESCE(portal_push, '{}'::jsonb) || jsonb_build_object('syncError', $2::text, 'checkedAt', now()) WHERE id = $1 AND portal_push->>'status' = 'pushed'`,
      [caseId, message],
    ),
  );
}

/**
 * Reads the status of pushed direct manufacturing cases from the K Line portal and brings the Hub cases in step.
 * One portal client per organisation. An error on one case is recorded on that case (fixed text, never patient data) and the rest carry on.
 * Safe to run twice at the same time or to repeat: see applyPortalInfo.
 */
export async function runPortalSync(opts: { caseId?: string } = {}): Promise<SyncSummary> {
  const summary: SyncSummary = { checked: 0, changed: 0, failed: 0, skipped: 0 };
  const rows = await tx(SYSTEM, (c) =>
    many<{ id: string; org_id: string; portal_case_uuid: string; org_settings: Record<string, any> | null }>(
      c,
      `SELECT c.id, c.org_id, c.portal_case_uuid, o.settings AS org_settings
         FROM cases c JOIN organizations o ON o.id = c.org_id
        WHERE ${ELIGIBLE_SQL} ${opts.caseId ? 'AND c.id = $1' : ''}
        ORDER BY (c.portal_push->>'checkedAt')::timestamptz NULLS FIRST, c.id
        LIMIT ${PORTAL_SYNC_CAP}`,
      opts.caseId ? [opts.caseId] : [],
    ),
  );
  const byOrg = new Map<string, typeof rows>();
  for (const r of rows) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r]);

  for (const [orgId, cases] of byOrg) {
    let client: (PortalClient & { close?: () => Promise<void> }) | undefined;
    try {
      client = getPortalClient({ id: orgId, settings: cases[0]!.org_settings ?? {} });
    } catch (e) {
      const message = e instanceof PortalError ? e.message : SAFE_SYNC_ERROR;
      for (const r of cases) {
        summary.checked++;
        summary.failed++;
        await recordFailure(r.id, message).catch(() => undefined);
      }
      continue;
    }
    try {
      if (isDemoPortal(client)) {
        summary.skipped += cases.length;
        continue;
      }
      for (const r of cases) {
        summary.checked++;
        try {
          const info = await client.getCase(r.portal_case_uuid);
          if (await tx(SYSTEM, (c) => applyPortalInfo(c, r.id, info))) summary.changed++;
        } catch (e) {
          summary.failed++;
          await recordFailure(r.id, e instanceof PortalError ? e.message : SAFE_SYNC_ERROR).catch(() => undefined);
        }
      }
    } finally {
      await client.close?.().catch(() => undefined);
    }
  }
  return summary;
}

/** Refresh button: checks the portal for one case now and returns the updated case. Partners reach their own cases only; K Line staff any. */
export async function refreshCaseFromPortal(ctx: DbCtx, a: AuthContext, id: string) {
  const row = await tx(ctx, (c) => loadCase(c, id, false, a));
  if (row.manufacturing_mode !== 'direct') throw conflict('Only direct manufacturing cases are sent to the K Line portal.', 'not_direct');
  if (row.portal_push?.status !== 'pushed' || !row.portal_case_uuid) throw conflict('This case has not been sent to the K Line portal yet.', 'not_pushed');
  await runPortalSync({ caseId: id });
  return { case: caseDto(await tx(ctx, (c) => loadCase(c, id, false, a)), partnerView(a)) };
}

/**
 * Claims the next sync slot: true for exactly one caller every 10 minutes, and never while a sync is already queued or running.
 * The claim moves last_run_at with a conditional update, so several workers do not queue it twice.
 */
export async function claimPortalSync(c: PoolClient): Promise<boolean> {
  const busy = await one(c, `SELECT 1 FROM jobs WHERE kind = 'portal.sync' AND status IN ('queued', 'running') LIMIT 1`);
  if (busy) return false;
  const r = await c.query(
    `INSERT INTO job_runs (name, last_run_at, last_status) VALUES ('portal.sync', now(), 'queued')
     ON CONFLICT (name) DO UPDATE SET last_run_at = now(), last_status = 'queued' WHERE job_runs.last_run_at < now() - make_interval(mins => $1)
     RETURNING name`,
    [PORTAL_SYNC_INTERVAL_MINUTES],
  );
  return (r.rowCount ?? 0) > 0;
}

registerJob('portal.sync', async () => {
  const s = await runPortalSync();
  await tx(SYSTEM, (c) =>
    c.query(
      `INSERT INTO job_runs (name, last_run_at, last_status, last_detail) VALUES ('portal.sync', now(), 'ok', $1::jsonb)
       ON CONFLICT (name) DO UPDATE SET last_status = 'ok', last_detail = EXCLUDED.last_detail`,
      [JSON.stringify(s)],
    ),
  );
});
