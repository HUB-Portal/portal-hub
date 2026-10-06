import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { audit } from '../audit';
import { one, many, tx, type PoolClient } from '../db';
import { dbCtx, type AuthContext } from '../auth/context';
import { revokeUserSessions } from '../auth/sessions';
import { badRequest, conflict, notFound } from '../http/errors';
import { assertNoBidi, clientIp, userAgent } from '../http/util';
import { KLINE_ROLES, PARTNER_ROLES } from '../../../shared/roles';
import { queueEmail } from './notify';
import { createUserToken } from './userTokens';

/**
 * User management for one organisation. The partner team routes and the K Line staff routes both use it,
 * so invites, role changes, disabling and authenticator resets behave the same way for both.
 */
export const INVITE_DAYS = 7;

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export function rolesSchema(kind: 'kline' | 'partner') {
  const allowed = (kind === 'kline' ? KLINE_ROLES : PARTNER_ROLES) as readonly string[];
  return z
    .array(z.string())
    .min(1)
    .max(5)
    .refine((r) => r.every((x) => allowed.includes(x)), 'Choose roles that exist for this organisation.')
    .transform((r) => [...new Set(r)]);
}

export interface TeamScope {
  /** The organisation whose users are managed. Always the caller's own organisation. */
  orgId: string;
  kind: 'kline' | 'partner';
}
export const teamScope = (a: AuthContext): TeamScope => ({ orgId: a.orgId, kind: a.orgKind });

const meta = (req: FastifyRequest) => ({ ip: clientIp(req), userAgent: userAgent(req) });

export async function listMembers(a: AuthContext, s: TeamScope) {
  const users = await tx(dbCtx(a), (c) =>
    many<any>(
      c,
      `SELECT u.id, u.email, u.name, u.roles, u.site_ids, u.status, u.mfa_enabled, u.last_login_at, u.created_at, u.locked_until,
              COALESCE((SELECT array_agg(st.code ORDER BY st.code) FROM sites st WHERE st.id = ANY(u.site_ids)), '{}') AS site_codes
         FROM users u WHERE u.org_id = $1 ORDER BY lower(u.name), u.email`,
      [s.orgId],
    ),
  );
  return users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    roles: u.roles,
    siteIds: u.site_ids,
    siteCodes: u.site_codes,
    status: u.status,
    mfaEnabled: u.mfa_enabled,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    isYou: u.id === a.userId,
    // Set while the account is locked after wrong passwords or wrong authenticator codes (an administrator can unlock it).
    locked: !!u.locked_until && new Date(u.locked_until).getTime() > Date.now(),
    lockedUntil: u.locked_until && new Date(u.locked_until).getTime() > Date.now() ? u.locked_until : null,
  }));
}

async function checkSites(c: PoolClient, s: TeamScope, siteIds: string[] | undefined): Promise<void> {
  if (!siteIds?.length) return;
  // K Line staff can be tied to any production site; partner users only to sites their organisation may use.
  const n =
    s.kind === 'kline'
      ? await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM sites WHERE id = ANY($1::uuid[])', [siteIds])
      : await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM org_sites WHERE org_id = $1 AND site_id = ANY($2::uuid[])', [s.orgId, siteIds]);
  if ((n?.n ?? 0) !== new Set(siteIds).size) throw badRequest('One of the sites is not available to this organisation.', 'invalid_site');
}

export async function inviteMember(
  a: AuthContext,
  req: FastifyRequest,
  s: TeamScope,
  body: { email: string; name: string; roles: string[]; siteIds?: string[] },
  auditPrefix = 'team',
  opts: { inviter?: string } = {},
): Promise<string> {
  assertNoBidi(body.name); // no hidden text direction characters in a person's name
  return tx(dbCtx(a), async (c) => {
    await checkSites(c, s, body.siteIds);
    const orgName = (await one<{ name: string }>(c, 'SELECT name FROM organizations WHERE id = $1', [s.orgId]))?.name ?? a.orgName;
    let id: string;
    try {
      const r = await c.query(
        `INSERT INTO users (org_id, email, name, roles, site_ids, status, invited_by) VALUES ($1, $2, $3, $4, $5, 'invited', $6) RETURNING id`,
        [s.orgId, body.email, body.name, body.roles, [...new Set(body.siteIds ?? [])], a.userId],
      );
      id = r.rows[0].id;
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('That email address cannot be invited.', 'email_unavailable');
      throw err;
    }
    const token = await createUserToken(c, { orgId: s.orgId, userId: id, kind: 'invite', ttlMinutes: INVITE_DAYS * 24 * 60 });
    await queueEmail(c, {
      to: body.email,
      template: 'invite',
      orgId: s.orgId,
      data: { name: body.name, inviter: opts.inviter ?? a.name, orgName, link: `${config.publicUrl}/invite/${token}` },
    });
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: s.orgId, action: `${auditPrefix}.invited`, targetType: 'user', targetId: id, ...meta(req), details: { roles: body.roles } });
    return id;
  });
}

async function target(c: PoolClient, s: TeamScope, id: string) {
  const u = await one<any>(c, 'SELECT id, email, name, roles, site_ids, status, password_hash, mfa_enabled FROM users WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, s.orgId]);
  if (!u) throw notFound('That person could not be found.');
  return u;
}

export function notSelf(a: AuthContext, id: string): void {
  if (a.userId === id) throw badRequest('You cannot change your own access. Ask another administrator.', 'self_change');
}

/** K Line must always keep at least one active administrator. */
async function keepsAnAdmin(c: PoolClient, s: TeamScope, id: string): Promise<void> {
  if (s.kind !== 'kline') return;
  const n = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND id <> $2 AND status <> 'disabled' AND 'kl_admin' = ANY(roles)`, [s.orgId, id]);
  if (!n || n.n < 1) throw conflict('There must always be at least one active administrator.', 'last_admin');
}

export async function changeRoles(a: AuthContext, req: FastifyRequest, s: TeamScope, id: string, roles: string[], siteIds?: string[], auditPrefix = 'team'): Promise<void> {
  notSelf(a, id);
  await tx(dbCtx(a), async (c) => {
    const u = await target(c, s, id);
    await checkSites(c, s, siteIds);
    if (u.roles.includes('kl_admin') && !roles.includes('kl_admin')) await keepsAnAdmin(c, s, id);
    await c.query('UPDATE users SET roles = $2, site_ids = COALESCE($3::uuid[], site_ids), updated_at = now() WHERE id = $1', [id, roles, siteIds ? [...new Set(siteIds)] : null]);
    const n = await revokeUserSessions(c, id, 'roles_changed');
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: s.orgId, action: `${auditPrefix}.roles_changed`, targetType: 'user', targetId: id, ...meta(req), details: { from: u.roles, to: roles, sitesChanged: !!siteIds, sessionsRevoked: n } });
  });
}

export async function disableMember(a: AuthContext, req: FastifyRequest, s: TeamScope, id: string, auditPrefix = 'team'): Promise<void> {
  notSelf(a, id);
  await tx(dbCtx(a), async (c) => {
    const u = await target(c, s, id);
    if (u.roles.includes('kl_admin')) await keepsAnAdmin(c, s, id);
    await c.query(`UPDATE users SET status = 'disabled', updated_at = now() WHERE id = $1`, [id]);
    const n = await revokeUserSessions(c, id, 'disabled');
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: s.orgId, action: `${auditPrefix}.disabled`, targetType: 'user', targetId: id, ...meta(req), details: { sessionsRevoked: n } });
  });
}

export async function enableMember(a: AuthContext, req: FastifyRequest, s: TeamScope, id: string, auditPrefix = 'team'): Promise<void> {
  notSelf(a, id);
  await tx(dbCtx(a), async (c) => {
    const u = await target(c, s, id);
    if (u.status !== 'disabled') return;
    await c.query(`UPDATE users SET status = $2, updated_at = now() WHERE id = $1`, [id, u.mfa_enabled ? 'active' : 'invited']);
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: s.orgId, action: `${auditPrefix}.enabled`, targetType: 'user', targetId: id, ...meta(req) });
  });
}

export async function resetMemberMfa(a: AuthContext, req: FastifyRequest, s: TeamScope, id: string, auditPrefix = 'team'): Promise<void> {
  notSelf(a, id);
  await tx(dbCtx(a), async (c) => {
    await target(c, s, id);
    await c.query(
      `UPDATE users SET totp_secret_enc = NULL, mfa_enabled = false, mfa_enrolled_at = NULL, totp_last_step = NULL, recovery_hashes = '{}', updated_at = now() WHERE id = $1`,
      [id],
    );
    const n = await revokeUserSessions(c, id, 'mfa_reset');
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: s.orgId, action: `${auditPrefix}.mfa_reset`, targetType: 'user', targetId: id, ...meta(req), details: { sessionsRevoked: n } });
  });
}

/**
 * Lifts a lock on an account (after wrong passwords or wrong authenticator codes) and clears the counters, so the person can sign in at once.
 * Needs a fresh authenticator code from the administrator; the entry is audited.
 */
export async function unlockMember(a: AuthContext, req: FastifyRequest, s: TeamScope, id: string, auditPrefix = 'team'): Promise<void> {
  await tx(dbCtx(a), async (c) => {
    const u = await target(c, s, id);
    const was = await one<{ locked: boolean }>(c, 'SELECT COALESCE(locked_until > now(), false) AS locked FROM users WHERE id = $1', [id]);
    await c.query(
      `UPDATE users SET failed_logins = 0, lockout_count = 0, locked_until = NULL, mfa_failed_codes = 0, mfa_fail_window_start = NULL, mfa_lockout_count = 0, updated_at = now() WHERE id = $1`,
      [u.id],
    );
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: s.orgId, action: `${auditPrefix}.unlocked`, targetType: 'user', targetId: id, ...meta(req), details: { wasLocked: !!was?.locked } });
  });
}

export async function resendMemberInvite(a: AuthContext, req: FastifyRequest, s: TeamScope, id: string, auditPrefix = 'team'): Promise<void> {
  await tx(dbCtx(a), async (c) => {
    const u = await target(c, s, id);
    if (u.status !== 'invited') throw badRequest('That person has already joined.', 'not_invited');
    const token = await createUserToken(c, { orgId: s.orgId, userId: id, kind: 'invite', ttlMinutes: INVITE_DAYS * 24 * 60 });
    await queueEmail(c, { to: u.email, template: 'invite', orgId: s.orgId, data: { name: u.name, inviter: a.name, orgName: a.orgName, link: `${config.publicUrl}/invite/${token}` } });
    await audit(c, { actorType: 'user', actorId: a.userId, orgId: s.orgId, action: `${auditPrefix}.invite_resent`, targetType: 'user', targetId: id, ...meta(req) });
  });
}
