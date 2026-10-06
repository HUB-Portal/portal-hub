import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, many, tx } from '../db';
import { dbCtx, getAuth, guard } from '../auth/context';
import { notFound } from '../http/errors';
import { parse } from '../http/util';
import { assertApproved, getMenuSetting, menuPatchSchema, menuVisibleFor, orgUploadState, partnerOnly, updateMenuSetting } from '../services/org';
import { logoView } from '../services/profile';
import { changeRoles, disableMember, emailSchema, enableMember, inviteMember, listMembers, resendMemberInvite, resetMemberMfa, rolesSchema, teamScope, unlockMember } from '../services/team';

const idParam = z.object({ id: z.string().uuid() });

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  // ----------------------------------------------------------------- own org
  app.get('/api/org', { preHandler: guard({ permission: 'org.read' }) }, async (req) => {
    const a = getAuth(req);
    return tx(dbCtx(a), async (c) => {
      const o = await one<any>(c, 'SELECT * FROM organizations WHERE id = $1', [a.orgId]);
      if (!o) throw notFound();
      const sites = await many<any>(
        c,
        `SELECT s.id, s.code, s.name, s.country FROM org_sites os JOIN sites s ON s.id = os.site_id WHERE os.org_id = $1 ORDER BY s.code`,
        [a.orgId],
      );
      const state = await orgUploadState(c, a.orgId);
      const s = o.settings ?? {};
      return {
        id: o.id,
        kind: o.kind,
        name: o.name,
        code: o.code,
        legalName: o.legal_name,
        country: o.country,
        vatId: o.vat_id,
        status: o.status,
        retentionMonths: o.retention_months,
        defaultSiteId: o.default_site_id,
        sites,
        settings: {
          requirePts: !!s.require_pts,
          manualReview: !!s.manual_review,
          slaDays: typeof s.sla_days === 'number' ? s.sla_days : 3,
          caseIdRegex: typeof s.case_id_regex === 'string' ? s.case_id_regex : null,
        },
        dpaOnFile: state.dpaOnFile,
        uploadsUnlocked: state.unlocked,
        // The shell shows the logo left of the company name: GET /api/org/logo?v=<version>.
        logo: logoView(o),
        // Menu visibility for the caller: what the menu shows, never what the caller may do (see docs/SECURITY.md).
        menu: menuVisibleFor(a, o.settings),
      };
    });
  });

  // Menu visibility. The raw setting is readable by everybody in the company; only company administrators (org.edit) change it.
  // VISIBILITY ONLY: role permissions and route guards are not touched by this setting.
  app.get('/api/org/menu', { preHandler: guard({ permission: 'org.read' }) }, async (req) => getMenuSetting(partnerOnly(getAuth(req))));
  app.put('/api/org/menu', { preHandler: guard({ permission: 'org.edit' }) }, async (req) => {
    const a = partnerOnly(getAuth(req));
    return updateMenuSetting(a, req, parse(menuPatchSchema, req.body));
  });

  // -------------------------------------------------------------------- team
  const stepUp = { preHandler: guard({ permission: 'team.manage', stepUp: true }) };
  const plain = { preHandler: guard({ permission: 'team.manage' }) };

  app.get('/api/team', plain, async (req) => {
    const a = getAuth(req);
    return { users: await listMembers(a, teamScope(a)) };
  });

  app.post('/api/team/invite', stepUp, async (req, reply) => {
    const a = getAuth(req);
    assertApproved(a); // team invites unlock when K Line has approved the company
    const body = parse(
      z.object({ email: emailSchema, name: z.string().trim().min(1).max(120), roles: rolesSchema(a.orgKind), siteIds: z.array(z.string().uuid()).max(20).optional() }),
      req.body,
    );
    const id = await inviteMember(a, req, teamScope(a), body);
    reply.code(201);
    return { id };
  });

  app.post('/api/team/:id/roles', stepUp, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    const { roles } = parse(z.object({ roles: rolesSchema(a.orgKind) }), req.body);
    await changeRoles(a, req, teamScope(a), id, roles);
    return { ok: true };
  });

  app.post('/api/team/:id/disable', plain, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    await disableMember(a, req, teamScope(a), id);
    return { ok: true };
  });

  app.post('/api/team/:id/enable', plain, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    await enableMember(a, req, teamScope(a), id);
    return { ok: true };
  });

  app.post('/api/team/:id/reset-mfa', stepUp, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    await resetMemberMfa(a, req, teamScope(a), id);
    return { ok: true };
  });

  // Lifts a lock after wrong passwords or wrong authenticator codes.
  app.post('/api/team/:id/unlock', stepUp, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    await unlockMember(a, req, teamScope(a), id);
    return { ok: true };
  });

  app.post('/api/team/:id/resend-invite', plain, async (req) => {
    const a = getAuth(req);
    assertApproved(a);
    const { id } = parse(idParam, req.params);
    await resendMemberInvite(a, req, teamScope(a), id);
    return { ok: true };
  });
}
