import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dbCtx, getAuth, guard, type AuthContext } from '../auth/context';
import { forbidden } from '../http/errors';
import { parse } from '../http/util';
import { LIST_STATUS_VALUES, listCases } from '../services/cases';
import { consoleOverview } from '../services/console';
import { bagsCsv, consoleCaseDetail, holdCase, listIntake, manualStage, releaseCase, routeCase } from '../services/intake';
import { STAGE_IDS } from '../../../shared/stages';

const idParam = z.object({ id: z.string().uuid() });

/** These routes are for K Line staff only, whatever permissions the caller holds. */
function kline(a: AuthContext): AuthContext {
  if (a.kind !== 'user' || a.orgKind !== 'kline') throw forbidden();
  return a;
}

export async function consoleRoutes(app: FastifyInstance): Promise<void> {
  const reader = { preHandler: guard({ permission: 'case.read' }) };
  const meta = (req: any) => ({ ip: req.ip as string, headers: req.headers as Record<string, any> });

  app.get('/api/console/overview', reader, async (req) => {
    const a = kline(getAuth(req));
    return consoleOverview(dbCtx(a), a);
  });

  app.get('/api/console/cases', reader, async (req) => {
    const a = kline(getAuth(req));
    const q = parse(
      z.object({
        search: z.string().max(200).optional(),
        status: z.enum(LIST_STATUS_VALUES).optional(),
        orgId: z.string().uuid().optional(),
        siteCode: z.string().max(20).optional(),
        mode: z.enum(['standard', 'direct']).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req.query,
    );
    return listCases(dbCtx(a), a, q);
  });

  app.get('/api/console/cases/:id', reader, async (req) => {
    const a = kline(getAuth(req));
    const { id } = parse(idParam, req.params);
    return consoleCaseDetail(dbCtx(a), a, id, meta(req));
  });

  // ------------------------------------------------------------------ intake
  const intake = { preHandler: guard({ permission: 'intake.manage' }) };

  app.get('/api/intake', intake, async (req) => {
    const a = kline(getAuth(req));
    const q = parse(
      z.object({
        tab: z.enum(['review', 'hold', 'ready']).default('review'),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req.query,
    );
    return listIntake(dbCtx(a), q.tab, q.page, q.pageSize);
  });

  app.post('/api/cases/:id/route', intake, async (req) => {
    const a = kline(getAuth(req));
    const { id } = parse(idParam, req.params);
    const { siteCode } = parse(z.object({ siteCode: z.string().trim().min(2).max(20) }), req.body);
    return routeCase(dbCtx(a), a, id, siteCode, meta(req));
  });

  app.post('/api/cases/:id/hold', intake, async (req) => {
    const a = kline(getAuth(req));
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
    return holdCase(dbCtx(a), a, id, reason, meta(req));
  });

  app.post('/api/cases/:id/release', intake, async (req) => {
    const a = kline(getAuth(req));
    const { id } = parse(idParam, req.params);
    return releaseCase(dbCtx(a), a, id, meta(req));
  });

  // ------------------------------------------------------------ manual stage
  app.post('/api/cases/:id/stage', { preHandler: guard({ permission: 'stage.manual' }) }, async (req) => {
    const a = kline(getAuth(req));
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        stage: z.enum(STAGE_IDS),
        carrier: z.string().trim().max(60).optional(),
        trackingNumber: z.string().trim().max(100).optional(),
        alignersShipped: z.number().int().min(1).max(5000).optional(),
        note: z.string().trim().max(500).optional(),
      }),
      req.body,
    );
    return manualStage(dbCtx(a), a, id, body, meta(req));
  });

  // -------------------------------------------------------------- bag labels
  app.get('/api/cases/:id/bags.csv', { preHandler: guard({ anyPermission: ['file.download', 'stage.manual'] }) }, async (req, reply) => {
    const a = kline(getAuth(req));
    const { id } = parse(idParam, req.params);
    const out = await bagsCsv(dbCtx(a), a, id, meta(req));
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${out.ref}-bags.csv"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store');
    return reply.send(out.csv);
  });
}
