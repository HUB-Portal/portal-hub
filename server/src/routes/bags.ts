import type { FastifyInstance } from 'fastify';
import { audit } from '../audit';
import { dbCtx, getAuth, guard, requireStepUp } from '../auth/context';
import { one, tx } from '../db';
import { notFound } from '../http/errors';
import { clientIp, userAgent } from '../http/util';
import { BAG_LIMITS, BAG_TOKENS, DEFAULT_BAG_LAYOUT, PERSONAL_TOKENS, printsPersonalData, renderBags, type BagLayout } from '../../../shared/bag';
import { conflict } from '../http/errors';
import { SAMPLE_BAG_CASE, orgBagLayout, parseBagLayout } from '../services/bags';

function view(layout: BagLayout, spec: { version: number } | null) {
  return {
    layout,
    /** True while an active production specification holds the layout: change it in a new specification version instead. */
    lockedBySpec: !!spec,
    specVersion: spec?.version ?? null,
    printsPersonalData: printsPersonalData(layout),
    defaults: DEFAULT_BAG_LAYOUT,
    tokens: BAG_TOKENS,
    personalTokens: PERSONAL_TOKENS,
    limits: BAG_LIMITS,
    // A preview with sample data, so the form can show what a bag will say.
    preview: renderBags(layout, SAMPLE_BAG_CASE),
  };
}

/** Bag label layout of the caller's organisation. */
export async function bagRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/org/bag-layout', { preHandler: guard({ permission: 'org.edit' }) }, async (req) => {
    const a = getAuth(req);
    return tx(dbCtx(a), async (c) => {
      const o = await one<any>(c, 'SELECT id FROM organizations WHERE id = $1', [a.orgId]);
      if (!o) throw notFound();
      const spec = await one<{ version: number }>(c, `SELECT version FROM specs WHERE org_id = $1 AND status = 'active'`, [a.orgId]);
      return view(await orgBagLayout(c, a.orgId), spec ?? null);
    });
  });

  app.put('/api/org/bag-layout', { preHandler: guard({ permission: 'org.edit' }) }, async (req) => {
    const a = getAuth(req);
    const layout = parseBagLayout(req.body);
    const active = await tx(dbCtx(a), (c) => one<{ version: number }>(c, `SELECT version FROM specs WHERE org_id = $1 AND status = 'active'`, [a.orgId]));
    // With an active specification the bag layout belongs to it. Changes go into a new specification version.
    if (active) throw conflict('The bag layout is part of your production specification. Change it in a new version of the specification.', 'bag_in_spec');
    // Printing patient data on a bag is a privacy relevant switch, so it needs a fresh authenticator code.
    if (printsPersonalData(layout)) requireStepUp(a);
    return tx(dbCtx(a), async (c) => {
      const o = await one<any>(c, 'SELECT settings FROM organizations WHERE id = $1 FOR UPDATE', [a.orgId]);
      if (!o) throw notFound();
      await c.query(`UPDATE organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{bag}', $2::jsonb, true), updated_at = now() WHERE id = $1`, [a.orgId, JSON.stringify(layout)]);
      await audit(c, {
        actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'org.bag_layout_updated', targetType: 'organization', targetId: a.orgId, ip: clientIp(req), userAgent: userAgent(req),
        details: { printsPersonalData: printsPersonalData(layout), lines: layout.lines.length },
      });
      return view(layout, null);
    });
  });
}
