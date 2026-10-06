import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit';
import { createApiKey, validCidr, MAX_KEY_LIFETIME_DAYS } from '../auth/apikeys';
import { dbCtx, getAuth, guard, type AuthContext } from '../auth/context';
import { many, one, tx } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { clientIp, parse, userAgent } from '../http/util';
import { KLINE_API_SCOPES } from '../../../shared/roles';
import { isAdequate, isEea } from '../../../shared/geo';
import { changeRoles, disableMember, emailSchema, enableMember, inviteMember, listMembers, resendMemberInvite, resetMemberMfa, rolesSchema, teamScope, unlockMember } from '../services/team';

const idParam = z.object({ id: z.string().uuid() });

function klineOnly(a: AuthContext): AuthContext {
  if (a.kind !== 'user' || a.orgKind !== 'kline') throw forbidden();
  return a;
}
const who = (req: any) => ({ ip: clientIp(req), userAgent: userAgent(req) });
const iso = (v: any) => (v instanceof Date ? v.toISOString() : v ?? null);

/** Service keys, K Line staff and production sites. */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ================================================================ service keys
  const keysRead = { preHandler: guard({ permission: 'admin.mes' }) };
  const keysWrite = { preHandler: guard({ permission: 'admin.mes', stepUp: true }) };

  app.get('/api/service-keys', keysRead, async (req) => {
    const a = klineOnly(getAuth(req));
    const rows = await tx(dbCtx(a), (c) =>
      many<any>(
        c,
        `SELECT k.id, k.name, k.prefix, k.scopes, k.cidrs, k.expires_at, k.last_used_at, k.last_used_ip, k.created_at, k.revoked_at, u.name AS created_by_name
           FROM api_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.org_id = $1 ORDER BY k.created_at DESC`,
        [a.orgId],
      ),
    );
    return {
      scopes: KLINE_API_SCOPES,
      items: rows.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        cidrs: k.cidrs,
        expiresAt: iso(k.expires_at),
        lastUsedAt: iso(k.last_used_at),
        lastUsedIp: k.last_used_ip,
        createdAt: iso(k.created_at),
        createdBy: k.created_by_name ?? null,
        status: k.revoked_at ? 'revoked' : new Date(k.expires_at).getTime() <= Date.now() ? 'expired' : 'active',
      })),
    };
  });

  app.post('/api/service-keys', keysWrite, async (req, reply) => {
    const a = klineOnly(getAuth(req));
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(80),
        scopes: z.array(z.enum(KLINE_API_SCOPES)).min(1).max(3),
        cidrs: z.array(z.string().trim().max(64)).max(20).optional(),
        expiresInDays: z.number().int().min(1).max(MAX_KEY_LIFETIME_DAYS),
      }),
      req.body,
    );
    if ((body.cidrs ?? []).some((x) => !validCidr(x))) throw badRequest('One of the network ranges is not valid.', 'invalid_cidr');
    const created = await tx(dbCtx(a), async (c) => {
      const k = await createApiKey(c, { orgId: a.orgId, orgKind: 'kline', name: body.name, scopes: [...new Set(body.scopes)], cidrs: body.cidrs, expiresInDays: body.expiresInDays, createdBy: a.userId });
      await audit(c, {
        actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'service_key.created', targetType: 'api_key', targetId: k.id, ...who(req),
        details: { prefix: k.prefix, scopes: body.scopes, cidrs: body.cidrs?.length ?? 0, expiresInDays: body.expiresInDays },
      });
      return k;
    });
    reply.code(201);
    // The full key is shown once and never stored.
    return { id: created.id, key: created.key, prefix: created.prefix, expiresAt: iso(created.expiresAt) };
  });

  app.delete('/api/service-keys/:id', keysWrite, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    await tx(dbCtx(a), async (c) => {
      const r = await c.query('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND org_id = $2 RETURNING prefix', [id, a.orgId]);
      if (!r.rowCount) throw notFound('That key could not be found.');
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'service_key.revoked', targetType: 'api_key', targetId: id, ...who(req), details: { prefix: r.rows[0].prefix } });
    });
    return { ok: true };
  });

  // ==================================================================== staff
  const staffRead = { preHandler: guard({ permission: 'admin.staff' }) };
  const staffWrite = { preHandler: guard({ permission: 'admin.staff', stepUp: true }) };
  const P = 'staff';

  app.get('/api/staff', staffRead, async (req) => {
    const a = klineOnly(getAuth(req));
    return { users: await listMembers(a, teamScope(a)) };
  });

  app.post('/api/staff/invite', staffWrite, async (req, reply) => {
    const a = klineOnly(getAuth(req));
    const body = parse(
      z.object({ email: emailSchema, name: z.string().trim().min(1).max(120), roles: rolesSchema('kline'), siteIds: z.array(z.string().uuid()).max(20).optional() }),
      req.body,
    );
    const id = await inviteMember(a, req, teamScope(a), body, P);
    reply.code(201);
    return { id };
  });

  app.post('/api/staff/:id/roles', staffWrite, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ roles: rolesSchema('kline'), siteIds: z.array(z.string().uuid()).max(20).optional() }), req.body);
    await changeRoles(a, req, teamScope(a), id, body.roles, body.siteIds, P);
    return { ok: true };
  });

  app.post('/api/staff/:id/disable', staffWrite, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    await disableMember(a, req, teamScope(a), id, P);
    return { ok: true };
  });

  app.post('/api/staff/:id/enable', staffWrite, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    await enableMember(a, req, teamScope(a), id, P);
    return { ok: true };
  });

  app.post('/api/staff/:id/reset-mfa', staffWrite, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    await resetMemberMfa(a, req, teamScope(a), id, P);
    return { ok: true };
  });

  app.post('/api/staff/:id/unlock', staffWrite, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    await unlockMember(a, req, teamScope(a), id, P);
    return { ok: true };
  });

  app.post('/api/staff/:id/resend-invite', staffWrite, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    await resendMemberInvite(a, req, teamScope(a), id, P);
    return { ok: true };
  });

  // =================================================================== sites
  const sitesGuard = { preHandler: guard({ permission: 'admin.sites' }) };
  const siteDto = (s: any) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    city: s.city ?? null,
    country: s.country,
    inEea: s.eea,
    hasAdequacy: s.adequacy,
    active: s.active,
    openCases: s.open_cases ?? 0,
  });
  const SITE_SELECT = `SELECT s.*, (SELECT count(*)::int FROM cases c WHERE c.site_id = s.id AND c.status IN ('ready', 'received', 'in_production')) AS open_cases FROM sites s`;
  const bool = z.boolean().optional();
  const siteFields = {
    code: z.string().trim().toUpperCase().regex(/^[A-Z]{2}-[A-Z0-9]{2,6}$/, 'Use a code such as PT-CHV.'),
    name: z.string().trim().min(2).max(120),
    city: z.string().trim().max(120).nullish(),
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two letter country code.'),
    active: bool,
    inEea: bool,
    in_eea: bool,
    hasAdequacy: bool,
    has_adequacy: bool,
  };

  app.get('/api/sites', sitesGuard, async (req) => {
    const a = klineOnly(getAuth(req));
    const rows = await tx(dbCtx(a), (c) => many<any>(c, `${SITE_SELECT} ORDER BY s.code`));
    return { items: rows.map(siteDto) };
  });

  app.post('/api/sites', sitesGuard, async (req, reply) => {
    const a = klineOnly(getAuth(req));
    const b = parse(z.object(siteFields), req.body);
    const eea = b.inEea ?? b.in_eea ?? isEea(b.country);
    const adequacy = b.hasAdequacy ?? b.has_adequacy ?? isAdequate(b.country);
    const row = await tx(dbCtx(a), async (c) => {
      let id: string;
      try {
        const r = await c.query('INSERT INTO sites (code, name, city, country, eea, adequacy, active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [b.code, b.name, b.city ?? null, b.country, eea, adequacy, b.active ?? true]);
        id = r.rows[0].id;
      } catch (err: any) {
        if (err?.code === '23505') throw conflict('A site with that code already exists.', 'site_exists');
        throw err;
      }
      await c.query('INSERT INTO org_sites (org_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a.orgId, id]);
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'site.created', targetType: 'site', targetId: id, ...who(req), details: { code: b.code, country: b.country, inEea: eea, hasAdequacy: adequacy } });
      return one<any>(c, `${SITE_SELECT} WHERE s.id = $1`, [id]);
    });
    reply.code(201);
    return { site: siteDto(row) };
  });

  app.patch('/api/sites/:id', sitesGuard, async (req) => {
    const a = klineOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    const b = parse(z.object(siteFields).partial(), req.body);
    return tx(dbCtx(a), async (c) => {
      const cur = await one<any>(c, 'SELECT * FROM sites WHERE id = $1 FOR UPDATE', [id]);
      if (!cur) throw notFound('That site could not be found.');
      const country = b.country ?? cur.country;
      const next = {
        code: b.code ?? cur.code,
        name: b.name ?? cur.name,
        city: b.city === undefined ? cur.city : b.city,
        country,
        eea: b.inEea ?? b.in_eea ?? cur.eea,
        adequacy: b.hasAdequacy ?? b.has_adequacy ?? cur.adequacy,
        active: b.active ?? cur.active,
      };
      try {
        await c.query('UPDATE sites SET code = $2, name = $3, city = $4, country = $5, eea = $6, adequacy = $7, active = $8 WHERE id = $1', [id, next.code, next.name, next.city, next.country, next.eea, next.adequacy, next.active]);
      } catch (err: any) {
        if (err?.code === '23505') throw conflict('A site with that code already exists.', 'site_exists');
        throw err;
      }
      const changed = Object.keys(next).filter((k) => (next as any)[k] !== (cur as any)[k]);
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'site.updated', targetType: 'site', targetId: id, ...who(req), details: { code: next.code, changed } });
      return { site: siteDto(await one<any>(c, `${SITE_SELECT} WHERE s.id = $1`, [id])) };
    });
  });
}
