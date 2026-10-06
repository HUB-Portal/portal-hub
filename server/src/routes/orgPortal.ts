import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit';
import { dbCtx, getAuth, guard } from '../auth/context';
import { one, tx } from '../db';
import { encryptField, fieldAad } from '../crypto/keys';
import { badRequest, notFound } from '../http/errors';
import { clientIp, parse, userAgent } from '../http/util';
import { PortalError, getPortalClient, portalConfigured, portalSettings } from '../services/portal';
import { assertSafePortalUrl } from '../services/portal/v2';
import { partnerApproved } from '../services/org';
import { createOrRotateHook, deleteHook, webhookView } from '../services/portalHooks';

const view = (settings: Record<string, any> | null) => {
  const p = portalSettings(settings);
  return { configured: portalConfigured(settings), baseUrl: p.baseUrl ?? null, userUuid: p.userUuid ?? null, doctorId: p.doctorId ?? null, defaultGender: Number.isInteger(p.defaultGender) ? (p.defaultGender as number) : 2 };
};

/** K Line customer portal credentials per organisation. The API key is stored encrypted and never returned. */
export async function orgPortalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/org/portal-api', { preHandler: guard({ permission: 'integration.manage' }) }, async (req) => {
    const a = getAuth(req);
    const { o, webhook } = await tx(dbCtx(a), async (c) => ({ o: await one<any>(c, 'SELECT settings FROM organizations WHERE id = $1', [a.orgId]), webhook: await webhookView(c, a.orgId) }));
    if (!o) throw notFound();
    return { ...view(o.settings), webhook };
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
    const body = parse(
      z.object({
        baseUrl: z.string().min(8).max(300),
        apiKey: z.string().min(16).max(512).optional(),
        userUuid: z.string().uuid(),
        doctorId: z.string().max(64).nullish(),
        defaultGender: z.number().int().min(0).max(9).optional(),
      }),
      req.body,
    );
    let baseUrl: string;
    try {
      baseUrl = assertSafePortalUrl(body.baseUrl);
    } catch (e) {
      if (e instanceof PortalError) throw badRequest('Use the https address of the K Line portal.', 'invalid_portal_url');
      throw e;
    }
    return tx(dbCtx(a), async (c) => {
      const o = await one<any>(c, 'SELECT settings FROM organizations WHERE id = $1 FOR UPDATE', [a.orgId]);
      if (!o) throw notFound();
      const existing = portalSettings(o.settings);
      if (!body.apiKey && !existing.apiKeyEnc) throw badRequest('Enter the API key.', 'api_key_required');
      const next = {
        baseUrl,
        apiKeyEnc: body.apiKey ? encryptField(body.apiKey.trim(), fieldAad.portalKey(a.orgId)) : existing.apiKeyEnc,
        userUuid: body.userUuid,
        doctorId: body.doctorId ? body.doctorId.trim() : null,
        ...(body.defaultGender !== undefined ? { defaultGender: body.defaultGender } : existing.defaultGender !== undefined ? { defaultGender: existing.defaultGender } : {}),
      };
      await c.query(`UPDATE organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{portal_api}', $2::jsonb, true), updated_at = now() WHERE id = $1`, [a.orgId, JSON.stringify(next)]);
      await audit(c, {
        actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'org.portal_api_updated', targetType: 'organization', targetId: a.orgId, ip: clientIp(req), userAgent: userAgent(req),
        details: { keyReplaced: !!body.apiKey },
      });
      return view({ portal_api: next });
    });
  });

  app.post('/api/org/portal-api/test', { preHandler: guard({ permission: 'integration.manage' }), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const a = getAuth(req);
    const o = await tx(dbCtx(a), (c) => one<any>(c, 'SELECT id, settings FROM organizations WHERE id = $1', [a.orgId]));
    if (!o) throw notFound();
    let out: { ok: boolean; code?: string; message?: string };
    let client: any;
    try {
      client = getPortalClient({ id: o.id, settings: o.settings ?? {} });
      await client.ping();
      out = { ok: true };
    } catch (e) {
      const pe = e instanceof PortalError ? e : new PortalError('unexpected');
      out = { ok: false, code: pe.code, message: pe.message };
    } finally {
      await client?.close?.().catch(() => undefined);
    }
    await tx(dbCtx(a), (c) =>
      audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'org.portal_api_tested', targetType: 'organization', targetId: a.orgId, ip: clientIp(req), userAgent: userAgent(req), details: { ok: out.ok, code: out.code ?? null } }),
    );
    return out;
  });
}
