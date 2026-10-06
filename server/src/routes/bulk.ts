import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dbCtx, getAuth, guard } from '../auth/context';
import { parse } from '../http/util';
import { createBatch, getBatch, retryPortalPush } from '../services/bulk';
import { refreshCaseFromPortal } from '../services/portalSync';

const idParam = z.object({ id: z.string().uuid() });

/** Direct manufacturing bulk intake and the push to the K Line portal. */
export async function bulkRoutes(app: FastifyInstance): Promise<void> {
  const reader = { preHandler: guard({ permission: 'case.read', apiKey: true }) };
  const writer = { preHandler: guard({ permission: 'case.write', apiKey: true }) };
  const meta = (req: any) => ({ ip: req.ip as string, headers: req.headers as Record<string, any> });

  app.post('/api/bulk/batches', writer, async (req, reply) => {
    const a = getAuth(req);
    const body = parse(
      z.object({
        cases: z
          .array(
            z.object({
              key: z.string().min(1).max(500),
              patientId: z.string().max(300),
              firstName: z.string().max(300),
              lastName: z.string().max(300),
              instructions: z.string().max(20000).nullish(),
            }),
          )
          .min(1)
          .max(500),
        brandId: z.string().uuid().nullish(),
        priority: z.enum(['normal', 'rush']).optional(),
        submitWhenClean: z.boolean().optional(),
      }),
      req.body,
    );
    const out = await createBatch(dbCtx(a), a, body, meta(req));
    reply.code(out.batchId ? 201 : 200);
    return out;
  });

  app.get('/api/bulk/batches/:id', reader, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    return getBatch(dbCtx(a), id);
  });

  app.post('/api/cases/:id/portal/retry', writer, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    return retryPortalPush(dbCtx(a), a, id, meta(req));
  });

  /** Reads the case status from the K Line portal now. Partners reach their own cases; K Line staff any. */
  app.post('/api/cases/:id/portal/refresh', { ...reader, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    return refreshCaseFromPortal(dbCtx(a), a, id);
  });
}
