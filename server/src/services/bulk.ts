import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { many, one, tx, type DbCtx } from '../db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../http/errors';
import { enqueue } from '../jobs';
import { NAME_MAX } from '../../../shared/bulk';
import { CASE_ID_ALPHABET, CASE_ID_MAX, caseIdRuleProblem } from '../../../shared/filenames';
import { assertCaseAddress } from './org';
import { CASE_SELECT, INSTRUCTIONS_MAX, actorOf, caseDto, insertCase, refreshBatch } from './cases';

export interface BulkEntryInput {
  key: string;
  patientId: string;
  firstName: string;
  lastName: string;
  instructions?: string | null;
}

export interface BulkEntryResult {
  key: string;
  id?: string;
  ref?: string;
  caseId?: string;
  error?: string;
  message?: string;
}

const clean = (s: string) => s.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();

/** Mandatory data rules for one direct manufacturing case. Returns the cleaned values or an error. */
export function validateBulkEntry(e: BulkEntryInput): { ok: true; patientId: string; first: string; last: string } | { ok: false; error: string; message: string } {
  const patientId = clean(e.patientId ?? '');
  const first = clean(e.firstName ?? '');
  const last = clean(e.lastName ?? '');
  if (!patientId) return { ok: false, error: 'patient_id_required', message: 'Patient ID is missing.' };
  if (patientId.length > CASE_ID_MAX || !CASE_ID_ALPHABET.test(patientId)) {
    return { ok: false, error: 'invalid_patient_id', message: `Patient ID may use letters, digits, spaces and _ . / # - only, up to ${CASE_ID_MAX} characters.` };
  }
  if (caseIdRuleProblem(patientId)) {
    return { ok: false, error: 'invalid_patient_id', message: 'Patient ID cannot have two dots in a row, and cannot start or end with a dot or a slash.' };
  }
  if (!first) return { ok: false, error: 'first_name_required', message: 'Patient first name is missing.' };
  if (!last) return { ok: false, error: 'last_name_required', message: 'Patient last name is missing.' };
  if (first.length > NAME_MAX || last.length > NAME_MAX) return { ok: false, error: 'name_too_long', message: `Names can be at most ${NAME_MAX} characters.` };
  if (e.instructions && e.instructions.length > INSTRUCTIONS_MAX) return { ok: false, error: 'instructions_too_long', message: `Instructions can be at most ${INSTRUCTIONS_MAX.toLocaleString('en-GB')} characters.` };
  return { ok: true, patientId, first, last };
}

export async function createBatch(
  ctx: DbCtx,
  a: AuthContext,
  input: { cases: BulkEntryInput[]; brandId?: string | null; priority?: 'normal' | 'rush'; submitWhenClean?: boolean },
  req?: { ip?: string; headers?: Record<string, any> },
): Promise<{ batchId: string | null; cases: BulkEntryResult[] }> {
  if (a.orgKind !== 'partner') throw forbidden('Bulk intake is for partner organisations.');
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    // Early gate: the portal keeps a shipping address on every direct case, so say so before the partner uploads gigabytes of files.
    await assertCaseAddress(c, a.orgId, a.userId);
    if (input.brandId) {
      const b = await one(c, 'SELECT 1 FROM brands WHERE id = $1 AND org_id = $2', [input.brandId, a.orgId]);
      if (!b) throw badRequest('That brand does not exist.', 'invalid_brand');
    }
    const batch = await one<{ id: string }>(
      c,
      `INSERT INTO bulk_batches (org_id, created_by, submit_when_clean, priority) VALUES ($1, $2, $3, $4) RETURNING id`,
      [a.orgId, a.userId, !!input.submitWhenClean, input.priority ?? 'normal'],
    );
    const batchId = batch!.id;
    const results: BulkEntryResult[] = [];
    let created = 0;
    for (const e of input.cases) {
      const v = validateBulkEntry(e);
      if (!v.ok) {
        results.push({ key: e.key, error: v.error, message: v.message });
        continue;
      }
      await c.query('SAVEPOINT bulk_entry');
      try {
        const r = await insertCase(c, {
          orgId: a.orgId, actor, mode: 'direct', caseId: v.patientId, firstName: v.first, lastName: v.last, brandId: input.brandId, priority: input.priority,
          instructions: e.instructions || null, batchId,
        });
        await c.query('RELEASE SAVEPOINT bulk_entry');
        created++;
        results.push({ key: e.key, id: r.id, ref: r.ref, caseId: v.patientId });
      } catch (err: any) {
        await c.query('ROLLBACK TO SAVEPOINT bulk_entry');
        if (err instanceof AppError) {
          results.push({ key: e.key, error: err.code, message: err.message });
          continue;
        }
        throw err;
      }
    }
    if (created === 0) {
      await c.query('DELETE FROM bulk_batches WHERE id = $1', [batchId]);
      return { batchId: null, cases: results };
    }
    await refreshBatch(c, batchId);
    await audit(c, {
      actorType: actor.actorType, actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: a.orgId, action: 'bulk.batch_created', targetType: 'bulk_batch', targetId: batchId,
      details: { requested: input.cases.length, created },
    });
    return { batchId, cases: results };
  });
}

export async function getBatch(ctx: DbCtx, id: string) {
  return tx(ctx, async (c) => {
    const b = await one<any>(c, 'SELECT id, org_id, status, case_count, submit_when_clean, priority, created_at FROM bulk_batches WHERE id = $1', [id]);
    if (!b) throw notFound('That batch could not be found.');
    const rows = await many<any>(c, `${CASE_SELECT} WHERE c.bulk_batch_id = $1 ORDER BY c.created_at, c.id`, [id]);
    return {
      batch: { id: b.id, status: b.status, caseCount: b.case_count, submitWhenClean: b.submit_when_clean, priority: b.priority, createdAt: b.created_at instanceof Date ? b.created_at.toISOString() : b.created_at },
      cases: rows.map(caseDto),
    };
  });
}

/** Re-queues a direct case whose push to the portal failed. */
export async function retryPortalPush(ctx: DbCtx, a: AuthContext, id: string, req?: { ip?: string; headers?: Record<string, any> }) {
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await one<any>(c, 'SELECT id, org_id, ref, status, manufacturing_mode, portal_push FROM cases WHERE id = $1 FOR UPDATE', [id]);
    if (!row) throw notFound('That case could not be found.');
    if (row.manufacturing_mode !== 'direct') throw conflict('Only direct manufacturing cases are sent to the K Line portal.', 'not_direct');
    if (row.portal_push?.status !== 'failed') throw conflict('This case is not waiting for a retry.', 'not_failed');
    if (!['submitted', 'ready'].includes(row.status)) throw conflict('This case is no longer waiting to be sent.', 'case_not_open');
    await c.query(`UPDATE cases SET portal_push = portal_push || jsonb_build_object('status', 'pending'), updated_at = now() WHERE id = $1`, [id]);
    await enqueue(c, 'bulk.push', { caseId: id }, { orgId: row.org_id, maxAttempts: 5 });
    await audit(c, { actorType: actor.actorType, actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: row.org_id, action: 'case.portal_retry', targetType: 'case', targetId: id, details: { ref: row.ref } });
    return { ok: true, portal: { status: 'pending' } };
  });
}
