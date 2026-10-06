import { z } from 'zod';
import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { many, one, tx, type DbCtx, type PoolClient } from '../db';
import { AppError, badRequest, forbidden, notFound } from '../http/errors';
import { keyCanSeePatients } from '../http/patientFields';
import { simpleStatus, stageLabel } from '../../../shared/stages';
import { CASE_SELECT, actorOf, createCase, eventSourceLabel, patientOf, portalBlock, submitCase } from './cases';
import { FILE_COLUMNS, createUpload } from './files';
import { listMaterials } from './materials';
import { canonicalNames } from './packaging';

/**
 * Partner ERP API (`/api/v1`): a thin versioned layer over the same services the web app uses.
 * Stable snake_case JSON. Patient names appear only for keys with the `patients:read` scope, and every such read is audited.
 */
type Req = { ip?: string; headers?: Record<string, any> };

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? null);
const REF_RE = /^[A-Z0-9]{2,8}-\d{6,}$/;
export const V1_MAX_PAGE_SIZE = 100;
export const SHIPMENTS_MAX_DAYS = 366;
export const SHIPMENTS_MAX_ROWS = 20_000;
export const V1_TIME_ZONE = 'Europe/Berlin';

export function requireV1Scope(a: AuthContext, scope: string): void {
  if (a.kind !== 'api_key' || a.orgKind !== 'partner') throw forbidden('This endpoint is for partner API keys.', 'wrong_key_type');
  if (!a.scopes.includes(scope)) throw forbidden(`This API key does not have the ${scope} scope.`, 'insufficient_scope');
}
const canSeePatients = keyCanSeePatients;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-24.')
  .refine((s) => {
    const d = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That date does not exist.');

export const pageParams = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(1).max(V1_MAX_PAGE_SIZE).default(25),
};

const SIMPLE_STATUSES: Record<string, string[]> = {
  draft: ['draft'],
  submitted: ['submitted', 'on_hold', 'ready'],
  production: ['received', 'in_production'],
  shipped: ['shipped', 'delivered'],
  cancelled: ['cancelled'],
};
export const SIMPLE_STATUS_VALUES = Object.keys(SIMPLE_STATUSES) as [string, ...string[]];
export const CASE_STATUS_VALUES = ['draft', 'submitted', 'on_hold', 'ready', 'received', 'in_production', 'shipped', 'delivered', 'cancelled'] as const;

/** A date in the partner's business time zone (Europe/Berlin). */
export const berlinDate = (col: string) => `(${col} AT TIME ZONE '${V1_TIME_ZONE}')::date`;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------
const V1_SELECT = CASE_SELECT.replace('SELECT c.*,', `SELECT c.*, (SELECT b.name FROM brands b WHERE b.id = c.brand_id) AS brand_name,`);

const issue = (i: any) => ({
  code: i.code as string,
  message: i.message as string,
  ...(i.fileId ? { file_id: i.fileId as string } : {}),
  ...(i.arch ? { arch: i.arch as string } : {}),
  ...(i.step !== undefined && i.step !== null ? { step: i.step as number } : {}),
});

export function v1Case(row: any, opts: { patient?: boolean } = {}) {
  const direct = row.manufacturing_mode === 'direct';
  const portal = portalBlock(row);
  const out: Record<string, unknown> = {
    ref: row.ref,
    case_id: row.partner_case_id ?? null,
    status: row.status,
    simple_status: simpleStatus(row),
    stage: row.stage ?? null,
    stage_label: row.stage ? stageLabel(row.stage) : null,
    kind: row.kind,
    mode: row.manufacturing_mode,
    priority: row.priority,
    brand: row.brand_name ?? null,
    site: row.site_code ?? null,
    due_date: row.due_date ?? null,
    expected_ship_date: row.due_date ?? null,
    hold_reason: row.hold_reason ?? null,
    aligners: { upper: row.aligners_upper, lower: row.aligners_lower, templates: row.aligners_templates, shipped: row.aligners_shipped },
    carrier: row.carrier ?? null,
    tracking_number: row.tracking ?? null,
    created_at: iso(row.created_at),
    submitted_at: iso(row.submitted_at),
    ready_at: iso(row.ready_at),
    received_at: iso(row.received_at),
    shipped_at: iso(row.shipped_at),
    delivered_at: iso(row.delivered_at),
    cancelled_at: iso(row.cancelled_at),
    updated_at: iso(row.updated_at),
    checks: { errors: (row.checks?.errors ?? []).map(issue), warnings: (row.checks?.warnings ?? []).map(issue) },
    warnings_acknowledged: !!row.warnings_acknowledged,
    parent_ref: row.parent_ref ?? null,
  };
  if (direct) out.portal = { status: portal.status, ...('caseUuid' in portal && portal.caseUuid ? { case_uuid: portal.caseUuid } : {}) };
  if (opts.patient) {
    const p = patientOf(row);
    out.patient = { first_name: p.first, last_name: p.last, name: p.full };
  }
  return out;
}

const EVENT_TEXT: Record<string, string> = {
  created: 'Case created.',
  submitted: 'Case submitted.',
  resubmitted: 'Case submitted again.',
  files_checked: 'Files checked.',
  on_hold: 'Case put on hold.',
  released: 'Hold released.',
  cancelled: 'Case cancelled.',
  routed: 'Case approved for production.',
  rerouted: 'Production site changed.',
  claim_opened: 'Quality claim opened.',
  replacement_ordered: 'Replacement order placed.',
  rework_ordered: 'Rework order placed.',
  instructions_updated: 'Instructions updated.',
  purged: 'Case data removed after the retention period.',
  portal_pushed: 'Case sent to the K Line portal.',
  portal_push_failed: 'Sending the case to the K Line portal failed.',
};

/** Fixed wording per event type: never the free text that staff or partners typed into an event. */
function eventMessage(e: { type: string; data: any }): string {
  if (e.type === 'stage' || e.type === 'stage_reported') {
    if (e.data?.source === 'portal' && typeof e.data?.message === 'string') return e.data.message;
    if (typeof e.data?.stage === 'string') return `Stage: ${stageLabel(e.data.stage)}.`;
    return 'Stage updated.';
  }
  return EVENT_TEXT[e.type] ?? 'Case updated.';
}

/** Canonical file names (`upper/U01.stl`), never the partner's own file names (they may hold patient names). */
export function canonicalFileNames(files: any[]): Map<string, string> {
  return canonicalNames(files.map((f) => ({ id: f.id, kind: f.kind, arch: f.arch, step: f.step, is_template: f.is_template, ext: f.ext, name: `document.${f.ext || 'bin'}` })));
}

export function v1File(f: any, name: string) {
  return {
    id: f.id as string,
    name,
    kind: f.kind as string,
    arch: (f.arch as string | null) ?? null,
    step: (f.step as number | null) ?? null,
    template: !!f.is_template,
    size: Number(f.size),
    state: f.state as string,
    sha256: (f.meta?.sha256 as string | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------
export interface V1ListQuery {
  status?: string;
  simple_status?: string;
  mode?: 'standard' | 'direct';
  from?: string;
  to?: string;
  updated_since?: string;
  case_id?: string;
  page: number;
  page_size: number;
}

export async function listCasesV1(ctx: DbCtx, a: AuthContext, q: V1ListQuery, req?: Req) {
  const params: unknown[] = [a.orgId];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = ['c.org_id = $1'];
  if (q.status) where.push(`c.status = ${add(q.status)}`);
  if (q.simple_status) where.push(`c.status = ANY(${add(SIMPLE_STATUSES[q.simple_status])}::text[])`);
  if (q.mode) where.push(`c.manufacturing_mode = ${add(q.mode)}`);
  if (q.from) where.push(`${berlinDate('c.created_at')} >= ${add(q.from)}::date`);
  if (q.to) where.push(`${berlinDate('c.created_at')} <= ${add(q.to)}::date`);
  if (q.updated_since) where.push(`c.updated_at >= ${add(q.updated_since)}::timestamptz`);
  if (q.case_id) where.push(`lower(c.partner_case_id) = lower(${add(q.case_id)})`);
  const w = where.join(' AND ');
  const order = q.updated_since ? 'c.updated_at, c.id' : 'c.created_at DESC, c.id';
  const patients = canSeePatients(a);
  return tx(ctx, async (c) => {
    const total = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM cases c WHERE ${w}`, params);
    const rows = await many<any>(c, `${V1_SELECT} WHERE ${w} ORDER BY ${order} LIMIT ${add(q.page_size)} OFFSET ${add((q.page - 1) * q.page_size)}`, params);
    if (patients) {
      const named = rows.filter((r) => r.patient_enc || r.patient_first_enc);
      if (named.length) {
        // One entry for the whole page: who (the key), how many and which cases. No names in the entry.
        const actor = actorOf(a, req);
        await audit(c, {
          actorType: 'api_key', actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: a.orgId, action: 'case.names_revealed', targetType: 'case',
          details: { via: 'api_v1_list', count: named.length, refs: named.map((r) => r.ref) },
        });
      }
    }
    return { items: rows.map((r) => v1Case(r, { patient: patients })), total: total?.n ?? 0, page: q.page, page_size: q.page_size };
  });
}

/** Finds one of the caller's cases by reference (ACME-000001) or by the partner's own case ID. */
export async function findCaseRow(c: PoolClient, a: AuthContext, key: string, lock = false): Promise<any> {
  const k = key.trim();
  let row: any;
  if (REF_RE.test(k.toUpperCase())) row = await one<any>(c, `${V1_SELECT} WHERE c.org_id = $1 AND c.ref = $2${lock ? ' FOR UPDATE OF c' : ''}`, [a.orgId, k.toUpperCase()]);
  if (!row) {
    // The newest case with that ID, preferring one that is not cancelled
    row = await one<any>(
      c,
      `${V1_SELECT} WHERE c.org_id = $1 AND lower(c.partner_case_id) = lower($2) ORDER BY (c.status = 'cancelled'), c.created_at DESC LIMIT 1${lock ? ' FOR UPDATE OF c' : ''}`,
      [a.orgId, k],
    );
  }
  if (!row) throw notFound('That case could not be found.');
  return row;
}

export async function getCaseV1(ctx: DbCtx, a: AuthContext, key: string, req?: Req) {
  return tx(ctx, async (c) => {
    const row = await findCaseRow(c, a, key);
    const files = await many<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.case_id = $1 AND f.purpose = 'case' AND f.state <> 'purged' ORDER BY f.arch NULLS LAST, f.step NULLS LAST, f.is_template, f.created_at, f.id`, [row.id]);
    const events = await many<any>(
      c,
      `SELECT e.type, e.actor_type, e.data, e.created_at, e.org_id, u.org_id AS actor_org_id
         FROM case_events e LEFT JOIN users u ON e.actor_type = 'user' AND u.id::text = e.actor_id
        WHERE e.case_id = $1 ORDER BY e.created_at, e.id`,
      [row.id],
    );
    const names = canonicalFileNames(files);
    const patients = canSeePatients(a);
    if (patients && (row.patient_enc || row.patient_first_enc)) {
      const actor = actorOf(a, req);
      await audit(c, { actorType: 'api_key', actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: a.orgId, action: 'case.name_revealed', targetType: 'case', targetId: row.id, details: { ref: row.ref, via: 'api_v1' } });
    }
    return {
      ...v1Case(row, { patient: patients }),
      files: files.map((f) => v1File(f, names.get(f.id)!)),
      events: events.map((e) => ({
        type: e.type as string,
        at: iso(e.created_at),
        stage: typeof e.data?.stage === 'string' ? (e.data.stage as string) : null,
        message: eventMessage(e),
        source: eventSourceLabel(e),
      })),
    };
  });
}

const reload = (ctx: DbCtx, a: AuthContext, id: string) =>
  tx(ctx, async (c) => {
    const row = await one<any>(c, `${V1_SELECT} WHERE c.id = $1 AND c.org_id = $2`, [id, a.orgId]);
    if (!row) throw notFound('That case could not be found.');
    return v1Case(row);
  });

export interface CreateCaseV1 {
  case_id?: string | null;
  patient_name?: string | null;
  instructions?: string | null;
  priority?: 'normal' | 'rush';
  brand?: string | null;
}

export async function createCaseV1(ctx: DbCtx, a: AuthContext, input: CreateCaseV1, req?: Req) {
  let brandId: string | null = null;
  if (input.brand) {
    const b = await tx(ctx, (c) => one<{ id: string }>(c, 'SELECT id FROM brands WHERE org_id = $1 AND lower(name) = lower($2)', [a.orgId, input.brand!.trim()]));
    if (!b) throw badRequest('That brand is not set up for your company. Add it under Company profile first.', 'invalid_brand');
    brandId = b.id;
  }
  const created = await createCase(ctx, a, { caseId: input.case_id ?? null, patientName: input.patient_name ?? null, brandId, priority: input.priority, instructions: input.instructions ?? null }, req);
  return reload(ctx, a, created.id);
}

export async function registerFileV1(ctx: DbCtx, a: AuthContext, key: string, input: { name: string; size: number; arch?: 'upper' | 'lower' | null; step?: number | null; template?: boolean }) {
  const cs = await tx(ctx, (c) => findCaseRow(c, a, key));
  const u = await createUpload(ctx, a, { purpose: 'case', caseId: cs.id, name: input.name, size: input.size, arch: input.arch, step: input.step, template: input.template });
  return { file_id: u.fileId, chunk_size: u.chunkSize, chunk_count: u.chunkCount, received: u.received, state: u.state };
}

export async function getFileV1(ctx: DbCtx, a: AuthContext, id: string) {
  return tx(ctx, async (c) => {
    const f = await one<any>(c, `SELECT ${FILE_COLUMNS}, cs.ref AS case_ref FROM files f JOIN cases cs ON cs.id = f.case_id WHERE f.id = $1 AND f.org_id = $2 AND f.purpose = 'case' AND f.state <> 'purged'`, [id, a.orgId]);
    if (!f) throw notFound('That file could not be found.');
    const siblings = await many<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.case_id = $1 AND f.purpose = 'case' AND f.state <> 'purged' ORDER BY f.arch NULLS LAST, f.step NULLS LAST, f.is_template, f.created_at, f.id`, [f.case_id]);
    const name = canonicalFileNames(siblings).get(f.id)!;
    return {
      ...v1File(f, name),
      case_ref: f.case_ref as string,
      errors: ((f.validation?.errors ?? []) as { code: string; message: string }[]).map((x) => ({ code: x.code, message: x.message })),
      warnings: ((f.validation?.warnings ?? []) as { code: string; message: string }[]).map((x) => ({ code: x.code, message: x.message })),
      created_at: iso(f.created_at),
    };
  });
}

const snakeIssues = (extra: Record<string, unknown> | undefined) => {
  if (!extra) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of ['errors', 'warnings'] as const) if (Array.isArray(extra[k])) out[k] = (extra[k] as any[]).map(issue);
  return out;
};

export async function submitCaseV1(ctx: DbCtx, a: AuthContext, key: string, opts: { acknowledge_warnings?: boolean }, req?: Req) {
  const cs = await tx(ctx, (c) => findCaseRow(c, a, key));
  try {
    await submitCase(ctx, a, cs.id, { acknowledgeWarnings: opts.acknowledge_warnings }, req);
  } catch (e) {
    // Issues travel in snake_case on this API.
    if (e instanceof AppError && e.extra) throw new AppError(e.status, e.code, e.message, snakeIssues(e.extra));
    throw e;
  }
  return reload(ctx, a, cs.id);
}

// ---------------------------------------------------------------------------
// Shipments for invoicing
// ---------------------------------------------------------------------------
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000);
}

/**
 * `aligners_shipped` as the partner is invoiced. Standard cases carry the count the factory reported. The K Line portal does
 * not report a count for direct manufacturing cases, so those are invoiced by the aligners in the order (upper plus lower).
 */
export const SHIPPED_COUNT_SQL = `(CASE WHEN c.aligners_shipped > 0 THEN c.aligners_shipped WHEN c.manufacturing_mode = 'direct' THEN c.aligners_upper + c.aligners_lower ELSE c.aligners_shipped END)`;

export async function shipmentRows(c: PoolClient, opts: { orgId: string | null; from: string; to: string; limit: number }): Promise<any[]> {
  const params: unknown[] = [opts.from, opts.to, opts.limit];
  let org = '';
  if (opts.orgId) {
    params.push(opts.orgId);
    org = `AND c.org_id = $4`;
  }
  return many<any>(
    c,
    `${V1_SELECT.replace('SELECT c.*,', `SELECT c.*, ${SHIPPED_COUNT_SQL} AS shipped_count,`)}
      WHERE c.shipped_at IS NOT NULL AND c.status IN ('shipped', 'delivered') ${org}
        AND ${berlinDate('c.shipped_at')} BETWEEN $1::date AND $2::date
      ORDER BY c.shipped_at, c.id LIMIT $3`,
    params,
  );
}

export const shipmentItem = (r: any) => ({
  ref: r.ref as string,
  case_id: (r.partner_case_id as string | null) ?? null,
  shipped_at: iso(r.shipped_at),
  carrier: (r.carrier as string | null) ?? null,
  tracking_number: (r.tracking as string | null) ?? null,
  aligners_shipped: Number(r.shipped_count),
  aligners_upper: Number(r.aligners_upper),
  aligners_lower: Number(r.aligners_lower),
  templates: Number(r.aligners_templates),
  mode: r.manufacturing_mode as string,
  kind: r.kind as string,
  site: (r.site_code as string | null) ?? null,
});

export async function shipmentsV1(ctx: DbCtx, a: AuthContext, q: { from: string; to: string }) {
  const days = daysBetween(q.from, q.to);
  if (days < 0) throw badRequest('The from date must not be after the to date.', 'invalid_period');
  if (days > SHIPMENTS_MAX_DAYS) throw badRequest(`Ask for at most ${SHIPMENTS_MAX_DAYS} days at a time.`, 'period_too_long');
  return tx(ctx, async (c) => {
    const rows = await shipmentRows(c, { orgId: a.orgId, from: q.from, to: q.to, limit: SHIPMENTS_MAX_ROWS + 1 });
    if (rows.length > SHIPMENTS_MAX_ROWS) throw new AppError(413, 'too_many_rows', 'That period holds too many shipments. Ask for a shorter period.');
    const items = rows.map(shipmentItem);
    return { items, total: items.length, total_aligners: items.reduce((s, i) => s + i.aligners_shipped, 0) };
  });
}

// ---------------------------------------------------------------------------
// Claims and materials
// ---------------------------------------------------------------------------
export const CLAIM_STATUS_FILTERS = ['active', 'open', 'in_review', 'awaiting_partner', 'accepted', 'rejected', 'closed'] as const;

/** Claims without any text people typed (no summary, description or messages) and without patient data. */
export async function listClaimsV1(ctx: DbCtx, a: AuthContext, q: { status?: string; from?: string; to?: string; page: number; page_size: number }) {
  const params: unknown[] = [a.orgId];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = ['cl.org_id = $1'];
  if (q.status === 'active') where.push(`cl.status IN ('open', 'in_review', 'awaiting_partner')`);
  else if (q.status) where.push(`cl.status = ${add(q.status)}`);
  if (q.from) where.push(`${berlinDate('cl.created_at')} >= ${add(q.from)}::date`);
  if (q.to) where.push(`${berlinDate('cl.created_at')} <= ${add(q.to)}::date`);
  const w = where.join(' AND ');
  return tx(ctx, async (c) => {
    const total = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM claims cl WHERE ${w}`, params);
    const rows = await many<any>(
      c,
      `SELECT cl.number, cs.ref AS case_ref, cl.status, cl.resolution, cl.created_at, (SELECT count(*)::int FROM claim_items i WHERE i.claim_id = cl.id) AS item_count
         FROM claims cl JOIN cases cs ON cs.id = cl.case_id WHERE ${w} ORDER BY cl.created_at DESC, cl.id LIMIT ${add(q.page_size)} OFFSET ${add((q.page - 1) * q.page_size)}`,
      params,
    );
    return {
      items: rows.map((r) => ({ number: r.number as string, case_ref: r.case_ref as string, status: r.status as string, resolution: (r.resolution as string | null) ?? null, created_at: iso(r.created_at), item_count: r.item_count as number })),
      total: total?.n ?? 0,
      page: q.page,
      page_size: q.page_size,
    };
  });
}

export async function listMaterialsV1(ctx: DbCtx, a: AuthContext) {
  const { items } = await listMaterials(ctx, a, {});
  return {
    items: items.map((m) => ({
      sku: m.sku,
      name: m.name,
      category: m.category,
      unit: m.unit,
      per_case: m.perCase,
      per_aligner: m.perAligner,
      min_stock: m.minStock,
      active: m.active,
      stock: m.stock.map((s) => ({ site: s.siteCode, on_hand: s.onHand, in_transit: s.inTransit, used_28d: s.used28d, days_of_cover: s.daysOfCover, low_stock: s.lowStock })),
    })),
  };
}
