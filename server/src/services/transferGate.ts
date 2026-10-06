import { audit } from '../audit';
import { SYSTEM, many, one, tx, type PoolClient } from '../db';
import { loadCase } from './cases';
import { notifyOrg } from './notify';
import { applyStage, type EngineActor } from './stageEngine';
import { TRANSFER_HOLD_REASON, siteIsLegal } from './transferCheck';

export { TRANSFER_HOLD_REASON, SCC_VALID_SQL, sccOnFile, siteIsLegal } from './transferCheck';

/**
 * The transfer gate (art. 44 GDPR, fixed decision 8): cases of EEA partners are produced only in the EEA, in a country with an adequacy decision,
 * or elsewhere when Standard Contractual Clauses are on file.
 *
 * Where it runs:
 *  - when a partner submits a standard case and when K Line routes or re-routes a case (services/cases.ts, services/intake.ts)
 *  - when the factory system pulls cases (GET /api/mes/v1/intake) and downloads a file (GET /api/mes/v1/files/:id), see services/mes.ts
 *  - once a day in the retention job (`transfer.recheck`, recheckTransfers below)
 *
 * Direct manufacturing cases (manufacturing_mode = 'direct') are produced by the K Line customer portal, not routed to a site by the Hub, so they
 * have no site and the gate does not apply to them anywhere. The files go to the portal when the case is pushed (services/bulkPush.ts);
 * where the portal runs is a question for Legal (docs/gdpr/TRANSFERS.md, section 1). If direct cases are ever routed to a site, call
 * `siteIsLegal` for them as well: every function here already takes the site and partner from the case row.
 */

/** Tells K Line intake that a transfer is no longer covered. Reference only: no patient data, no partner case ID. */
async function notifyKlineIntake(c: PoolClient, row: { id: string; ref: string }): Promise<void> {
  const kl = await one<{ id: string }>(c, `SELECT id FROM organizations WHERE kind = 'kline' LIMIT 1`);
  if (!kl) return;
  await notifyOrg(c, { orgId: kl.id, kind: 'transfer_blocked', title: 'Transfer no longer covered', body: `Case ${row.ref}`, data: { caseId: row.id, ref: row.ref } });
}

export type GateTrigger = 'mes_intake' | 'mes_file' | 'daily_check';

const SYSTEM_ACTOR: EngineActor = { actorType: 'system', actorId: null };

/**
 * Checks one standard case that is `ready` or `received` at a site and, when its site is no longer legal for the partner, puts it on hold with the
 * fixed reason, writes the case event and the audit entry `case.transfer_blocked`, and tells K Line intake by reference. The caller holds the transaction.
 * Returns true when the case was put on hold (it must then not be listed or served).
 */
export async function enforceTransferGate(c: PoolClient, caseId: string, trigger: GateTrigger, cache?: Map<string, boolean>): Promise<boolean> {
  const row = await loadCase(c, caseId, true);
  if (row.manufacturing_mode !== 'standard' || !row.site_id || !['ready', 'received'].includes(row.status)) return false;
  const site = await one<any>(c, 'SELECT code, country, eea, adequacy FROM sites WHERE id = $1', [row.site_id]);
  if (!site) return false;
  const key = `${row.org_id}|${row.site_id}`;
  let legal = cache?.get(key);
  if (legal === undefined) {
    legal = await siteIsLegal(c, row.org_id, site);
    cache?.set(key, legal);
  }
  if (legal) return false;
  const r = await applyStage(c, row, { target: 'hold', source: 'system', occurredAt: new Date(), holdReason: TRANSFER_HOLD_REASON, eventData: { gate: 'transfer', site: site.code } }, SYSTEM_ACTOR);
  if (r.outcome !== 'applied') return false;
  await audit(c, { actorType: 'system', orgId: row.org_id, action: 'case.transfer_blocked', targetType: 'case', targetId: row.id, details: { ref: row.ref, site: site.code, from: row.status, trigger } });
  await notifyKlineIntake(c, row);
  return true;
}

/**
 * Daily check: every standard case that is `ready` or `received` at a site outside the EEA is evaluated again. Cases whose site is no longer legal
 * for the partner (an SCC was withdrawn or expired, or a site flag changed) go on hold. Returns how many were put on hold.
 */
export async function recheckTransfers(): Promise<number> {
  const ids = await tx(SYSTEM, (c) =>
    many<{ id: string }>(
      c,
      `SELECT c.id FROM cases c JOIN sites s ON s.id = c.site_id
        WHERE c.manufacturing_mode = 'standard' AND c.status IN ('ready', 'received') AND NOT s.eea ORDER BY c.id`,
    ),
  );
  let held = 0;
  const cache = new Map<string, boolean>();
  for (const { id } of ids) {
    const done = await tx(SYSTEM, (c) => enforceTransferGate(c, id, 'daily_check', cache));
    if (done) held++;
  }
  return held;
}
