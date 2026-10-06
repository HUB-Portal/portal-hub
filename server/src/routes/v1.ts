import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dbCtx, getAuth } from '../auth/context';
import { parse, userAgent } from '../http/util';
import {
  CASE_STATUS_VALUES,
  CLAIM_STATUS_FILTERS,
  SIMPLE_STATUS_VALUES,
  createCaseV1,
  getCaseV1,
  getFileV1,
  isoDate,
  listCasesV1,
  listClaimsV1,
  listMaterialsV1,
  pageParams,
  registerFileV1,
  requireV1Scope,
  shipmentsV1,
  submitCaseV1,
} from '../services/v1';

const keyParam = z.object({ key: z.string().min(1).max(200) });
const idParam = z.object({ id: z.string().uuid() });

/**
 * Partner ERP API. Authentication (API key only, no session, no service keys) happens for the whole /api/v1 prefix in app.ts;
 * each route then checks its scope. Errors are the usual `{code, message}` bodies.
 */
export async function v1Routes(app: FastifyInstance): Promise<void> {
  const meta = (req: any) => ({ ip: req.ip as string, headers: { 'user-agent': userAgent(req) ?? undefined } as Record<string, any> });
  const scoped = (scope: string) => ({
    preHandler: async (req: any) => {
      requireV1Scope(getAuth(req), scope);
    },
  });

  // --------------------------------------------------------------- cases
  app.get('/api/v1/cases', scoped('cases:read'), async (req) => {
    const a = getAuth(req);
    const q = parse(
      z.object({
        status: z.enum(CASE_STATUS_VALUES).optional(),
        simple_status: z.enum(SIMPLE_STATUS_VALUES).optional(),
        mode: z.enum(['standard', 'direct']).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        updated_since: z.string().datetime({ offset: true }).optional(),
        case_id: z.string().max(200).optional(),
        ...pageParams,
      }),
      req.query,
    );
    return listCasesV1(dbCtx(a), a, q, meta(req));
  });

  app.post('/api/v1/cases', scoped('cases:write'), async (req, reply) => {
    const a = getAuth(req);
    const body = parse(
      z.object({
        case_id: z.string().max(200).nullish(),
        patient_name: z.string().max(400).nullish(),
        instructions: z.string().max(8000).nullish(),
        priority: z.enum(['normal', 'rush']).optional(),
        brand: z.string().max(80).nullish(),
      }),
      req.body,
    );
    const out = await createCaseV1(dbCtx(a), a, body, meta(req));
    reply.code(201);
    return out;
  });

  app.get('/api/v1/cases/:key', scoped('cases:read'), async (req) => {
    const a = getAuth(req);
    const { key } = parse(keyParam, req.params);
    return getCaseV1(dbCtx(a), a, key, meta(req));
  });

  app.post('/api/v1/cases/:key/files', scoped('cases:write'), async (req) => {
    const a = getAuth(req);
    const { key } = parse(keyParam, req.params);
    const body = parse(
      z.object({
        name: z.string().min(1).max(600),
        size: z.number().int().min(1).max(4 * 1024 * 1024 * 1024),
        arch: z.enum(['upper', 'lower']).nullable().optional(),
        step: z.number().int().min(0).max(999).nullable().optional(),
        template: z.boolean().optional(),
      }),
      req.body,
    );
    return registerFileV1(dbCtx(a), a, key, body);
  });

  app.post('/api/v1/cases/:key/submit', scoped('cases:write'), async (req) => {
    const a = getAuth(req);
    const { key } = parse(keyParam, req.params);
    const body = parse(z.object({ acknowledge_warnings: z.boolean().optional() }), req.body);
    return submitCaseV1(dbCtx(a), a, key, body, meta(req));
  });

  app.get('/api/v1/files/:id', scoped('cases:read'), async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    return getFileV1(dbCtx(a), a, id);
  });

  // --------------------------------------------------------------- shipments, claims, materials
  app.get('/api/v1/shipments', scoped('cases:read'), async (req) => {
    const a = getAuth(req);
    const q = parse(z.object({ from: isoDate, to: isoDate }), req.query);
    return shipmentsV1(dbCtx(a), a, q);
  });

  app.get('/api/v1/claims', scoped('claims:read'), async (req) => {
    const a = getAuth(req);
    const q = parse(z.object({ status: z.enum(CLAIM_STATUS_FILTERS).optional(), from: isoDate.optional(), to: isoDate.optional(), ...pageParams }), req.query);
    return listClaimsV1(dbCtx(a), a, q);
  });

  app.get('/api/v1/materials', scoped('materials:read'), async (req) => {
    const a = getAuth(req);
    return listMaterialsV1(dbCtx(a), a);
  });
}
