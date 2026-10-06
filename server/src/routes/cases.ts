import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dbCtx, getAuth, guard } from '../auth/context';
import { parse } from '../http/util';
import { LIST_STATUS_VALUES, cancelCase, createCase, deleteCase, getCaseDetail, listCases, patchCase, preparePackage, revealName, submitCase } from '../services/cases';
import { zipStream } from '../services/packaging';
import { orderReplacement } from '../services/childCases';
import { eraseCase } from '../services/erasure';

const idParam = z.object({ id: z.string().uuid() });

export async function caseRoutes(app: FastifyInstance): Promise<void> {
  const reader = { preHandler: guard({ permission: 'case.read', apiKey: true }) };
  const writer = { preHandler: guard({ permission: 'case.write', apiKey: true }) };
  const meta = (req: any) => ({ ip: req.ip as string, headers: req.headers as Record<string, any> });

  app.get('/api/cases', reader, async (req) => {
    const a = getAuth(req);
    const q = parse(
      z.object({
        search: z.string().max(200).optional(),
        status: z.enum(LIST_STATUS_VALUES).optional(),
        mode: z.enum(['standard', 'direct']).optional(),
        orgId: z.string().uuid().optional(),
        siteCode: z.string().max(20).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req.query,
    );
    return listCases(dbCtx(a), a, q);
  });

  app.post('/api/cases', writer, async (req, reply) => {
    const a = getAuth(req);
    const body = parse(
      z.object({
        caseId: z.string().max(200).nullish(),
        patientName: z.string().max(400).nullish(),
        brandId: z.string().uuid().nullish(),
        priority: z.enum(['normal', 'rush']).optional(),
        instructions: z.string().max(20000).nullish(),
      }),
      req.body,
    );
    const created = await createCase(dbCtx(a), a, body, meta(req));
    reply.code(201);
    return { case: created };
  });

  app.get('/api/cases/:id', reader, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    return getCaseDetail(dbCtx(a), id, a, meta(req));
  });

  app.patch('/api/cases/:id', writer, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        caseId: z.string().max(200).nullable().optional(),
        patientName: z.string().max(400).nullable().optional(),
        firstName: z.string().max(400).optional(),
        lastName: z.string().max(400).optional(),
        brandId: z.string().uuid().nullable().optional(),
        priority: z.enum(['normal', 'rush']).optional(),
        instructions: z.string().max(20000).nullable().optional(),
      }),
      req.body,
    );
    return patchCase(dbCtx(a), a, id, body, meta(req));
  });

  app.post('/api/cases/:id/submit', writer, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ acknowledgeWarnings: z.boolean().optional() }), req.body);
    return submitCase(dbCtx(a), a, id, body, meta(req));
  });

  // Replacement order for aligners of a shipped case: creates a child case that reuses the parent's files.
  app.post('/api/cases/:id/replacement', writer, async (req, reply) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        items: z.array(z.object({ arch: z.enum(['upper', 'lower']), step: z.number().int().min(0).max(999), template: z.boolean().optional() })).min(1).max(400),
        reason: z.string().max(2000).optional(),
      }),
      req.body,
    );
    const out = await orderReplacement(dbCtx(a), a, id, body, meta(req));
    reply.code(201);
    return out;
  });

  app.post('/api/cases/:id/cancel', writer, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    return cancelCase(dbCtx(a), a, id, meta(req));
  });

  app.delete('/api/cases/:id', writer, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    await deleteCase(dbCtx(a), a, id, meta(req));
    return { ok: true };
  });

  // Erasure on request: removes the case's files and the patient data now and keeps the non identifying production record.
  // Partners erase their own organisation's cases; K Line administrators any case. Needs a fresh authenticator code. Not for API keys.
  app.post('/api/cases/:id/erase', { preHandler: guard({ permission: 'case.erase', stepUp: true }) }, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ confirmRef: z.string().min(1).max(40) }), req.body);
    return eraseCase(dbCtx(a), a, id, body.confirmRef, meta(req));
  });

  app.post('/api/cases/:id/reveal-name', { preHandler: guard({ permission: 'case.reveal_name', apiKey: true }) }, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    return revealName(dbCtx(a), a, id, meta(req));
  });

  app.get('/api/cases/:id/package.zip', { preHandler: guard({ permission: 'file.download', apiKey: true }) }, async (req, reply) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    const pkg = await preparePackage(dbCtx(a), a, id, meta(req));
    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${pkg.ref}.zip"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store');
    return reply.send(zipStream(pkg.entries));
  });
}
