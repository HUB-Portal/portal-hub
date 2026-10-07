import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { audit } from '../audit';
import { SYSTEM, one, tx } from '../db';
import { createSession, loginStage, revokeUserSessions, setSessionCookie } from '../auth/sessions';
import { checkPasswordPolicy, hashPassword } from '../crypto/password';
import { csrfFor } from '../crypto/tokens';
import { badRequest, forbidden } from '../http/errors';
import { clientIp, parse, userAgent } from '../http/util';
import { PRIVACY_VERSION, validateRegistration } from '../../../shared/signup';
import { SIGNUP_ANSWER, alertKlineAdmins, floorTime, processRegistration } from '../services/signup';
import { consumeUserToken, findUserToken } from '../services/userTokens';

const REGISTER_LIMIT = { rateLimit: { max: 5, timeWindow: '10 minutes' } };
const AUTH_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const INVALID_LINK = 'This link is not valid or has expired. Register again to get a new one.';

/** Public routes: no session. Every query runs as the system role, so each one is scoped by the token or address deliberately. */
export async function signupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/public/config', async () => ({
    privacyEmail: config.privacyEmail,
    supportEmail: config.supportEmail,
    signupEnabled: config.signupEnabled,
    privacyVersion: PRIVACY_VERSION,
    googleSignIn: config.oidc.googleEnabled,
    mfaRequired: config.mfaRequired,
  }));

  // ---------------------------------------------------------------- register
  app.post('/api/auth/register', { config: REGISTER_LIMIT }, async (req, reply) => {
    const started = process.hrtime.bigint();
    if (!config.signupEnabled) throw forbidden('Registration is not open at the moment.', 'signup_disabled');
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    // Honeypot: a person never sees this field. Answer as if all was well and do nothing.
    if (typeof body.hp === 'string' ? body.hp.trim() !== '' : body.hp !== undefined && body.hp !== null && body.hp !== false) {
      await floorTime(started, config.signupMinMs);
      return reply.code(202).send(SIGNUP_ANSWER);
    }

    // Validation never looks at the database, so a 400 says nothing about any address. It is answered at once.
    const v = validateRegistration(body);
    if (!v.ok) {
      const emailNotAllowed = v.problems.some((p) => p.code === 'email_not_allowed');
      throw badRequest(
        emailNotAllowed && v.problems.length === 1 ? v.problems[0]!.message : 'Some details are missing or not valid.',
        emailNotAllowed ? 'email_not_allowed' : 'invalid_request',
        { fields: v.problems.map((p) => ({ path: p.path, message: p.message })) },
      );
    }

    try {
      await processRegistration(v.value);
    } catch (err) {
      // The same answer whatever happens behind it. The log line holds no request data.
      req.log.error({ err }, 'registration failed');
    }
    await floorTime(started, config.signupMinMs);
    return reply.code(202).send(SIGNUP_ANSWER);
  });

  // ------------------------------------------------------------------ verify
  app.get('/api/auth/verify/:token', { config: AUTH_LIMIT }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.params);
    const r = await tx(SYSTEM, async (c) => {
      const f = await findUserToken(c, token, 'verify');
      if (!f) return null;
      // Scoped by the user the token belongs to.
      return one<any>(c, `SELECT u.email, u.name, u.status, o.name AS org_name FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`, [f.userId]);
    });
    if (!r || r.status === 'disabled') return { valid: false };
    return { valid: true, email: r.email, name: r.name, orgName: r.org_name };
  });

  app.post('/api/auth/verify', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), password: z.string().min(1).max(200) }), req.body);
    const t = await tx(SYSTEM, async (c) => {
      const f = await findUserToken(c, body.token, 'verify');
      if (!f) return null;
      const u = await one<any>(c, `SELECT email, name, mfa_enabled, status FROM users WHERE id = $1`, [f.userId]);
      return u && u.status !== 'disabled' ? { ...f, email: u.email as string, name: u.name as string, mfa: u.mfa_enabled as boolean } : null;
    });
    if (!t) throw badRequest(INVALID_LINK, 'invalid_token');
    const problem = checkPasswordPolicy(body.password, { email: t.email, name: t.name });
    if (problem) throw badRequest(problem, 'weak_password');
    const hash = await hashPassword(body.password);
    const stage = loginStage(t.mfa);
    const s = await tx(SYSTEM, async (c) => {
      if (!(await consumeUserToken(c, t.id))) throw badRequest(INVALID_LINK, 'invalid_token');
      await c.query('UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, updated_at = now() WHERE id = $1', [t.userId, hash]);
      await revokeUserSessions(c, t.userId, 'email_confirmed');
      // The first confirmation marks the registration and tells K Line. A user who confirms again (a second link) changes nothing.
      const marked = await c.query(
        `UPDATE organizations SET signup = jsonb_set(signup, '{verified_at}', $2::jsonb, true), updated_at = now()
          WHERE id = $1 AND signup ? 'at' AND (signup->>'verified_at') IS NULL AND NOT (signup ? 'declined_at')`,
        [t.orgId, JSON.stringify(new Date().toISOString())],
      );
      const created = await createSession(c, { userId: t.userId, orgId: t.orgId, stage, ip: clientIp(req), userAgent: userAgent(req) });
      await audit(c, { actorType: 'user', actorId: t.userId, orgId: t.orgId, action: 'auth.invite_accepted', ip: clientIp(req), userAgent: userAgent(req), details: { via: 'signup_verify' } });
      if (marked.rowCount) {
        await audit(c, { actorType: 'user', actorId: t.userId, orgId: t.orgId, action: 'signup.email_confirmed', targetType: 'organization', targetId: t.orgId, ip: clientIp(req), userAgent: userAgent(req) });
        // Fixed text, no company name: the reviewer opens the console for the details.
        await alertKlineAdmins(c, {
          kind: 'signup_confirmed',
          title: 'A new company is waiting for review',
          body: 'A new company has confirmed its email address.',
          template: 'admin_new_signup',
          data: { orgId: t.orgId },
        });
      }
      return created;
    });
    setSessionCookie(reply, s.token, s.expiresAt);
    return { stage, csrfToken: csrfFor(s.id) };
  });
}
