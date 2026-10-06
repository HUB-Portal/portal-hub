import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { many, one, tx, type DbCtx, type PoolClient } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { assertNoBidi } from '../http/util';
import { CLAIM_RESOLUTIONS, CLAIM_STATUSES, CLAIMABLE_CASE_STATUSES, DEFECT_CODES, OPEN_CLAIM_STATUSES, defectLabel, type ClaimResolution } from '../../../shared/defects';
import { actorOf, loadCase, type Actor } from './cases';
import { createChildCase, alignersOf, dedupeItems, itemKey } from './childCases';
import { FILE_COLUMNS, fileDto } from './files';
import { notifyKline, notifyOrg } from './notify';
import { scopeCondition, siteScope } from './scope';
import { specContentById } from './specs';
import { emitClaimWebhook } from './webhooks';
import { clausesOf } from '../../../shared/spec';
import type { RequestedItem } from './requested';

type Req = { ip?: string; headers?: Record<string, any> };

export const CLAIM_LIMITS = { summaryMin: 3, summaryMax: 200, descriptionMax: 4000, itemNoteMax: 500, maxItems: 100, maxClauses: 20, messageMax: 4000, textMax: 2000, noteMax: 2000 } as const;

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? null);

const CLAIM_SELECT = `SELECT cl.*, cs.ref AS case_ref, cs.kind AS case_kind, cs.status AS case_status, cs.spec_id AS case_spec_id, cs.site_id AS case_site_id,
    o.name AS org_name, o.code AS org_code, rw.ref AS rework_ref, u.name AS opened_by_name,
    (SELECT count(*)::int FROM claim_items i WHERE i.claim_id = cl.id) AS item_count,
    (SELECT count(*)::int FROM files f WHERE f.claim_id = cl.id AND f.state <> 'purged') AS evidence_count
  FROM claims cl JOIN cases cs ON cs.id = cl.case_id JOIN organizations o ON o.id = cl.org_id
  LEFT JOIN cases rw ON rw.id = cl.rework_case_id LEFT JOIN users u ON u.id = cl.opened_by`;

export function claimDto(row: any) {
  return {
    id: row.id as string,
    number: row.number as string,
    status: row.status as string,
    resolution: (row.resolution as string | null) ?? null,
    summary: row.summary as string,
    description: (row.description as string | null) ?? null,
    specClauseIds: (row.spec_clause_ids as string[]) ?? [],
    rootCause: row.root_cause ?? null,
    correctiveAction: row.corrective_action ?? null,
    decisionNote: row.decision_note ?? null,
    caseId: row.case_id as string,
    caseRef: row.case_ref as string,
    caseKind: row.case_kind as string,
    caseStatus: row.case_status as string,
    orgId: row.org_id as string,
    orgName: row.org_name as string,
    orgCode: (row.org_code as string | null) ?? null,
    reworkCaseId: row.rework_case_id ?? null,
    reworkCaseRef: row.rework_ref ?? null,
    openedByName: row.opened_by_name ?? null,
    itemCount: row.item_count ?? 0,
    evidenceCount: row.evidence_count ?? 0,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    decidedAt: iso(row.decided_at),
    closedAt: iso(row.closed_at),
  };
}

/** Loads a claim (partners only ever see their own through row level security; production staff only their sites). */
async function loadClaim(c: PoolClient, id: string, a: AuthContext, lock = false): Promise<any> {
  const row = await one<any>(c, `${CLAIM_SELECT} WHERE cl.id = $1${lock ? ' FOR UPDATE OF cl' : ''}`, [id]);
  if (!row) throw notFound('That claim could not be found.');
  const sc = siteScope(a);
  if (sc && (!row.case_site_id || !sc.includes(row.case_site_id))) throw notFound('That claim could not be found.');
  return row;
}

const auditClaim = (c: PoolClient, actor: Actor, orgId: string, action: string, claimId: string, details: Record<string, unknown> = {}) =>
  audit(c, { actorType: actor.actorType, actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId, action, targetType: 'claim', targetId: claimId, details });

async function addMessage(c: PoolClient, row: { id: string; org_id: string }, side: 'partner' | 'kline' | 'system', authorId: string | null, body: string) {
  const m = await one<any>(
    c,
    // clock_timestamp so messages written in one transaction keep their order
    `INSERT INTO claim_messages (org_id, claim_id, author_id, side, body, created_at) VALUES ($1, $2, $3, $4, $5, clock_timestamp()) RETURNING id, created_at`,
    [row.org_id, row.id, authorId, side, body],
  );
  return m!;
}

/** In app notification for the other side. Claim number and case reference only: no patient data, no free text. */
async function notifyClaim(c: PoolClient, to: 'partner' | 'kline', row: any, n: { kind: string; title: string }): Promise<void> {
  const p = {
    kind: n.kind, title: n.title, body: `Claim ${row.number}, case ${row.case_ref}`,
    data: { claimId: row.id, number: row.number, caseId: row.case_id, ref: row.case_ref, orgId: row.org_id },
  };
  // K Line is told through a job (partner requests cannot write K Line rows); the partner is told at once.
  if (to === 'kline') await notifyKline(c, row.org_id, p);
  else await notifyOrg(c, { orgId: row.org_id, ...p });
}

function cleanText(v: string | null | undefined, max: number): string | null {
  assertNoBidi(v); // hidden text direction characters are refused in every text of a claim
  const t = (v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\r\n/g, '\n').trim();
  return t ? t.slice(0, max) : null;
}

// ---------------------------------------------------------------------------
// Open a claim
// ---------------------------------------------------------------------------
export interface OpenClaimInput {
  caseId: string;
  summary: string;
  description?: string;
  specClauseIds?: string[];
  items: { arch: 'upper' | 'lower'; step: number; template?: boolean; defectCode: string; note?: string }[];
}

export async function openClaim(ctx: DbCtx, a: AuthContext, input: OpenClaimInput, req?: Req) {
  if (a.orgKind !== 'partner' || a.kind !== 'user') throw forbidden('Quality claims are raised by people in the partner organisation.');
  const summary = cleanText(input.summary, CLAIM_LIMITS.summaryMax);
  if (!summary || summary.length < CLAIM_LIMITS.summaryMin) throw badRequest('Give the claim a short summary.', 'summary_required');
  if (!input.items.length) throw badRequest('Choose at least one aligner and say what is wrong with it.', 'items_required');
  for (const i of input.items) if (!(DEFECT_CODES as readonly string[]).includes(i.defectCode)) throw badRequest('One of the defect types is not known.', 'invalid_defect');
  // The same aligner with the same defect cannot be listed twice in one claim.
  const seen = new Set<string>();
  for (const i of input.items) {
    const k = itemKey(i.arch, i.step, !!i.template) + '|' + i.defectCode;
    if (seen.has(k)) throw badRequest('The same aligner and defect is listed more than once. List each one once.', 'duplicate_item');
    seen.add(k);
  }
  for (const i of input.items) assertNoBidi(i.note);
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const cs = await loadCase(c, input.caseId, false, a);
    if (!(CLAIMABLE_CASE_STATUSES as readonly string[]).includes(cs.status)) {
      throw conflict('A claim can be raised once a case has reached the factory.', 'case_not_claimable');
    }
    if (cs.purged_at) throw conflict('The files of this case are no longer stored, so a claim cannot be raised.', 'case_purged');
    const have = await alignersOf(c, cs.id);
    for (const i of input.items) if (!have.has(itemKey(i.arch, i.step, !!i.template))) throw conflict('One of the aligners is not part of this case.', 'unknown_aligner');

    const clauseIds = [...new Set((input.specClauseIds ?? []).map((x) => x.trim()).filter(Boolean))];
    if (clauseIds.length) {
      const spec = await specContentById(c, cs.spec_id);
      const known = new Set(spec ? clausesOf(spec).map((x) => x.id) : []);
      if (clauseIds.some((x) => !known.has(x))) throw badRequest('One of the specification clauses is not part of this case\'s specification.', 'unknown_clause');
    }

    const year = new Date().getUTCFullYear();
    const n = await one<{ n: number }>(c, 'SELECT kph_next_counter($1) AS n', [`claim:${year}`]);
    const number = `CLM-${year}-${String(n!.n).padStart(5, '0')}`;
    const ins = await one<{ id: string }>(
      c,
      `INSERT INTO claims (org_id, number, case_id, status, summary, description, spec_clause_ids, opened_by) VALUES ($1, $2, $3, 'open', $4, $5, $6, $7) RETURNING id`,
      [cs.org_id, number, cs.id, summary, cleanText(input.description, CLAIM_LIMITS.descriptionMax), clauseIds, a.userId],
    );
    const id = ins!.id;
    for (const [pos, i] of input.items.entries()) {
      await c.query(`INSERT INTO claim_items (org_id, claim_id, arch, step, is_template, defect_code, note, pos) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        cs.org_id, id, i.arch, i.step, !!i.template, i.defectCode, cleanText(i.note, CLAIM_LIMITS.itemNoteMax), pos,
      ]);
    }
    await addMessage(c, { id, org_id: cs.org_id }, 'system', null, 'Claim opened.');
    await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data) VALUES ($1, $2, 'claim_opened', $3, $4, $5::jsonb)`, [
      cs.org_id, cs.id, actor.actorType, actor.actorId, JSON.stringify({ claimNumber: number, items: input.items.length }),
    ]);
    const row = await loadClaim(c, id, a);
    await auditClaim(c, actor, cs.org_id, 'claim.opened', id, { number, ref: cs.ref, items: input.items.length });
    await notifyClaim(c, 'kline', row, { kind: 'claim_opened', title: 'New quality claim' });
    await emitClaimWebhook(c, id, 'claim.updated', { orgId: cs.org_id, number, status: 'open' });
    return detailOf(c, a, row);
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
export interface ClaimListQuery {
  status?: (typeof CLAIM_STATUSES)[number] | 'active';
  caseId?: string;
  orgId?: string;
  page: number;
  pageSize: number;
}

export async function listClaims(ctx: DbCtx, a: AuthContext, q: ClaimListQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (a.orgKind === 'partner') where.push(`cl.org_id = ${add(a.orgId)}`);
  else if (q.orgId) where.push(`cl.org_id = ${add(q.orgId)}`);
  const sc = scopeCondition(a, add, 'cs');
  if (sc) where.push(sc);
  if (q.status === 'active') where.push(`cl.status = ANY(${add([...OPEN_CLAIM_STATUSES])}::text[])`);
  else if (q.status) where.push(`cl.status = ${add(q.status)}`);
  if (q.caseId) where.push(`cl.case_id = ${add(q.caseId)}`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return tx(ctx, async (c) => {
    const total = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM claims cl JOIN cases cs ON cs.id = cl.case_id ${w}`, params);
    const rows = await many<any>(c, `${CLAIM_SELECT} ${w} ORDER BY cl.created_at DESC, cl.id LIMIT ${add(q.pageSize)} OFFSET ${add((q.page - 1) * q.pageSize)}`, params);
    return { items: rows.map(claimDto), total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
  });
}

async function detailOf(c: PoolClient, a: AuthContext, row: any) {
  const items = await many<any>(c, `SELECT id, arch, step, is_template, defect_code, note FROM claim_items WHERE claim_id = $1 ORDER BY pos, id`, [row.id]);
  const messages = await many<any>(
    c,
    `SELECT m.id, m.side, m.body, m.created_at, m.author_id, u.name AS author_name FROM claim_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.claim_id = $1 ORDER BY m.created_at, m.id`,
    [row.id],
  );
  const files = await many<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.claim_id = $1 AND f.state <> 'purged' ORDER BY f.created_at, f.id`, [row.id]);
  const spec = await specContentById(c, row.case_spec_id);
  const titles = new Map(spec ? clausesOf(spec).map((x) => [x.id, x.title]) : []);
  const viewerKline = a.orgKind === 'kline';
  return {
    claim: claimDto(row),
    items: items.map((i) => ({ id: i.id, arch: i.arch as string, step: i.step as number, template: i.is_template as boolean, defectCode: i.defect_code as string, defectLabel: defectLabel(i.defect_code), note: i.note ?? null })),
    messages: messages.map((m) => ({
      id: m.id as string,
      side: m.side as 'partner' | 'kline' | 'system',
      // Partners see "K Line" rather than the name of the person who wrote.
      authorName: m.side === 'system' ? null : m.side === 'kline' && !viewerKline ? 'K Line' : (m.author_name ?? null),
      body: m.body as string,
      createdAt: iso(m.created_at),
    })),
    evidence: files.map(fileDto),
    specClauses: (row.spec_clause_ids as string[]).map((id) => ({ id, title: titles.get(id) ?? null })),
  };
}

/** K Line staff opening a claim leave an entry in the partner's access log (at most one per person and claim every 10 minutes). */
async function auditViewOnce(c: PoolClient, a: AuthContext, row: any, actor: Actor): Promise<void> {
  const seen = await one(c, `SELECT 1 FROM audit_log WHERE action = 'claim.viewed' AND target_id = $1 AND actor_id = $2 AND at > now() - interval '10 minutes' LIMIT 1`, [row.id, actor.actorId]);
  if (!seen) await auditClaim(c, actor, row.org_id, 'claim.viewed', row.id, { number: row.number });
}

export async function getClaimDetail(ctx: DbCtx, a: AuthContext, id: string, req?: Req) {
  return tx(ctx, async (c) => {
    const row = await loadClaim(c, id, a);
    if (a.orgKind === 'kline') await auditViewOnce(c, a, row, actorOf(a, req));
    return detailOf(c, a, row);
  });
}

// ---------------------------------------------------------------------------
// Messages and status
// ---------------------------------------------------------------------------
export async function postMessage(ctx: DbCtx, a: AuthContext, id: string, body: string, req?: Req) {
  if (a.kind !== 'user') throw forbidden();
  const text = cleanText(body, CLAIM_LIMITS.messageMax);
  if (!text) throw badRequest('Write a message first.', 'message_required');
  const actor = actorOf(a, req);
  const side = a.orgKind === 'kline' ? 'kline' : 'partner';
  return tx(ctx, async (c) => {
    const row = await loadClaim(c, id, a, true);
    if (row.status === 'closed') throw conflict('This claim is closed.', 'claim_closed');
    const m = await addMessage(c, row, side, a.userId, text);
    let status = row.status as string;
    if (side === 'partner' && status === 'awaiting_partner') {
      status = 'in_review';
      await c.query(`UPDATE claims SET status = 'in_review', updated_at = now() WHERE id = $1`, [id]);
    } else {
      await c.query(`UPDATE claims SET updated_at = now() WHERE id = $1`, [id]);
    }
    await auditClaim(c, actor, row.org_id, 'claim.message', id, { number: row.number, side });
    await notifyClaim(c, side === 'partner' ? 'kline' : 'partner', row, { kind: 'claim_message', title: 'New message on a quality claim' });
    if (status !== row.status) await emitClaimWebhook(c, id, 'claim.updated', { orgId: row.org_id, number: row.number, status });
    return {
      message: { id: m.id as string, side, authorName: a.name, body: text, createdAt: iso(m.created_at) },
      status,
    };
  });
}

export async function setStatus(ctx: DbCtx, a: AuthContext, id: string, status: 'in_review' | 'awaiting_partner', req?: Req) {
  if (a.orgKind !== 'kline' || a.kind !== 'user') throw forbidden();
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await loadClaim(c, id, a, true);
    if (!(OPEN_CLAIM_STATUSES as readonly string[]).includes(row.status)) throw conflict('This claim has already been decided.', 'claim_decided');
    if (row.status === status) throw conflict('The claim already has that status.', 'status_unchanged');
    await c.query(`UPDATE claims SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
    await addMessage(c, row, 'system', null, status === 'in_review' ? 'K Line is looking into this claim.' : 'K Line is waiting for more information from you.');
    await auditClaim(c, actor, row.org_id, 'claim.status_changed', id, { number: row.number, from: row.status, to: status });
    await notifyClaim(c, 'partner', row, { kind: 'claim_status', title: status === 'in_review' ? 'Quality claim under review' : 'Quality claim needs your reply' });
    await emitClaimWebhook(c, id, 'claim.updated', { orgId: row.org_id, number: row.number, status });
    return { claim: claimDto(await loadClaim(c, id, a)) };
  });
}

// ---------------------------------------------------------------------------
// Decision and closing
// ---------------------------------------------------------------------------
export interface DecisionInput {
  decision: 'accepted' | 'rejected';
  resolution?: ClaimResolution;
  rootCause?: string;
  correctiveAction?: string;
  note?: string;
}

export async function decideClaim(ctx: DbCtx, a: AuthContext, id: string, input: DecisionInput, req?: Req) {
  if (a.orgKind !== 'kline' || a.kind !== 'user') throw forbidden();
  if (input.decision === 'accepted' && (!input.resolution || !(CLAIM_RESOLUTIONS as readonly string[]).includes(input.resolution))) {
    throw badRequest('Choose how the claim is resolved.', 'resolution_required');
  }
  const note = cleanText(input.note, CLAIM_LIMITS.noteMax);
  if (input.decision === 'rejected' && (!note || note.length < 3)) throw badRequest('Say why the claim is rejected.', 'note_required');
  const rootCause = cleanText(input.rootCause, CLAIM_LIMITS.textMax);
  const corrective = cleanText(input.correctiveAction, CLAIM_LIMITS.textMax);
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await loadClaim(c, id, a, true);
    if (!(OPEN_CLAIM_STATUSES as readonly string[]).includes(row.status)) throw conflict('This claim has already been decided.', 'claim_decided');
    const accepted = input.decision === 'accepted';
    const resolution = accepted ? input.resolution! : null;

    let rework: { id: string; ref: string; status: string } | null = null;
    if (accepted && resolution === 'remake') {
      const items = await many<any>(c, `SELECT arch, step, is_template, defect_code FROM claim_items WHERE claim_id = $1 ORDER BY pos, id`, [id]);
      const asItems: RequestedItem[] = dedupeItems(items.map((i) => ({ arch: i.arch, step: i.step, template: i.is_template, defectCode: i.defect_code })));
      rework = await createChildCase(c, { parentId: row.case_id, kind: 'rework', items: asItems, priority: 'rush', claim: { id, number: row.number }, actor, userId: a.userId });
    }
    await c.query(
      `UPDATE claims SET status = $2, resolution = $3, root_cause = $4, corrective_action = $5, decision_note = $6, rework_case_id = $7, decided_by = $8, decided_at = now(), updated_at = now() WHERE id = $1`,
      [id, input.decision, resolution, rootCause, corrective, note, rework?.id ?? null, a.userId],
    );
    await addMessage(
      c, row, 'system', null,
      accepted ? `Claim accepted. Resolution: ${resolution === 'no_action' ? 'no action needed' : resolution}.${rework ? ` A rush rework case ${rework.ref} has been created.` : ''}` : 'Claim rejected.',
    );
    if (note) await addMessage(c, row, 'kline', a.userId, note);
    await auditClaim(c, actor, row.org_id, accepted ? 'claim.accepted' : 'claim.rejected', id, { number: row.number, resolution, reworkRef: rework?.ref ?? null });
    await notifyClaim(c, 'partner', row, { kind: 'claim_decision', title: accepted ? 'Quality claim accepted' : 'Quality claim rejected' });
    await emitClaimWebhook(c, id, 'claim.updated', { orgId: row.org_id, number: row.number, status: input.decision, resolution });
    return detailOf(c, a, await loadClaim(c, id, a));
  });
}

export async function closeClaim(ctx: DbCtx, a: AuthContext, id: string, req?: Req) {
  if (a.orgKind !== 'kline' || a.kind !== 'user') throw forbidden();
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await loadClaim(c, id, a, true);
    if (row.status === 'closed') throw conflict('This claim is already closed.', 'claim_closed');
    if (!['accepted', 'rejected'].includes(row.status)) throw conflict('Decide the claim before closing it.', 'claim_not_decided');
    await c.query(`UPDATE claims SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1`, [id]);
    await addMessage(c, row, 'system', null, 'Claim closed.');
    await auditClaim(c, actor, row.org_id, 'claim.closed', id, { number: row.number, outcome: row.status });
    await notifyClaim(c, 'partner', row, { kind: 'claim_closed', title: 'Quality claim closed' });
    await emitClaimWebhook(c, id, 'claim.updated', { orgId: row.org_id, number: row.number, status: 'closed' });
    return { claim: claimDto(await loadClaim(c, id, a)) };
  });
}
