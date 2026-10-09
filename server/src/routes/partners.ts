import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit';
import { dbCtx, getAuth, guard, type AuthContext } from '../auth/context';
import { many, one, tx, type PoolClient } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { clientIp, parse, userAgent } from '../http/util';
import { DPA_SQL, SCC_SQL } from '../services/console';
import { siteOptions } from '../services/intake';
import { emailSchema, inviteMember, rolesSchema } from '../services/team';
import { activatePartner, changePartnerCode, createPartner, declinePartner, listPartners, partnerGates, profileForStaff, signupDetails, signupFlags } from '../services/partnerReview';
import { portalBody, portalView, savePortalSettings, testPortalSettings } from '../services/portalSettings';
import { logoRow } from '../services/profile';
import { replyWithLogo } from './profile';

const idParam = z.object({ id: z.string().uuid() });
const agreementKinds = ['msa', 'qaa', 'dpa', 'scc', 'it'] as const;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-09-24.');

function klineOnly(a: AuthContext): AuthContext {
  if (a.kind !== 'user' || a.orgKind !== 'kline') throw forbidden();
  return a;
}
const who = (req: any) => ({ ip: clientIp(req), userAgent: userAgent(req) });

async function loadPartner(c: PoolClient, id: string): Promise<any> {
  const o = await one<any>(c, `SELECT o.*, ${DPA_SQL} AS dpa, ${SCC_SQL} AS scc FROM organizations o WHERE o.id = $1 AND o.kind = 'partner'`, [id]);
  if (!o) throw notFound('That partner could not be found.');
  return o;
}

const settingsView = (s: any) => ({
  requirePts: !!s?.require_pts,
  manualReview: !!s?.manual_review,
  slaDays: typeof s?.sla_days === 'number' ? s.sla_days : 3,
});

/** Partner administration and registration review for K Line staff. */
export async function partnerRoutes(app: FastifyInstance): Promise<void> {
  const g = { preHandler: guard({ permission: 'admin.partners' }) };
  const gStepUp = { preHandler: guard({ permission: 'admin.partners', stepUp: true }) };

  app.get('/api/partners', g, async (req) => {
    const a = klineOnly(getAuth(req));
    const q = parse(z.object({ tab: z.enum(['all', 'review', 'declined']).default('all'), search: z.string().max(100).optional() }), req.query);
    return listPartners(a, q.tab, q.search);
  });

  app.post('/api/partners', gStepUp, async (req, reply) => {
    const a = klineOnly(getAuth(req));
    const b = parse(
      z.object({
        name: z.string().max(200),
        code: z.string().max(20),
        country: z.string().max(4),
        legalName: z.string().trim().max(160).nullish(),
        retentionMonths: z.number().int().min(1).max(180).optional(),
        siteCodes: z.array(z.string().trim().max(20)).max(50).default([]),
        defaultSiteCode: z.string().trim().max(20).nullish(),
      }),
      req.body,
    );
    const out = await createPartner(a, req, b);
    reply.code(201);
    return out;
  });

  app.patch('/api/partners/:id/code', g, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    const { code } = parse(z.object({ code: z.string().max(20) }), req.body);
    return changePartnerCode(a, req, id, code);
  });

  app.post('/api/partners/:id/users/invite', gStepUp, async (req, reply) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ email: emailSchema, name: z.string().trim().min(1).max(120), roles: rolesSchema('partner') }), req.body);
    await tx(dbCtx(a), async (c) => {
      const o = await loadPartner(c, id);
      if (signupFlags(o.signup).declined) throw conflict('This registration was declined.', 'partner_declined');
    });
    const userId = await inviteMember(a, req, { orgId: id, kind: 'partner' }, b, 'partner_user', { inviter: 'K Line' });
    reply.code(201);
    return { id: userId };
  });

  app.post('/api/partners/:id/decline', gStepUp, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).nullish() }), req.body);
    return declinePartner(a, req, id, reason ? reason : null);
  });

  app.get('/api/partners/:id/logo', g, async (req, reply) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    const row = await tx(dbCtx(a), async (c) => {
      await loadPartner(c, id);
      return logoRow(c, id, { kind: 'org' });
    });
    if (!row) throw notFound('There is no logo yet.');
    return replyWithLogo(reply, row);
  });

  app.get('/api/partners/:id', g, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    return tx(dbCtx(a), async (c) => {
      const o = await loadPartner(c, id);
      const agreements = await many<any>(
        c,
        `SELECT id, type, signed_at, valid_until, reference, notes, signed_by, revoked_at, created_at FROM agreements WHERE org_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      const users = await one<{ n: number; active: number }>(c, `SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'active')::int AS active FROM users WHERE org_id = $1`, [id]);
      const so = await siteOptions(c, id);
      const gates = await partnerGates(c, o);
      const flags = signupFlags(o.signup);
      const cases = await one<any>(
        c,
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('submitted', 'on_hold', 'ready', 'received', 'in_production'))::int AS open FROM cases WHERE org_id = $1`,
        [id],
      );
      return {
        id: o.id,
        name: o.name,
        legalName: o.legal_name,
        code: o.code,
        country: o.country,
        vatId: o.vat_id,
        address: o.address,
        status: o.status,
        retentionMonths: o.retention_months,
        settings: settingsView(o.settings),
        defaultSiteCode: so.defaultSiteCode,
        sites: so.sites,
        gates,
        ...profileForStaff(o),
        selfRegistered: flags.selfRegistered,
        emailConfirmed: flags.emailConfirmed,
        declined: flags.declined,
        signup: signupDetails(o.signup),
        agreements: agreements.map((x) => ({
          id: x.id, kind: x.type, signedAt: x.signed_at, expiresAt: x.valid_until, reference: x.reference, notes: x.notes, signedBy: x.signed_by, revoked: !!x.revoked_at, createdAt: x.created_at,
        })),
        usersCount: users?.n ?? 0,
        activeUsersCount: users?.active ?? 0,
        casesCount: cases?.total ?? 0,
        openCases: cases?.open ?? 0,
        createdAt: o.created_at,
      };
    });
  });

  app.patch('/api/partners/:id/settings', g, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    const b = parse(
      z.object({
        retentionMonths: z.number().int().min(1).max(180).optional(),
        slaDays: z.number().int().min(1).max(30).optional(),
        requirePts: z.boolean().optional(),
        manualReview: z.boolean().optional(),
        defaultSiteCode: z.string().trim().max(20).nullable().optional(),
      }),
      req.body,
    );
    return tx(dbCtx(a), async (c) => {
      await loadPartner(c, id);
      const patch: Record<string, unknown> = {};
      if (b.slaDays !== undefined) patch.sla_days = b.slaDays;
      if (b.requirePts !== undefined) patch.require_pts = b.requirePts;
      if (b.manualReview !== undefined) patch.manual_review = b.manualReview;
      if (Object.keys(patch).length) await c.query(`UPDATE organizations SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(patch)]);
      if (b.retentionMonths !== undefined) await c.query('UPDATE organizations SET retention_months = $2, updated_at = now() WHERE id = $1', [id, b.retentionMonths]);
      if (b.defaultSiteCode !== undefined) {
        if (b.defaultSiteCode === null) await c.query('UPDATE organizations SET default_site_id = NULL, updated_at = now() WHERE id = $1', [id]);
        else {
          const s = await one<{ id: string }>(c, 'SELECT s.id FROM sites s JOIN org_sites os ON os.site_id = s.id AND os.org_id = $1 WHERE s.code = $2', [id, b.defaultSiteCode]);
          if (!s) throw badRequest('The default site must be one of the partner sites.', 'invalid_site');
          await c.query('UPDATE organizations SET default_site_id = $2, updated_at = now() WHERE id = $1', [id, s.id]);
        }
      }
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: id, action: 'partner.settings_updated', targetType: 'organization', targetId: id, ...who(req), details: { changed: Object.keys(b) } });
      const o = await loadPartner(c, id);
      const so = await siteOptions(c, id);
      return { retentionMonths: o.retention_months, settings: settingsView(o.settings), defaultSiteCode: so.defaultSiteCode };
    });
  });

  app.put('/api/partners/:id/sites', g, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ siteCodes: z.array(z.string().trim().max(20)).max(50), defaultSiteCode: z.string().trim().max(20).nullable().optional() }), req.body);
    const codes = [...new Set(b.siteCodes)];
    if (b.defaultSiteCode && !codes.includes(b.defaultSiteCode)) throw badRequest('The default site must be one of the selected sites.', 'invalid_site');
    return tx(dbCtx(a), async (c) => {
      await loadPartner(c, id);
      const sites = await many<{ id: string; code: string }>(c, 'SELECT id, code FROM sites WHERE code = ANY($1::text[])', [codes]);
      if (sites.length !== codes.length) throw badRequest('One of the sites does not exist.', 'invalid_site');
      await c.query('DELETE FROM org_sites WHERE org_id = $1', [id]);
      for (const s of sites) await c.query('INSERT INTO org_sites (org_id, site_id) VALUES ($1, $2)', [id, s.id]);
      const def = b.defaultSiteCode === undefined ? undefined : b.defaultSiteCode ? sites.find((s) => s.code === b.defaultSiteCode)!.id : null;
      // A default site that is no longer allowed is cleared.
      await c.query(
        def === undefined
          ? 'UPDATE organizations SET default_site_id = CASE WHEN default_site_id = ANY($2::uuid[]) THEN default_site_id ELSE NULL END, updated_at = now() WHERE id = $1'
          : 'UPDATE organizations SET default_site_id = $3, updated_at = now() WHERE id = $1 AND $2::uuid[] IS NOT NULL',
        def === undefined ? [id, sites.map((s) => s.id)] : [id, sites.map((s) => s.id), def],
      );
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: id, action: 'partner.sites_updated', targetType: 'organization', targetId: id, ...who(req), details: { sites: codes, defaultSite: b.defaultSiteCode ?? null } });
      const so = await siteOptions(c, id);
      return { defaultSiteCode: so.defaultSiteCode, sites: so.sites };
    });
  });

  app.post('/api/partners/:id/agreements', gStepUp, async (req, reply) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    const b = parse(
      z.object({
        kind: z.enum(agreementKinds),
        signedAt: dateOnly,
        expiresAt: dateOnly.nullish(),
        reference: z.string().trim().max(120).nullish(),
        notes: z.string().trim().max(1000).nullish(),
      }),
      req.body,
    );
    if (b.expiresAt && b.expiresAt < b.signedAt) throw badRequest('The end date cannot be before the signing date.', 'invalid_dates');
    const out = await tx(dbCtx(a), async (c) => {
      await loadPartner(c, id);
      const r = await c.query(
        `INSERT INTO agreements (org_id, type, signed_at, valid_until, reference, notes, signed_by, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [id, b.kind, b.signedAt, b.expiresAt ?? null, b.reference ?? null, b.notes ?? null, a.name, a.userId],
      );
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: id, action: 'partner.agreement_added', targetType: 'agreement', targetId: r.rows[0].id, ...who(req), details: { kind: b.kind, signedAt: b.signedAt, expiresAt: b.expiresAt ?? null } });
      return r.rows[0].id as string;
    });
    reply.code(201);
    return { id: out };
  });

  app.delete('/api/partners/:id/agreements/:agreementId', gStepUp, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id, agreementId } = parse(z.object({ id: z.string().uuid(), agreementId: z.string().uuid() }), req.params);
    await tx(dbCtx(a), async (c) => {
      await loadPartner(c, id);
      // Withdrawn, not erased: the record stays for the audit trail.
      const r = await c.query('UPDATE agreements SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND org_id = $2 RETURNING type', [agreementId, id]);
      if (!r.rowCount) throw notFound('That agreement could not be found.');
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: id, action: 'partner.agreement_removed', targetType: 'agreement', targetId: agreementId, ...who(req), details: { kind: r.rows[0].type } });
    });
    return { ok: true };
  });

  // The portal connection of every partner (the page "Portal connection" in the console). The API key is never returned.
  app.get('/api/partners/portal-connections', g, async (req) => {
    const a = klineOnly(getAuth(req));
    return tx(dbCtx(a), async (c) => {
      const rows = await many<any>(c, `SELECT id, name, code, status, settings FROM organizations WHERE kind = 'partner' ORDER BY name`);
      return { items: rows.map((o) => ({ id: o.id, name: o.name, code: o.code, status: o.status, ...portalView(o.settings) })) };
    });
  });

  app.get('/api/partners/:id/portal-api', g, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    return tx(dbCtx(a), async (c) => {
      const o = await loadPartner(c, id);
      return { name: o.name, code: o.code, status: o.status, ...portalView(o.settings) };
    });
  });

  app.put('/api/partners/:id/portal-api', gStepUp, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    await tx(dbCtx(a), (c) => loadPartner(c, id));
    return savePortalSettings(a, id, parse(portalBody, req.body), who(req), true);
  });

  app.post('/api/partners/:id/portal-api/test', { ...g, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    await tx(dbCtx(a), (c) => loadPartner(c, id));
    return testPortalSettings(a, id, who(req), true);
  });

  app.post('/api/partners/:id/activate', g, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    return activatePartner(a, req, id, loadPartner);
  });

  app.post('/api/partners/:id/suspend', g, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    return tx(dbCtx(a), async (c) => {
      const o = await loadPartner(c, id);
      await c.query(`UPDATE organizations SET status = 'suspended', updated_at = now() WHERE id = $1`, [id]);
      // Sessions of a suspended organisation stop working at once (see loadSession); mark them revoked as well.
      await c.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'org_suspended' WHERE org_id = $1 AND revoked_at IS NULL`, [id]);
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: id, action: 'partner.suspended', targetType: 'organization', targetId: id, ...who(req), details: { from: o.status } });
      return { status: 'suspended' };
    });
  });
}
