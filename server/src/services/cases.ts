import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { SYSTEM, many, one, tx, type DbCtx, type PoolClient } from '../db';
import { keyCanSeePatients } from '../http/patientFields';
import { blindIndex, blindIndexes, decryptField, encryptField, fieldAad } from '../crypto/keys';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { enqueue, registerJob } from '../jobs';
import { notifyOrg } from './notify';
import { assertCaseAddress, orgUploadState } from './org';
import { recomputeCase } from './checks';
import { FILE_COLUMNS, OPEN_CASE_STATES, fileContentStream, fileDto, fileName, removeStored } from './files';
import { canonicalNames, csvCell, type ZipEntry } from './packaging';
import { CASE_ID_ALPHABET, CASE_ID_MAX, caseIdRuleProblem } from '../../../shared/filenames';
import { canReceive } from '../../../shared/geo';
import { sccOnFile } from './transferCheck';
import { NAME_MAX } from '../../../shared/bulk';
import { portalStatusLabel, simpleStatus, stageLabel, stepperSteps } from '../../../shared/stages';
import { assertInScope, scopeCondition } from './scope';
import { itemsOf } from './requested';
import { emitCaseWebhook } from './webhooks';

export const INSTRUCTIONS_MAX = 8000;
const INSTRUCTION_STATES = ['draft', 'submitted', 'on_hold', 'ready'];
const PATIENT_NAME_MAX = 120;

export interface Actor {
  actorType: 'user' | 'api_key';
  actorId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export function actorOf(a: AuthContext, req?: { ip?: string; headers?: Record<string, any> }): Actor {
  const ua = req?.headers?.['user-agent'];
  return { actorType: a.kind === 'user' ? 'user' : 'api_key', actorId: a.userId ?? a.apiKeyId, ip: req?.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null };
}

const auditFor = (c: PoolClient, actor: Actor, orgId: string, action: string, caseId: string | null, details: Record<string, unknown> = {}) =>
  audit(c, { actorType: actor.actorType, actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId, action, targetType: 'case', targetId: caseId, details });

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
/** "Marc Alonso" becomes "M*** A*****". */
export function maskName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const chars = [...w];
      return chars[0]! + '*'.repeat(Math.max(0, chars.length - 1));
    })
    .join(' ');
}

export function patientOf(row: any): { first: string | null; last: string | null; full: string | null } {
  try {
    if (row.patient_first_enc || row.patient_last_enc) {
      const first = row.patient_first_enc ? decryptField(row.patient_first_enc, fieldAad.casePatientFirst(row.id)) : null;
      const last = row.patient_last_enc ? decryptField(row.patient_last_enc, fieldAad.casePatientLast(row.id)) : null;
      return { first, last, full: [first, last].filter(Boolean).join(' ') || null };
    }
    if (row.patient_enc) return { first: null, last: null, full: decryptField(row.patient_enc, fieldAad.casePatient(row.id)) };
  } catch {
    /* unreadable name: treated as none */
  }
  return { first: null, last: null, full: null };
}

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? null);

export function portalBlock(row: any) {
  if (row.manufacturing_mode !== 'direct') return { status: 'not_applicable', attempts: 0 };
  const p = row.portal_push ?? {};
  return {
    status: (p.status as string) ?? 'pending',
    ...(row.portal_case_uuid ? { caseUuid: row.portal_case_uuid as string } : {}),
    attempts: Number(p.attempts ?? 0),
    ...(p.status === 'pushing' && Number.isInteger(p.step) ? { step: Number(p.step), steps: 3 } : {}),
    ...(p.lastError ? { lastError: String(p.lastError) } : {}),
    /** True when the fake portal was used: nothing was sent to the K Line portal. */
    demo: p.demo === true,
    /** Last status read from the K Line portal, with its label and when it was last read. */
    ...(p.portalStatus ? { portalStatus: String(p.portalStatus), portalStatusLabel: portalStatusLabel(String(p.portalStatus)) } : {}),
    ...(p.syncedAt ? { syncedAt: String(p.syncedAt) } : {}),
    ...(p.syncError ? { syncError: String(p.syncError) } : {}),
  };
}

export function caseDto(row: any) {
  const p = patientOf(row);
  return {
    id: row.id,
    ref: row.ref,
    caseId: row.partner_case_id ?? null,
    status: row.status,
    stage: row.stage ?? null,
    kind: row.kind,
    priority: row.priority,
    manufacturingMode: row.manufacturing_mode as 'standard' | 'direct',
    patientMasked: p.full ? maskName(p.full) : null,
    hasPatientName: !!p.full,
    hasInstructions: !!row.notes_enc,
    instructionsLocked: !INSTRUCTION_STATES.includes(row.status),
    brandId: row.brand_id ?? null,
    siteCode: row.site_code ?? null,
    dueDate: row.due_date ?? null,
    holdReason: row.hold_reason ?? null,
    stageLabel: row.stage ? stageLabel(row.stage) : null,
    simpleStatus: simpleStatus(row),
    stepper: stepperSteps({ status: row.status, stage: row.stage, portalStatus: row.manufacturing_mode === 'direct' ? row.portal_push?.portalStatus ?? null : null }),
    expectedShipDate: row.due_date ?? null,
    carrier: row.carrier ?? null,
    trackingNumber: row.tracking ?? null,
    counts: { upper: row.aligners_upper, lower: row.aligners_lower, templates: row.aligners_templates, shipped: row.aligners_shipped },
    fileCount: row.file_count ?? 0,
    checks: { errors: row.checks?.errors ?? [], warnings: row.checks?.warnings ?? [] },
    warningsAcknowledged: row.warnings_acknowledged,
    portal: portalBlock(row),
    bulkBatchId: row.bulk_batch_id ?? null,
    parentId: row.parent_id ?? null,
    parentRef: row.parent_ref ?? null,
    specId: row.spec_id ?? null,
    specVersion: row.spec_version ?? null,
    requestedItems: itemsOf(row.requested_items),
    claimId: row.claim_id ?? null,
    claimNumber: row.claim_number ?? null,
    orgId: row.org_id,
    orgName: row.org_name ?? null,
    orgCode: row.org_code ?? null,
    createdAt: iso(row.created_at),
    submittedAt: iso(row.submitted_at),
    readyAt: iso(row.ready_at),
    receivedAt: iso(row.received_at),
    shippedAt: iso(row.shipped_at),
    deliveredAt: iso(row.delivered_at),
    cancelledAt: iso(row.cancelled_at),
    purgedAt: iso(row.purged_at),
    updatedAt: iso(row.updated_at),
  };
}

export const CASE_SELECT = `SELECT c.*, s.code AS site_code, o.name AS org_name, o.code AS org_code,
    (SELECT count(*)::int FROM files f WHERE f.case_id = c.id AND f.state <> 'purged') AS file_count,
    (SELECT p.ref FROM cases p WHERE p.id = c.parent_id) AS parent_ref,
    (SELECT sp.version FROM specs sp WHERE sp.id = c.spec_id) AS spec_version,
    (SELECT cl.number FROM claims cl WHERE cl.id = c.claim_id) AS claim_number
  FROM cases c JOIN organizations o ON o.id = c.org_id LEFT JOIN sites s ON s.id = c.site_id`;

/** A case whose data was purged or erased cannot be changed, submitted, routed or released any more. */
export function assertNotErased(row: { purged_at?: unknown }): void {
  if (row.purged_at) throw conflict('The data of this case was removed, so it cannot be changed.', 'case_erased');
}

/** Loads one case. Pass the caller to apply the K Line production site scope (out of scope reads as not found). */
export async function loadCase(c: PoolClient, id: string, lock = false, scope?: AuthContext): Promise<any> {
  const row = await one<any>(c, `${CASE_SELECT} WHERE c.id = $1${lock ? ' FOR UPDATE OF c' : ''}`, [id]);
  if (!row) throw notFound('That case could not be found.');
  if (scope) assertInScope(scope, row);
  return row;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
export function validateCaseId(raw: string, code = 'invalid_case_id'): string {
  const v = raw.trim();
  if (!v || v.length > CASE_ID_MAX || !CASE_ID_ALPHABET.test(v)) {
    throw badRequest(`Use letters, digits, spaces and _ . / # - only, up to ${CASE_ID_MAX} characters.`, code);
  }
  // Also no "..", and no dot or slash at the start or the end.
  if (caseIdRuleProblem(v)) throw badRequest('A case ID cannot have two dots in a row, and cannot start or end with a dot or a slash.', code);
  return v;
}

function cleanName(raw: string, max: number, code: string): string {
  const v = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!v) throw badRequest('A name is missing.', code);
  if (v.length > max) throw badRequest(`Names can be at most ${max} characters.`, 'name_too_long');
  return v;
}

function checkInstructions(text: string): string {
  if (text.length > INSTRUCTIONS_MAX) throw badRequest(`Instructions can be at most ${INSTRUCTIONS_MAX.toLocaleString('en-GB')} characters.`, 'instructions_too_long');
  return text;
}

export function addBusinessDays(from: Date, days: number): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let n = days;
  while (n > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n--;
  }
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export interface InsertCaseInput {
  orgId: string;
  actor: Actor;
  mode: 'standard' | 'direct';
  caseId?: string | null;
  patientName?: string | null;
  firstName?: string;
  lastName?: string;
  brandId?: string | null;
  priority?: 'normal' | 'rush';
  instructions?: string | null;
  batchId?: string | null;
}

/** Inserts a draft case with its encrypted fields, reference and created event. Throws case_id_exists on duplicates. */
export async function insertCase(c: PoolClient, input: InsertCaseInput): Promise<{ id: string; ref: string; caseId: string | null }> {
  const id = randomUUID();
  if (input.brandId) {
    const b = await one(c, 'SELECT 1 FROM brands WHERE id = $1 AND org_id = $2', [input.brandId, input.orgId]);
    if (!b) throw badRequest('That brand does not exist.', 'invalid_brand');
  }
  const org = await one<{ code: string | null }>(c, 'SELECT code FROM organizations WHERE id = $1', [input.orgId]);
  if (!org) throw notFound('That organisation could not be found.');
  const code = org.code ?? 'CASE';
  const n = await one<{ n: number }>(c, 'SELECT kph_next_counter($1) AS n', [`case:${code}`]);
  const ref = `${code}-${String(n!.n).padStart(6, '0')}`;

  let patientEnc: string | null = null;
  let firstEnc: string | null = null;
  let lastEnc: string | null = null;
  let bidx: string | null = null;
  let bidxs: string[] = [];
  if (input.mode === 'direct') {
    const first = input.firstName!;
    const last = input.lastName!;
    firstEnc = encryptField(first, fieldAad.casePatientFirst(id));
    lastEnc = encryptField(last, fieldAad.casePatientLast(id));
    patientEnc = encryptField(`${first} ${last}`, fieldAad.casePatient(id));
    bidxs = blindIndexes(first, last);
    bidx = bidxs[0]!;
  } else if (input.patientName) {
    patientEnc = encryptField(input.patientName, fieldAad.casePatient(id));
    bidx = blindIndex(input.patientName);
    bidxs = [bidx];
  }
  const notes = input.instructions ? encryptField(input.instructions, fieldAad.caseNotes(id)) : null;
  try {
    await c.query(
      `INSERT INTO cases (id, org_id, ref, partner_case_id, patient_enc, patient_bidx, patient_bidxs, patient_first_enc, patient_last_enc, brand_id, priority, notes_enc,
                          manufacturing_mode, bulk_batch_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        id, input.orgId, ref, input.caseId ?? null, patientEnc, bidx, bidxs, firstEnc, lastEnc, input.brandId ?? null, input.priority ?? 'normal', notes,
        input.mode, input.batchId ?? null, input.actor.actorType === 'user' ? input.actor.actorId : null,
      ],
    );
  } catch (err: any) {
    if (err?.code === '23505' && String(err?.constraint ?? '').includes('partner_id')) throw conflict('You already have a case with that case ID.', 'case_id_exists');
    throw err;
  }
  await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data) VALUES ($1, $2, 'created', $3, $4, $5::jsonb)`, [
    input.orgId, id, input.actor.actorType, input.actor.actorId, JSON.stringify({ mode: input.mode }),
  ]);
  await auditFor(c, input.actor, input.orgId, 'case.created', id, { ref, mode: input.mode });
  return { id, ref, caseId: input.caseId ?? null };
}

export interface CreateCaseInput {
  caseId?: string | null;
  patientName?: string | null;
  brandId?: string | null;
  priority?: 'normal' | 'rush';
  instructions?: string | null;
}

export async function createCase(ctx: DbCtx, a: AuthContext, input: CreateCaseInput, req?: { ip?: string; headers?: Record<string, any> }) {
  if (a.orgKind !== 'partner') throw forbidden('Cases are created by partner organisations.');
  const caseId = input.caseId ? validateCaseId(input.caseId) : null;
  const patientName = input.patientName ? cleanName(input.patientName, PATIENT_NAME_MAX, 'invalid_patient_name') : null;
  if (!caseId && !patientName) throw badRequest('Give a case ID or a patient name.', 'identifier_required');
  const instructions = input.instructions ? checkInstructions(input.instructions) : null;
  return tx(ctx, async (c) => {
    const r = await insertCase(c, { orgId: a.orgId, actor: actorOf(a, req), mode: 'standard', caseId, patientName, brandId: input.brandId, priority: input.priority, instructions });
    return caseDto(await loadCase(c, r.id));
  });
}

// ---------------------------------------------------------------------------
// List and read
// ---------------------------------------------------------------------------
/**
 * Groups used by the partner app, plus every raw status (used by the K Line console).
 * `simple_*` groups match the four step progress bar: Submitted (submitted, on hold, ready), Production (received, in production), Shipped (shipped, delivered).
 */
export const LIST_STATUS_VALUES = ['attention', 'production', 'done', 'simple_submitted', 'simple_production', 'simple_shipped', 'draft', 'submitted', 'on_hold', 'ready', 'received', 'in_production', 'shipped', 'delivered', 'cancelled'] as const;
export type ListStatus = (typeof LIST_STATUS_VALUES)[number];

export interface ListQuery {
  search?: string;
  status?: ListStatus;
  mode?: 'standard' | 'direct';
  orgId?: string;
  siteCode?: string;
  page: number;
  pageSize: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

export async function listCases(ctx: DbCtx, a: AuthContext, q: ListQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (a.orgKind === 'partner') where.push(`c.org_id = ${add(a.orgId)}`);
  else if (q.orgId) where.push(`c.org_id = ${add(q.orgId)}`);
  const scoped = scopeCondition(a, add);
  if (scoped) where.push(scoped);
  if (q.siteCode) where.push(`c.site_id = (SELECT id FROM sites WHERE code = ${add(q.siteCode)})`);
  if (q.mode) where.push(`c.manufacturing_mode = ${add(q.mode)}`);
  const s = q.search?.trim().slice(0, 120);
  let hitSql = 'false';
  if (s) {
    const like = add('%' + escapeLike(s) + '%');
    // A partner API key without the patients:read scope cannot find a case by a patient name (that would reveal who is a patient).
    if (a.kind === 'api_key' && !keyCanSeePatients(a)) {
      where.push(`(c.partner_case_id ILIKE ${like} OR c.ref ILIKE ${like})`);
    } else {
      const h = add(blindIndex(s));
      hitSql = `(c.patient_bidxs && ARRAY[${h}]::text[])`;
      where.push(`(c.partner_case_id ILIKE ${like} OR c.ref ILIKE ${like} OR ${hitSql})`);
    }
  }
  switch (q.status) {
    case 'attention':
      where.push(`(c.status = 'on_hold' OR c.portal_push->>'status' = 'failed' OR (c.status IN ('draft', 'submitted') AND EXISTS (SELECT 1 FROM files f WHERE f.case_id = c.id AND f.state = 'rejected')))`);
      break;
    case 'production':
      where.push(`c.status IN ('submitted', 'ready', 'received', 'in_production')`);
      break;
    case 'done':
    case 'simple_shipped':
      where.push(`c.status IN ('shipped', 'delivered')`);
      break;
    case 'simple_submitted':
      where.push(`c.status IN ('submitted', 'on_hold', 'ready')`);
      break;
    case 'simple_production':
      where.push(`c.status IN ('received', 'in_production')`);
      break;
    case undefined:
      break;
    default:
      where.push(`c.status = ${add(q.status)}`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return tx(ctx, async (c) => {
    const total = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM cases c ${w}`, params);
    const rows = await many<any>(
      c,
      `${CASE_SELECT.replace('SELECT c.*,', `SELECT c.*, ${hitSql} AS name_hit,`)} ${w} ORDER BY c.created_at DESC, c.id LIMIT ${add(q.pageSize)} OFFSET ${add((q.page - 1) * q.pageSize)}`,
      params,
    );
    // K Line staff who find a case through a patient name leave a trace in the partner's access log.
    if (a.orgKind === 'kline') {
      for (const r of rows.filter((x) => x.name_hit)) {
        await audit(c, { actorType: a.kind === 'user' ? 'user' : 'api_key', actorId: a.userId ?? a.apiKeyId, orgId: r.org_id, action: 'case.name_searched', targetType: 'case', targetId: r.id, details: { ref: r.ref } });
      }
    }
    return { items: rows.map(caseDto), total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
  });
}

/** K Line staff opening a case leave an entry in the partner's access log (at most one per person and case every 10 minutes). */
async function auditViewOnce(c: PoolClient, a: AuthContext, row: any, req?: { ip?: string; headers?: Record<string, any> }): Promise<void> {
  const actor = actorOf(a, req);
  const seen = await one(c, `SELECT 1 FROM audit_log WHERE action = 'case.viewed' AND target_id = $1 AND actor_id = $2 AND at > now() - interval '10 minutes' LIMIT 1`, [row.id, actor.actorId]);
  if (!seen) await auditFor(c, actor, row.org_id, 'case.viewed', row.id, { ref: row.ref });
}

/** Who an event is attributed to, as the partner sees it. */
export function eventSourceLabel(e: { actor_type: string; data?: any; actor_org_id?: string | null; org_id?: string | null }): 'Partner' | 'K Line' | 'Factory system' | 'K Line portal' | 'System' {
  if (e.data?.source === 'portal') return 'K Line portal';
  if (e.actor_type === 'service' || e.data?.source === 'mes' || e.data?.source === 'csv') return 'Factory system';
  if (e.actor_type === 'system') return 'System';
  if (e.actor_type === 'api_key') return 'Partner';
  return e.actor_org_id && e.actor_org_id === e.org_id ? 'Partner' : 'K Line';
}

export async function getCaseDetail(ctx: DbCtx, id: string, a: AuthContext, req?: { ip?: string; headers?: Record<string, any> }) {
  return tx(ctx, async (c) => {
    const row = await loadCase(c, id, false, a);
    const files = await many<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.case_id = $1 AND f.state <> 'purged' ORDER BY f.arch NULLS LAST, f.step NULLS LAST, f.is_template, f.created_at, f.id`, [id]);
    const events = await many<any>(
      c,
      `SELECT e.id, e.type, e.actor_type, e.data, e.created_at, e.org_id, u.org_id AS actor_org_id
         FROM case_events e LEFT JOIN users u ON e.actor_type = 'user' AND u.id::text = e.actor_id
        WHERE e.case_id = $1 ORDER BY e.created_at, e.id`,
      [id],
    );
    if (a.orgKind === 'kline') await auditViewOnce(c, a, row, req);
    let instructions: string | null = null;
    if (row.notes_enc) {
      try {
        instructions = decryptField(row.notes_enc, fieldAad.caseNotes(id));
      } catch {
        instructions = null;
      }
    }
    const children = await many<any>(c, `SELECT id, ref, kind, status, priority, created_at FROM cases WHERE parent_id = $1 ORDER BY created_at, id`, [id]);
    const claims = await many<any>(c, `SELECT id, number, status, summary, created_at FROM claims WHERE case_id = $1 ORDER BY created_at DESC, id`, [id]);
    return {
      case: caseDto(row),
      files: files.map(fileDto),
      events: events.map((e) => ({ id: e.id, type: e.type, actorType: e.actor_type, sourceLabel: eventSourceLabel(e), data: e.data ?? {}, createdAt: iso(e.created_at) })),
      instructions,
      children: children.map((x) => ({ id: x.id, ref: x.ref, kind: x.kind, status: x.status, priority: x.priority, createdAt: iso(x.created_at) })),
      claims: claims.map((x) => ({ id: x.id, number: x.number, status: x.status, summary: x.summary, createdAt: iso(x.created_at) })),
    };
  });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
export interface PatchCaseInput {
  caseId?: string | null;
  patientName?: string | null;
  firstName?: string;
  lastName?: string;
  brandId?: string | null;
  priority?: 'normal' | 'rush';
  instructions?: string | null;
}

export async function patchCase(ctx: DbCtx, a: AuthContext, id: string, input: PatchCaseInput, req?: { ip?: string; headers?: Record<string, any> }) {
  const actor = actorOf(a, req);
  const touchesDetails = ['caseId', 'patientName', 'firstName', 'lastName', 'brandId', 'priority'].some((k) => (input as any)[k] !== undefined);
  return tx(ctx, async (c) => {
    const row = await loadCase(c, id, true, a);
    assertNotErased(row);
    if (touchesDetails && !OPEN_CASE_STATES.includes(row.status)) throw conflict('Case details can only be changed while a case is a draft or on hold.', 'case_not_open');
    const direct = row.manufacturing_mode === 'direct';
    if (direct && input.patientName !== undefined) throw badRequest('Direct manufacturing cases use a first and last name.', 'invalid_request');
    if (!direct && (input.firstName !== undefined || input.lastName !== undefined)) throw badRequest('Only direct manufacturing cases have a first and last name.', 'invalid_request');

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    let newCaseId: string | null | undefined;
    if (input.caseId !== undefined) {
      newCaseId = input.caseId === null || input.caseId === '' ? null : validateCaseId(input.caseId);
      set('partner_case_id', newCaseId);
    }
    if (input.brandId !== undefined) {
      if (input.brandId) {
        const b = await one(c, 'SELECT 1 FROM brands WHERE id = $1 AND org_id = $2', [input.brandId, row.org_id]);
        if (!b) throw badRequest('That brand does not exist.', 'invalid_brand');
      }
      set('brand_id', input.brandId);
    }
    if (input.priority !== undefined) set('priority', input.priority);

    let hasName = !!(row.patient_enc || row.patient_first_enc);
    if (input.patientName !== undefined) {
      if (input.patientName === null || input.patientName.trim() === '') {
        set('patient_enc', null);
        set('patient_bidx', null);
        set('patient_bidxs', []);
        hasName = false;
      } else {
        const name = cleanName(input.patientName, PATIENT_NAME_MAX, 'invalid_patient_name');
        set('patient_enc', encryptField(name, fieldAad.casePatient(id)));
        const bi = blindIndex(name);
        set('patient_bidx', bi);
        set('patient_bidxs', [bi]);
        hasName = true;
      }
    }
    if (direct && (input.firstName !== undefined || input.lastName !== undefined)) {
      const cur = patientOf(row);
      const first = input.firstName !== undefined ? cleanName(input.firstName, NAME_MAX, 'first_name_required') : cur.first!;
      const last = input.lastName !== undefined ? cleanName(input.lastName, NAME_MAX, 'last_name_required') : cur.last!;
      set('patient_first_enc', encryptField(first, fieldAad.casePatientFirst(id)));
      set('patient_last_enc', encryptField(last, fieldAad.casePatientLast(id)));
      set('patient_enc', encryptField(`${first} ${last}`, fieldAad.casePatient(id)));
      const bis = blindIndexes(first, last);
      set('patient_bidx', bis[0]);
      set('patient_bidxs', bis);
    }
    const finalCaseId = newCaseId !== undefined ? newCaseId : row.partner_case_id;
    if (!finalCaseId && !hasName) throw badRequest('A case needs a case ID or a patient name.', 'identifier_required');
    if (direct && !finalCaseId) throw badRequest('Direct manufacturing cases need a patient ID.', 'identifier_required');

    let instructionsChanged = false;
    if (input.instructions !== undefined) {
      if (!INSTRUCTION_STATES.includes(row.status)) throw conflict('Instructions can no longer be changed because production has started.', 'instructions_locked');
      const text = input.instructions === null ? '' : checkInstructions(input.instructions);
      set('notes_enc', text ? encryptField(text, fieldAad.caseNotes(id)) : null);
      instructionsChanged = true;
    }
    if (!sets.length) return { case: caseDto(row) };
    try {
      await c.query(`UPDATE cases SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('You already have a case with that case ID.', 'case_id_exists');
      throw err;
    }
    if (instructionsChanged && row.status !== 'draft') {
      await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data) VALUES ($1, $2, 'instructions_updated', $3, $4, '{}'::jsonb)`, [row.org_id, id, actor.actorType, actor.actorId]);
      await enqueue(c, 'notify.kline', { kind: 'instructions_updated', caseId: id }, { orgId: row.org_id });
      await auditFor(c, actor, row.org_id, 'case.instructions_updated', id, { ref: row.ref });
    }
    if (touchesDetails) await auditFor(c, actor, row.org_id, 'case.updated', id, { ref: row.ref });
    return { case: caseDto(await loadCase(c, id)) };
  });
}

// ---------------------------------------------------------------------------
// Submit, cancel, delete
// ---------------------------------------------------------------------------
export async function refreshBatch(c: PoolClient, batchId: string | null | undefined): Promise<void> {
  if (!batchId) return;
  const r = await one<any>(
    c,
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status <> 'draft')::int AS submitted,
            count(*) FILTER (WHERE portal_push->>'status' = 'pushed')::int AS pushed,
            count(*) FILTER (WHERE portal_push->>'status' = 'failed')::int AS failed
       FROM cases WHERE bulk_batch_id = $1 AND status <> 'cancelled'`,
    [batchId],
  );
  const status = !r || r.total === 0 ? 'open' : r.failed > 0 ? 'failed' : r.pushed === r.total ? 'completed' : r.submitted === r.total ? 'submitted' : 'open';
  await c.query('UPDATE bulk_batches SET status = $2, case_count = (SELECT count(*) FROM cases WHERE bulk_batch_id = $1) WHERE id = $1', [batchId, status]);
}

export interface Routing {
  manual: boolean;
  /** The site a new case goes to at once, or null when it waits for K Line (manual review, or no site allowed). */
  site: { id: string; code: string; country: string; eea: boolean; adequacy: boolean } | null;
  slaDays: number;
}

/**
 * Where a newly submitted case goes: the default site or the first allowed site that may legally receive it.
 * Strict mode (partner submit) refuses when there is no usable site; otherwise the case simply waits for K Line.
 */
export async function resolveRouting(c: PoolClient, orgId: string, strict: boolean, opts: { direct?: boolean } = {}): Promise<Routing> {
  const org = await one<any>(c, 'SELECT country, default_site_id, settings FROM organizations WHERE id = $1', [orgId]);
  // Direct manufacturing cases are produced by the K Line customer portal, not routed to a site by the Hub. They have no site, so the
  // transfer gate does not apply to them (see services/transferGate.ts). Review and the service level still follow the partner's settings.
  if (opts.direct) {
    return { manual: !!org.settings?.manual_review, site: null, slaDays: typeof org.settings?.sla_days === 'number' ? org.settings.sla_days : 3 };
  }
  const sites = await many<any>(
    c,
    `SELECT s.id, s.code, s.country, s.eea, s.adequacy FROM org_sites os JOIN sites s ON s.id = os.site_id WHERE os.org_id = $1 AND s.active ORDER BY s.code`,
    [orgId],
  );
  const scc = await sccOnFile(c, orgId);
  const ordered = [...sites.filter((s) => s.id === org.default_site_id), ...sites.filter((s) => s.id !== org.default_site_id)];
  const manual = !!org.settings?.manual_review;
  const slaDays = typeof org.settings?.sla_days === 'number' ? org.settings.sla_days : 3;
  let site: any = null;
  if (ordered.length === 0) {
    if (strict && !manual) throw conflict('No production site is set up for your organisation yet. Please contact K Line.', 'no_site_configured');
  } else {
    site = ordered.find((s) => canReceive(org.country, s, scc));
    if (!site && strict) throw forbidden('Cases from your organisation cannot be produced at the available sites until Standard Contractual Clauses are on file. Please contact K Line.', 'transfer_blocked');
  }
  return { manual, site, slaDays };
}

export async function submitCase(ctx: DbCtx, a: AuthContext, id: string, opts: { acknowledgeWarnings?: boolean }, req?: { ip?: string; headers?: Record<string, any> }) {
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await loadCase(c, id, true, a);
    assertNotErased(row);
    if (!OPEN_CASE_STATES.includes(row.status)) throw conflict('Only a draft or a case on hold can be submitted.', 'case_not_open');
    const up = await orgUploadState(c, row.org_id);
    if (!up.unlocked) throw forbidden('Your organisation must be approved with a data processing agreement on file before cases can be submitted.', 'org_not_approved');

    // Early gate for direct manufacturing cases: the case address is sent to the portal, so a missing one is reported now.
    if (row.manufacturing_mode === 'direct') await assertCaseAddress(c, row.org_id, row.created_by ?? null);

    // Checks are still recomputed and stored on the case, but errors and warnings no longer block a submission.
    const checks = await recomputeCase(c, id);

    const { manual, site, slaDays } = await resolveRouting(c, row.org_id, true, { direct: row.manufacturing_mode === 'direct' });

    const fromHold = row.status === 'on_hold';
    const now = new Date();
    // The active production specification of the partner applies to the case (brief section 15: each case records its spec version).
    const spec = await one<{ id: string }>(c, `SELECT id FROM specs WHERE org_id = $1 AND status = 'active'`, [row.org_id]);
    const direct = row.manufacturing_mode === 'direct';
    // A case that K Line or the factory put on hold always goes back to K Line for a manual review, whatever the partner's review setting:
    // a partner can never use "submit again" to push a held case straight back into production.
    const ready = !manual && !fromHold;
    await c.query(
      `UPDATE cases SET status = $2, submitted_at = COALESCE(submitted_at, now()), ready_at = $3, site_id = $4, due_date = $5, spec_id = COALESCE($6, spec_id),
              hold_reason = NULL, stage = NULL, received_at = NULL, started_at = NULL, finished_at = NULL, warnings_acknowledged = $7, warnings_acknowledged_at = CASE WHEN $7 THEN now() ELSE NULL END, warnings_acknowledged_by = $8,
              portal_push = CASE WHEN $9 THEN jsonb_build_object('status', 'pending', 'attempts', 0) ELSE portal_push END, updated_at = now()
        WHERE id = $1`,
      [id, ready ? 'ready' : 'submitted', ready ? now : null, ready ? site?.id ?? null : null, ready ? addBusinessDays(now, slaDays) : null, spec?.id ?? null, !!(checks?.warnings.length && opts.acknowledgeWarnings), a.userId, direct],
    );
    await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [
      row.org_id, id, fromHold ? 'resubmitted' : 'submitted', actor.actorType, actor.actorId,
      JSON.stringify({ status: ready ? 'ready' : 'submitted', site: ready ? site?.code ?? null : null, warnings: checks?.warnings.length ?? 0, acknowledged: !!opts.acknowledgeWarnings }),
    ]);
    await auditFor(c, actor, row.org_id, fromHold ? 'case.resubmitted' : 'case.submitted', id, { ref: row.ref, status: ready ? 'ready' : 'submitted', mode: row.manufacturing_mode });
    if (!ready) await enqueue(c, 'notify.kline', { kind: 'case_submitted', caseId: id }, { orgId: row.org_id });
    if (direct) await enqueue(c, 'bulk.push', { caseId: id }, { orgId: row.org_id, maxAttempts: 5 });
    await refreshBatch(c, row.bulk_batch_id);
    await emitCaseWebhook(c, id, 'case.submitted');
    return { case: caseDto(await loadCase(c, id)) };
  });
}

export async function cancelCase(ctx: DbCtx, a: AuthContext, id: string, req?: { ip?: string; headers?: Record<string, any> }) {
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await loadCase(c, id, true, a);
    if (!['draft', 'submitted', 'on_hold', 'ready'].includes(row.status)) throw conflict('This case can no longer be cancelled here. Please contact K Line.', 'cannot_cancel');
    await c.query(`UPDATE cases SET status = 'cancelled', cancelled_at = now(), purge_after = now() + interval '30 days', updated_at = now() WHERE id = $1`, [id]);
    await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data) VALUES ($1, $2, 'cancelled', $3, $4, $5::jsonb)`, [
      row.org_id, id, actor.actorType, actor.actorId, JSON.stringify({ from: row.status }),
    ]);
    await auditFor(c, actor, row.org_id, 'case.cancelled', id, { ref: row.ref, from: row.status });
    await refreshBatch(c, row.bulk_batch_id);
    await emitCaseWebhook(c, id, 'case.cancelled', { status: 'cancelled', stage: null });
    return { case: caseDto(await loadCase(c, id)) };
  });
}

export async function deleteCase(ctx: DbCtx, a: AuthContext, id: string, req?: { ip?: string; headers?: Record<string, any> }): Promise<void> {
  const actor = actorOf(a, req);
  const prefixes = await tx(ctx, async (c) => {
    const row = await loadCase(c, id, true, a);
    if (row.status !== 'draft') throw conflict('Only drafts can be deleted. Cancel the case instead.', 'case_not_draft');
    const files = await many<{ storage_prefix: string | null }>(c, 'SELECT storage_prefix FROM files WHERE case_id = $1', [id]);
    await c.query('DELETE FROM cases WHERE id = $1', [id]);
    await auditFor(c, actor, row.org_id, 'case.deleted', id, { ref: row.ref, files: files.length });
    await refreshBatch(c, row.bulk_batch_id);
    return files.map((f) => f.storage_prefix).filter((p): p is string => !!p);
  });
  await removeStored(prefixes);
}

// ---------------------------------------------------------------------------
// Patient name reveal and package
// ---------------------------------------------------------------------------
export async function revealName(ctx: DbCtx, a: AuthContext, id: string, req?: { ip?: string; headers?: Record<string, any> }) {
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await loadCase(c, id, false, a);
    // The entry names the case org, so the partner sees who at K Line looked.
    await auditFor(c, actor, row.org_id, 'case.name_revealed', id, { ref: row.ref });
    const p = patientOf(row);
    return { patientName: p.full, firstName: p.first, lastName: p.last };
  });
}

export async function preparePackage(ctx: DbCtx, a: AuthContext, id: string, req?: { ip?: string; headers?: Record<string, any> }) {
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await loadCase(c, id, false, a);
    const files = await many<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.case_id = $1 AND f.state = 'ready' ORDER BY f.created_at, f.id`, [id]);
    let instructions = '';
    if (row.notes_enc) {
      try {
        instructions = decryptField(row.notes_enc, fieldAad.caseNotes(id));
      } catch {
        instructions = '';
      }
    }
    await auditFor(c, actor, row.org_id, 'case.package_downloaded', id, { ref: row.ref, files: files.length });
    return { ref: row.ref as string, entries: buildPackageEntries(files, instructions) };
  });
}

export function buildPackageEntries(files: any[], instructions: string): ZipEntry[] {
  const named = files.map((f) => ({ id: f.id, kind: f.kind, arch: f.arch, step: f.step, is_template: f.is_template, ext: f.ext, name: fileName(f) }));
  const names = canonicalNames(named);
  const rows = ['path,kind,arch,step,template,size,sha256'];
  const entries: ZipEntry[] = [];
  for (const f of files) {
    const path = names.get(f.id)!;
    rows.push([path, f.kind, f.arch ?? '', f.step ?? '', f.is_template ? 'yes' : 'no', Number(f.size), f.meta?.sha256 ?? ''].map(csvCell).join(','));
    entries.push({ name: path, stream: () => fileContentStream(f), size: Number(f.size), level: ['pdf', 'image'].includes(f.kind) ? 0 : 1 });
  }
  entries.unshift({ name: 'manifest.csv', buffer: Buffer.from(rows.join('\r\n') + '\r\n', 'utf8'), level: 6 });
  entries.unshift({ name: 'instructions.txt', buffer: Buffer.from(instructions || 'No instructions were provided.\r\n', 'utf8'), level: 6 });
  return entries;
}

// ---------------------------------------------------------------------------
// Job: tell K Line intake by reference only (never patient data)
// ---------------------------------------------------------------------------
registerJob('notify.kline', async (job) => {
  const { kind, caseId } = job.payload as { kind: string; caseId: string };
  await tx(SYSTEM, async (c) => {
    const cs = await one<{ ref: string }>(c, 'SELECT ref FROM cases WHERE id = $1', [caseId]);
    const kl = await one<{ id: string }>(c, `SELECT id FROM organizations WHERE kind = 'kline' LIMIT 1`);
    if (!cs || !kl) return;
    const title = kind === 'instructions_updated' ? 'Case instructions updated' : 'Case waiting for review';
    await notifyOrg(c, { orgId: kl.id, kind, title, body: `Case ${cs.ref}`, data: { caseId, ref: cs.ref } });
  });
});
