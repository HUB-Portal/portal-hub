import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, tx } from '../db';
import { dbCtx, getAuth, guard } from '../auth/context';
import { forbidden } from '../http/errors';
import { clientIp, parse, userAgent } from '../http/util';
import { audit } from '../audit';

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Walks the whole hash chain. K Line administrators only. Runs the read only SECURITY DEFINER wrapper
   * kph_audit_verify_chain(); the app role never gets the trim function.
   */
  app.get('/api/audit/verify', { preHandler: guard({ permission: 'audit.read' }), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const a = getAuth(req);
    if (a.orgKind !== 'kline' || !a.roles.includes('kl_admin')) throw forbidden();
    return tx(dbCtx(a), async (c) => {
      const r = await c.query('SELECT ok, checked, first_bad_seq FROM kph_audit_verify_chain()');
      const row = r.rows[0];
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'audit.verified', ip: clientIp(req), userAgent: userAgent(req), details: { ok: row.ok, checked: row.checked } });
      return { ok: row.ok as boolean, checked: row.checked as number, firstBadSeq: (row.first_bad_seq as number | null) ?? null };
    });
  });

  /** Own organisation's entries, newest first. K Line users with admin.partners may pass orgId. */
  app.get('/api/audit', { preHandler: guard({ permission: 'audit.read' }) }, async (req) => {
    const a = getAuth(req);
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.coerce.number().int().positive().optional(),
        action: z.string().max(80).regex(/^[a-z0-9_.]*$/).optional(),
        orgId: z.string().uuid().optional(),
      }),
      req.query,
    );
    const orgId = q.orgId && a.orgKind === 'kline' && a.permissions.has('admin.partners') ? q.orgId : a.orgId;
    const rows = await tx(dbCtx(a), (c) =>
      many<any>(
        c,
        `SELECT l.seq, l.at, l.actor_type, l.actor_id, l.action, l.target_type, l.target_id, l.ip, l.details, u.name AS actor_name, u.org_id AS actor_org
           FROM audit_log l
           LEFT JOIN users u ON l.actor_type = 'user' AND u.id::text = l.actor_id
          WHERE l.org_id = $1 AND ($2::bigint IS NULL OR l.seq < $2) AND ($3::text IS NULL OR l.action LIKE $3 || '%')
          ORDER BY l.seq DESC LIMIT $4`,
        [orgId, q.before ?? null, q.action ?? null, q.limit],
      ),
    );
    const entries = rows.map((r) => {
      const own = r.actor_org === a.orgId || a.orgKind === 'kline';
      return {
        seq: r.seq,
        at: r.at,
        actorType: r.actor_type,
        actorLabel: r.actor_type === 'user' ? (r.actor_name ?? 'K Line staff') : r.actor_type === 'api_key' ? 'API key' : r.actor_type === 'service' ? 'K Line service' : 'System',
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        ip: own ? r.ip : null,
        details: r.details,
      };
    });
    return { entries, nextBefore: entries.length === q.limit ? entries[entries.length - 1].seq : null };
  });
}
