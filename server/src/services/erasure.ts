import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { many, tx, type DbCtx } from '../db';
import { AppError, conflict, notFound } from '../http/errors';
import { actorOf, loadCase } from './cases';
import { notifyKline, notifyOrg } from './notify';
import { removePurgedObjects, wipeCaseData } from './retention';
import { emitCaseWebhook } from './webhooks';

/** The sentence every direct manufacturing erasure carries: the K Line customer portal keeps a copy that the Hub cannot remove. */
export const PORTAL_COPY_NOTICE = 'The K Line portal keeps its own copy. Ask K Line to remove it there.';

export interface EraseResult {
  ok: true;
  ref: string;
  filesRemoved: number;
  /** True for a direct manufacturing case that was sent to the K Line customer portal: the portal holds its own copy. */
  portalCopyRemains: boolean;
  message: string;
}

/**
 * Erasure on request (BRIEF section 19, permission `case.erase`). Removes the case's files and the patient data now, by the same code path as the
 * retention purge (wipeCaseData), and keeps only the non identifying production record: reference, status, stage, dates, aligner counts, site,
 * carrier and tracking, file measurements and the case events without free text. The partner case ID goes too, whatever the case type, because a case
 * ID can hold a name. Follow up cases (replacement or rework) keep their own copy of the name and are not touched; their stored bytes stay while
 * a live file of such a case still uses them.
 *
 * Partners erase their own organisation's cases (another organisation's case reads as not found). K Line administrators can erase any case.
 * Drafts are deleted instead; a case that is already purged or erased answers `already_erased`.
 * Nothing in the event, the audit entry, the notifications or the answer holds patient data.
 */
export async function eraseCase(ctx: DbCtx, a: AuthContext, id: string, confirmRef: string, req?: { ip?: string; headers?: Record<string, any> }): Promise<EraseResult> {
  const actor = actorOf(a, req);
  const done = await tx(ctx, async (c) => {
    const row = await loadCase(c, id, true, a);
    if (a.orgKind === 'partner' && row.org_id !== a.orgId) throw notFound('That case could not be found.');
    if (row.purged_at) throw conflict('The data of this case was already removed.', 'already_erased');
    if (row.status === 'draft') throw conflict('A draft is deleted instead of erased. Use Delete draft.', 'use_delete_for_drafts');
    if (confirmRef.trim().toLowerCase() !== String(row.ref).toLowerCase()) throw new AppError(400, 'confirmation_mismatch', 'Type the case reference to confirm.');

    const direct = row.manufacturing_mode === 'direct';
    const push = row.portal_push ?? {};
    // The portal has its own copy once the case was created there (even if the push is not finished).
    const portalCopyRemains = direct && (!!row.portal_case_uuid || ['pushed', 'pushing'].includes(String(push.status ?? '')));
    const byKline = a.orgKind === 'kline';

    const w = await wipeCaseData(c, id, { partnerCaseId: 'always' });
    if (!w.done) throw conflict('The data of this case was already removed.', 'already_erased');

    const data = { files: w.fileIds.length, byKline, ...(direct ? { portalCopyRemains } : {}) };
    await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data) VALUES ($1, $2, 'erased', $3, $4, $5::jsonb)`, [
      row.org_id, id, actor.actorType, actor.actorId, JSON.stringify(data),
    ]);
    await audit(c, {
      actorType: actor.actorType, actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: row.org_id, action: 'case.erased', targetType: 'case', targetId: id,
      details: { ref: row.ref, mode: row.manufacturing_mode, status: row.status, files: w.fileIds.length, byKline, portalCopyRemains },
    });

    // In app notice to the organisation's administrators (reference only). K Line intake hears too when the factory may be working on the case.
    const admins = await many<{ id: string }>(c, `SELECT id FROM users WHERE org_id = $1 AND status = 'active' AND 'admin' = ANY(roles)`, [row.org_id]);
    for (const u of admins) {
      await notifyOrg(c, { orgId: row.org_id, userId: u.id, kind: 'case_erased', title: 'Case data erased', body: `Case ${row.ref}`, data: { caseId: id, ref: row.ref } });
    }
    if (!byKline && ['ready', 'received', 'in_production'].includes(row.status)) {
      await notifyKline(c, row.org_id, { kind: 'case_erased', title: 'Case data erased by the partner', body: `Case ${row.ref}`, data: { caseId: id, ref: row.ref } });
    }
    // Not a subscribable webhook event (partners cannot subscribe to it); the internal hook is still called so that it can become one later.
    await emitCaseWebhook(c, id, 'case.erased', { status: row.status });
    return { ref: row.ref as string, prefixes: w.prefixes, fileIds: w.fileIds, portalCopyRemains };
  });

  // After the commit: the stored objects. The key material is already gone, so a failure here leaves nothing readable; the next retention run retries.
  await removePurgedObjects(done);

  const message = `The case data was erased. The production record (reference, status and dates) stays.${done.portalCopyRemains ? ' ' + PORTAL_COPY_NOTICE : ''}`;
  return { ok: true, ref: done.ref, filesRemoved: done.fileIds.length, portalCopyRemains: done.portalCopyRemains, message };
}

