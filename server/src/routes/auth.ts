import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { audit } from '../audit';
import { SYSTEM, tx, one, type PoolClient } from '../db';
import { dbCtx, getAuth, guard, type AuthContext } from '../auth/context';
import {
  clearSessionCookie, clearUserMfaFailures, createSession, isUserLocked, listSessions, loginStage, markStepUp, promoteSession, recordMfaFailure, recordUserMfaFailure,
  revokeSession, revokeUserSessions, setSessionCookie,
} from '../auth/sessions';
import { decryptField, encryptField, fieldAad } from '../crypto/keys';
import { checkPasswordPolicy, dummyVerify, hashPassword, verifyPassword } from '../crypto/password';
import { csrfFor, sha256Hex } from '../crypto/tokens';
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUri, qrDataUrl, verifyTotp } from '../crypto/totp';
import { badRequest, unauthorized } from '../http/errors';
import { clientIp, padTo, parse, userAgent } from '../http/util';
import { queueEmail } from '../services/notify';
import { consumeUserToken, createUserToken, findUserToken } from '../services/userTokens';
import { demoCurrentCode } from '../services/demo';
import { demoAllowed } from '../http/proxy';

const AUTH_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const FORGOT_LIMIT = { rateLimit: { max: 5, timeWindow: '1 minute' } };

const GENERIC_LOGIN = 'The email address or password is not correct, or the account is temporarily locked.';
const BAD_CODE = 'That code is not correct. Try the next one from your app.';

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const codeSchema = z.string().trim().transform((s) => s.replace(/\s+/g, '')).pipe(z.string().min(6).max(24));
const passwordSchema = z.string().min(1).max(200);

function sha8(s: string): string {
  return sha256Hex(s.toLowerCase()).slice(0, 12);
}

export function publicUser(a: AuthContext) {
  return { id: a.userId, email: a.email, name: a.name, roles: a.roles };
}

/** Everything the web app needs to know about the caller. */
async function meBody(a: AuthContext, req: FastifyRequest) {
  const full = a.stage === 'full';
  const extra = await tx(dbCtx(a), async (c) => {
    const u = await one<{ mfa_enabled: boolean; recovery: number; site_ids: string[] }>(
      c,
      'SELECT mfa_enabled, cardinality(recovery_hashes)::int AS recovery, site_ids FROM users WHERE id = $1',
      [a.userId],
    );
    const org = await one<any>(c, 'SELECT id, kind, name, code, status, country FROM organizations WHERE id = $1', [a.orgId]);
    return { u, org };
  });
  // Demo hints (the live authenticator code) only for direct local use: never through a proxy or tunnel, never from a public address.
  const demo = demoAllowed(req)
    ? { enabled: true, code: a.email ? demoCurrentCode(a.email) : null }
    : { enabled: false, code: null };
  return {
    authenticated: true,
    stage: a.stage,
    csrfToken: a.sessionId ? csrfFor(a.sessionId) : null,
    user: { id: a.userId, email: a.email, name: a.name, roles: a.roles, mfaEnabled: extra.u?.mfa_enabled ?? false, recoveryCodesRemaining: extra.u?.recovery ?? 0 },
    org: extra.org ? { id: extra.org.id, kind: extra.org.kind, name: extra.org.name, code: extra.org.code, status: extra.org.status, country: extra.org.country } : null,
    permissions: full ? [...a.permissions].sort() : [],
    stepUp: { valid: !config.mfaRequired || (!!a.stepUpAt && Date.now() - new Date(a.stepUpAt).getTime() <= config.stepUpMinutes * 60_000), minutes: config.stepUpMinutes },
    demo,
  };
}

const LOCKED_TEXT = 'Too many wrong codes. Sign in is paused for a short while. Please try again later.';

interface MfaFail {
  /** The session ended (five wrong codes in this session, or the account was locked). */
  revoked: boolean;
  /** The account is locked. */
  locked: boolean;
}

/**
 * A wrong authenticator or recovery code. It is counted for the person across all sessions (five within 15 minutes lock the account and end
 * every session) and for this session (five end the session). It runs in the same transaction as the check of the code, which holds the
 * row of the person, so parallel guesses are counted one by one.
 */
async function recordMfaFail(c: PoolClient, req: FastifyRequest, a: AuthContext, action: string): Promise<MfaFail> {
  const user = await recordUserMfaFailure(c, a.userId!);
  const revoked = user.locked ? true : await recordMfaFailure(c, a.sessionId!);
  await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action, ip: clientIp(req), userAgent: userAgent(req), details: { sessionRevoked: revoked, accountLocked: user.locked } });
  if (user.locked) await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'auth.mfa_locked', ip: clientIp(req), userAgent: userAgent(req), details: { via: action } });
  return { revoked, locked: user.locked };
}

function throwMfaFail(reply: FastifyReply, out: MfaFail): never {
  if (out.revoked) {
    clearSessionCookie(reply);
    throw unauthorized(out.locked ? LOCKED_TEXT : 'Too many wrong codes. Please sign in again.', 'session_revoked');
  }
  throw badRequest(BAD_CODE, 'invalid_code');
}

/** A locked account cannot finish a sign in: its partial session is ended (and stays ended), nothing is counted. */
async function endIfLocked(c: PoolClient, a: AuthContext): Promise<boolean> {
  if (!(await isUserLocked(c, a.userId!))) return false;
  await revokeSession(c, a.sessionId!, 'mfa_lockout');
  return true;
}

function throwLocked(reply: FastifyReply): never {
  clearSessionCookie(reply);
  throw unauthorized(LOCKED_TEXT, 'session_revoked');
}

/** Checks a TOTP code against the user's secret, refusing replays. Returns the step, or null. Must run inside a tx. */
async function checkTotp(c: PoolClient, userId: string, code: string): Promise<number | null> {
  const u = await one<{ id: string; totp_secret_enc: string | null; totp_last_step: number | null }>(
    c,
    'SELECT id, totp_secret_enc, totp_last_step FROM users WHERE id = $1 FOR UPDATE',
    [userId],
  );
  if (!u?.totp_secret_enc) return null;
  const step = verifyTotp(decryptField(u.totp_secret_enc, fieldAad.userTotp(u.id)), code, { lastStep: u.totp_last_step });
  if (step === null) return null;
  await c.query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [userId, step]);
  await clearUserMfaFailures(c, userId); // only a correct authenticator code clears the wrong code counter
  return step;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------ login
  app.post('/api/auth/login', { config: AUTH_LIMIT }, async (req, reply) => {
    const started = Date.now();
    const body = parse(z.object({ email: emailSchema, password: passwordSchema }), req.body);
    const user = await tx(SYSTEM, (c) =>
      one<any>(
        c,
        `SELECT u.id, u.org_id, u.email, u.name, u.roles, u.password_hash, u.auth_provider, u.status, u.mfa_enabled, u.locked_until, o.status AS org_status
           FROM users u JOIN organizations o ON o.id = u.org_id WHERE lower(u.email) = $1`,
        [body.email],
      ),
    );
    const usable = !!user && user.auth_provider === 'local' && !!user.password_hash && user.status !== 'disabled' && user.org_status !== 'suspended';
    const passwordOk = usable ? await verifyPassword(user.password_hash, body.password) : await dummyVerify(body.password);
    const locked = !!user?.locked_until && new Date(user.locked_until) > new Date();

    if (!passwordOk || locked) {
      await tx(SYSTEM, async (c) => {
        if (user && !locked && usable) {
          await c.query(
            `UPDATE users SET
               failed_logins = CASE WHEN failed_logins + 1 >= 5 THEN 0 ELSE failed_logins + 1 END,
               lockout_count = CASE WHEN failed_logins + 1 >= 5 THEN lockout_count + 1 ELSE lockout_count END,
               locked_until = CASE WHEN failed_logins + 1 >= 5
                 THEN now() + LEAST(interval '24 hours', interval '15 minutes' * power(2, LEAST(lockout_count, 10))) ELSE locked_until END
             WHERE id = $1`,
            [user.id],
          );
        }
        await audit(c, {
          actorType: user ? 'user' : 'system',
          actorId: user?.id ?? null,
          orgId: user?.org_id ?? null,
          action: 'auth.login_failed',
          ip: clientIp(req),
          userAgent: userAgent(req),
          details: user ? { reason: locked ? 'locked' : 'bad_credentials' } : { reason: 'unknown_account', ref: sha8(body.email) },
        });
      });
      await padTo(started, 250);
      throw unauthorized(GENERIC_LOGIN, 'invalid_credentials');
    }

    const stage = loginStage(user.mfa_enabled);
    const previous = req.auth?.sessionId ?? null;
    const s = await tx(SYSTEM, async (c) => {
      if (previous) await revokeSession(c, previous, 'replaced');
      await c.query('UPDATE users SET failed_logins = 0, lockout_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
      const created = await createSession(c, { userId: user.id, orgId: user.org_id, stage, ip: clientIp(req), userAgent: userAgent(req) });
      await audit(c, { actorType: 'user', actorId: user.id, orgId: user.org_id, action: 'auth.password_ok', ip: clientIp(req), userAgent: userAgent(req), details: { stage } });
      if (stage === 'full') {
        await c.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
        await audit(c, { actorType: 'user', actorId: user.id, orgId: user.org_id, action: 'auth.login', ip: clientIp(req), userAgent: userAgent(req), details: { method: 'password', mfa: 'not_required' } });
      }
      return created;
    });
    setSessionCookie(reply, s.token, s.expiresAt);
    return { stage, csrfToken: csrfFor(s.id) };
  });

  // -------------------------------------------------------------- mfa verify
  app.post('/api/auth/mfa/verify', { config: AUTH_LIMIT, preHandler: guard({ partial: ['password'] }) }, async (req, reply) => {
    const a = getAuth(req);
    const { code } = parse(z.object({ code: codeSchema }), req.body);
    const out = await tx(dbCtx(a), async (c) => {
      if (await endIfLocked(c, a)) return { kind: 'locked' as const };
      const step = await checkTotp(c, a.userId!, code);
      if (step === null) return { kind: 'failed' as const, fail: await recordMfaFail(c, req, a, 'auth.mfa_failed') };
      await c.query('UPDATE users SET last_login_at = now() WHERE id = $1', [a.userId]);
      const s = await promoteSession(c, a.sessionId!, 'full', { stepUp: true });
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'auth.login', ip: clientIp(req), userAgent: userAgent(req), details: { method: 'totp' } });
      return { kind: 'ok' as const, s };
    });
    if (out.kind === 'locked') throwLocked(reply);
    if (out.kind === 'failed') throwMfaFail(reply, out.fail);
    setSessionCookie(reply, out.s.token, out.s.expiresAt);
    return { stage: 'full', csrfToken: csrfFor(a.sessionId!) };
  });

  app.post('/api/auth/mfa/recovery', { config: AUTH_LIMIT, preHandler: guard({ partial: ['password'] }) }, async (req, reply) => {
    const a = getAuth(req);
    const { code } = parse(z.object({ code: codeSchema }), req.body);
    const out = await tx(dbCtx(a), async (c) => {
      if (await endIfLocked(c, a)) return { kind: 'locked' as const };
      const r = await c.query(
        `UPDATE users SET recovery_hashes = array_remove(recovery_hashes, $2), last_login_at = now()
          WHERE id = $1 AND $2 = ANY(recovery_hashes) RETURNING cardinality(recovery_hashes)::int AS remaining`,
        [a.userId, hashRecoveryCode(code)],
      );
      if (!r.rows[0]) return { kind: 'failed' as const, fail: await recordMfaFail(c, req, a, 'auth.recovery_failed') };
      await clearUserMfaFailures(c, a.userId!);
      const s = await promoteSession(c, a.sessionId!, 'full', { stepUp: true });
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'auth.login', ip: clientIp(req), userAgent: userAgent(req), details: { method: 'recovery_code', remaining: r.rows[0].remaining } });
      return { kind: 'ok' as const, s, remaining: r.rows[0].remaining as number };
    });
    if (out.kind === 'locked') throwLocked(reply);
    if (out.kind === 'failed') throwMfaFail(reply, out.fail);
    setSessionCookie(reply, out.s.token, out.s.expiresAt);
    return { stage: 'full', csrfToken: csrfFor(a.sessionId!), recoveryCodesRemaining: out.remaining };
  });

  // --------------------------------------------------------------- mfa setup
  app.post('/api/auth/mfa/setup', { config: AUTH_LIMIT, preHandler: guard({ partial: ['mfa_setup'] }) }, async (req) => {
    const a = getAuth(req);
    const secret = generateTotpSecret();
    await tx(dbCtx(a), async (c) => {
      await c.query('UPDATE users SET totp_secret_enc = $2, mfa_enabled = false WHERE id = $1', [a.userId, encryptField(secret, fieldAad.userTotp(a.userId!))]);
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'auth.mfa_setup_started', ip: clientIp(req), userAgent: userAgent(req) });
    });
    const uri = otpauthUri({ secret, account: a.email! });
    return { secret, otpauthUri: uri, qrDataUrl: await qrDataUrl(uri) };
  });

  app.post('/api/auth/mfa/setup/confirm', { config: AUTH_LIMIT, preHandler: guard({ partial: ['mfa_setup'] }) }, async (req, reply) => {
    const a = getAuth(req);
    const { code } = parse(z.object({ code: codeSchema }), req.body);
    const rc = generateRecoveryCodes(10);
    const out = await tx(dbCtx(a), async (c) => {
      if (await endIfLocked(c, a)) return { kind: 'locked' as const };
      const step = await checkTotp(c, a.userId!, code);
      if (step === null) return { kind: 'failed' as const, fail: await recordMfaFail(c, req, a, 'auth.mfa_setup_failed') };
      await c.query(
        `UPDATE users SET mfa_enabled = true, mfa_enrolled_at = now(), status = 'active', recovery_hashes = $2, last_login_at = now() WHERE id = $1`,
        [a.userId, rc.hashes],
      );
      const s = await promoteSession(c, a.sessionId!, 'full', { stepUp: true });
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'auth.mfa_enrolled', ip: clientIp(req), userAgent: userAgent(req) });
      return { kind: 'ok' as const, s };
    });
    if (out.kind === 'locked') throwLocked(reply);
    if (out.kind === 'failed') throwMfaFail(reply, out.fail);
    setSessionCookie(reply, out.s.token, out.s.expiresAt);
    return { stage: 'full', csrfToken: csrfFor(a.sessionId!), recoveryCodes: rc.codes };
  });

  app.post('/api/auth/recovery-codes/regenerate', { config: AUTH_LIMIT, preHandler: guard({ stepUp: true }) }, async (req) => {
    const a = getAuth(req);
    const rc = generateRecoveryCodes(10);
    await tx(dbCtx(a), async (c) => {
      await c.query('UPDATE users SET recovery_hashes = $2 WHERE id = $1', [a.userId, rc.hashes]);
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'auth.recovery_codes_regenerated', ip: clientIp(req), userAgent: userAgent(req) });
    });
    return { recoveryCodes: rc.codes };
  });

  // ----------------------------------------------------------------- step up
  app.post('/api/auth/step-up', { config: AUTH_LIMIT, preHandler: guard() }, async (req, reply) => {
    const a = getAuth(req);
    const { code } = parse(z.object({ code: codeSchema }), req.body);
    const out = await tx(dbCtx(a), async (c) => {
      const step = await checkTotp(c, a.userId!, code);
      if (step === null) return { kind: 'failed' as const, fail: await recordMfaFail(c, req, a, 'auth.step_up_failed') };
      await markStepUp(c, a.sessionId!);
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'auth.step_up', ip: clientIp(req), userAgent: userAgent(req) });
      return { kind: 'ok' as const };
    });
    if (out.kind === 'failed') throwMfaFail(reply, out.fail);
    return { ok: true, validForMinutes: config.stepUpMinutes };
  });

  // ------------------------------------------------------------ me and csrf
  app.get('/api/auth/me', async (req) => meBody(getAuth(req), req));

  app.get('/api/auth/csrf', async (req) => {
    const a = getAuth(req);
    if (!a.sessionId) throw badRequest('API keys do not use CSRF tokens.');
    return { csrfToken: csrfFor(a.sessionId) };
  });

  // ------------------------------------------------------------------ logout
  app.post('/api/auth/logout', { preHandler: guard({ partial: true }) }, async (req, reply) => {
    const a = getAuth(req);
    await tx(dbCtx(a), async (c) => {
      await revokeSession(c, a.sessionId!, 'logout');
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'auth.logout', ip: clientIp(req), userAgent: userAgent(req) });
    });
    clearSessionCookie(reply);
    return { ok: true };
  });

  // ---------------------------------------------------------------- sessions
  app.get('/api/auth/sessions', { preHandler: guard() }, async (req) => {
    const a = getAuth(req);
    const rows = await tx(dbCtx(a), (c) => listSessions(c, a.userId!));
    return { sessions: rows.map((s) => ({ ...s, current: s.id === a.sessionId })) };
  });

  app.delete('/api/auth/sessions/:id', { preHandler: guard() }, async (req, reply) => {
    const a = getAuth(req);
    const id = parse(z.object({ id: z.string().uuid() }), req.params).id;
    await tx(dbCtx(a), async (c) => {
      const own = await one(c, 'SELECT 1 AS x FROM sessions WHERE id = $1 AND user_id = $2', [id, a.userId]);
      if (!own) return;
      await revokeSession(c, id, 'revoked_by_user');
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'auth.session_revoked', targetType: 'session', targetId: id, ip: clientIp(req), userAgent: userAgent(req) });
    });
    if (id === a.sessionId) clearSessionCookie(reply);
    return { ok: true };
  });

  app.post('/api/auth/sessions/revoke-others', { preHandler: guard() }, async (req) => {
    const a = getAuth(req);
    const n = await tx(dbCtx(a), async (c) => {
      const count = await revokeUserSessions(c, a.userId!, 'revoked_by_user', a.sessionId);
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'auth.sessions_revoked_others', ip: clientIp(req), userAgent: userAgent(req), details: { count } });
      return count;
    });
    return { revoked: n };
  });

  // --------------------------------------------------------- password change
  app.post('/api/auth/password/change', { config: AUTH_LIMIT, preHandler: guard() }, async (req) => {
    const a = getAuth(req);
    const body = parse(z.object({ currentPassword: passwordSchema, newPassword: passwordSchema }), req.body);
    const row = await tx(dbCtx(a), (c) => one<{ password_hash: string | null }>(c, 'SELECT password_hash FROM users WHERE id = $1', [a.userId]));
    const ok = row?.password_hash ? await verifyPassword(row.password_hash, body.currentPassword) : await dummyVerify(body.currentPassword);
    if (!ok) throw badRequest('Your current password is not correct.', 'invalid_current_password');
    if (body.newPassword === body.currentPassword) throw badRequest('Choose a new password that is different from your current one.', 'same_password');
    const problem = checkPasswordPolicy(body.newPassword, { email: a.email!, name: a.name! });
    if (problem) throw badRequest(problem, 'weak_password');
    const hash = await hashPassword(body.newPassword);
    await tx(dbCtx(a), async (c) => {
      await c.query('UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1', [a.userId, hash]);
      const n = await revokeUserSessions(c, a.userId!, 'password_changed', a.sessionId);
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'auth.password_changed', ip: clientIp(req), userAgent: userAgent(req), details: { otherSessionsRevoked: n } });
    });
    return { ok: true };
  });

  // --------------------------------------------------------- forgot and reset
  app.post('/api/auth/password/forgot', { config: FORGOT_LIMIT }, async (req) => {
    const started = Date.now();
    const { email } = parse(z.object({ email: emailSchema }), req.body);
    await tx(SYSTEM, async (c) => {
      const u = await one<any>(
        c,
        `SELECT u.id, u.org_id, u.name, u.email FROM users u JOIN organizations o ON o.id = u.org_id
          WHERE lower(u.email) = $1 AND u.auth_provider = 'local' AND u.status <> 'disabled' AND o.status <> 'suspended'`,
        [email],
      );
      if (!u) return;
      const token = await createUserToken(c, { orgId: u.org_id, userId: u.id, kind: 'reset', ttlMinutes: 60 });
      await queueEmail(c, { to: u.email, template: 'password_reset', orgId: u.org_id, data: { name: u.name, link: `${config.publicUrl}/reset-password?token=${token}` } });
      await audit(c, { actorType: 'system', orgId: u.org_id, action: 'auth.password_reset_requested', targetType: 'user', targetId: u.id, ip: clientIp(req), userAgent: userAgent(req) });
    }).catch(() => {
      /* same answer whatever happens */
    });
    await padTo(started, 400);
    return { ok: true, message: 'If that email address has an account, we have sent a link to reset the password.' };
  });

  app.post('/api/auth/password/reset', { config: AUTH_LIMIT }, async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), newPassword: passwordSchema }), req.body);
    const t = await tx(SYSTEM, async (c) => {
      const found = await findUserToken(c, body.token, 'reset');
      if (!found) return null;
      const u = await one<{ email: string; name: string }>(c, 'SELECT email, name FROM users WHERE id = $1', [found.userId]);
      return { ...found, email: u!.email, name: u!.name };
    });
    if (!t) throw badRequest('This link is not valid or has expired. Ask for a new one.', 'invalid_token');
    const problem = checkPasswordPolicy(body.newPassword, { email: t.email, name: t.name });
    if (problem) throw badRequest(problem, 'weak_password');
    const hash = await hashPassword(body.newPassword);
    await tx(SYSTEM, async (c) => {
      if (!(await consumeUserToken(c, t.id))) throw badRequest('This link is not valid or has expired. Ask for a new one.', 'invalid_token');
      // A reset by email link also lifts a lock (wrong passwords or wrong authenticator codes) and clears the wrong code counter.
      await c.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, lockout_count = 0, locked_until = NULL,
                mfa_failed_codes = 0, mfa_fail_window_start = NULL, mfa_lockout_count = 0, updated_at = now() WHERE id = $1`,
        [t.userId, hash],
      );
      const n = await revokeUserSessions(c, t.userId, 'password_reset');
      await audit(c, { actorType: 'user', actorId: t.userId, orgId: t.orgId, action: 'auth.password_reset', ip: clientIp(req), userAgent: userAgent(req), details: { sessionsRevoked: n } });
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ invite
  app.get('/api/auth/invite/:token', { config: AUTH_LIMIT }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.params);
    const r = await tx(SYSTEM, async (c) => {
      const f = await findUserToken(c, token, 'invite');
      if (!f) return null;
      return one<any>(c, `SELECT u.email, u.name, o.name AS org_name FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`, [f.userId]);
    });
    if (!r) throw badRequest('This invitation is not valid or has expired. Ask for a new one.', 'invalid_token');
    return { email: r.email, name: r.name, orgName: r.org_name };
  });

  app.post('/api/auth/invite/accept', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), password: passwordSchema }), req.body);
    const t = await tx(SYSTEM, async (c) => {
      const f = await findUserToken(c, body.token, 'invite');
      if (!f) return null;
      const u = await one<any>(c, `SELECT email, name, mfa_enabled, status FROM users WHERE id = $1`, [f.userId]);
      return u && u.status !== 'disabled' ? { ...f, email: u.email as string, name: u.name as string, mfa: u.mfa_enabled as boolean } : null;
    });
    if (!t) throw badRequest('This invitation is not valid or has expired. Ask for a new one.', 'invalid_token');
    const problem = checkPasswordPolicy(body.password, { email: t.email, name: t.name });
    if (problem) throw badRequest(problem, 'weak_password');
    const hash = await hashPassword(body.password);
    const stage = loginStage(t.mfa);
    const s = await tx(SYSTEM, async (c) => {
      if (!(await consumeUserToken(c, t.id))) throw badRequest('This invitation is not valid or has expired. Ask for a new one.', 'invalid_token');
      await c.query('UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, updated_at = now() WHERE id = $1', [t.userId, hash]);
      await revokeUserSessions(c, t.userId, 'invite_accepted');
      const created = await createSession(c, { userId: t.userId, orgId: t.orgId, stage, ip: clientIp(req), userAgent: userAgent(req) });
      await audit(c, { actorType: 'user', actorId: t.userId, orgId: t.orgId, action: 'auth.invite_accepted', ip: clientIp(req), userAgent: userAgent(req) });
      return created;
    });
    setSessionCookie(reply, s.token, s.expiresAt);
    return { stage, csrfToken: csrfFor(s.id) };
  });
}

