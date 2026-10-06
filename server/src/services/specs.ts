import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { many, one, tx, type DbCtx, type PoolClient } from '../db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../http/errors';
import { SPEC_LIMITS, defaultSpecContent, diffSpecs, hashSpec, parseSpecContent, type SpecContent } from '../../../shared/spec';
import { actorOf, type Actor } from './cases';
import { notifyKline, notifyOrg } from './notify';
import { emitSpecWebhook } from './webhooks';

type Req = { ip?: string; headers?: Record<string, any> };
type Side = 'partner' | 'kline';

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? null);
const sideOf = (a: AuthContext): Side => (a.orgKind === 'kline' ? 'kline' : 'partner');

/** Partners need spec.edit. K Line staff may also draft and propose with claim.decide (quality) or admin.partners. */
export function canEditSpecs(a: AuthContext): boolean {
  if (a.orgKind === 'partner') return a.permissions.has('spec.edit');
  return a.permissions.has('spec.edit') || a.permissions.has('claim.decide') || a.permissions.has('admin.partners');
}
function requireEditor(a: AuthContext): void {
  if (!canEditSpecs(a)) throw forbidden();
}

const auditSpec = (c: PoolClient, actor: Actor, orgId: string, action: string, specId: string, details: Record<string, unknown> = {}) =>
  audit(c, { actorType: actor.actorType, actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId, action, targetType: 'spec', targetId: specId, details });

export interface SpecActions {
  edit: boolean;
  delete: boolean;
  propose: boolean;
  sign: boolean;
  reject: boolean;
}

function actionsFor(row: any, a: AuthContext): SpecActions {
  const side = sideOf(a);
  const isDraftOwner = row.status === 'draft' && row.created_side === side && canEditSpecs(a);
  const canSign = a.permissions.has('spec.sign');
  const signed = side === 'partner' ? !!row.partner_signed_at : !!row.kline_signed_at;
  return {
    edit: isDraftOwner,
    delete: isDraftOwner,
    propose: isDraftOwner,
    sign: row.status === 'proposed' && canSign && !signed,
    reject: row.status === 'proposed' && canSign,
  };
}

/** Spec as the web app sees it. `content` is left out of list rows. */
export function specDto(row: any, a: AuthContext, withContent: boolean) {
  const sig = (name: string | null, at: any) => (at ? { name: name ?? '', signedAt: iso(at) } : null);
  return {
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name ?? null,
    version: row.version,
    status: row.status as string,
    title: row.title,
    changeNote: row.change_note ?? null,
    contentHash: row.content_hash ?? null,
    createdSide: row.created_side as Side,
    proposedAt: iso(row.proposed_at),
    partnerSignature: sig(row.partner_signed_name, row.partner_signed_at),
    klineSignature: sig(row.kline_signed_name, row.kline_signed_at),
    rejectionNote: row.rejection_note ?? null,
    rejectedAt: iso(row.rejected_at),
    activatedAt: iso(row.activated_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    actions: actionsFor(row, a),
    ...(withContent ? { content: row.content as SpecContent } : {}),
  };
}

const SPEC_SELECT = `SELECT s.*, o.name AS org_name FROM specs s JOIN organizations o ON o.id = s.org_id`;

/** The organisation a request is about: the caller's own for partners, an explicit partner for K Line staff. */
async function targetOrg(c: PoolClient, a: AuthContext, orgId: string | undefined): Promise<string> {
  if (a.orgKind === 'partner') return a.orgId;
  if (!orgId) throw badRequest('Say which partner this is for.', 'org_required');
  const o = await one<{ id: string; kind: string }>(c, 'SELECT id, kind FROM organizations WHERE id = $1', [orgId]);
  if (!o || o.kind !== 'partner') throw notFound('That partner could not be found.');
  return o.id;
}

/** Working drafts stay private to the side that started them until they are proposed. */
const draftHidden = (row: any, a: AuthContext) => row.status === 'draft' && row.created_side !== sideOf(a);

async function loadSpec(c: PoolClient, id: string, a: AuthContext, lock = false): Promise<any> {
  const row = await one<any>(c, `${SPEC_SELECT} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [id]);
  if (!row || draftHidden(row, a)) throw notFound('That specification could not be found.');
  return row;
}

export async function listSpecs(ctx: DbCtx, a: AuthContext, orgId?: string) {
  return tx(ctx, async (c) => {
    const org = await targetOrg(c, a, orgId);
    const rows = (await many<any>(c, `${SPEC_SELECT} WHERE s.org_id = $1 ORDER BY s.version DESC`, [org])).filter((r) => !draftHidden(r, a));
    return { items: rows.map((r) => specDto(r, a, false)), activeId: (rows.find((r) => r.status === 'active')?.id as string | undefined) ?? null };
  });
}

export async function getActiveSpec(ctx: DbCtx, a: AuthContext, orgId?: string) {
  return tx(ctx, async (c) => {
    const org = await targetOrg(c, a, orgId);
    const row = await one<any>(c, `${SPEC_SELECT} WHERE s.org_id = $1 AND s.status = 'active'`, [org]);
    return { spec: row ? specDto(row, a, true) : null };
  });
}

export async function getSpec(ctx: DbCtx, a: AuthContext, id: string) {
  return tx(ctx, async (c) => ({ spec: specDto(await loadSpec(c, id, a), a, true) }));
}

/** The default template and its hash, for starting a first specification. */
export async function defaultSpec() {
  const content = defaultSpecContent();
  return { content, contentHash: await hashSpec(content) };
}

/** K Line overview: every partner with the state of its specification. */
export async function partnerSpecSummaries(ctx: DbCtx) {
  return tx(ctx, async (c) => {
    const rows = await many<any>(
      c,
      `SELECT o.id, o.name, o.code, o.status AS org_status,
              act.id AS active_id, act.version AS active_version, act.activated_at,
              pr.id AS proposed_id, pr.version AS proposed_version, pr.partner_signed_at AS pr_partner, pr.kline_signed_at AS pr_kline,
              (SELECT count(*)::int FROM specs d WHERE d.org_id = o.id AND d.status = 'draft' AND d.created_side = 'kline') AS kline_drafts
         FROM organizations o
         LEFT JOIN specs act ON act.org_id = o.id AND act.status = 'active'
         LEFT JOIN LATERAL (SELECT * FROM specs p WHERE p.org_id = o.id AND p.status = 'proposed' ORDER BY p.version DESC LIMIT 1) pr ON true
        WHERE o.kind = 'partner' ORDER BY lower(o.name)`,
    );
    return {
      items: rows.map((r) => ({
        orgId: r.id,
        name: r.name,
        code: r.code,
        orgStatus: r.org_status,
        activeSpecId: r.active_id ?? null,
        activeVersion: r.active_version ?? null,
        activatedAt: iso(r.activated_at),
        proposed: r.proposed_id ? { id: r.proposed_id, version: r.proposed_version, needsKlineSignature: !r.pr_kline, needsPartnerSignature: !r.pr_partner } : null,
        klineDrafts: r.kline_drafts,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------
function cleanNote(v: string | null | undefined, max: number): string | null {
  const t = (v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

function contentOrThrow(input: unknown): SpecContent {
  const r = parseSpecContent(input, { rejectBidi: true }); // what people write: no hidden text direction characters
  if (!r.ok) throw badRequest('The specification is not valid. ' + r.problems[0], 'invalid_spec', { problems: r.problems.slice(0, 20) });
  return r.content;
}

export async function createDraft(ctx: DbCtx, a: AuthContext, input: { orgId?: string; baseSpecId?: string; changeNote?: string; title?: string }, req?: Req) {
  requireEditor(a);
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const orgId = await targetOrg(c, a, input.orgId);
    await c.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]); // serialises version numbers
    let content: SpecContent;
    if (input.baseSpecId) {
      const base = await one<any>(c, 'SELECT content, org_id, status, created_side FROM specs WHERE id = $1', [input.baseSpecId]);
      if (!base || base.org_id !== orgId || draftHidden(base, a)) throw notFound('That specification could not be found.');
      const r = parseSpecContent(base.content);
      content = r.ok ? r.content : defaultSpecContent();
    } else {
      const active = await one<any>(c, `SELECT content FROM specs WHERE org_id = $1 AND status = 'active'`, [orgId]);
      const r = active ? parseSpecContent(active.content) : null;
      content = r && r.ok ? r.content : defaultSpecContent();
    }
    const version = (await one<{ v: number }>(c, 'SELECT COALESCE(max(version), 0) + 1 AS v FROM specs WHERE org_id = $1', [orgId]))!.v;
    const hash = await hashSpec(content);
    const title = (input.title ?? '').trim().slice(0, 120) || 'Production specification';
    const ins = await one<{ id: string }>(
      c,
      `INSERT INTO specs (org_id, version, title, content, content_hash, change_note, created_side, status, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 'draft', $8) RETURNING id`,
      [orgId, version, title, JSON.stringify(content), hash, cleanNote(input.changeNote, SPEC_LIMITS.changeNoteMax), sideOf(a), a.userId],
    );
    await auditSpec(c, actor, orgId, 'spec.draft_created', ins!.id, { version, side: sideOf(a) });
    return { spec: specDto(await loadSpec(c, ins!.id, a), a, true) };
  });
}

/** Loads a draft that the caller's side may change. */
async function ownDraft(c: PoolClient, a: AuthContext, id: string): Promise<any> {
  const row = await loadSpec(c, id, a, true);
  if (row.status !== 'draft') throw conflict('Only a draft can be changed.', 'spec_not_draft');
  if (row.created_side !== sideOf(a)) throw forbidden('This draft belongs to the other side. You can read it once it has been proposed.');
  return row;
}

export async function updateDraft(ctx: DbCtx, a: AuthContext, id: string, input: { content: unknown; changeNote?: string | null; title?: string }, req?: Req) {
  requireEditor(a);
  const actor = actorOf(a, req);
  const content = contentOrThrow(input.content);
  const hash = await hashSpec(content);
  return tx(ctx, async (c) => {
    const row = await ownDraft(c, a, id);
    const note = input.changeNote === undefined ? row.change_note : cleanNote(input.changeNote, SPEC_LIMITS.changeNoteMax);
    const title = input.title === undefined ? row.title : (input.title.trim().slice(0, 120) || row.title);
    await c.query(`UPDATE specs SET content = $2::jsonb, content_hash = $3, change_note = $4, title = $5, updated_at = now() WHERE id = $1`, [id, JSON.stringify(content), hash, note, title]);
    await auditSpec(c, actor, row.org_id, 'spec.draft_updated', id, { version: row.version });
    return { spec: specDto(await loadSpec(c, id, a), a, true) };
  });
}

export async function deleteDraft(ctx: DbCtx, a: AuthContext, id: string, req?: Req): Promise<void> {
  requireEditor(a);
  const actor = actorOf(a, req);
  await tx(ctx, async (c) => {
    const row = await ownDraft(c, a, id);
    await c.query('DELETE FROM specs WHERE id = $1', [id]);
    await auditSpec(c, actor, row.org_id, 'spec.draft_deleted', id, { version: row.version });
  });
}

// ---------------------------------------------------------------------------
// Propose, sign, reject
// ---------------------------------------------------------------------------
async function notifySide(c: PoolClient, side: Side, partnerOrgId: string, n: { kind: string; title: string; body: string; specId: string }): Promise<void> {
  const data = { specId: n.specId, orgId: partnerOrgId };
  // K Line is told through a job (partner requests cannot write K Line rows).
  if (side === 'kline') await notifyKline(c, partnerOrgId, { kind: n.kind, title: n.title, body: n.body, data });
  else await notifyOrg(c, { orgId: partnerOrgId, kind: n.kind, title: n.title, body: n.body, data });
}

const other = (s: Side): Side => (s === 'partner' ? 'kline' : 'partner');

export async function proposeSpec(ctx: DbCtx, a: AuthContext, id: string, req?: Req) {
  requireEditor(a);
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await ownDraft(c, a, id);
    const content = contentOrThrow(row.content);
    const hash = await hashSpec(content);
    await c.query(
      `UPDATE specs SET content = $2::jsonb, content_hash = $3, status = 'proposed', proposed_by = $4, proposed_at = now(), updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(content), hash, a.userId],
    );
    await auditSpec(c, actor, row.org_id, 'spec.proposed', id, { version: row.version, side: sideOf(a), hash });
    await notifySide(c, other(sideOf(a)), row.org_id, {
      kind: 'spec_proposed',
      title: 'Production specification proposed',
      body: `${row.org_name}, version ${row.version}`,
      specId: id,
    });
    await emitSpecWebhook(c, id, 'spec.updated', { orgId: row.org_id, version: row.version, status: 'proposed' });
    return { spec: specDto(await loadSpec(c, id, a), a, true) };
  });
}

export async function signSpec(ctx: DbCtx, a: AuthContext, id: string, input: { contentHash?: string }, req?: Req) {
  if (!a.permissions.has('spec.sign') || a.kind !== 'user') throw forbidden();
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await loadSpec(c, id, a, true);
    if (row.status !== 'proposed') throw conflict('Only a proposed specification can be signed.', 'spec_not_proposed');
    const side = sideOf(a);
    const mine = side === 'partner' ? row.partner_signed_by : row.kline_signed_by;
    const theirs = side === 'partner' ? row.kline_signed_by : row.partner_signed_by;
    if (mine) throw conflict('Your side has already signed this version.', 'already_signed');
    if (theirs && theirs === a.userId) throw conflict('One person cannot sign for both sides.', 'same_signer');
    // What is signed is the hash of the stored content. Refuse if it is not what the signer saw, or if the stored text no longer matches its hash.
    const actual = await hashSpec(row.content);
    if (actual !== row.content_hash || (input.contentHash && input.contentHash.toLowerCase() !== row.content_hash)) {
      throw new AppError(409, 'hash_mismatch', 'The specification does not match the version you were shown. Reload it and check it again.');
    }
    const col = side === 'partner' ? 'partner' : 'kline';
    await c.query(`UPDATE specs SET ${col}_signed_by = $2, ${col}_signed_name = $3, ${col}_signed_at = now(), updated_at = now() WHERE id = $1`, [id, a.userId, a.name ?? 'Signer']);
    await auditSpec(c, actor, row.org_id, 'spec.signed', id, { version: row.version, side, hash: row.content_hash });
    const fresh = await loadSpec(c, id, a, true);
    if (fresh.partner_signed_at && fresh.kline_signed_at) {
      await activate(c, fresh, actor);
    } else {
      await notifySide(c, other(side), row.org_id, {
        kind: 'spec_signed',
        title: 'Production specification signed',
        body: `${row.org_name}, version ${row.version}, waiting for the other side`,
        specId: id,
      });
      await emitSpecWebhook(c, id, 'spec.updated', { orgId: row.org_id, version: row.version, status: 'proposed', signedBy: side });
    }
    return { spec: specDto(await loadSpec(c, id, a), a, true) };
  });
}

/** Both sides have signed: the version becomes active, the previous one is superseded and the bag layout is taken from it. */
async function activate(c: PoolClient, row: any, actor: Actor): Promise<void> {
  const prev = await one<{ id: string; version: number }>(c, `SELECT id, version FROM specs WHERE org_id = $1 AND status = 'active' AND id <> $2`, [row.org_id, row.id]);
  if (prev) {
    await c.query(`UPDATE specs SET status = 'superseded', updated_at = now() WHERE id = $1`, [prev.id]);
    await auditSpec(c, actor, row.org_id, 'spec.superseded', prev.id, { version: prev.version, by: row.version });
  }
  await c.query(`UPDATE specs SET status = 'active', activated_at = now(), updated_at = now() WHERE id = $1`, [row.id]);
  const bag = (row.content as SpecContent).bag;
  await c.query(`UPDATE organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{bag}', $2::jsonb, true), updated_at = now() WHERE id = $1`, [row.org_id, JSON.stringify(bag)]);
  await auditSpec(c, actor, row.org_id, 'spec.activated', row.id, { version: row.version, hash: row.content_hash });
  for (const side of ['partner', 'kline'] as const) {
    await notifySide(c, side, row.org_id, { kind: 'spec_activated', title: 'Production specification active', body: `${row.org_name}, version ${row.version}`, specId: row.id });
  }
  await emitSpecWebhook(c, row.id, 'spec.updated', { orgId: row.org_id, version: row.version, status: 'active' });
}

export async function rejectSpec(ctx: DbCtx, a: AuthContext, id: string, note: string, req?: Req) {
  if (!a.permissions.has('spec.sign') || a.kind !== 'user') throw forbidden();
  const text = cleanNote(note, SPEC_LIMITS.rejectNoteMax);
  if (!text || text.length < 3) throw badRequest('Say why you are rejecting this version.', 'note_required');
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await loadSpec(c, id, a, true);
    if (row.status !== 'proposed') throw conflict('Only a proposed specification can be rejected.', 'spec_not_proposed');
    await c.query(`UPDATE specs SET status = 'rejected', rejection_note = $2, rejected_by = $3, rejected_at = now(), updated_at = now() WHERE id = $1`, [id, text, a.userId]);
    await auditSpec(c, actor, row.org_id, 'spec.rejected', id, { version: row.version, side: sideOf(a) });
    await notifySide(c, other(sideOf(a)), row.org_id, {
      kind: 'spec_rejected',
      title: 'Production specification rejected',
      body: `${row.org_name}, version ${row.version}`,
      specId: id,
    });
    await emitSpecWebhook(c, id, 'spec.updated', { orgId: row.org_id, version: row.version, status: 'rejected' });
    return { spec: specDto(await loadSpec(c, id, a), a, true) };
  });
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------
/** What `id` adds, removes and changes compared with `otherId` (both from the same organisation). */
export async function diffById(ctx: DbCtx, a: AuthContext, id: string, otherId: string) {
  return tx(ctx, async (c) => {
    const target = await loadSpec(c, id, a);
    const base = await loadSpec(c, otherId, a);
    if (target.org_id !== base.org_id) throw badRequest('These versions belong to different partners.', 'org_mismatch');
    const t = parseSpecContent(target.content);
    const b = parseSpecContent(base.content);
    if (!t.ok || !b.ok) throw new AppError(500, 'spec_unreadable', 'A specification could not be read.');
    return {
      from: { id: base.id, version: base.version, status: base.status },
      to: { id: target.id, version: target.version, status: target.status },
      ...diffSpecs(b.content, t.content),
    };
  });
}

/** The spec a case was made under, or the active one, for claim clause checks. */
export async function specContentById(c: PoolClient, specId: string | null): Promise<SpecContent | null> {
  if (!specId) return null;
  const row = await one<any>(c, 'SELECT content FROM specs WHERE id = $1', [specId]);
  if (!row) return null;
  const r = parseSpecContent(row.content);
  return r.ok ? r.content : null;
}
