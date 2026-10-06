import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { many, one, tx, type DbCtx, type PoolClient } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { assertNoBidi } from '../http/util';
import { actorOf, type Actor } from './cases';
import { FILE_COLUMNS, fileDto } from './files';
import { notifyKline, notifyOrg } from './notify';
import { orgUploadState } from './org';
import { assertInScope, siteScope } from './scope';
import { emitMaterialsWebhook } from './webhooks';

type Req = { ip?: string; headers?: Record<string, any> };

export const MATERIAL_CATEGORIES = ['box', 'bag', 'elastic', 'button', 'insert', 'other'] as const;
export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number];
export const QUANTITY_MAX = 1_000_000;
export const SHIPMENT_STATUSES = ['in_transit', 'received', 'discrepancy', 'cancelled'] as const;

const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? null);
const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));

const auditMat = (c: PoolClient, actor: Actor, orgId: string, action: string, targetType: string, targetId: string | null, details: Record<string, unknown> = {}) =>
  audit(c, { actorType: actor.actorType, actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId, action, targetType, targetId, details });

// ---------------------------------------------------------------------------
// Items and stock
// ---------------------------------------------------------------------------
export interface StockRow {
  siteCode: string;
  siteName: string;
  onHand: number;
  inTransit: number;
  used28d: number;
  daysOfCover: number | null;
  lowStock: boolean;
}

/** Days of cover = on hand / (used in the last 28 days / 28), null when nothing was used. */
export function daysOfCover(onHand: number, used28d: number): number | null {
  if (!(used28d > 0)) return null;
  return Math.round((Math.max(onHand, 0) / (used28d / 28)) * 10) / 10;
}

/** Stock per material and site for one organisation: the default site and every site that held or was sent the material. */
async function stockByMaterial(c: PoolClient, orgId: string): Promise<Map<string, StockRow[]>> {
  const mats = await many<any>(c, 'SELECT id, min_stock FROM materials WHERE org_id = $1', [orgId]);
  const moves = await many<any>(
    c,
    `SELECT mv.material_id, mv.site_id, sum(mv.quantity) AS on_hand,
            COALESCE(sum(-mv.quantity) FILTER (WHERE mv.kind = 'consumption' AND mv.created_at > now() - interval '28 days'), 0) AS used28
       FROM material_movements mv WHERE mv.org_id = $1 GROUP BY mv.material_id, mv.site_id`,
    [orgId],
  );
  const transit = await many<any>(
    c,
    `SELECT l.material_id, s.site_id, sum(l.quantity) AS in_transit
       FROM material_shipment_lines l JOIN material_shipments s ON s.id = l.shipment_id WHERE s.org_id = $1 AND s.status = 'in_transit' GROUP BY l.material_id, s.site_id`,
    [orgId],
  );
  const anyShipment = await many<any>(
    c,
    `SELECT DISTINCT l.material_id, s.site_id FROM material_shipment_lines l JOIN material_shipments s ON s.id = l.shipment_id WHERE s.org_id = $1 AND s.status <> 'cancelled'`,
    [orgId],
  );
  const def = await one<{ default_site_id: string | null }>(c, 'SELECT default_site_id FROM organizations WHERE id = $1', [orgId]);
  const sites = new Map((await many<any>(c, 'SELECT id, code, name FROM sites')).map((s) => [s.id as string, s]));
  const out = new Map<string, StockRow[]>();
  for (const m of mats) {
    const ids = new Set<string>();
    if (def?.default_site_id) ids.add(def.default_site_id);
    for (const r of moves) if (r.material_id === m.id) ids.add(r.site_id);
    for (const r of transit) if (r.material_id === m.id) ids.add(r.site_id);
    for (const r of anyShipment) if (r.material_id === m.id) ids.add(r.site_id);
    const rows = [...ids]
      .map((siteId): StockRow => {
        const mv = moves.find((r) => r.material_id === m.id && r.site_id === siteId);
        const tr = transit.find((r) => r.material_id === m.id && r.site_id === siteId);
        const onHand = num(mv?.on_hand);
        const used = num(mv?.used28);
        const s = sites.get(siteId);
        return {
          siteCode: s?.code ?? '',
          siteName: s?.name ?? '',
          onHand,
          inTransit: num(tr?.in_transit),
          used28d: used,
          daysOfCover: daysOfCover(onHand, used),
          lowStock: num(m.min_stock) > 0 && onHand < num(m.min_stock),
        };
      })
      .sort((x, y) => x.siteCode.localeCompare(y.siteCode));
    out.set(m.id, rows);
  }
  return out;
}

function materialDto(row: any, stock: StockRow[]) {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    orgName: (row.org_name as string | undefined) ?? undefined,
    sku: row.sku as string,
    name: row.name as string,
    category: row.category as MaterialCategory,
    unit: row.unit as string,
    perCase: num(row.per_case),
    perAligner: num(row.per_aligner),
    minStock: num(row.min_stock),
    active: row.active as boolean,
    stock,
    createdAt: iso(row.created_at),
  };
}

export async function listMaterials(ctx: DbCtx, a: AuthContext, opts: { orgId?: string }) {
  return tx(ctx, async (c) => {
    const orgs = a.orgKind === 'partner' ? [a.orgId] : opts.orgId ? [opts.orgId] : (await many<{ id: string }>(c, `SELECT id FROM organizations WHERE kind = 'partner' ORDER BY lower(name)`)).map((o) => o.id);
    const items = [];
    for (const orgId of orgs) {
      const stock = await stockByMaterial(c, orgId);
      const rows = await many<any>(c, `SELECT m.*, o.name AS org_name FROM materials m JOIN organizations o ON o.id = m.org_id WHERE m.org_id = $1 ORDER BY m.active DESC, lower(m.name), m.id`, [orgId]);
      for (const r of rows) items.push(materialDto(r, stock.get(r.id) ?? []));
    }
    return { items };
  });
}

export interface MaterialInput {
  sku: string;
  name: string;
  category: MaterialCategory;
  unit: string;
  perCase: number;
  perAligner: number;
  minStock: number;
  active?: boolean;
}

function checkRules(i: Partial<MaterialInput>): void {
  assertNoBidi(i.sku, i.name, i.unit);
  for (const k of ['perCase', 'perAligner', 'minStock'] as const) {
    const v = i[k];
    if (v !== undefined && (!Number.isFinite(v) || v < 0 || v > QUANTITY_MAX)) throw badRequest('Usage rules and minimum stock must be zero or more.', 'invalid_rules');
  }
}

export async function createMaterial(ctx: DbCtx, a: AuthContext, input: MaterialInput, req?: Req) {
  if (a.orgKind !== 'partner') throw forbidden('Materials are managed by the partner who supplies them.');
  checkRules(input);
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    try {
      const r = await one<any>(
        c,
        `INSERT INTO materials (org_id, sku, name, category, unit, per_case, per_aligner, min_stock, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [a.orgId, input.sku.trim(), input.name.trim(), input.category, input.unit.trim(), input.perCase, input.perAligner, input.minStock, input.active ?? true],
      );
      await auditMat(c, actor, a.orgId, 'material.created', 'material', r!.id, { sku: r!.sku });
      return { material: materialDto(r, []) };
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('You already have a material with that SKU.', 'sku_exists');
      throw err;
    }
  });
}

export async function updateMaterial(ctx: DbCtx, a: AuthContext, id: string, input: Partial<MaterialInput>, req?: Req) {
  if (a.orgKind !== 'partner') throw forbidden('Materials are managed by the partner who supplies them.');
  checkRules(input);
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await one<any>(c, 'SELECT * FROM materials WHERE id = $1 FOR UPDATE', [id]);
    if (!row) throw notFound('That material could not be found.');
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.sku !== undefined) set('sku', input.sku.trim());
    if (input.name !== undefined) set('name', input.name.trim());
    if (input.category !== undefined) set('category', input.category);
    if (input.unit !== undefined) set('unit', input.unit.trim());
    if (input.perCase !== undefined) set('per_case', input.perCase);
    if (input.perAligner !== undefined) set('per_aligner', input.perAligner);
    if (input.minStock !== undefined) set('min_stock', input.minStock);
    if (input.active !== undefined) set('active', input.active);
    if (!sets.length) return { material: materialDto(row, (await stockByMaterial(c, row.org_id)).get(id) ?? []) };
    try {
      await c.query(`UPDATE materials SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('You already have a material with that SKU.', 'sku_exists');
      throw err;
    }
    await auditMat(c, actor, row.org_id, 'material.updated', 'material', id, { sku: input.sku ?? row.sku });
    const fresh = await one<any>(c, 'SELECT * FROM materials WHERE id = $1', [id]);
    return { material: materialDto(fresh, (await stockByMaterial(c, row.org_id)).get(id) ?? []) };
  });
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------
const SHIPMENT_SELECT = `SELECT s.*, o.name AS org_name, o.code AS org_code, st.code AS site_code, st.name AS site_name
  FROM material_shipments s JOIN organizations o ON o.id = s.org_id JOIN sites st ON st.id = s.site_id`;

async function linesOf(c: PoolClient, shipmentIds: string[]): Promise<Map<string, any[]>> {
  const rows = shipmentIds.length
    ? await many<any>(
        c,
        `SELECT l.id, l.shipment_id, l.material_id, l.quantity, l.received_quantity, m.sku, m.name, m.unit
           FROM material_shipment_lines l JOIN materials m ON m.id = l.material_id WHERE l.shipment_id = ANY($1::uuid[]) ORDER BY lower(m.name), l.id`,
        [shipmentIds],
      )
    : [];
  const out = new Map<string, any[]>();
  for (const r of rows) {
    const list = out.get(r.shipment_id) ?? [];
    list.push({
      id: r.id,
      materialId: r.material_id,
      sku: r.sku,
      name: r.name,
      unit: r.unit,
      quantity: r.quantity,
      receivedQuantity: r.received_quantity ?? null,
      difference: r.received_quantity === null ? null : r.received_quantity - r.quantity,
    });
    out.set(r.shipment_id, list);
  }
  return out;
}

function shipmentDto(row: any, lines: any[]) {
  return {
    id: row.id as string,
    number: row.number as string,
    orgId: row.org_id as string,
    orgName: row.org_name as string,
    orgCode: (row.org_code as string | null) ?? null,
    siteCode: row.site_code as string,
    siteName: row.site_name as string,
    carrier: row.carrier ?? null,
    tracking: row.tracking ?? null,
    expectedDate: row.expected_date ?? null,
    status: row.status as string,
    receivedAt: iso(row.received_at),
    receiveNote: row.receive_note ?? null,
    createdAt: iso(row.created_at),
    lines,
  };
}

export interface ListShipmentsQuery {
  status?: (typeof SHIPMENT_STATUSES)[number];
  siteCode?: string;
  orgId?: string;
  page: number;
  pageSize: number;
}

export async function listShipments(ctx: DbCtx, a: AuthContext, q: ListShipmentsQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (a.orgKind === 'partner') where.push(`s.org_id = ${add(a.orgId)}`);
  else if (q.orgId) where.push(`s.org_id = ${add(q.orgId)}`);
  const sc = siteScope(a);
  if (sc) where.push(`s.site_id = ANY(${add(sc)}::uuid[])`);
  if (q.status) where.push(`s.status = ${add(q.status)}`);
  if (q.siteCode) where.push(`st.code = ${add(q.siteCode)}`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return tx(ctx, async (c) => {
    const total = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM material_shipments s JOIN sites st ON st.id = s.site_id ${w}`, params);
    const rows = await many<any>(c, `${SHIPMENT_SELECT} ${w} ORDER BY (s.status = 'in_transit') DESC, s.created_at DESC, s.id LIMIT ${add(q.pageSize)} OFFSET ${add((q.page - 1) * q.pageSize)}`, params);
    const lines = await linesOf(c, rows.map((r) => r.id));
    return { items: rows.map((r) => shipmentDto(r, lines.get(r.id) ?? [])), total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
  });
}

async function loadShipment(c: PoolClient, a: AuthContext, id: string, lock = false): Promise<any> {
  const row = await one<any>(c, `${SHIPMENT_SELECT} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [id]);
  if (!row) throw notFound('That shipment could not be found.');
  const sc = siteScope(a);
  if (sc && !sc.includes(row.site_id)) throw notFound('That shipment could not be found.');
  return row;
}

export async function getShipment(ctx: DbCtx, a: AuthContext, id: string) {
  return tx(ctx, async (c) => {
    const row = await loadShipment(c, a, id);
    const lines = (await linesOf(c, [id])).get(id) ?? [];
    const docs = await many<any>(c, `SELECT ${FILE_COLUMNS} FROM files f WHERE f.shipment_id = $1 AND f.state <> 'purged' ORDER BY f.created_at, f.id`, [id]);
    return { shipment: shipmentDto(row, lines), documents: docs.map(fileDto) };
  });
}

export interface DeclareInput {
  siteCode: string;
  carrier?: string;
  tracking?: string;
  expectedDate?: string;
  lines: { materialId: string; quantity: number }[];
}

export async function declareShipment(ctx: DbCtx, a: AuthContext, input: DeclareInput, req?: Req) {
  if (a.orgKind !== 'partner' || a.kind !== 'user') throw forbidden('Shipments are declared by people in the partner organisation.');
  if (new Set(input.lines.map((l) => l.materialId)).size !== input.lines.length) throw badRequest('Each material can appear once in a shipment.', 'duplicate_line');
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const st = await orgUploadState(c, a.orgId);
    if (!st.unlocked) throw forbidden('Your organisation must be approved with a data processing agreement on file before you can send materials.', 'org_not_approved');
    const site = await one<any>(c, `SELECT s.id, s.code, s.name FROM sites s JOIN org_sites os ON os.site_id = s.id AND os.org_id = $1 WHERE s.code = $2 AND s.active`, [a.orgId, input.siteCode]);
    if (!site) throw badRequest('That site is not available to your organisation.', 'invalid_site');
    const mats = await many<any>(c, `SELECT id FROM materials WHERE org_id = $1 AND active AND id = ANY($2::uuid[])`, [a.orgId, input.lines.map((l) => l.materialId)]);
    if (mats.length !== input.lines.length) throw badRequest('One of the materials does not exist.', 'invalid_material');
    const year = new Date().getUTCFullYear();
    const n = await one<{ n: number }>(c, 'SELECT kph_next_counter($1) AS n', [`shipment:${year}`]);
    const number = `SHP-${year}-${String(n!.n).padStart(5, '0')}`;
    const clean = (v: string | undefined, max: number) => (v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null;
    const ins = await one<{ id: string }>(
      c,
      `INSERT INTO material_shipments (org_id, number, site_id, carrier, tracking, expected_date, status, declared_by) VALUES ($1, $2, $3, $4, $5, $6, 'in_transit', $7) RETURNING id`,
      [a.orgId, number, site.id, clean(input.carrier, 60), clean(input.tracking, 100), input.expectedDate ?? null, a.userId],
    );
    for (const l of input.lines) {
      await c.query(`INSERT INTO material_shipment_lines (org_id, shipment_id, material_id, quantity) VALUES ($1, $2, $3, $4)`, [a.orgId, ins!.id, l.materialId, l.quantity]);
    }
    await auditMat(c, actor, a.orgId, 'material.shipment_declared', 'material_shipment', ins!.id, { number, site: site.code, lines: input.lines.length });
    await notifyKline(c, a.orgId, {
      kind: 'material_shipment', title: 'Materials on their way', body: `Shipment ${number}, site ${site.code}`,
      data: { shipmentId: ins!.id, number, siteCode: site.code, orgId: a.orgId },
    });
    const row = await loadShipment(c, a, ins!.id);
    return { shipment: shipmentDto(row, (await linesOf(c, [ins!.id])).get(ins!.id) ?? []) };
  });
}

export async function cancelShipment(ctx: DbCtx, a: AuthContext, id: string, req?: Req) {
  if (a.orgKind !== 'partner') throw forbidden();
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await loadShipment(c, a, id, true);
    if (row.status !== 'in_transit') throw conflict('Only a shipment that is on its way can be cancelled.', 'shipment_not_in_transit');
    await c.query(`UPDATE material_shipments SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
    await auditMat(c, actor, row.org_id, 'material.shipment_cancelled', 'material_shipment', id, { number: row.number });
    const fresh = await loadShipment(c, a, id);
    return { shipment: shipmentDto(fresh, (await linesOf(c, [id])).get(id) ?? []) };
  });
}

export async function receiveShipment(ctx: DbCtx, a: AuthContext, id: string, input: { lines: { lineId: string; receivedQuantity: number }[]; note?: string }, req?: Req) {
  if (a.orgKind !== 'kline' || a.kind !== 'user') throw forbidden();
  const actor = actorOf(a, req);
  return tx(ctx, async (c) => {
    const row = await loadShipment(c, a, id, true);
    if (row.status !== 'in_transit') throw conflict('This shipment has already been dealt with.', 'shipment_not_in_transit');
    const lines = await many<any>(c, 'SELECT id, material_id, quantity FROM material_shipment_lines WHERE shipment_id = $1', [id]);
    const given = new Map(input.lines.map((l) => [l.lineId, l.receivedQuantity]));
    if (given.size !== input.lines.length || given.size !== lines.length || lines.some((l) => !given.has(l.id))) {
      throw badRequest('Give the received quantity for every line of the shipment.', 'lines_mismatch');
    }
    let differences = 0;
    for (const l of lines) {
      const got = given.get(l.id)!;
      if (got !== l.quantity) differences++;
      await c.query('UPDATE material_shipment_lines SET received_quantity = $2 WHERE id = $1', [l.id, got]);
      if (got > 0) {
        await c.query(
          `INSERT INTO material_movements (org_id, material_id, site_id, kind, quantity, shipment_id, actor_id) VALUES ($1, $2, $3, 'receipt', $4, $5, $6)`,
          [row.org_id, l.material_id, row.site_id, got, id, a.userId],
        );
      }
    }
    const status = differences ? 'discrepancy' : 'received';
    const note = (input.note ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, 1000) || null;
    await c.query(`UPDATE material_shipments SET status = $2, received_by = $3, received_at = now(), receive_note = $4, updated_at = now() WHERE id = $1`, [id, status, a.userId, note]);
    await auditMat(c, actor, row.org_id, 'material.shipment_received', 'material_shipment', id, { number: row.number, status, differences, site: row.site_code });
    await notifyOrg(c, {
      orgId: row.org_id, kind: 'material_received', title: differences ? 'Materials received with differences' : 'Materials received',
      body: `Shipment ${row.number}, site ${row.site_code}`, data: { shipmentId: id, number: row.number, status },
    });
    const fresh = await loadShipment(c, a, id);
    return { shipment: shipmentDto(fresh, (await linesOf(c, [id])).get(id) ?? []) };
  });
}

export async function adjustStock(ctx: DbCtx, a: AuthContext, input: { orgId: string; materialId: string; siteCode: string; quantity: number; reason: string }, req?: Req) {
  if (a.orgKind !== 'kline' || a.kind !== 'user') throw forbidden();
  const actor = actorOf(a, req);
  const reason = input.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (reason.length < 3 || reason.length > 300) throw badRequest('Give a reason of 3 to 300 characters.', 'reason_required');
  return tx(ctx, async (c) => {
    // The material row is locked, so two corrections at the same time cannot both pass the stock check.
    const mat = await one<any>(c, 'SELECT * FROM materials WHERE id = $1 AND org_id = $2 FOR UPDATE', [input.materialId, input.orgId]);
    if (!mat) throw notFound('That material could not be found.');
    const site = await one<any>(c, 'SELECT id, code FROM sites WHERE code = $1', [input.siteCode]);
    if (!site) throw badRequest('That site does not exist.', 'invalid_site');
    const sc = siteScope(a);
    if (sc && !sc.includes(site.id)) throw notFound('That site could not be found.');
    // A correction never takes the stock at a site below zero.
    const have = await one<{ n: number }>(c, 'SELECT COALESCE(sum(quantity), 0)::float8 AS n FROM material_movements WHERE material_id = $1 AND site_id = $2', [input.materialId, site.id]);
    if (input.quantity < 0 && (have?.n ?? 0) + input.quantity < 0) {
      throw conflict(`That would take the stock below zero. There are ${Math.max(0, have?.n ?? 0).toLocaleString('en-GB')} in stock at ${site.code}.`, 'would_go_negative');
    }
    await c.query(
      `INSERT INTO material_movements (org_id, material_id, site_id, kind, quantity, reason, actor_id) VALUES ($1, $2, $3, 'adjustment', $4, $5, $6)`,
      [input.orgId, input.materialId, site.id, input.quantity, reason, a.userId],
    );
    await auditMat(c, actor, input.orgId, 'material.adjusted', 'material', input.materialId, { sku: mat.sku, site: site.code, quantity: input.quantity, reason });
    await checkLowStock(c, input.orgId, [input.materialId], site.id);
    const stock = (await stockByMaterial(c, input.orgId)).get(input.materialId) ?? [];
    return { material: materialDto(mat, stock) };
  });
}

// ---------------------------------------------------------------------------
// Consumption and low stock
// ---------------------------------------------------------------------------
/**
 * Books the materials used by a case that has shipped: per case plus per aligner shipped, at the case's site.
 * Once per case and material (a unique index), so a repeated call changes nothing.
 */
export async function bookConsumption(c: PoolClient, row: { id: string; org_id: string; ref: string; site_id: string | null }, alignersShipped: number): Promise<void> {
  const org = await one<{ default_site_id: string | null }>(c, 'SELECT default_site_id FROM organizations WHERE id = $1', [row.org_id]);
  const siteId = row.site_id ?? org?.default_site_id ?? null;
  if (!siteId) return;
  const mats = await many<any>(c, `SELECT id, per_case, per_aligner FROM materials WHERE org_id = $1 AND active AND (per_case > 0 OR per_aligner > 0)`, [row.org_id]);
  const booked: string[] = [];
  for (const m of mats) {
    const qty = num(m.per_case) + num(m.per_aligner) * Math.max(0, alignersShipped);
    if (!(qty > 0)) continue;
    const r = await c.query(
      `INSERT INTO material_movements (org_id, material_id, site_id, kind, quantity, case_id) VALUES ($1, $2, $3, 'consumption', $4, $5) ON CONFLICT DO NOTHING`,
      [row.org_id, m.id, siteId, -qty, row.id],
    );
    if (r.rowCount) booked.push(m.id);
  }
  if (!booked.length) return;
  await audit(c, { actorType: 'system', orgId: row.org_id, action: 'material.consumed', targetType: 'case', targetId: row.id, details: { ref: row.ref, materials: booked.length, aligners: alignersShipped } });
  await checkLowStock(c, row.org_id, booked, siteId);
}

/** Tells the partner when a material is below its minimum at a site, at most once every 24 hours per material and site. */
export async function checkLowStock(c: PoolClient, orgId: string, materialIds: string[], siteId: string): Promise<void> {
  const rows = await many<any>(
    c,
    `SELECT m.id, m.sku, m.name, m.min_stock, COALESCE(sum(mv.quantity), 0) AS on_hand
       FROM materials m LEFT JOIN material_movements mv ON mv.material_id = m.id AND mv.site_id = $3
      WHERE m.org_id = $1 AND m.id = ANY($2::uuid[]) AND m.active AND m.min_stock > 0
      GROUP BY m.id`,
    [orgId, materialIds, siteId],
  );
  const low = rows.filter((r) => num(r.on_hand) < num(r.min_stock));
  if (!low.length) return;
  const site = await one<{ code: string; name: string }>(c, 'SELECT code, name FROM sites WHERE id = $1', [siteId]);
  for (const m of low) {
    const claimed = await c.query(
      `INSERT INTO material_alerts (org_id, material_id, site_id, notified_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (material_id, site_id) DO UPDATE SET notified_at = now() WHERE material_alerts.notified_at < now() - interval '24 hours'
       RETURNING material_id`,
      [orgId, m.id, siteId],
    );
    if (!claimed.rowCount) continue;
    const onHand = num(m.on_hand);
    await notifyOrg(c, {
      orgId, kind: 'material_low_stock', title: 'Materials running low', body: `${m.name} at ${site?.name ?? 'a K Line site'}: ${onHand} left`,
      data: { materialId: m.id, siteCode: site?.code ?? null, onHand, minStock: num(m.min_stock) },
    });
    // The email to the people who manage materials goes out through notifyOrg (fixed text, combined inside 15 minutes).
    await emitMaterialsWebhook(c, orgId, 'materials.low_stock', { materialId: m.id, sku: m.sku, siteCode: site?.code ?? null, onHand, minStock: num(m.min_stock) });
  }
}
