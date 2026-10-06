import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { many, one, tx, type DbCtx, type PoolClient } from '../db';
import { decryptField, encryptField, fieldAad } from '../crypto/keys';
import { badRequest, conflict, forbidden } from '../http/errors';
import { enqueue } from '../jobs';
import { CASE_ID_MAX } from '../../../shared/filenames';
import { CASE_SELECT, actorOf, addBusinessDays, caseDto, loadCase, patientOf, resolveRouting, type Actor } from './cases';
import { recomputeCase } from './checks';
import { FILE_COLUMNS, fileName } from './files';
import { orgUploadState } from './org';
import type { RequestedItem } from './requested';
import { emitCaseWebhook } from './webhooks';

type Req = { ip?: string; headers?: Record<string, any> };

/**
 * Child cases (BRIEF sections 9 and 14): a replacement order placed by the partner, or a rush rework case created when a
 * quality claim ends in a remake. The child holds a copy of each of its parent's ready files that points at the same
 * stored (encrypted) bytes, so nothing is uploaded again. Only the requested aligners' files are required.
 */
export interface ChildInput {
  parentId: string;
  kind: 'replacement' | 'rework';
  items: RequestedItem[];
  priority: 'normal' | 'rush';
  claim?: { id: string; number: string };
  reason?: string | null;
  actor: Actor;
  userId: string | null;
}

export const REPLACEMENT_REASON_MAX = 500;

/** Aligner models of a case (ready STL files) as request keys. */
export async function alignersOf(c: PoolClient, caseId: string): Promise<Set<string>> {
  const rows = await many<{ arch: string; step: number; is_template: boolean }>(
    c,
    `SELECT DISTINCT arch, step, is_template FROM files WHERE case_id = $1 AND purpose = 'case' AND kind = 'stl' AND state = 'ready' AND arch IS NOT NULL AND step IS NOT NULL`,
    [caseId],
  );
  return new Set(rows.map((r) => itemKey(r.arch, r.step, r.is_template)));
}
export const itemKey = (arch: string, step: number, template: boolean) => `${arch}|${step}|${template ? 'T' : 'A'}`;

/** Removes repeated aligners, keeping the first entry. */
export function dedupeItems(items: RequestedItem[]): RequestedItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = itemKey(i.arch, i.step, i.template);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function createChildCase(c: PoolClient, input: ChildInput): Promise<{ id: string; ref: string; status: string }> {
  const parent = await loadCase(c, input.parentId, true);
  if (parent.purged_at) throw conflict('The files of this case are no longer stored, so it cannot be made again.', 'files_unavailable');
  const files = await many<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.case_id = $1 AND f.purpose = 'case' AND f.state = 'ready' ORDER BY f.created_at, f.id`, [parent.id]);
  if (!files.some((f) => f.kind === 'stl')) throw conflict('The files of this case are no longer stored, so it cannot be made again.', 'files_unavailable');
  const have = await alignersOf(c, parent.id);
  const items = dedupeItems(input.items);
  if (!items.length) throw badRequest('Choose at least one aligner.', 'items_required');
  for (const i of items) if (!have.has(itemKey(i.arch, i.step, i.template))) throw conflict('One of the aligners is not part of this case.', 'unknown_aligner');

  const routing = await resolveRouting(c, parent.org_id, false);
  const site = routing.manual ? null : routing.site;
  const ready = !!site;
  const now = new Date();
  const id = randomUUID();
  const code = (await one<{ code: string | null }>(c, 'SELECT code FROM organizations WHERE id = $1', [parent.org_id]))?.code ?? 'CASE';
  const n = await one<{ n: number }>(c, 'SELECT kph_next_counter($1) AS n', [`case:${code}`]);
  const ref = `${code}-${String(n!.n).padStart(6, '0')}`;

  // Patient name and instructions are field encrypted per case, so they are re-encrypted for the child.
  const full = patientOf(parent).full;
  let notes = '';
  if (parent.notes_enc) {
    try {
      notes = decryptField(parent.notes_enc, fieldAad.caseNotes(parent.id));
    } catch {
      notes = '';
    }
  }
  const lead =
    input.kind === 'rework'
      ? `Rework order for quality claim ${input.claim?.number ?? ''}.`.replace(' .', '.')
      : `Replacement order.${input.reason ? ' Reason: ' + input.reason : ''}`;
  const childNotes = [lead, notes].filter(Boolean).join('\n\n');

  const spec = await one<{ id: string }>(c, `SELECT id FROM specs WHERE org_id = $1 AND status = 'active'`, [parent.org_id]);
  const slaDays = routing.slaDays;
  await c.query(
    `INSERT INTO cases (id, org_id, ref, partner_case_id, patient_enc, patient_bidx, patient_bidxs, brand_id, kind, parent_id, status, site_id, spec_id, notes_enc, priority, due_date,
                        checks, warnings_acknowledged, warnings_acknowledged_at, manufacturing_mode, submitted_at, ready_at, requested_items, claim_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, 'standard', now(), $20, $21::jsonb, $22, $23)`,
    [
      id, parent.org_id, ref, parent.partner_case_id ? String(parent.partner_case_id).slice(0, CASE_ID_MAX) : null,
      full ? encryptField(full, fieldAad.casePatient(id)) : null, full ? parent.patient_bidx : null, full ? parent.patient_bidxs ?? [] : [],
      parent.brand_id, input.kind, parent.id, ready ? 'ready' : 'submitted', site?.id ?? null, spec?.id ?? parent.spec_id ?? null,
      childNotes ? encryptField(childNotes, fieldAad.caseNotes(id)) : null, input.priority, ready ? addBusinessDays(now, slaDays) : null,
      JSON.stringify(parent.checks ?? { errors: [], warnings: [] }), parent.warnings_acknowledged, parent.warnings_acknowledged_at,
      ready ? now : null, JSON.stringify(items), input.claim?.id ?? null, input.userId,
    ],
  );

  // Copy the file rows. The stored bytes stay where they are and remain bound to the original file id.
  for (const f of files) {
    const fid = randomUUID();
    await c.query(
      `INSERT INTO files (id, org_id, purpose, case_id, kind, arch, step, is_template, name_enc, ext, content_type, size, chunk_size, chunk_count, wrapped_key, key_id, nonce_prefix,
                          storage_prefix, cipher_file_id, state, scan_status, validation, meta, uploader_id, created_at, uploaded_at, processed_at)
       VALUES ($1, $2, 'case', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'ready', $19, $20::jsonb, $21::jsonb, $22, $23, now(), now())`,
      [
        fid, f.org_id, id, f.kind, f.arch, f.step, f.is_template, encryptField(fileName(f), fieldAad.fileName(fid)), f.ext, f.content_type, f.size, f.chunk_size, f.chunk_count,
        f.wrapped_key, f.key_id, f.nonce_prefix, f.storage_prefix, f.cipher_file_id ?? f.id, f.scan_status, JSON.stringify(f.validation ?? {}), JSON.stringify(f.meta ?? {}), input.userId, f.created_at,
      ],
    );
  }
  await recomputeCase(c, id);

  const eventType = input.kind === 'rework' ? 'rework_ordered' : 'replacement_ordered';
  await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data, created_at) VALUES ($1, $2, 'created', $3, $4, $5::jsonb, clock_timestamp())`, [
    parent.org_id, id, input.actor.actorType, input.actor.actorId, JSON.stringify({ mode: 'standard', kind: input.kind, parentRef: parent.ref, ...(input.claim ? { claimNumber: input.claim.number } : {}) }),
  ]);
  await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data, created_at) VALUES ($1, $2, 'submitted', $3, $4, $5::jsonb, clock_timestamp())`, [
    parent.org_id, id, input.actor.actorType, input.actor.actorId, JSON.stringify({ status: ready ? 'ready' : 'submitted', site: site?.code ?? null, kind: input.kind, items: items.length }),
  ]);
  await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [
    parent.org_id, parent.id, eventType, input.actor.actorType, input.actor.actorId,
    JSON.stringify({ childRef: ref, items: items.length, ...(input.claim ? { claimNumber: input.claim.number } : {}) }),
  ]);
  await audit(c, {
    actorType: input.actor.actorType, actorId: input.actor.actorId, ip: input.actor.ip, userAgent: input.actor.userAgent, orgId: parent.org_id,
    action: input.kind === 'rework' ? 'case.rework_ordered' : 'case.replacement_ordered', targetType: 'case', targetId: id,
    details: { ref, parentRef: parent.ref, items: items.length, ...(input.claim ? { claimNumber: input.claim.number } : {}) },
  });
  if (!ready) await enqueue(c, 'notify.kline', { kind: 'case_submitted', caseId: id }, { orgId: parent.org_id });
  // A replacement or rework order is a submitted case like any other.
  await emitCaseWebhook(c, id, 'case.submitted');
  if (ready) await emitCaseWebhook(c, id, 'case.ready', { site: site!.code });
  return { id, ref, status: ready ? 'ready' : 'submitted' };
}

/** Partner: order a replacement for aligners of a shipped or delivered case. */
export async function orderReplacement(
  ctx: DbCtx,
  a: AuthContext,
  parentId: string,
  input: { items: { arch: 'upper' | 'lower'; step: number; template?: boolean }[]; reason?: string },
  req?: Req,
) {
  if (a.orgKind !== 'partner') throw forbidden('Replacement orders are placed by partner organisations.');
  const reason = (input.reason ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (reason.length > REPLACEMENT_REASON_MAX) throw badRequest(`The reason can be at most ${REPLACEMENT_REASON_MAX} characters.`, 'reason_too_long');
  const items: RequestedItem[] = input.items.map((i) => ({ arch: i.arch, step: i.step, template: !!i.template }));
  return tx(ctx, async (c) => {
    const parent = await loadCase(c, parentId, true, a);
    if (parent.manufacturing_mode !== 'standard') throw conflict('Replacements for direct manufacturing cases are arranged with K Line.', 'direct_case');
    if (!['shipped', 'delivered'].includes(parent.status)) throw conflict('A replacement can be ordered once the case has shipped.', 'case_not_replaceable');
    const up = await orgUploadState(c, parent.org_id);
    if (!up.unlocked) throw forbidden('Your organisation must be approved with a data processing agreement on file before cases can be ordered.', 'org_not_approved');
    const child = await createChildCase(c, {
      parentId, kind: 'replacement', items, priority: 'normal', reason: reason || null, actor: actorOf(a, req), userId: a.userId,
    });
    return { case: caseDto(await one<any>(c, `${CASE_SELECT} WHERE c.id = $1`, [child.id])) };
  });
}
