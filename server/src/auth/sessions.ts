import type { FastifyReply } from 'fastify';
import { config } from '../config';
import { SYSTEM, tx, type PoolClient } from '../db';
import { randomToken, sha256Hex } from '../crypto/tokens';

export type SessionStage = 'password' | 'mfa_setup' | 'full';

export interface LoadedSession {
  id: string;
  orgId: string;
  userId: string;
  stage: SessionStage;
  stepUpAt: Date | null;
  email: string;
  name: string;
  roles: string[];
  siteIds: string[];
  orgKind: 'kline' | 'partner';
  orgStatus: string;
  orgName: string;
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(config.cookieName, { httpOnly: true, secure: config.isProd, sameSite: 'strict', path: '/' });
}

export async function createSession(
  c: PoolClient,
  p: { userId: string; orgId: string; stage: SessionStage; ip?: string | null; userAgent?: string | null; stepUp?: boolean },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const r = await c.query(
    `INSERT INTO sessions (org_id, user_id, token_hash, stage, expires_at, ip, user_agent, step_up_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5), $6, $7, CASE WHEN $8::boolean THEN now() END)
     RETURNING id, expires_at`,
    [p.orgId, p.userId, sha256Hex(token), p.stage, config.sessionMaxHours, p.ip ?? null, p.userAgent ?? null, p.stepUp ?? false],
  );
  return { id: r.rows[0].id, token, expiresAt: r.rows[0].expires_at };
}

/** Looks up a session by cookie token. Enforces idle and absolute timeouts, revocation, disabled users and suspended orgs. */
export async function loadSession(token: string): Promise<LoadedSession | null> {
  if (!token || token.length > 200) return null;
  return tx(SYSTEM, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.org_id, s.user_id, s.stage, s.step_up_at, s.last_seen_at,
              u.email, u.name, u.roles, u.site_ids, u.status AS user_status,
              o.kind AS org_kind, o.status AS org_status, o.name AS org_name
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN organizations o ON o.id = s.org_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND s.last_seen_at > now() - make_interval(mins => $2)`,
      [sha256Hex(token), config.sessionIdleMinutes],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (row.user_status === 'disabled' || row.org_status === 'suspended') {
      await c.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'account_unavailable' WHERE id = $1`, [row.id]);
      return null;
    }
    if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
      await c.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.id]);
    }
    return {
      id: row.id,
      orgId: row.org_id,
      userId: row.user_id,
      stage: row.stage,
      stepUpAt: row.step_up_at,
      email: row.email,
      name: row.name,
      roles: row.roles,
      siteIds: row.site_ids,
      orgKind: row.org_kind,
      orgStatus: row.org_status,
      orgName: row.org_name,
    } satisfies LoadedSession;
  });
}

/** Moves a session to a new stage and rotates its token (prevents fixation). Returns the new token. */
export async function promoteSession(c: PoolClient, id: string, stage: SessionStage, opts: { stepUp?: boolean } = {}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const r = await c.query(
    `UPDATE sessions SET stage = $2, token_hash = $3, last_seen_at = now(), mfa_failures = 0, mfa_window_start = NULL,
            step_up_at = CASE WHEN $4::boolean THEN now() ELSE step_up_at END
      WHERE id = $1 AND revoked_at IS NULL RETURNING expires_at`,
    [id, stage, sha256Hex(token), opts.stepUp ?? false],
  );
  return { token, expiresAt: r.rows[0].expires_at };
}

export async function markStepUp(c: PoolClient, id: string): Promise<void> {
  await c.query('UPDATE sessions SET step_up_at = now(), mfa_failures = 0, mfa_window_start = NULL WHERE id = $1', [id]);
}

/** Counts a wrong authenticator or recovery code. Five within 15 minutes revoke the session. Returns true when revoked. */
export async function recordMfaFailure(c: PoolClient, id: string): Promise<boolean> {
  const r = await c.query(
    `UPDATE sessions SET
       mfa_failures = CASE WHEN mfa_window_start IS NULL OR mfa_window_start < now() - interval '15 minutes' THEN 1 ELSE mfa_failures + 1 END,
       mfa_window_start = CASE WHEN mfa_window_start IS NULL OR mfa_window_start < now() - interval '15 minutes' THEN now() ELSE mfa_window_start END
     WHERE id = $1 RETURNING mfa_failures`,
    [id],
  );
  if ((r.rows[0]?.mfa_failures ?? 0) >= 5) {
    await revokeSession(c, id, 'mfa_failures');
    return true;
  }
  return false;
}

/** How many wrong second factor codes lock an account, and the window they are counted in. */
export const MFA_FAILURE_LIMIT = 5;
export const MFA_FAILURE_WINDOW = '15 minutes';

/**
 * Counts a wrong authenticator or recovery code against the USER, across every session. A new password sign in therefore never gives fresh
 * guesses: five wrong codes within 15 minutes lock the account (users.locked_until, 15 minutes, doubling on every repeat up to 24 hours) and
 * end every session of the person. A correct password does not reset this counter; only a correct authenticator code, an administrator
 * unlock or a password reset by email link does. Returns whether the account is locked now.
 */
export async function recordUserMfaFailure(c: PoolClient, userId: string): Promise<{ locked: boolean }> {
  const cur = await c.query('SELECT COALESCE(locked_until > now(), false) AS locked FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!cur.rows[0]) return { locked: false };
  if (cur.rows[0].locked) {
    await revokeUserSessions(c, userId, 'mfa_lockout');
    return { locked: true };
  }
  const r = await c.query(
    `UPDATE users SET
       mfa_failed_codes = CASE WHEN mfa_fail_window_start IS NULL OR mfa_fail_window_start < now() - interval '${MFA_FAILURE_WINDOW}' THEN 1 ELSE mfa_failed_codes + 1 END,
       mfa_fail_window_start = CASE WHEN mfa_fail_window_start IS NULL OR mfa_fail_window_start < now() - interval '${MFA_FAILURE_WINDOW}' THEN now() ELSE mfa_fail_window_start END
     WHERE id = $1 RETURNING mfa_failed_codes`,
    [userId],
  );
  if ((r.rows[0]?.mfa_failed_codes ?? 0) < MFA_FAILURE_LIMIT) return { locked: false };
  await c.query(
    `UPDATE users SET locked_until = now() + LEAST(interval '24 hours', interval '15 minutes' * power(2, LEAST(mfa_lockout_count, 10))),
            mfa_lockout_count = mfa_lockout_count + 1, mfa_failed_codes = 0, mfa_fail_window_start = NULL, updated_at = now() WHERE id = $1`,
    [userId],
  );
  await revokeUserSessions(c, userId, 'mfa_lockout');
  return { locked: true };
}

/** A correct authenticator (or recovery) code clears the wrong code counter and the doubling of the lock time. */
export async function clearUserMfaFailures(c: PoolClient, userId: string): Promise<void> {
  await c.query('UPDATE users SET mfa_failed_codes = 0, mfa_fail_window_start = NULL, mfa_lockout_count = 0 WHERE id = $1 AND (mfa_failed_codes <> 0 OR mfa_lockout_count <> 0 OR mfa_fail_window_start IS NOT NULL)', [userId]);
}

/**
 * True while the account is locked (after wrong passwords or wrong codes). The row is locked until the transaction ends, so guesses that
 * arrive at the same time are checked and counted one after the other: a person cannot get more than five tries by sending them in parallel.
 */
export async function isUserLocked(c: PoolClient, userId: string): Promise<boolean> {
  const r = await c.query('SELECT COALESCE(locked_until > now(), false) AS locked FROM users WHERE id = $1 FOR UPDATE', [userId]);
  return !!r.rows[0]?.locked;
}

export async function revokeSession(c: PoolClient, id: string, reason: string): Promise<void> {
  await c.query('UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [id, reason]);
}

/** Revokes every live session of a user, optionally keeping one. Returns how many were revoked. */
export async function revokeUserSessions(c: PoolClient, userId: string, reason: string, exceptId?: string | null): Promise<number> {
  const r = await c.query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`,
    [userId, reason, exceptId ?? null],
  );
  return r.rowCount ?? 0;
}

export async function listSessions(c: PoolClient, userId: string): Promise<Array<{ id: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date; ip: string | null; userAgent: string | null; stage: SessionStage }>> {
  const r = await c.query(
    `SELECT id, created_at, last_seen_at, expires_at, ip, user_agent, stage FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND last_seen_at > now() - make_interval(mins => $2)
      ORDER BY last_seen_at DESC`,
    [userId, config.sessionIdleMinutes],
  );
  return r.rows.map((x) => ({ id: x.id, createdAt: x.created_at, lastSeenAt: x.last_seen_at, expiresAt: x.expires_at, ip: x.ip, userAgent: x.user_agent, stage: x.stage }));
}
