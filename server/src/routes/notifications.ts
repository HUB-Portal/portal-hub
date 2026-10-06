import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dbCtx, getAuth, guard } from '../auth/context';
import { many, one, tx } from '../db';
import { parse } from '../http/util';

/** The bell. A signed in person sees their own notifications and those addressed to their whole organisation. */
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const g = { preHandler: guard() };

  app.get('/api/notifications', g, async (req) => {
    const a = getAuth(req);
    return tx(dbCtx(a), async (c) => {
      const mine = `org_id = $1 AND (user_id = $2 OR user_id IS NULL)`;
      const rows = await many<any>(c, `SELECT id, kind, title, body, data, read_at, created_at FROM notifications WHERE ${mine} ORDER BY created_at DESC, id LIMIT 50`, [a.orgId, a.userId]);
      const unread = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM notifications WHERE ${mine} AND read_at IS NULL`, [a.orgId, a.userId]);
      return {
        items: rows.map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          body: n.body,
          data: n.data ?? {},
          read: !!n.read_at,
          createdAt: n.created_at instanceof Date ? n.created_at.toISOString() : n.created_at,
        })),
        unread: unread?.n ?? 0,
      };
    });
  });

  app.post('/api/notifications/read', g, async (req) => {
    const a = getAuth(req);
    const body = parse(z.object({ ids: z.array(z.string().uuid()).max(100).optional(), all: z.boolean().optional() }), req.body);
    const marked = await tx(dbCtx(a), async (c) => {
      const base = `org_id = $1 AND (user_id = $2 OR user_id IS NULL) AND read_at IS NULL`;
      const r = body.all
        ? await c.query(`UPDATE notifications SET read_at = now() WHERE ${base}`, [a.orgId, a.userId])
        : await c.query(`UPDATE notifications SET read_at = now() WHERE ${base} AND id = ANY($3::uuid[])`, [a.orgId, a.userId, body.ids ?? []]);
      return r.rowCount ?? 0;
    });
    return { ok: true, marked };
  });
}
