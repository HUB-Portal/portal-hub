import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dbCtx, getAuth, guard, type AuthContext } from '../auth/context';
import { forbidden } from '../http/errors';
import { parse } from '../http/util';
import { CLAIM_RESOLUTIONS, CLAIM_STATUSES, DEFECT_CODES } from '../../../shared/defects';
import { CLAIM_LIMITS, closeClaim, decideClaim, getClaimDetail, listClaims, openClaim, postMessage, setStatus } from '../services/claims';

const idParam = z.object({ id: z.string().uuid() });

/** K Line staff only, whatever permissions the caller holds. */
function kline(a: AuthContext): AuthContext {
  if (a.kind !== 'user' || a.orgKind !== 'kline') throw forbidden();
  return a;
}

const listQuery = z.object({
  status: z.enum([...CLAIM_STATUSES, 'active']).optional(),
  caseId: z.string().uuid().optional(),
  orgId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Quality claims (BRIEF section 14). Evidence files use the upload routes with purpose `claim`. */
export async function claimRoutes(app: FastifyInstance): Promise<void> {
  const meta = (req: any) => ({ ip: req.ip as string, headers: req.headers as Record<string, any> });
  const reader = { preHandler: guard({ permission: 'claim.read', apiKey: true }) };
  const writer = { preHandler: guard({ permission: 'claim.write' }) };
  const decider = { preHandler: guard({ permission: 'claim.decide' }) };

  // ---------------------------------------------------------------- partner + shared
  app.post('/api/claims', writer, async (req, reply) => {
    const a = getAuth(req);
    const body = parse(
      z.object({
        caseId: z.string().uuid(),
        summary: z.string().trim().min(CLAIM_LIMITS.summaryMin).max(CLAIM_LIMITS.summaryMax),
        description: z.string().max(CLAIM_LIMITS.descriptionMax).optional(),
        specClauseIds: z.array(z.string().trim().min(1).max(20)).max(CLAIM_LIMITS.maxClauses).optional(),
        items: z
          .array(
            z.object({
              arch: z.enum(['upper', 'lower']),
              step: z.number().int().min(0).max(999),
              template: z.boolean().optional(),
              defectCode: z.enum(DEFECT_CODES),
              note: z.string().max(CLAIM_LIMITS.itemNoteMax).optional(),
            }),
          )
          .min(1)
          .max(CLAIM_LIMITS.maxItems),
      }),
      req.body,
    );
    const out = await openClaim(dbCtx(a), a, body, meta(req));
    reply.code(201);
    return out;
  });

  app.get('/api/claims', reader, async (req) => {
    const a = getAuth(req);
    return listClaims(dbCtx(a), a, parse(listQuery, req.query));
  });

  app.get('/api/claims/:id', reader, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    return getClaimDetail(dbCtx(a), a, id, meta(req));
  });

  app.post('/api/claims/:id/messages', writer, async (req, reply) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(CLAIM_LIMITS.messageMax) }), req.body);
    const out = await postMessage(dbCtx(a), a, id, body, meta(req));
    reply.code(201);
    return out;
  });

  // ---------------------------------------------------------------- K Line quality
  app.post('/api/claims/:id/status', writer, async (req) => {
    const a = kline(getAuth(req));
    const { id } = parse(idParam, req.params);
    const { status } = parse(z.object({ status: z.enum(['in_review', 'awaiting_partner']) }), req.body);
    return setStatus(dbCtx(a), a, id, status, meta(req));
  });

  app.post('/api/claims/:id/decision', decider, async (req) => {
    const a = kline(getAuth(req));
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        decision: z.enum(['accepted', 'rejected']),
        resolution: z.enum(CLAIM_RESOLUTIONS).optional(),
        rootCause: z.string().max(CLAIM_LIMITS.textMax).optional(),
        correctiveAction: z.string().max(CLAIM_LIMITS.textMax).optional(),
        note: z.string().max(CLAIM_LIMITS.noteMax).optional(),
      }),
      req.body,
    );
    return decideClaim(dbCtx(a), a, id, body, meta(req));
  });

  app.post('/api/claims/:id/close', decider, async (req) => {
    const a = kline(getAuth(req));
    const { id } = parse(idParam, req.params);
    return closeClaim(dbCtx(a), a, id, meta(req));
  });

  // ---------------------------------------------------------------- console lists
  app.get('/api/console/claims', reader, async (req) => {
    const a = kline(getAuth(req));
    return listClaims(dbCtx(a), a, parse(listQuery, req.query));
  });

  app.get('/api/console/claims/:id', reader, async (req) => {
    const a = kline(getAuth(req));
    const { id } = parse(idParam, req.params);
    return getClaimDetail(dbCtx(a), a, id, meta(req));
  });
}
