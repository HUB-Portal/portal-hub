import { audit } from '../audit';
import { SYSTEM, many, one, tx, type PoolClient } from '../db';
import { SCRUB_PAYLOAD_KINDS, registerJob } from '../jobs';
import { storage } from '../storage';
import { recomputeCase } from './checks';
import { refreshBatch } from './cases';
import { deleteOrganisation, removeStoredPrefixes } from './org';
import { scrubCase, type ScrubOptions } from './scrub';
import { recheckTransfers } from './transferGate';

/**
 * Data retention (BRIEF section 19). Runs daily in the worker and on demand from the CLI.
 * The audit log is never touched here (it has its own trim function). Nothing in here logs patient data.
 */
export interface RetentionReport {
  casesPurged: number;
  draftsDeleted: number;
  abandonedUploads: number;
  orphanObjectsRemoved: number;
  sessions: number;
  userTokens: number;
  oidcFlows: number;
  notifications: number;
  mesEvents: number;
  devMailbox: number;
  jobs: number;
  /** Webhook deliveries (and their payloads) older than 90 days. */
  webhookDeliveries: number;
  /** Email notice bookkeeping (the 15 minute window) older than 2 days. */
  emailNotices: number;
  /** Registrations whose email address was never confirmed, deleted 7 days after registering. */
  unconfirmedRegistrations: number;
  /** Declined registrations deleted 30 days after the decision. */
  declinedRegistrations: number;
  /** Logo files nobody uses, older than 7 days. */
  unusedLogos: number;
  /** Registration bookkeeping rows (attempt counts, notice throttles). */
  signupRecords: number;
  /** Purged cases whose leftover personal data (patient ID, hold reasons, claim text) was scrubbed in this run (cases purged before the scrub existed). */
  casesScrubbed: number;
  /** Email jobs older than 24 hours whose payload (addresses, one time links) was wiped. */
  emailJobsScrubbed: number;
  /** Standard cases at sites outside the EEA that were put on hold because the transfer is no longer covered. */
  transfersHeld: number;
}

const BATCH = 200;

/** Deletes stored objects. Returns the prefixes that could not be removed (they are retried on the next run). */
async function deleteStored(prefixes: string[]): Promise<Set<string>> {
  const failed = new Set<string>();
  if (!prefixes.length) return failed;
  const st = await storage();
  for (const p of prefixes) {
    try {
      await st.deletePrefix(p + '/');
    } catch {
      failed.add(p);
    }
  }
  return failed;
}

export interface WipeResult {
  /** False when the case was already purged or erased (nothing was done). */
  done: boolean;
  org_id?: string;
  ref?: string;
  prefixes: string[];
  fileIds: string[];
}

/**
 * The one code path that removes a case's data, used by the retention purge and by erasure on request. Inside the caller's transaction:
 * stored chunks and key material of the case's files and of its claims' evidence go (objects still used by a live file of another case, such as a
 * replacement or rework child, stay), names, instructions and blind indexes go, `purged_at` is set, and scrubCase removes the personal data around the case.
 * The non identifying production record stays. Returns the storage prefixes to delete once the transaction has committed.
 */
export async function wipeCaseData(c: PoolClient, caseId: string, scrub: ScrubOptions = { partnerCaseId: 'direct' }): Promise<WipeResult> {
  const cs = await one<any>(c, 'SELECT id, org_id, ref, purged_at FROM cases WHERE id = $1 FOR UPDATE', [caseId]);
  if (!cs || cs.purged_at) return { done: false, prefixes: [], fileIds: [] };
  // The case's own files and the evidence photos and videos of its quality claims.
  const owned = `(case_id = $1 OR claim_id IN (SELECT id FROM claims WHERE case_id = $1))`;
  const files = await many<{ id: string; storage_prefix: string | null }>(c, `SELECT id, storage_prefix FROM files WHERE ${owned} AND state <> 'purged'`, [caseId]);
  // Key material is removed in the same transaction: even if object deletion fails later, the stored bytes can no longer be read.
  await c.query(
    `UPDATE files SET state = 'purged', purged_at = now(), name_enc = NULL, wrapped_key = NULL, nonce_prefix = NULL, key_id = NULL, validation = '{}'::jsonb, updated_at = now()
      WHERE ${owned} AND state <> 'purged'`,
    [caseId],
  );
  await c.query(`DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM files WHERE ${owned})`, [caseId]);
  // A replacement or rework case reuses the stored bytes of its parent. Objects still used by a live file of another case stay.
  const deletable = files.length
    ? await many<{ storage_prefix: string }>(
        c,
        `SELECT DISTINCT f.storage_prefix FROM files f
          WHERE f.id = ANY($1::uuid[]) AND f.storage_prefix IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM files o WHERE o.storage_prefix = f.storage_prefix AND o.state <> 'purged')`,
        [files.map((f) => f.id)],
      )
    : [];
  await c.query(
    `UPDATE cases SET patient_enc = NULL, patient_bidx = NULL, patient_bidxs = '{}', patient_first_enc = NULL, patient_last_enc = NULL, notes_enc = NULL,
            purged_at = now(), updated_at = now() WHERE id = $1`,
    [caseId],
  );
  await scrubCase(c, caseId, scrub);
  return { done: true, org_id: cs.org_id, ref: cs.ref, prefixes: deletable.map((f) => f.storage_prefix), fileIds: files.map((f) => f.id) };
}

/**
 * Purges one case for retention inside the caller's transaction (see wipeCaseData), with the `purged` event and the audit entry `case.purged`.
 * Returns the storage prefixes to delete once the transaction has committed.
 */
export async function purgeCaseData(c: PoolClient, caseId: string, reason: string): Promise<{ purged: boolean; prefixes: string[]; fileIds: string[] }> {
  const w = await wipeCaseData(c, caseId, { partnerCaseId: 'direct' });
  if (!w.done) return { purged: false, prefixes: [], fileIds: [] };
  await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, data) VALUES ($1, $2, 'purged', 'system', $3::jsonb)`, [w.org_id, caseId, JSON.stringify({ reason, files: w.fileIds.length })]);
  await audit(c, { actorType: 'system', orgId: w.org_id, action: 'case.purged', targetType: 'case', targetId: caseId, details: { ref: w.ref, reason, files: w.fileIds.length } });
  return { purged: true, prefixes: w.prefixes, fileIds: w.fileIds };
}

/**
 * After the transaction of a purge or an erasure has committed: deletes the stored objects and clears the pointers of the ones that went.
 * Objects that cannot be deleted keep their pointer and are retried by the next retention run (sweepOrphans).
 */
export async function removePurgedObjects(r: { prefixes: string[]; fileIds: string[] }): Promise<void> {
  const failed = await deleteStored(r.prefixes);
  const done = r.fileIds.length ? await tx(SYSTEM, (c) => many<{ id: string; storage_prefix: string | null }>(c, 'SELECT id, storage_prefix FROM files WHERE id = ANY($1::uuid[])', [r.fileIds])) : [];
  const clear = done.filter((f) => f.storage_prefix && !failed.has(f.storage_prefix)).map((f) => f.id);
  if (clear.length) await tx(SYSTEM, (c) => c.query('UPDATE files SET storage_prefix = NULL WHERE id = ANY($1::uuid[])', [clear]));
}

async function purgeDueCases(): Promise<number> {
  let total = 0;
  for (;;) {
    const ids = await tx(SYSTEM, (c) =>
      many<{ id: string }>(
        c,
        `SELECT id FROM cases
          WHERE purged_at IS NULL AND status <> 'draft'
            AND ((purge_after IS NOT NULL AND purge_after <= now()) OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_at <= now() - interval '30 days'))
          ORDER BY id LIMIT ${BATCH}`,
      ),
    );
    if (!ids.length) return total;
    let did = 0;
    for (const { id } of ids) {
      const r = await tx(SYSTEM, (c) => purgeCaseData(c, id, 'retention'));
      if (!r.purged) continue;
      did++;
      await removePurgedObjects(r);
    }
    total += did;
    if (did === 0) return total; // nothing more can be purged this run
  }
}

/**
 * Cases that were purged before scrubbing existed (or whose scrub did not finish) still hold the patient ID of direct cases, hold reasons, claim text
 * and webhook payload ids. Each gets the same scrubCase as a new purge. Marked by `scrubbed_at`.
 */
async function scrubPurgedCases(): Promise<number> {
  let n = 0;
  for (;;) {
    const ids = await tx(SYSTEM, (c) => many<{ id: string }>(c, `SELECT id FROM cases WHERE purged_at IS NOT NULL AND scrubbed_at IS NULL ORDER BY id LIMIT ${BATCH}`));
    if (!ids.length) return n;
    for (const { id } of ids) {
      await tx(SYSTEM, async (c) => {
        await c.query('SELECT 1 FROM cases WHERE id = $1 FOR UPDATE', [id]);
        await scrubCase(c, id, { partnerCaseId: 'direct' });
      });
      n++;
    }
    if (ids.length < BATCH) return n;
  }
}

/**
 * Email jobs hold addresses and one time links in their payload. Whatever their state, a payload older than 24 hours is wiped (an old email is never
 * sent late): finished and failed jobs keep their row for the 14 day cleanup, queued ones are marked failed.
 */
async function scrubOldEmailJobs(): Promise<number> {
  const kinds = [...SCRUB_PAYLOAD_KINDS];
  return tx(SYSTEM, async (c) => {
    const r = await c.query(
      `UPDATE jobs SET payload = '{}'::jsonb,
              status = CASE WHEN status IN ('done', 'failed') THEN status ELSE 'failed' END,
              finished_at = COALESCE(finished_at, now()),
              locked_at = CASE WHEN status IN ('done', 'failed') THEN locked_at ELSE NULL END,
              last_error = CASE WHEN status = 'done' THEN last_error ELSE 'The email could not be sent.' END
        WHERE kind = ANY($1::text[]) AND created_at < now() - interval '24 hours' AND payload <> '{}'::jsonb`,
      [kinds],
    );
    return r.rowCount ?? 0;
  });
}

/** Purged files whose objects could not be removed earlier. */
async function sweepOrphans(): Promise<number> {
  const rows = await tx(SYSTEM, (c) => many<{ id: string; storage_prefix: string }>(c, `SELECT id, storage_prefix FROM files WHERE state = 'purged' AND storage_prefix IS NOT NULL LIMIT 1000`));
  if (!rows.length) return 0;
  // Never remove objects that a live file (for example in a child case) still points to; just drop the stale pointer.
  const prefixes = [...new Set(rows.map((r) => r.storage_prefix))];
  const live = new Set((await tx(SYSTEM, (c) => many<{ storage_prefix: string }>(c, `SELECT DISTINCT storage_prefix FROM files WHERE storage_prefix = ANY($1::text[]) AND state <> 'purged'`, [prefixes]))).map((r) => r.storage_prefix));
  const failed = await deleteStored(prefixes.filter((p) => !live.has(p)));
  const ok = rows.filter((r) => !failed.has(r.storage_prefix)).map((r) => r.id);
  if (ok.length) await tx(SYSTEM, (c) => c.query('UPDATE files SET storage_prefix = NULL WHERE id = ANY($1::uuid[])', [ok]));
  return ok.length;
}

async function deleteOldDrafts(): Promise<number> {
  let n = 0;
  for (;;) {
    const ids = await tx(SYSTEM, (c) => many<{ id: string }>(c, `SELECT id FROM cases WHERE status = 'draft' AND updated_at < now() - interval '30 days' ORDER BY id LIMIT ${BATCH}`));
    if (!ids.length) return n;
    for (const { id } of ids) {
      const prefixes = await tx(SYSTEM, async (c) => {
        const cs = await one<any>(c, `SELECT id, org_id, ref, bulk_batch_id FROM cases WHERE id = $1 AND status = 'draft' AND updated_at < now() - interval '30 days' FOR UPDATE`, [id]);
        if (!cs) return null;
        const files = await many<{ storage_prefix: string | null }>(c, 'SELECT storage_prefix FROM files WHERE case_id = $1', [id]);
        await c.query('DELETE FROM cases WHERE id = $1', [id]);
        await audit(c, { actorType: 'system', orgId: cs.org_id, action: 'case.deleted', targetType: 'case', targetId: id, details: { ref: cs.ref, files: files.length, reason: 'retention' } });
        await refreshBatch(c, cs.bulk_batch_id);
        return files.map((f) => f.storage_prefix).filter((p): p is string => !!p);
      });
      if (prefixes) {
        n++;
        await deleteStored(prefixes);
      }
    }
  }
}

async function deleteAbandonedUploads(): Promise<number> {
  const rows = await tx(SYSTEM, (c) =>
    many<{ id: string; case_id: string | null }>(
      c,
      `SELECT f.id, f.case_id FROM files f
        WHERE f.state = 'uploading' AND COALESCE((SELECT max(fc.created_at) FROM file_chunks fc WHERE fc.file_id = f.id), f.created_at) < now() - interval '2 days'
        LIMIT 1000`,
    ),
  );
  let n = 0;
  for (const r of rows) {
    const prefix = await tx(SYSTEM, async (c) => {
      if (r.case_id) await c.query('SELECT 1 FROM cases WHERE id = $1 FOR UPDATE', [r.case_id]);
      const f = await one<{ storage_prefix: string | null }>(c, `SELECT storage_prefix FROM files WHERE id = $1 AND state = 'uploading'`, [r.id]);
      if (!f) return null;
      await c.query('DELETE FROM files WHERE id = $1', [r.id]);
      if (r.case_id) await recomputeCase(c, r.case_id);
      return f.storage_prefix ?? '';
    });
    if (prefix !== null) {
      n++;
      if (prefix) await deleteStored([prefix]);
    }
  }
  return n;
}

export const UNCONFIRMED_REGISTRATION_DAYS = 7;
export const DECLINED_REGISTRATION_DAYS = 30;

/**
 * Registrations that never confirmed their email address go after 7 days; declined ones (confirmed, then refused by K Line) 30 days
 * after the decision. Both use the single deleteOrganisation service. The audit entry keeps only the organisation id and code.
 */
async function deleteExpiredRegistrations(kind: 'unconfirmed' | 'declined'): Promise<number> {
  const days = kind === 'unconfirmed' ? UNCONFIRMED_REGISTRATION_DAYS : DECLINED_REGISTRATION_DAYS;
  const due = (alias: string) =>
    kind === 'unconfirmed'
      ? `${alias}.signup ? 'at' AND (${alias}.signup->>'verified_at') IS NULL AND NOT (${alias}.signup ? 'declined_at') AND ${alias}.status = 'onboarding' AND (${alias}.signup->>'at')::timestamptz < now() - interval '${days} days'`
      : `${alias}.signup ? 'declined_at' AND (${alias}.signup->>'declined_at')::timestamptz < now() - interval '${days} days'`;
  let n = 0;
  for (;;) {
    const ids = await tx(SYSTEM, (c) => many<{ id: string }>(c, `SELECT o.id FROM organizations o WHERE o.kind = 'partner' AND ${due('o')} ORDER BY o.id LIMIT ${BATCH}`));
    if (!ids.length) return n;
    let did = 0;
    for (const { id } of ids) {
      const prefixes = await tx(SYSTEM, async (c) => {
        // Look again under the row lock: the state may have changed since the list was read.
        const o = await one<{ id: string }>(c, `SELECT o.id FROM organizations o WHERE o.id = $1 AND o.kind = 'partner' AND ${due('o')} FOR UPDATE`, [id]);
        if (!o) return null;
        const del = await deleteOrganisation(c, id);
        await audit(c, { actorType: 'system', orgId: id, action: kind === 'unconfirmed' ? 'signup.expired' : 'partner.registration_deleted', targetType: 'organization', targetId: id, details: { code: del.code, reason: kind === 'unconfirmed' ? 'email_not_confirmed_7_days' : 'declined_30_days' } });
        return del.prefixes;
      });
      if (prefixes) {
        did++;
        await removeStoredPrefixes(prefixes);
      }
    }
    n += did;
    if (did === 0) return n;
  }
}

/** Logo files that were uploaded but never became a logo (or were replaced): removed after 7 days. */
async function deleteUnusedLogos(): Promise<number> {
  const rows = await tx(SYSTEM, (c) =>
    many<{ id: string; storage_prefix: string | null }>(
      c,
      `SELECT f.id, f.storage_prefix FROM files f
        WHERE f.purpose = 'logo' AND f.created_at < now() - interval '7 days'
          AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.logo_file_id = f.id)
          AND NOT EXISTS (SELECT 1 FROM brands b WHERE b.logo_file_id = f.id)
        LIMIT 500`,
    ),
  );
  let n = 0;
  for (const r of rows) {
    const gone = await tx(SYSTEM, async (c) => {
      const d = await c.query(
        `DELETE FROM files f WHERE f.id = $1 AND f.purpose = 'logo'
           AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.logo_file_id = f.id) AND NOT EXISTS (SELECT 1 FROM brands b WHERE b.logo_file_id = f.id)`,
        [r.id],
      );
      return (d.rowCount ?? 0) > 0;
    });
    if (!gone) continue;
    n++;
    if (r.storage_prefix) await deleteStored([r.storage_prefix]);
  }
  return n;
}

async function cleanTables(): Promise<Pick<RetentionReport, 'sessions' | 'userTokens' | 'oidcFlows' | 'notifications' | 'mesEvents' | 'devMailbox' | 'jobs' | 'webhookDeliveries' | 'emailNotices' | 'signupRecords'>> {
  return tx(SYSTEM, async (c) => {
    const del = async (sql: string) => (await c.query(sql)).rowCount ?? 0;
    const hasWebhooks = !!(await one<{ r: string | null }>(c, `SELECT to_regclass('public.webhook_deliveries') AS r`))?.r;
    return {
      sessions: await del(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`),
      userTokens: await del(`DELETE FROM user_tokens WHERE expires_at < now() - interval '30 days'`),
      oidcFlows: await del(`DELETE FROM oidc_flows WHERE expires_at < now() - interval '1 day'`),
      notifications: await del(`DELETE FROM notifications WHERE created_at < now() - interval '180 days'`),
      mesEvents: await del(`DELETE FROM mes_events WHERE received_at < now() - interval '180 days'`),
      devMailbox: await del(`DELETE FROM dev_mailbox WHERE created_at < now() - interval '14 days'`),
      jobs: await del(`DELETE FROM jobs WHERE status IN ('done', 'failed') AND finished_at < now() - interval '14 days'`),
      signupRecords: (await del(`DELETE FROM signup_attempts WHERE at < now() - interval '2 days'`)) + (await del(`DELETE FROM signup_mail_log WHERE sent_at < now() - interval '1 day'`)),
      emailNotices: await del(`DELETE FROM email_notice_log WHERE sent_at < now() - interval '2 days'`),
      webhookDeliveries: hasWebhooks ? await del(`DELETE FROM webhook_deliveries WHERE created_at < now() - interval '90 days'`) : 0,
    };
  });
}

export async function runRetention(): Promise<RetentionReport> {
  const casesPurged = await purgeDueCases();
  const orphanObjectsRemoved = await sweepOrphans();
  const draftsDeleted = await deleteOldDrafts();
  const abandonedUploads = await deleteAbandonedUploads();
  const unconfirmedRegistrations = await deleteExpiredRegistrations('unconfirmed');
  const declinedRegistrations = await deleteExpiredRegistrations('declined');
  const unusedLogos = await deleteUnusedLogos();
  const casesScrubbed = await scrubPurgedCases();
  const transfersHeld = await recheckTransfers();
  const emailJobsScrubbed = await scrubOldEmailJobs();
  const tables = await cleanTables();
  const report: RetentionReport = { casesPurged, draftsDeleted, abandonedUploads, orphanObjectsRemoved, unconfirmedRegistrations, declinedRegistrations, unusedLogos, casesScrubbed, transfersHeld, emailJobsScrubbed, ...tables };
  await tx(SYSTEM, (c) =>
    c.query(
      `INSERT INTO job_runs (name, last_run_at, last_status, last_detail) VALUES ('retention', now(), 'ok', $1::jsonb)
       ON CONFLICT (name) DO UPDATE SET last_run_at = now(), last_status = 'ok', last_detail = EXCLUDED.last_detail`,
      [JSON.stringify(report)],
    ),
  );
  return report;
}

/**
 * Claims the daily slot. Returns true for exactly one caller per 24 hours (safe with several workers).
 * The slot is claimed by moving last_run_at; the job itself sets the final status.
 */
export async function claimDailyRetention(c: PoolClient): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO job_runs (name, last_run_at, last_status) VALUES ('retention', now(), 'queued')
     ON CONFLICT (name) DO UPDATE SET last_run_at = now(), last_status = 'queued' WHERE job_runs.last_run_at < now() - interval '24 hours'
     RETURNING name`,
  );
  return (r.rowCount ?? 0) > 0;
}

registerJob('retention', async () => {
  await runRetention();
});
