import type { PoolClient } from '../db';
import { randomToken, sha256Hex } from '../crypto/tokens';

export type UserTokenKind = 'invite' | 'reset' | 'verify';

/** Creates a one time token (only its hash is stored) and retires earlier unused tokens of the same kind. Returns the raw token. */
export async function createUserToken(c: PoolClient, p: { orgId: string; userId: string; kind: UserTokenKind; ttlMinutes: number }): Promise<string> {
  await c.query(`UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`, [p.userId, p.kind]);
  const raw = randomToken(32);
  await c.query(
    `INSERT INTO user_tokens (org_id, user_id, kind, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [p.orgId, p.userId, p.kind, sha256Hex(raw), p.ttlMinutes],
  );
  return raw;
}

/** Looks up a live token. Does not consume it. */
export async function findUserToken(c: PoolClient, raw: string, kind: UserTokenKind): Promise<{ id: string; userId: string; orgId: string } | null> {
  if (!raw || raw.length > 200) return null;
  const r = await c.query(
    `SELECT id, user_id, org_id FROM user_tokens WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()`,
    [sha256Hex(raw), kind],
  );
  const row = r.rows[0];
  return row ? { id: row.id, userId: row.user_id, orgId: row.org_id } : null;
}

/** Marks a token used. Returns false when someone else used it first. */
export async function consumeUserToken(c: PoolClient, id: string): Promise<boolean> {
  const r = await c.query('UPDATE user_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL', [id]);
  return (r.rowCount ?? 0) > 0;
}
