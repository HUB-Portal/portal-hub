import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { many, one, tx, type DbCtx, type PoolClient } from '../db';
import { decryptField, fieldAad } from '../crypto/keys';
import { config } from '../config';
import { AppError, badRequest, conflict, forbidden, notFound } from '../http/errors';
import { STAGE_CODE_RE, isMapTarget, isStageId, stageLabel, type MapTarget } from '../../../shared/stages';
import { CASE_SELECT, loadCase } from './cases';
import { FILE_COLUMNS } from './files';
import { canonicalNames } from './packaging';
import { bagsForMes } from './bags';
import { isRequestedFile, itemsOf } from './requested';
import { alignerCode } from '../../../shared/bag';
import { applyStage, cleanText, type EngineActor, type EngineSource, type StageTarget } from './stageEngine';
import { enforceTransferGate } from './transferGate';
import { siteIsLegal } from './transferCheck';

// ---------------------------------------------------------------------------
// Stage map
// ---------------------------------------------------------------------------
export interface StageMapRow {
  code: string;
  target: MapTarget;
  note: string;
}

export const stageMapSchema = z
  .array(
    z.object({
      code: z.string().trim().toUpperCase().regex(STAGE_CODE_RE, 'Codes use capital letters, digits and _ . - only, up to 40 characters.'),
      target: z.string().refine(isMapTarget, 'Choose a stage, hold, cancelled or ignore.'),
      note: z.string().max(200).default(''),
    }),
  )
  .min(1)
  .max(300);

/** Codes are compared without regard to case (they are stored in capitals), so "ship" and "SHIP" are the same code: a repeat is refused, never merged. */
export function assertUniqueCodes(entries: { code: string }[]): void {
  const seen = new Set<string>();
  for (const e of entries) {
    const k = e.code.toUpperCase();
    if (seen.has(k)) throw badRequest('Each code can appear only once, whatever its capital letters. Remove the repeated code.', 'duplicate_code');
    seen.add(k);
  }
}

export async function readStageMap(c: PoolClient): Promise<StageMapRow[]> {
  const rows = await many<any>(c, `SELECT mes_code, target, note FROM mes_stage_map WHERE target IS NOT NULL ORDER BY mes_code`);
  return rows.map((r) => ({ code: r.mes_code, target: r.target, note: r.note ?? '' }));
}

/** Replaces the whole map. Callers check the codes with assertUniqueCodes first. */
export async function writeStageMap(c: PoolClient, entries: StageMapRow[]): Promise<StageMapRow[]> {
  const byCode = new Map(entries.map((e) => [e.code, e]));
  const codes = [...byCode.keys()];
  await c.query('DELETE FROM mes_stage_map WHERE NOT (mes_code = ANY($1::text[]))', [codes]);
  for (const e of byCode.values()) {
    await c.query(
      `INSERT INTO mes_stage_map (mes_code, stage, target, note, label, updated_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (mes_code) DO UPDATE SET stage = EXCLUDED.stage, target = EXCLUDED.target, note = EXCLUDED.note, label = EXCLUDED.label, updated_at = now()`,
      [e.code, isStageId(e.target) ? e.target : null, e.target, e.note, isStageId(e.target) ? stageLabel(e.target) : null],
    );
  }
  return readStageMap(c);
}

// ---------------------------------------------------------------------------
// Intake for the factory system
// ---------------------------------------------------------------------------
type Req = { ip?: string; headers?: Record<string, any> };

const serviceActor = (a: AuthContext, req?: Req): EngineActor => ({
  actorType: 'service',
  actorId: a.apiKeyId,
  ip: req?.ip ?? null,
  userAgent: typeof req?.headers?.['user-agent'] === 'string' ? (req!.headers!['user-agent'] as string).slice(0, 300) : null,
});
export { serviceActor };

/** Canonical file names for the factory system: never the partner's own file names (they may hold patient names). */
export function mesFileNames(files: any[]): Map<string, string> {
  return canonicalNames(files.map((f) => ({ id: f.id, kind: f.kind, arch: f.arch, step: f.step, is_template: f.is_template, ext: f.ext, name: `document.${f.ext || 'bin'}` })));
}

/** The audit entry of one intake call lists at most this many case references. */
export const INTAKE_AUDIT_REFS = 20;

export async function mesIntake(ctx: DbCtx, a: AuthContext, opts: { site?: string; limit: number }, req?: Req) {
  const actor = serviceActor(a, req);
  return tx(ctx, async (c) => {
    const params: unknown[] = [];
    let siteWhere = '';
    if (opts.site) {
      params.push(opts.site);
      siteWhere = `AND s.code = $${params.length}`;
    }
    params.push(opts.limit);
    const candidates = await many<any>(
      c,
      `${CASE_SELECT.replace('SELECT c.*,', `SELECT c.*, (SELECT b.name FROM brands b WHERE b.id = c.brand_id) AS brand_name,`)}
        WHERE c.status = 'ready' AND c.manufacturing_mode = 'standard' AND c.site_id IS NOT NULL AND c.purged_at IS NULL ${siteWhere}
        ORDER BY c.ready_at, c.id LIMIT $${params.length}`,
      params,
    );
    // The transfer gate is checked again now: a case whose site is no longer legal for the partner (Standard Contractual Clauses withdrawn or
    // expired, site flags changed) is put on hold with the fixed reason and is not listed. K Line intake is told by reference.
    const rows: any[] = [];
    const gate = new Map<string, boolean>();
    for (const r of candidates) {
      if (!(await enforceTransferGate(c, r.id, 'mes_intake', gate))) rows.push(r);
    }
    const items = [];
    for (const r of rows) {
      const files = await many<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.case_id = $1 AND f.purpose = 'case' AND f.state = 'ready' ORDER BY f.created_at, f.id`, [r.id]);
      const requested = itemsOf(r.requested_items);
      const names = mesFileNames(files);
      let notes: string | null = null;
      if (r.notes_enc) {
        try {
          notes = decryptField(r.notes_enc, fieldAad.caseNotes(r.id));
        } catch {
          notes = null;
        }
      }
      const { bags, personalData } = await bagsForMes(c, r);
      items.push({
        ref: r.ref,
        partner: { code: r.org_code, name: r.org_name },
        partner_case_id: r.partner_case_id ?? null,
        kind: r.kind,
        parent_ref: r.parent_ref ?? null,
        priority: r.priority,
        site: r.site_code,
        ready_at: r.ready_at instanceof Date ? r.ready_at.toISOString() : r.ready_at,
        expected_ship_date: r.due_date ?? null,
        spec_version: r.spec_version ?? null,
        claim_number: r.claim_number ?? null,
        brand: r.brand_name ?? null,
        notes,
        acknowledged_warnings: r.warnings_acknowledged ? (r.checks?.warnings ?? []) : [],
        aligner_counts: { upper: r.aligners_upper, lower: r.aligners_lower, templates: r.aligners_templates },
        // Replacement and rework cases: the aligners to make again. Empty for a new case (everything is required).
        items: (requested ?? []).map((i) => ({ aligner: alignerCode(i.arch, i.step) + (i.template ? '_T' : ''), arch: i.arch, step: i.step, template: i.template, defect_code: i.defectCode ?? null })),
        files: files.map((f) => ({
          id: f.id,
          name: names.get(f.id)!,
          kind: f.kind,
          arch: f.arch,
          step: f.step,
          template: f.is_template,
          // false for the parent's files that are not part of this replacement or rework order
          requested: isRequestedFile(f, requested),
          bytes: Number(f.size),
          sha256: f.meta?.sha256 ?? null,
          download_url: `${config.publicUrl}/api/mes/v1/files/${f.id}`,
        })),
        bags,
        bag_personal_data: personalData,
      });
    }
    // One audit entry per call (not one per case and poll, which would bury the log): how many cases and the first references. The partners'
    // own access logs still show every file the factory system downloads (file.download) and every acknowledgement.
    await audit(c, {
      actorType: 'service', actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: a.orgId, action: 'mes.intake_read',
      details: { cases: items.length, refs: items.slice(0, INTAKE_AUDIT_REFS).map((i) => i.ref), site: opts.site ?? null },
    });
    return { cases: items };
  });
}

/** A file of a routed case, for the factory system. Audited to the partner organisation as a K Line access. */
export async function mesFile(ctx: DbCtx, a: AuthContext, fileId: string, req?: Req) {
  const actor = serviceActor(a, req);
  return tx(ctx, async (c) => {
    const f = await one<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.id = $1`, [fileId]);
    if (!f || !f.case_id) throw notFound('That file could not be found.');
    const cs = await one<any>(c, 'SELECT id, org_id, ref, status, site_id, manufacturing_mode FROM cases WHERE id = $1', [f.case_id]);
    if (!cs || cs.manufacturing_mode !== 'standard' || !cs.site_id || !['ready', 'received', 'in_production'].includes(cs.status)) throw notFound('That file could not be found.');
    // The transfer gate again: no file leaves the Hub for a site that is no longer legal for the partner. The case is put on hold when it is
    // ready or received; one already in production only stops the download. Either way the refusal is committed with its audit entry.
    const site = await one<any>(c, 'SELECT code, country, eea, adequacy FROM sites WHERE id = $1', [cs.site_id]);
    if (site && !(await siteIsLegal(c, cs.org_id, site))) {
      if (!(await enforceTransferGate(c, cs.id, 'mes_file'))) {
        await audit(c, { actorType: 'service', actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: cs.org_id, action: 'case.transfer_blocked', targetType: 'case', targetId: cs.id, details: { ref: cs.ref, site: site.code, from: cs.status, trigger: 'mes_file' } });
      }
      return { blocked: true as const };
    }
    if (f.state !== 'ready') throw conflict('This file is not available for download.', 'file_not_available');
    const siblings = await many<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.case_id = $1 AND f.purpose = 'case' AND f.state = 'ready' ORDER BY f.created_at, f.id`, [f.case_id]);
    const names = mesFileNames(siblings);
    await audit(c, { actorType: 'service', actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: f.org_id, action: 'file.download', targetType: 'file', targetId: fileId, details: { caseId: f.case_id, kind: f.kind, size: Number(f.size), via: 'mes' } });
    return { blocked: false as const, row: f, downloadName: (names.get(f.id) ?? 'file').split('/').pop()! };
  }).then((r) => {
    if (r.blocked) throw forbidden('Transfer to this site is not covered at the moment. K Line has been told.', 'transfer_blocked');
    return r;
  });
}

const MES_CASE_ID = /^[A-Za-z0-9_.:/#-]{1,64}$/;

export async function mesAck(ctx: DbCtx, a: AuthContext, ref: string, mesCaseId: string, req?: Req) {
  if (!MES_CASE_ID.test(mesCaseId)) throw badRequest('The factory case number is not valid.', 'invalid_request');
  const actor = serviceActor(a, req);
  return tx(ctx, async (c) => {
    const found = await one<{ id: string }>(c, 'SELECT id FROM cases WHERE ref = $1', [ref]);
    if (!found) throw notFound('That case could not be found.');
    const row = await loadCase(c, found.id, true);
    if (row.mes_case_id && row.mes_case_id !== mesCaseId) throw conflict('This case already has a different factory case number.', 'mes_case_id_mismatch');
    if (row.manufacturing_mode !== 'standard') throw conflict('This case is not produced through the factory system.', 'not_standard');
    const taken = await one(c, 'SELECT 1 FROM cases WHERE mes_case_id = $1 AND id <> $2', [mesCaseId, row.id]);
    if (taken) throw conflict('That factory case number belongs to another case.', 'mes_case_id_taken');
    if (row.status !== 'ready') {
      if (['received', 'in_production', 'shipped', 'delivered'].includes(row.status) && row.mes_case_id === mesCaseId) return { ok: true, already: true, status: row.status };
      throw conflict('Only a case that is ready can be acknowledged.', 'case_not_ready');
    }
    const r = await applyStage(c, row, { target: 'received', source: 'mes', occurredAt: new Date(), mesCaseId }, actor);
    if (r.outcome !== 'applied') throw conflict(r.message ?? 'The case cannot be acknowledged now.', r.code ?? 'case_not_ready');
    return { ok: true, already: false, status: r.status };
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
const optText = (max: number) => z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().max(max).optional());

export const eventSchema = z.object({
  event_id: z.string().trim().min(1).max(100),
  case_ref: optText(40),
  mes_case_id: optText(64),
  partner_code: optText(20),
  partner_case_id: optText(64),
  stage_code: z.string().trim().min(1).max(60),
  occurred_at: z.string().trim().min(1).max(40),
  carrier: optText(200),
  tracking_number: optText(300),
  aligners_shipped: z.preprocess((v) => (v === '' || v === null ? undefined : typeof v === 'string' ? Number(v) : v), z.number().int().min(0).max(1_000_000).optional()),
  hold_reason: optText(2000),
});
export type MesEvent = z.infer<typeof eventSchema>;

export interface EventResult {
  event_id: string | null;
  outcome: 'applied' | 'duplicate' | 'ignored' | 'error';
  message?: string;
}

export const MAX_EVENTS_PER_CALL = 500;

type Lookup = { kind: 'ref' | 'mes_case_id' | 'partner_case_id'; row?: any; problem?: string };

async function findCase(c: PoolClient, e: MesEvent): Promise<Lookup> {
  if (e.case_ref) {
    const r = await one<{ id: string }>(c, 'SELECT id FROM cases WHERE ref = $1', [e.case_ref]);
    return { kind: 'ref', row: r ? await loadCase(c, r.id, true) : undefined };
  }
  if (e.mes_case_id) {
    const r = await one<{ id: string }>(c, 'SELECT id FROM cases WHERE mes_case_id = $1', [e.mes_case_id]);
    return { kind: 'mes_case_id', row: r ? await loadCase(c, r.id, true) : undefined };
  }
  if (e.partner_code && e.partner_case_id) {
    const rs = await many<{ id: string; cancelled_at: Date | null }>(
      c,
      `SELECT c.id, c.cancelled_at FROM cases c JOIN organizations o ON o.id = c.org_id
        WHERE o.code = $1 AND lower(c.partner_case_id) = lower($2) AND c.manufacturing_mode = 'standard' ORDER BY c.created_at DESC LIMIT 5`,
      [e.partner_code.toUpperCase(), e.partner_case_id],
    );
    const live = rs.filter((x) => !x.cancelled_at);
    if (live.length > 1) return { kind: 'partner_case_id', problem: 'More than one case matches. Use the K Line reference.' };
    const pick = live[0] ?? rs[0];
    return { kind: 'partner_case_id', row: pick ? await loadCase(c, pick.id, true) : undefined };
  }
  return { kind: 'ref', problem: 'Give a case reference, a factory case number, or a partner code with a partner case ID.' };
}

/** What is stored about an event: identifiers and codes only. Free text and partner case IDs stay out. */
function loggedPayload(e: Partial<MesEvent>, lookup?: string): Record<string, unknown> {
  return {
    event_id: e.event_id ?? null,
    case_ref: e.case_ref ?? null,
    mes_case_id: e.mes_case_id ?? null,
    lookup: lookup ?? null,
    stage_code: e.stage_code ? e.stage_code.slice(0, 60) : null,
    occurred_at: e.occurred_at ?? null,
    carrier: e.carrier ? e.carrier.slice(0, 60) : null,
    tracking_number: e.tracking_number ? e.tracking_number.slice(0, 100) : null,
    aligners_shipped: e.aligners_shipped ?? null,
    hold_reason_given: !!e.hold_reason,
  };
}

/**
 * Processes events one by one, each in its own transaction, so one bad event never blocks the rest.
 * Idempotent on event_id: an event that was applied or ignored before is reported as duplicate.
 * Errors do not reserve the event_id, so the sender can correct the cause and send the same event again.
 */
export async function processEvents(ctx: DbCtx, raw: unknown[], opts: { source: EngineSource; actor: EngineActor }): Promise<EventResult[]> {
  const map = new Map((await tx(ctx, (c) => readStageMap(c))).map((r) => [r.code, r.target]));
  const results: EventResult[] = [];
  for (const item of raw) {
    results.push(await processOne(ctx, item, map, opts));
  }
  return results;
}

async function processOne(ctx: DbCtx, item: unknown, map: Map<string, MapTarget>, opts: { source: EngineSource; actor: EngineActor }): Promise<EventResult> {
  const parsed = eventSchema.safeParse(item);
  const logSource = opts.source === 'csv' ? 'csv' : 'mes';
  if (!parsed.success) {
    const id = typeof (item as any)?.event_id === 'string' ? String((item as any).event_id).slice(0, 100) : null;
    const message = 'The event is missing details or has values that are not valid.';
    await tx(ctx, (c) =>
      c.query(`INSERT INTO mes_events (external_id, payload, source, outcome, message, processed_at) VALUES (NULL, $1::jsonb, $2, 'error', $3, now())`, [JSON.stringify({ event_id: id }), logSource, message]),
    );
    return { event_id: id, outcome: 'error', message };
  }
  const e = parsed.data;
  const occurred = /^\d{4}-\d{2}-\d{2}/.test(e.occurred_at) ? new Date(e.occurred_at) : new Date(Number.NaN);
  const code = e.stage_code.toUpperCase();

  return tx(ctx, async (c): Promise<EventResult> => {
    const claim = await c.query(
      `INSERT INTO mes_events (external_id, payload, source, stage_code, occurred_at) VALUES ($1, $2::jsonb, $3, $4, $5)
       ON CONFLICT (external_id) DO NOTHING RETURNING id`,
      [e.event_id, JSON.stringify(loggedPayload(e)), logSource, code.slice(0, 60), Number.isNaN(occurred.getTime()) ? null : occurred],
    );
    if (!claim.rowCount) {
      await c.query(
        `INSERT INTO mes_events (external_id, payload, source, stage_code, occurred_at, outcome, message, processed_at) VALUES (NULL, $1::jsonb, $2, $3, $4, 'duplicate', 'This event was already received.', now())`,
        [JSON.stringify(loggedPayload(e)), logSource, code.slice(0, 60), Number.isNaN(occurred.getTime()) ? null : occurred],
      );
      return { event_id: e.event_id, outcome: 'duplicate', message: 'This event was already received.' };
    }
    const logId = claim.rows[0].id as string;
    const finish = async (outcome: 'applied' | 'ignored' | 'error', message: string | undefined, caseId: string | null, lookup?: string): Promise<EventResult> => {
      await c.query(
        `UPDATE mes_events SET outcome = $2, message = $3, case_id = $4, processed_at = now(), payload = $5::jsonb,
                external_id = CASE WHEN $2 = 'error' THEN NULL ELSE external_id END WHERE id = $1`,
        [logId, outcome, message ?? null, caseId, JSON.stringify(loggedPayload(e, lookup))],
      );
      return { event_id: e.event_id, outcome, ...(message ? { message } : {}) };
    };

    if (Number.isNaN(occurred.getTime())) return finish('error', 'The time of the event is not a valid date.', null);
    const target = map.get(code);
    if (!target) return finish('error', STAGE_CODE_RE.test(code) ? `The stage code ${code} is not in the stage map.` : 'The stage code is not in the stage map.', null);

    const found = await findCase(c, e);
    if (found.problem) return finish('error', found.problem, null, found.kind);
    if (!found.row) return finish('error', 'The case could not be found.', null, found.kind);
    if (target === 'ignore') return finish('ignored', 'This stage code is set to be ignored.', found.row.id, found.kind);

    const r = await applyStage(
      c,
      found.row,
      {
        target: target as StageTarget,
        source: opts.source,
        occurredAt: occurred,
        carrier: e.carrier,
        trackingNumber: e.tracking_number,
        alignersShipped: e.aligners_shipped,
        holdReason: e.hold_reason,
        mesCaseId: e.mes_case_id,
      },
      opts.actor,
    );
    return finish(r.outcome, r.message, found.row.id, found.kind);
  }).catch(async (err) => {
    // An unexpected failure (for example a unique factory case number clash) rolls the event back and is reported without details.
    if (err instanceof AppError) throw err;
    await tx(ctx, (c) =>
      c.query(`INSERT INTO mes_events (external_id, payload, source, stage_code, outcome, message, processed_at) VALUES (NULL, $1::jsonb, $2, $3, 'error', 'The event could not be processed.', now())`, [JSON.stringify(loggedPayload(e)), logSource, code.slice(0, 60)]),
    ).catch(() => undefined);
    return { event_id: e.event_id, outcome: 'error' as const, message: 'The event could not be processed.' };
  });
}

// ---------------------------------------------------------------------------
// CSV import of events
// ---------------------------------------------------------------------------
export const CSV_COLUMNS = ['event_id', 'case_ref', 'partner_code', 'partner_case_id', 'mes_case_id', 'stage_code', 'occurred_at', 'carrier', 'tracking_number', 'aligners_shipped', 'hold_reason'] as const;
export const MAX_IMPORT_ROWS = 5000;

/** Small RFC 4180 reader: quoted cells, doubled quotes, CRLF or LF, optional BOM. Returns rows of cells. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
      any = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
      any = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      if (any || cell !== '') {
        row.push(cell);
        rows.push(row);
      }
      row = [];
      cell = '';
      any = false;
    } else {
      cell += ch;
      any = true;
    }
  }
  if (any || cell !== '') {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

export interface ImportRowResult extends EventResult {
  row: number;
}

export async function importEventsCsv(ctx: DbCtx, a: AuthContext, text: string, req?: Req) {
  const table = parseCsv(text);
  if (table.length < 2) throw badRequest('The file needs a header row and at least one event.', 'empty_import');
  if (table.length - 1 > MAX_IMPORT_ROWS) throw badRequest(`Import at most ${MAX_IMPORT_ROWS.toLocaleString('en-GB')} events at a time.`, 'too_many_rows');
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  for (const need of ['stage_code', 'occurred_at']) {
    if (!header.includes(need)) throw badRequest(`The header row needs a ${need} column.`, 'missing_column');
  }
  const idx = new Map<string, number>();
  header.forEach((h, i) => {
    if ((CSV_COLUMNS as readonly string[]).includes(h) && !idx.has(h)) idx.set(h, i);
  });
  const events = table.slice(1).map((cells) => {
    const o: Record<string, string> = {};
    for (const [k, i] of idx) o[k] = (cells[i] ?? '').trim();
    if (!o.event_id) {
      // Repeating the same file must not double count: a blank ID becomes a hash of the row.
      o.event_id = 'csv:' + createHash('sha256').update(JSON.stringify(cells.map((x) => x.trim()))).digest('hex').slice(0, 32);
    }
    return o;
  });
  const actor: EngineActor = { actorType: 'user', actorId: a.userId, ip: req?.ip ?? null, userAgent: typeof req?.headers?.['user-agent'] === 'string' ? (req!.headers!['user-agent'] as string).slice(0, 300) : null };
  const results = await processEvents(ctx, events, { source: 'csv', actor });
  const summary = { total: results.length, applied: 0, ignored: 0, error: 0, duplicate: 0 };
  for (const r of results) summary[r.outcome]++;
  await tx(ctx, (c) => audit(c, { actorType: 'user', actorId: a.userId, ip: actor.ip, userAgent: actor.userAgent, orgId: a.orgId, action: 'mes.events_imported', details: summary }));
  return { summary, results: results.map((r, i): ImportRowResult => ({ row: i + 2, ...r })) };
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------
export async function listMesEvents(ctx: DbCtx, q: { outcome?: string; page: number; pageSize: number }) {
  return tx(ctx, async (c) => {
    const params: unknown[] = [];
    const where = q.outcome ? (params.push(q.outcome), `WHERE e.outcome = $1`) : '';
    const total = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM mes_events e ${where}`, params);
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await many<any>(
      c,
      `SELECT e.id, e.external_id, e.payload, e.source, e.outcome, e.message, e.stage_code, e.occurred_at, e.received_at, cs.ref AS case_ref
         FROM mes_events e LEFT JOIN cases cs ON cs.id = e.case_id ${where}
        ORDER BY e.received_at DESC, e.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        eventId: r.external_id ?? r.payload?.event_id ?? null,
        source: r.source,
        caseRef: r.case_ref ?? r.payload?.case_ref ?? null,
        stageCode: r.stage_code,
        outcome: r.outcome,
        message: r.message,
        occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at,
        receivedAt: r.received_at instanceof Date ? r.received_at.toISOString() : r.received_at,
      })),
      total: total?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  });
}
