import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { many, one, tx, type DbCtx, type PoolClient } from '../db';
import { AppError, badRequest, conflict, forbidden } from '../http/errors';
import { canReceive } from '../../../shared/geo';
import { sccOnFile } from './transferCheck';
import { renderBags, printsPersonalData } from '../../../shared/bag';
import { csvCell } from './packaging';
import { CASE_SELECT, assertNotErased, actorOf, addBusinessDays, caseDto, getCaseDetail, loadCase, type Actor } from './cases';
import { applyStage, cleanText, type EngineActor, type StageInput } from './stageEngine';
import { bagCaseData, orgBagLayout } from './bags';
import { notifyOrg } from './notify';
import { emitCaseWebhook } from './webhooks';
import type { StageId } from '../../../shared/stages';

type Req = { ip?: string; headers?: Record<string, any> };

const engineActor = (a: AuthContext, req?: Req): EngineActor => {
  const x: Actor = actorOf(a, req);
  return { actorType: x.actorType, actorId: x.actorId, ip: x.ip, userAgent: x.userAgent };
};

export interface SiteOption {
  code: string;
  name: string;
  country: string;
  allowed: boolean;
  reason: string | null;
}

/** Sites of a partner with the transfer gate applied to each. */
export async function siteOptions(c: PoolClient, orgId: string): Promise<{ country: string | null; scc: boolean; defaultSiteCode: string | null; sites: SiteOption[] }> {
  const org = await one<any>(c, `SELECT o.country, ds.code AS default_code FROM organizations o LEFT JOIN sites ds ON ds.id = o.default_site_id WHERE o.id = $1`, [orgId]);
  const scc = await sccOnFile(c, orgId);
  const sites = await many<any>(c, `SELECT s.code, s.name, s.country, s.eea, s.adequacy, s.active FROM org_sites os JOIN sites s ON s.id = os.site_id WHERE os.org_id = $1 ORDER BY s.code`, [orgId]);
  return {
    country: org?.country ?? null,
    scc,
    defaultSiteCode: org?.default_code ?? null,
    sites: sites.map((s) => {
      const gate = canReceive(org?.country, s, scc);
      return { code: s.code, name: s.name, country: s.country, allowed: s.active && gate, reason: !s.active ? 'The site is not active.' : !gate ? 'Standard Contractual Clauses are needed for this site.' : null };
    }),
  };
}

// ---------------------------------------------------------------------------
// Intake list
// ---------------------------------------------------------------------------
export type IntakeTab = 'review' | 'hold' | 'ready';
const TAB_STATUS: Record<IntakeTab, string> = { review: 'submitted', hold: 'on_hold', ready: 'ready' };

export async function listIntake(ctx: DbCtx, tab: IntakeTab, page: number, pageSize: number) {
  return tx(ctx, async (c) => {
    const status = TAB_STATUS[tab];
    const total = await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM cases WHERE status = $1', [status]);
    const rows = await many<any>(
      c,
      `${CASE_SELECT} WHERE c.status = $1 ORDER BY (c.priority = 'rush') DESC, COALESCE(c.submitted_at, c.created_at), c.id LIMIT $2 OFFSET $3`,
      [status, pageSize, (page - 1) * pageSize],
    );
    const cache = new Map<string, Awaited<ReturnType<typeof siteOptions>>>();
    const items = [];
    for (const r of rows) {
      if (!cache.has(r.org_id)) cache.set(r.org_id, await siteOptions(c, r.org_id));
      const o = cache.get(r.org_id)!;
      const since = r.status === 'ready' ? r.ready_at : r.status === 'on_hold' ? r.updated_at : r.submitted_at ?? r.created_at;
      items.push({
        ...caseDto(r),
        waitingHours: since ? Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 3_600_000)) : 0,
        sites: o.sites,
        defaultSiteCode: o.defaultSiteCode,
      });
    }
    return { tab, items, total: total?.n ?? 0, page, pageSize };
  });
}

// ---------------------------------------------------------------------------
// Route, hold, release
// ---------------------------------------------------------------------------
export async function routeCase(ctx: DbCtx, a: AuthContext, id: string, siteCode: string, req?: Req) {
  const actor = engineActor(a, req);
  return tx(ctx, async (c) => {
    const row = await loadCase(c, id, true, a);
    assertNotErased(row);
    if (!['submitted', 'ready'].includes(row.status)) throw conflict('Only a submitted case can be sent to a production site.', 'case_not_routable');
    const site = await one<any>(
      c,
      `SELECT s.id, s.code, s.country, s.eea, s.adequacy FROM sites s JOIN org_sites os ON os.site_id = s.id AND os.org_id = $1 WHERE s.code = $2 AND s.active`,
      [row.org_id, siteCode],
    );
    if (!site) throw badRequest('That site is not available for this partner.', 'invalid_site');
    const org = await one<any>(c, 'SELECT country, settings FROM organizations WHERE id = $1', [row.org_id]);
    // Direct manufacturing cases are produced by the K Line portal, not at a site: the gate does not apply to them (services/transferGate.ts).
    if (row.manufacturing_mode !== 'direct' && !canReceive(org?.country, site, await sccOnFile(c, row.org_id))) {
      throw forbidden('Cases from this partner cannot be produced at that site until Standard Contractual Clauses are on file.', 'transfer_blocked');
    }
    const rerouted = row.status === 'ready';
    if (rerouted) {
      if (row.site_id === site.id) return { case: caseDto(row) };
      await c.query('UPDATE cases SET site_id = $2, updated_at = now() WHERE id = $1', [id, site.id]);
    } else {
      const now = new Date();
      const sla = typeof org?.settings?.sla_days === 'number' ? org.settings.sla_days : 3;
      await c.query(`UPDATE cases SET status = 'ready', site_id = $2, ready_at = $3, due_date = $4, hold_reason = NULL, updated_at = now() WHERE id = $1`, [id, site.id, now, addBusinessDays(now, sla)]);
    }
    await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [
      row.org_id, id, rerouted ? 'rerouted' : 'routed', actor.actorType, actor.actorId, JSON.stringify({ site: site.code, source: 'kline', sourceLabel: 'K Line' }),
    ]);
    await audit(c, { actorType: actor.actorType, actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: row.org_id, action: rerouted ? 'case.rerouted' : 'case.routed', targetType: 'case', targetId: id, details: { ref: row.ref, site: site.code } });
    if (!rerouted) {
      const users = await many<{ id: string }>(c, `SELECT id FROM users WHERE org_id = $1 AND status = 'active'`, [row.org_id]);
      for (const u of users) await notifyOrg(c, { orgId: row.org_id, userId: u.id, kind: 'case_routed', title: 'Case approved for production', body: `Case ${row.ref}`, data: { caseId: id, ref: row.ref } });
    }
    await emitCaseWebhook(c, id, rerouted ? 'case.rerouted' : 'case.ready', { site: site.code });
    return { case: caseDto(await loadCase(c, id)) };
  });
}

function throwFor(r: { outcome: string; code?: string; message?: string }): never {
  if (r.outcome === 'ignored') throw conflict(r.message ?? 'That change is not possible now.', 'stage_not_allowed');
  const status = r.code === 'shipping_details_required' || r.code === 'invalid_shipping_details' || r.code === 'invalid_hold_reason' ? 400 : 409;
  throw new AppError(status, r.code ?? 'stage_not_allowed', r.message ?? 'That change is not possible now.');
}

export async function holdCase(ctx: DbCtx, a: AuthContext, id: string, reason: string, req?: Req) {
  const actor = engineActor(a, req);
  return tx(ctx, async (c) => {
    const row = await loadCase(c, id, true, a);
    const r = await applyStage(c, row, { target: 'hold', source: 'kline', occurredAt: new Date(), holdReason: cleanText(reason) }, actor);
    if (r.outcome !== 'applied') throwFor(r);
    return { case: caseDto(await loadCase(c, id)) };
  });
}

export async function releaseCase(ctx: DbCtx, a: AuthContext, id: string, req?: Req) {
  const actor = engineActor(a, req);
  return tx(ctx, async (c) => {
    const row = await loadCase(c, id, true, a);
    assertNotErased(row);
    if (row.status !== 'on_hold') throw conflict('Only a case on hold can be released.', 'not_on_hold');
    await c.query(
      `UPDATE cases SET status = 'submitted', hold_reason = NULL, stage = NULL, site_id = NULL, ready_at = NULL, due_date = NULL, received_at = NULL, started_at = NULL, finished_at = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );
    await c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, actor_id, data) VALUES ($1, $2, 'released', $3, $4, $5::jsonb)`, [
      row.org_id, id, actor.actorType, actor.actorId, JSON.stringify({ source: 'kline', sourceLabel: 'K Line' }),
    ]);
    await audit(c, { actorType: actor.actorType, actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: row.org_id, action: 'case.released', targetType: 'case', targetId: id, details: { ref: row.ref } });
    const users = await many<{ id: string }>(c, `SELECT id FROM users WHERE org_id = $1 AND status = 'active'`, [row.org_id]);
    for (const u of users) await notifyOrg(c, { orgId: row.org_id, userId: u.id, kind: 'case_released', title: 'Hold released', body: `Case ${row.ref}`, data: { caseId: id, ref: row.ref } });
    await emitCaseWebhook(c, id, 'case.released');
    return { case: caseDto(await loadCase(c, id)) };
  });
}

// ---------------------------------------------------------------------------
// Manual stage update
// ---------------------------------------------------------------------------
export async function manualStage(
  ctx: DbCtx,
  a: AuthContext,
  id: string,
  input: { stage: StageId; carrier?: string; trackingNumber?: string; alignersShipped?: number; note?: string },
  req?: Req,
) {
  const actor = engineActor(a, req);
  return tx(ctx, async (c) => {
    const row = await loadCase(c, id, true, a);
    if (!['ready', 'received', 'in_production', 'shipped'].includes(row.status)) {
      throw conflict('The stage can only be changed for a case that is ready, at the factory or shipped.', 'stage_not_allowed');
    }
    const si: StageInput = {
      target: input.stage,
      source: 'kline',
      occurredAt: new Date(),
      carrier: input.carrier,
      trackingNumber: input.trackingNumber,
      alignersShipped: input.alignersShipped,
      note: input.note,
    };
    const r = await applyStage(c, row, si, actor);
    if (r.outcome !== 'applied') throwFor(r);
    return { case: caseDto(await loadCase(c, id)) };
  });
}

// ---------------------------------------------------------------------------
// Console case detail and bag print file
// ---------------------------------------------------------------------------
export async function consoleCaseDetail(ctx: DbCtx, a: AuthContext, id: string, req?: Req) {
  const detail = await getCaseDetail(ctx, id, a, req);
  const routing = await tx(ctx, async (c) => {
    const row = await one<any>(c, `SELECT c.org_id, c.mes_case_id, c.status, s.code AS site_code, s.name AS site_name FROM cases c LEFT JOIN sites s ON s.id = c.site_id WHERE c.id = $1`, [id]);
    const o = await siteOptions(c, row.org_id);
    return {
      siteCode: row.site_code ?? null,
      siteName: row.site_name ?? null,
      mesCaseId: row.mes_case_id ?? null,
      canRoute: row.status === 'submitted' || row.status === 'ready',
      partnerCountry: o.country,
      sccOnFile: o.scc,
      defaultSiteCode: o.defaultSiteCode,
      sites: o.sites,
    };
  });
  return { ...detail, routing };
}

export async function bagsCsv(ctx: DbCtx, a: AuthContext, id: string, req?: Req): Promise<{ ref: string; csv: string }> {
  const actor = engineActor(a, req);
  return tx(ctx, async (c) => {
    const row = await loadCase(c, id, false, a);
    if (row.status === 'draft') throw conflict('Bag labels are available once a case has been submitted.', 'case_not_submitted');
    const layout = await orgBagLayout(c, row.org_id);
    const personal = printsPersonalData(layout);
    const data = await bagCaseData(c, row, { withPatient: personal });
    const bags = renderBags(layout, data);
    const width = Math.max(layout.lines.length, 1);
    const header = ['aligner', 'arch', 'step', 'barcode', ...Array.from({ length: width }, (_, i) => `line_${i + 1}`)];
    const lines = [header.join(',')];
    for (const b of bags) lines.push([b.aligner, b.arch, b.step, b.barcode, ...Array.from({ length: width }, (_, i) => b.lines[i] ?? '')].map(csvCell).join(','));
    await audit(c, {
      actorType: actor.actorType, actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: row.org_id, action: 'case.bags_csv', targetType: 'case', targetId: id,
      details: { ref: row.ref, bags: bags.length, personalData: personal },
    });
    if (personal) {
      await audit(c, { actorType: actor.actorType, actorId: actor.actorId, ip: actor.ip, userAgent: actor.userAgent, orgId: row.org_id, action: 'case.name_revealed', targetType: 'case', targetId: id, details: { ref: row.ref, via: 'bags_csv' } });
    }
    return { ref: row.ref as string, csv: lines.join('\r\n') + '\r\n' };
  });
}

