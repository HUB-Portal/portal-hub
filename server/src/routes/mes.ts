import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit';
import { dbCtx, getAuth, guard, requireScope } from '../auth/context';
import { tx } from '../db';
import { AppError, badRequest, forbidden } from '../http/errors';
import { clientIp, parse, userAgent } from '../http/util';
import { replyWithFile } from './files';
import {
  MAX_EVENTS_PER_CALL,
  importEventsCsv,
  listMesEvents,
  mesAck,
  mesFile,
  mesIntake,
  processEvents,
  readStageMap,
  serviceActor,
  assertUniqueCodes,
  stageMapSchema,
  writeStageMap,
} from '../services/mes';

/** Only a K Line service key with the given scope. Sessions and partner keys are refused. */
function serviceGuard(scope: string) {
  return async (req: FastifyRequest): Promise<void> => {
    const a = getAuth(req);
    if (a.kind !== 'api_key' || a.orgKind !== 'kline') throw forbidden('This endpoint is for K Line service keys only.');
    requireScope(a, scope);
  };
}

const meta = (req: FastifyRequest) => ({ ip: req.ip as string, headers: req.headers as Record<string, any> });

export async function mesRoutes(app: FastifyInstance): Promise<void> {
  // Raw CSV upload for the import (the web app can also send JSON with a `csv` field).
  app.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  // ============================================================ service API
  app.get('/api/mes/v1/intake', { preHandler: serviceGuard('mes:intake') }, async (req) => {
    const a = getAuth(req);
    const q = parse(
      z.object({
        site: z.string().regex(/^[A-Z]{2}-[A-Z0-9]{2,6}$/).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      req.query,
    );
    return mesIntake(dbCtx(a), a, { site: q.site, limit: q.limit }, meta(req));
  });

  app.get('/api/mes/v1/files/:id', { preHandler: serviceGuard('mes:files') }, async (req, reply) => {
    const a = getAuth(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const f = await mesFile(dbCtx(a), a, id, meta(req));
    return replyWithFile(reply, f.row, f.downloadName);
  });

  app.post('/api/mes/v1/cases/:ref/ack', { preHandler: serviceGuard('mes:intake') }, async (req) => {
    const a = getAuth(req);
    const { ref } = parse(z.object({ ref: z.string().regex(/^[A-Z0-9]{2,8}-\d{6,}$/) }), req.params);
    const body = parse(z.object({ mes_case_id: z.string().trim().min(1).max(64) }), req.body);
    return mesAck(dbCtx(a), a, ref, body.mes_case_id, meta(req));
  });

  app.post('/api/mes/v1/events', { preHandler: serviceGuard('mes:events') }, async (req) => {
    const a = getAuth(req);
    const body = parse(z.object({ events: z.array(z.unknown()) }), req.body);
    if (body.events.length > MAX_EVENTS_PER_CALL) throw new AppError(400, 'too_many_events', `Send at most ${MAX_EVENTS_PER_CALL} events per call.`);
    const results = await processEvents(dbCtx(a), body.events, { source: 'mes', actor: serviceActor(a, meta(req)) });
    return { results };
  });

  app.get('/api/mes/v1/stage-map', { preHandler: serviceGuard('mes:events') }, async (req) => {
    const a = getAuth(req);
    return { stage_map: await tx(dbCtx(a), (c) => readStageMap(c)) };
  });

  // ================================================== console (session, admin.mes)
  const admin = { preHandler: guard({ permission: 'admin.mes' }) };

  app.get('/api/mes/stage-map', admin, async (req) => {
    const a = getAuth(req);
    return { items: await tx(dbCtx(a), (c) => readStageMap(c)) };
  });

  // Replaces the whole map the factory system is translated by: needs a fresh authenticator code.
  app.put('/api/mes/stage-map', { preHandler: guard({ permission: 'admin.mes', stepUp: true }) }, async (req) => {
    const a = getAuth(req);
    const body = parse(z.object({ items: stageMapSchema }), req.body);
    assertUniqueCodes(body.items);
    return tx(dbCtx(a), async (c) => {
      const items = await writeStageMap(c, body.items);
      await audit(c, { actorType: 'user', actorId: a.userId, orgId: a.orgId, action: 'mes.stage_map_updated', ip: clientIp(req), userAgent: userAgent(req), details: { codes: items.length } });
      return { items };
    });
  });

  app.get('/api/mes/events', admin, async (req) => {
    const a = getAuth(req);
    const q = parse(
      z.object({
        outcome: z.enum(['applied', 'ignored', 'error', 'duplicate']).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    return listMesEvents(dbCtx(a), q);
  });

  app.post('/api/mes/events/import', { ...admin, bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const a = getAuth(req);
    const raw = req.body as unknown;
    const text = typeof raw === 'string' ? raw : typeof (raw as any)?.csv === 'string' ? ((raw as any).csv as string) : null;
    if (text === null) throw badRequest('Send the CSV text in a "csv" field or as text/csv.', 'invalid_request');
    return importEventsCsv(dbCtx(a), a, text, meta(req));
  });
}
