import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAuth, guard } from '../auth/context';
import { parse, userAgent } from '../http/util';
import {
  DELIVERY_STATUSES,
  WEBHOOK_DESCRIPTION_MAX,
  createWebhook,
  deleteWebhook,
  getDelivery,
  listDeliveries,
  listWebhooks,
  retryDelivery,
  rotateSecret,
  testWebhook,
  updateWebhook,
} from '../services/webhookAdmin';
import { WEBHOOK_URL_MAX } from '../services/netSafety';
import { partnerApproved, partnerOnly } from '../services/org';

const idParam = z.object({ id: z.string().uuid() });
const deliveryParams = z.object({ id: z.string().uuid(), deliveryId: z.string().uuid() });

/** Partner webhooks. Session only (no API keys), partner companies only, approved companies only. */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: guard({ permission: 'integration.manage' }) };
  const write = { preHandler: guard({ permission: 'integration.manage', stepUp: true }) };
  const meta = (req: any) => ({ ip: req.ip as string, headers: { 'user-agent': userAgent(req) ?? undefined } as Record<string, any> });

  app.get('/api/webhooks', read, async (req) => listWebhooks(partnerOnly(getAuth(req))));

  app.post('/api/webhooks', write, async (req, reply) => {
    const a = partnerApproved(getAuth(req));
    const body = parse(
      z.object({
        url: z.string().min(1).max(WEBHOOK_URL_MAX),
        events: z.array(z.string().max(40)).min(1).max(20),
        description: z.string().max(WEBHOOK_DESCRIPTION_MAX).nullish(),
      }),
      req.body,
    );
    const out = await createWebhook(a, meta(req), body);
    reply.code(201);
    return out;
  });

  app.patch('/api/webhooks/:id', write, async (req) => {
    const a = partnerApproved(getAuth(req));
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        url: z.string().min(1).max(WEBHOOK_URL_MAX).optional(),
        events: z.array(z.string().max(40)).min(1).max(20).optional(),
        active: z.boolean().optional(),
        description: z.string().max(WEBHOOK_DESCRIPTION_MAX).nullable().optional(),
      }),
      req.body,
    );
    return updateWebhook(a, meta(req), id, body);
  });

  app.post('/api/webhooks/:id/rotate-secret', write, async (req) => {
    const a = partnerApproved(getAuth(req));
    const { id } = parse(idParam, req.params);
    return rotateSecret(a, meta(req), id);
  });

  app.delete('/api/webhooks/:id', write, async (req) => {
    const a = partnerApproved(getAuth(req));
    const { id } = parse(idParam, req.params);
    await deleteWebhook(a, meta(req), id);
    return { ok: true };
  });

  app.get('/api/webhooks/:id/deliveries', read, async (req) => {
    const a = partnerOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    const q = parse(
      z.object({
        status: z.enum(DELIVERY_STATUSES).optional(),
        event: z.string().max(40).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req.query,
    );
    return listDeliveries(a, id, q);
  });

  app.get('/api/webhooks/:id/deliveries/:deliveryId', read, async (req) => {
    const a = partnerOnly(getAuth(req));
    const { id, deliveryId } = parse(deliveryParams, req.params);
    return getDelivery(a, id, deliveryId);
  });

  app.post('/api/webhooks/:id/deliveries/:deliveryId/retry', read, async (req) => {
    const a = partnerApproved(getAuth(req));
    const { id, deliveryId } = parse(deliveryParams, req.params);
    return retryDelivery(a, meta(req), id, deliveryId);
  });

  // Sends a real request to the endpoint, so it is limited to 10 a minute per webhook.
  app.post(
    '/api/webhooks/:id/test',
    {
      ...read,
      config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req: any) => `whtest:${String(req.params?.id ?? '')}` } },
    },
    async (req) => {
      const a = partnerApproved(getAuth(req));
      const { id } = parse(idParam, req.params);
      return testWebhook(a, meta(req), id);
    },
  );
}
