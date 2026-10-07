import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { audit } from '../audit';
import { SYSTEM, one, tx } from '../db';
import { createSession, loginStage, revokeSession, setSessionCookie } from '../auth/sessions';
import { OIDC_FLOW_MINUTES, OidcError, exchangeCode, hashValue, startFlow, verifyGoogleIdToken } from '../auth/oidc';
import { safeEqual } from '../crypto/keys';
import { clientIp, userAgent } from '../http/util';

const OIDC_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const FAILED = '/login?error=google';
const oidcCookie = () => (config.isProd ? '__Host-kph_oidc' : 'kph_oidc');

function clearFlowCookie(reply: FastifyReply): void {
  // Lax, not Strict: the browser comes back from Google with a cross site navigation, and a Strict cookie would not be sent.
  reply.clearCookie(oidcCookie(), { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/' });
}

/** Staff may sign in with Google only when the account already exists. Nothing here creates an account. */
export async function oidcRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/oidc/google/start', { config: OIDC_LIMIT }, async (req, reply) => {
    if (!config.oidc.googleEnabled) return reply.redirect(FAILED, 302);
    try {
      const flow = await startFlow();
      await tx(SYSTEM, (c) =>
        c.query(
          `INSERT INTO oidc_flows (state, nonce, code_verifier, browser_hash, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
          [flow.stateHash, flow.nonceHash, flow.encryptedVerifier, flow.browserHash, OIDC_FLOW_MINUTES],
        ),
      );
      reply.setCookie(oidcCookie(), flow.browserToken, { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/', maxAge: OIDC_FLOW_MINUTES * 60 });
      return reply.redirect(flow.url, 302);
    } catch (err) {
      req.log.error({ err }, 'google sign in could not start');
      return reply.redirect(FAILED, 302);
    }
  });

  app.get('/api/auth/oidc/google/callback', { config: OIDC_LIMIT }, async (req, reply) => {
    const fail = async (reason: string, extra: Record<string, unknown> = {}, orgId: string | null = null, userId: string | null = null) => {
      clearFlowCookie(reply);
      await tx(SYSTEM, (c) =>
        audit(c, { actorType: userId ? 'user' : 'system', actorId: userId, orgId, action: 'auth.oidc_failed', ip: clientIp(req), userAgent: userAgent(req), details: { provider: 'google', reason, ...extra } }),
      ).catch(() => {});
      return reply.redirect(FAILED, 302);
    };
    try {
      return await handleCallback(req, reply, fail);
    } catch (err) {
      req.log.error({ err: err instanceof OidcError ? { name: 'OidcError', message: err.reason } : err }, 'google sign in failed');
      return fail(err instanceof OidcError ? err.reason : 'error');
    }
  });
}

async function handleCallback(
  req: FastifyRequest,
  reply: FastifyReply,
  fail: (reason: string, extra?: Record<string, unknown>, orgId?: string | null, userId?: string | null) => Promise<unknown>,
): Promise<unknown> {
  if (!config.oidc.googleEnabled || !config.oidc.googleClientId || !config.oidc.allowedDomain) return fail('not_configured');
  const q = (req.query ?? {}) as Record<string, unknown>;
  const state = typeof q.state === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(q.state) ? q.state : null;
  const code = typeof q.code === 'string' && q.code.length > 0 && q.code.length <= 2048 ? q.code : null;
  if (typeof q.error === 'string') return fail('provider_error');
  const browserToken = req.cookies?.[oidcCookie()];
  if (!state || !code || !browserToken) return fail('request_invalid');

  // A flow can be used once, and only in the browser that started it.
  const stateHash = hashValue(state);
  const flow = await tx(SYSTEM, async (c) => {
    const r = await c.query(`DELETE FROM oidc_flows WHERE state = $1 AND expires_at > now() RETURNING nonce, code_verifier, browser_hash`, [stateHash]);
    return r.rows[0] as { nonce: string; code_verifier: string; browser_hash: string | null } | undefined;
  });
  if (!flow) return fail('state_invalid');
  if (!flow.browser_hash || !safeEqual(flow.browser_hash, hashValue(browserToken))) return fail('browser_mismatch');

  const idToken = await exchangeCode(code, flow.code_verifier, stateHash);
  const claims = await verifyGoogleIdToken(idToken, {
    clientId: config.oidc.googleClientId,
    allowedDomain: config.oidc.allowedDomain,
    nonceHash: flow.nonce,
  });

  const email = claims.email!.toLowerCase();
  const previous = req.auth?.sessionId ?? null;
  const outcome = await tx(SYSTEM, async (c) => {
    const u = await one<any>(
      c,
      `SELECT u.id, u.org_id, u.status, u.mfa_enabled, u.oidc_subject, u.auth_provider, o.kind AS org_kind, o.status AS org_status
         FROM users u JOIN organizations o ON o.id = u.org_id WHERE lower(u.email) = $1 FOR UPDATE OF u`,
      [email],
    );
    // Staff only: the account must exist in the K Line organisation. Partner users never sign in with Google.
    if (!u || u.org_kind !== 'kline' || u.org_status === 'suspended' || !['active', 'invited'].includes(u.status) || !['google', 'local'].includes(u.auth_provider)) {
      return { ok: false as const, reason: 'no_account', ref: hashValue(email).slice(0, 12), orgId: u?.org_id ?? null, userId: null };
    }
    if (u.oidc_subject && !safeEqual(u.oidc_subject, claims.sub)) {
      return { ok: false as const, reason: 'subject_mismatch', orgId: u.org_id, userId: u.id };
    }
    if (!u.oidc_subject) await c.query('UPDATE users SET oidc_subject = $2 WHERE id = $1', [u.id, claims.sub]);

    // Fixed decision 4: Google is only the first factor. A session made here is never `full`; the authenticator code (or its setup) comes next.
    const stage = loginStage(u.mfa_enabled);
    if (previous) await revokeSession(c, previous, 'replaced');
    const s = await createSession(c, { userId: u.id, orgId: u.org_id, stage, ip: clientIp(req), userAgent: userAgent(req) });
    await audit(c, {
      actorType: 'user', actorId: u.id, orgId: u.org_id, action: 'auth.google_ok',
      ip: clientIp(req), userAgent: userAgent(req), details: { method: 'google', stage },
    });
    return { ok: true as const, stage, session: s };
  });

  if (!outcome.ok) {
    return fail(outcome.reason, outcome.reason === 'no_account' ? { ref: (outcome as any).ref } : {}, outcome.orgId, outcome.userId);
  }
  clearFlowCookie(reply);
  setSessionCookie(reply, outcome.session.token, outcome.session.expiresAt);
  return reply.redirect(outcome.stage === 'password' ? '/mfa' : outcome.stage === 'mfa_setup' ? '/mfa-setup' : '/', 302);
}
