import { z } from 'zod';
import { audit } from '../audit';
import { dbCtx, type AuthContext } from '../auth/context';
import { one, tx, type PoolClient } from '../db';
import { encryptField, fieldAad } from '../crypto/keys';
import { badRequest, notFound } from '../http/errors';
import { PortalError, getPortalClient, portalConfigured, portalSettings } from './portal';
import { assertSafePortalUrl } from './portal/v2';

/** K Line customer portal credentials of one organisation, shared by the partner's own page and the K Line console. */
export const portalBody = z.object({
  baseUrl: z.string().min(8).max(300),
  apiKey: z.string().min(16).max(512).optional(),
  userUuid: z.string().uuid(),
  doctorId: z.string().max(64).nullish(),
  defaultGender: z.number().int().min(0).max(9).optional(),
});
export type PortalBody = z.infer<typeof portalBody>;

/** What the settings page may see. The API key is never part of it. */
export function portalView(settings: Record<string, any> | null) {
  const p = portalSettings(settings);
  return { configured: portalConfigured(settings), baseUrl: p.baseUrl ?? null, userUuid: p.userUuid ?? null, doctorId: p.doctorId ?? null, defaultGender: Number.isInteger(p.defaultGender) ? (p.defaultGender as number) : 2 };
}

interface Who { ip: string | null; userAgent: string | null }

/** Saves the credentials of `orgId`. Without a new API key the saved one stays. `byStaff` marks a change made by K Line for a partner. */
export async function savePortalSettings(a: AuthContext, orgId: string, body: PortalBody, who: Who, byStaff = false) {
  let baseUrl: string;
  try {
    baseUrl = assertSafePortalUrl(body.baseUrl);
  } catch (e) {
    if (e instanceof PortalError) throw badRequest('Use the https address of the K Line portal.', 'invalid_portal_url');
    throw e;
  }
  return tx(dbCtx(a), async (c: PoolClient) => {
    const o = await one<any>(c, 'SELECT settings FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
    if (!o) throw notFound();
    const existing = portalSettings(o.settings);
    if (!body.apiKey && !existing.apiKeyEnc) throw badRequest('Enter the API key.', 'api_key_required');
    const next = {
      baseUrl,
      apiKeyEnc: body.apiKey ? encryptField(body.apiKey.trim(), fieldAad.portalKey(orgId)) : existing.apiKeyEnc,
      userUuid: body.userUuid,
      doctorId: body.doctorId ? body.doctorId.trim() : null,
      ...(body.defaultGender !== undefined ? { defaultGender: body.defaultGender } : existing.defaultGender !== undefined ? { defaultGender: existing.defaultGender } : {}),
    };
    await c.query(`UPDATE organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{portal_api}', $2::jsonb, true), updated_at = now() WHERE id = $1`, [orgId, JSON.stringify(next)]);
    await audit(c, {
      actorType: 'user', actorId: a.userId, orgId, action: 'org.portal_api_updated', targetType: 'organization', targetId: orgId, ip: who.ip, userAgent: who.userAgent,
      details: { keyReplaced: !!body.apiKey, ...(byStaff ? { byStaff: true } : {}) },
    });
    return portalView({ portal_api: next });
  });
}

/** Asks the K Line portal for a reply with the saved credentials of `orgId`. */
export async function testPortalSettings(a: AuthContext, orgId: string, who: Who, byStaff = false): Promise<{ ok: boolean; code?: string; message?: string }> {
  const o = await tx(dbCtx(a), (c) => one<any>(c, 'SELECT id, settings FROM organizations WHERE id = $1', [orgId]));
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
    audit(c, { actorType: 'user', actorId: a.userId, orgId, action: 'org.portal_api_tested', targetType: 'organization', targetId: orgId, ip: who.ip, userAgent: who.userAgent, details: { ok: out.ok, code: out.code ?? null, ...(byStaff ? { byStaff: true } : {}) } }),
  );
  return out;
}
