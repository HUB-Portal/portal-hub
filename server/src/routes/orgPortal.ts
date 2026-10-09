import type { FastifyInstance } from 'fastify';
import { dbCtx, getAuth, guard } from '../auth/context';
import { one, tx } from '../db';
import { notFound } from '../http/errors';
import { clientIp, parse, userAgent } from '../http/util';
import { partnerApproved } from '../services/org';
import { createOrRotateHook, deleteHook, webhookView } from '../services/portalHooks';
import { portalBody, portalView, savePortalSettings, testPortalSettings } from '../services/portalSettings';

/** K Line customer portal credentials per organisation. The API key is stored encrypted and never returned. */
export async function orgPortalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/org/portal-api', { preHandler: guard({ permission: 'integration.manage' }) }, async (req) => {
    const a = getAuth(req);
    const { o, webhook } = await tx(dbCtx(a), async (c) => ({ o: await one<any>(c, 'SELECT settings FROM organizations WHERE id = $1', [a.orgId]), webhook: await webhookView(c, a.orgId) }));
    if (!o) throw notFound();
    return { ...portalView(o.settings), webhook };
  });

  // Instant updates: the address and secret the K Line portal uses to tell the Hub that a case changed. The secret is shown once.
  app.post('/api/org/portal-api/webhook', { preHandler: guard({ permission: 'integration.manage', stepUp: true }) }, async (req, reply) => {
    const a = partnerApproved(getAuth(req));
    const out = await createOrRotateHook(a, { ip: clientIp(req), headers: { 'user-agent': userAgent(req) ?? undefined } });
    reply.code(out.rotated ? 200 : 201);
    return { url: out.url, secret: out.secret, rotated: out.rotated };
  });

  app.delete('/api/org/portal-api/webhook', { preHandler: guard({ permission: 'integration.manage', stepUp: true }) }, async (req) => {
    const a = partnerApproved(getAuth(req));
    await deleteHook(a, { ip: clientIp(req), headers: { 'user-agent': userAgent(req) ?? undefined } });
    return { ok: true };
  });

  app.put('/api/org/portal-api', { preHandler: guard({ permission: 'integration.manage', stepUp: true }) }, async (req) => {
    const a = getAuth(req);
    return savePortalSettings(a, a.orgId, parse(portalBody, req.body), { ip: clientIp(req), userAgent: userAgent(req) });
  });

  app.post('/api/org/portal-api/test', { preHandler: guard({ permission: 'integration.manage' }), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const a = getAuth(req);
    return testPortalSettings(a, a.orgId, { ip: clientIp(req), userAgent: userAgent(req) });
  });
}
