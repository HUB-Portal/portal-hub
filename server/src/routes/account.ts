import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit';
import { dbCtx, getAuth, guard } from '../auth/context';
import { one, tx } from '../db';
import { notFound } from '../http/errors';
import { parse, userAgent } from '../http/util';

/** Personal preferences of the signed in person. */
export async function accountRoutes(app: FastifyInstance): Promise<void> {
  const g = { preHandler: guard() };

  // Email notices (stage changes, holds, claims, specifications waiting for a signature, low stock, switched off webhooks).
  // Registration, invitation and password emails are not affected: they are always sent.
  app.get('/api/account/notifications', g, async (req) => {
    const a = getAuth(req);
    return tx(dbCtx(a), async (c) => {
      const u = await one<{ notify_email: boolean }>(c, 'SELECT notify_email FROM users WHERE id = $1', [a.userId]);
      if (!u) throw notFound();
      return { email: u.notify_email };
    });
  });

  app.put('/api/account/notifications', g, async (req) => {
    const a = getAuth(req);
    const body = parse(z.object({ email: z.boolean() }), req.body);
    return tx(dbCtx(a), async (c) => {
      const r = await c.query('UPDATE users SET notify_email = $2, updated_at = now() WHERE id = $1', [a.userId, body.email]);
      if (!r.rowCount) throw notFound();
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, ip: req.ip, userAgent: userAgent(req), action: 'account.notifications_updated', targetType: 'user', targetId: a.userId, details: { email: body.email } });
      return { email: body.email };
    });
  });
}
