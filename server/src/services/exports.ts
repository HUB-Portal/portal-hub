import { Readable } from 'node:stream';
import type { AuthContext } from '../auth/context';
import { requireStepUp } from '../auth/context';
import { audit } from '../audit';
import { many, one, tx, type DbCtx, type PoolClient } from '../db';
import { AppError, badRequest, forbidden, notFound } from '../http/errors';
import { simpleStatus } from '../../../shared/stages';
import { CASE_SELECT, patientOf } from './cases';
import { csvCell } from './packaging';
import { SHIPPED_COUNT_SQL, berlinDate, daysBetween } from './v1';

/**
 * CSV exports of cases and shipments. Streamed in batches (a batch per short transaction), at most 100,000 rows.
 * Patient names are only included for people who may reveal names, after a fresh authenticator code, and the export is
 * audited in the partner's log as a bulk name reveal with the number of rows.
 */
export const EXPORT_MAX_ROWS = 100_000;
const DEFAULT_BATCH = 500;
const limits = { maxRows: EXPORT_MAX_ROWS, batch: DEFAULT_BATCH };
/** For tests: smaller caps. Call with no arguments to restore. */
export function setExportLimits(o: { maxRows?: number; batch?: number } = {}): void {
  limits.maxRows = o.maxRows ?? EXPORT_MAX_ROWS;
  limits.batch = o.batch ?? DEFAULT_BATCH;
}

export type ExportKind = 'cases' | 'shipments';

export interface ExportQuery {
  from: string;
  to: string;
  includeNames: boolean;
  dateField: 'created' | 'shipped';
  orgId?: string;
}

/** csvCell defuses leading = + - @; a leading tab or carriage return also starts a formula in some spreadsheets. */
export function exportCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[\t\r]/.test(s)) s = "'" + s;
  return csvCell(s);
}

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? '');

const CASE_COLUMNS = ['ref', 'case_id', 'mode', 'kind', 'status', 'simple_status', 'stage', 'priority', 'brand', 'site', 'created_at', 'submitted_at', 'shipped_at', 'delivered_at', 'aligners_upper', 'aligners_lower', 'templates', 'aligners_shipped', 'carrier', 'tracking_number'];
const SHIPMENT_COLUMNS = ['ref', 'case_id', 'mode', 'kind', 'site', 'shipped_at', 'delivered_at', 'carrier', 'tracking_number', 'aligners_shipped', 'aligners_upper', 'aligners_lower', 'templates'];
export const NAME_COLUMNS = ['first_name', 'last_name', 'name'];

function lineFor(kind: ExportKind, r: any, names: boolean): string {
  const base =
    kind === 'cases'
      ? [r.ref, r.partner_case_id, r.manufacturing_mode, r.kind, r.status, simpleStatus(r), r.stage, r.priority, r.brand_name, r.site_code, iso(r.created_at), iso(r.submitted_at), iso(r.shipped_at), iso(r.delivered_at), r.aligners_upper, r.aligners_lower, r.aligners_templates, r.shipped_count, r.carrier, r.tracking]
      : [r.ref, r.partner_case_id, r.manufacturing_mode, r.kind, r.site_code, iso(r.shipped_at), iso(r.delivered_at), r.carrier, r.tracking, r.shipped_count, r.aligners_upper, r.aligners_lower, r.aligners_templates];
  if (names) {
    const p = patientOf(r);
    base.push(p.first, p.last, p.full);
  }
  return base.map(exportCell).join(',') + '\r\n';
}

interface Resolved {
  ctx: DbCtx;
  orgId: string | null;
}

async function resolveScope(a: AuthContext, q: ExportQuery): Promise<Resolved> {
  if (a.orgKind === 'partner') return { ctx: { orgId: a.orgId, bypass: false }, orgId: a.orgId };
  const ctx: DbCtx = { orgId: a.orgId, bypass: true };
  if (!q.orgId) {
    if (q.includeNames) throw badRequest('Choose a partner company to export names.', 'org_required');
    return { ctx, orgId: null };
  }
  const org = await tx(ctx, (c) => one<{ id: string }>(c, `SELECT id FROM organizations WHERE id = $1 AND kind = 'partner'`, [q.orgId]));
  if (!org) throw notFound('That company could not be found.');
  return { ctx, orgId: org.id };
}

function whereFor(kind: ExportKind, q: ExportQuery, orgId: string | null, params: unknown[]): string {
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const w: string[] = [];
  if (orgId) w.push(`c.org_id = ${add(orgId)}`);
  else w.push(`o.kind = 'partner'`);
  const col = kind === 'shipments' || q.dateField === 'shipped' ? 'c.shipped_at' : 'c.created_at';
  if (col === 'c.shipped_at') w.push('c.shipped_at IS NOT NULL');
  if (kind === 'shipments') w.push(`c.status IN ('shipped', 'delivered')`);
  w.push(`${berlinDate(col)} BETWEEN ${add(q.from)}::date AND ${add(q.to)}::date`);
  return w.join(' AND ');
}

const COUNTED = `(CASE WHEN c.status IN ('shipped', 'delivered') THEN ${SHIPPED_COUNT_SQL} ELSE c.aligners_shipped END)`;

export interface PreparedExport {
  filename: string;
  stream: Readable;
  rows: number;
}

/** Checks everything, writes the audit entries, then returns the stream. Nothing is read from the database by the stream until it is consumed. */
export async function prepareExport(a: AuthContext, req: { ip?: string; headers?: Record<string, any> }, kind: ExportKind, q: ExportQuery): Promise<PreparedExport> {
  if (daysBetween(q.from, q.to) < 0) throw badRequest('The from date must not be after the to date.', 'invalid_period');
  if (q.includeNames) {
    // Names are a bulk reveal: the permission first, then a fresh authenticator code.
    if (!a.permissions.has('case.reveal_name')) throw forbidden('You do not have permission to export patient names.');
    requireStepUp(a);
  }
  const { ctx, orgId } = await resolveScope(a, q);
  const params: unknown[] = [];
  const where = whereFor(kind, q, orgId, params);
  const sortCol = kind === 'shipments' || q.dateField === 'shipped' ? 'c.shipped_at' : 'c.created_at';
  const ua = typeof req.headers?.['user-agent'] === 'string' ? (req.headers!['user-agent'] as string).slice(0, 300) : null;

  const counts = await tx(ctx, async (c) => {
    const rows = await many<{ org_id: string; n: number }>(c, `SELECT c.org_id, count(*)::int AS n FROM cases c JOIN organizations o ON o.id = c.org_id WHERE ${where} GROUP BY c.org_id`, params);
    const total = rows.reduce((s, r) => s + r.n, 0);
    if (total > limits.maxRows) {
      throw new AppError(413, 'too_many_rows', `That period holds more than ${limits.maxRows.toLocaleString('en-GB')} rows. Choose a shorter period and export in parts.`);
    }
    // The partner sees every export of its data in its access log; names are logged as a bulk reveal with the row count.
    for (const r of rows) {
      const common = { from: q.from, to: q.to, dateField: kind === 'shipments' ? 'shipped' : q.dateField, rows: r.n };
      await audit(c, {
        actorType: 'user', actorId: a.userId, ip: req.ip ?? null, userAgent: ua, orgId: r.org_id, action: kind === 'cases' ? 'export.cases_csv' : 'export.shipments_csv',
        targetType: 'export', details: { ...common, includeNames: q.includeNames },
      });
      if (q.includeNames) {
        await audit(c, {
          actorType: 'user', actorId: a.userId, ip: req.ip ?? null, userAgent: ua, orgId: r.org_id, action: 'case.names_revealed', targetType: 'case',
          details: { via: 'export', export: kind === 'cases' ? 'cases.csv' : 'shipments.csv', count: r.n, from: q.from, to: q.to },
        });
      }
    }
    return total;
  });

  const cols = [...(kind === 'cases' ? CASE_COLUMNS : SHIPMENT_COLUMNS), ...(q.includeNames ? NAME_COLUMNS : [])];
  async function* generate(): AsyncGenerator<string> {
    yield '﻿' + cols.join(',') + '\r\n';
    let sent = 0;
    let after: { ts: string; id: string } | null = null;
    for (;;) {
      const p = [...params];
      let keyset = '';
      if (after) {
        p.push(after.ts, after.id);
        keyset = `AND (${sortCol}, c.id) > ($${p.length - 1}::timestamptz, $${p.length}::uuid)`;
      }
      p.push(Math.min(limits.batch, limits.maxRows - sent));
      const batch: any[] = await tx(ctx, (c: PoolClient) =>
        many<any>(
          c,
          `${CASE_SELECT.replace('SELECT c.*,', `SELECT c.*, (SELECT b.name FROM brands b WHERE b.id = c.brand_id) AS brand_name, ${kind === 'cases' ? COUNTED : SHIPPED_COUNT_SQL} AS shipped_count,
             to_char(${sortCol} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key,`)}
            WHERE ${where} ${keyset} ORDER BY ${sortCol}, c.id LIMIT $${p.length}`,
          p,
        ),
      );
      if (!batch.length) return;
      yield batch.map((r) => lineFor(kind, r, q.includeNames)).join('');
      sent += batch.length;
      const last = batch[batch.length - 1];
      after = { ts: last.sort_key, id: last.id };
      if (batch.length < limits.batch || sent >= limits.maxRows) return;
    }
  }
  const tag = `${q.from}_to_${q.to}`;
  return { filename: `${kind}_${tag}.csv`, stream: Readable.from(generate(), { objectMode: false }), rows: counts };
}
