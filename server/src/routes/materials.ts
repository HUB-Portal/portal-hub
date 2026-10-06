import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dbCtx, getAuth, guard, type AuthContext } from '../auth/context';
import { forbidden } from '../http/errors';
import { parse } from '../http/util';
import {
  MATERIAL_CATEGORIES, QUANTITY_MAX, SHIPMENT_STATUSES, adjustStock, cancelShipment, createMaterial, declareShipment, getShipment, listMaterials, listShipments, receiveShipment,
  updateMaterial,
} from '../services/materials';

const idParam = z.object({ id: z.string().uuid() });

function kline(a: AuthContext): AuthContext {
  if (a.kind !== 'user' || a.orgKind !== 'kline') throw forbidden();
  return a;
}

const rule = z.number().min(0).max(QUANTITY_MAX);
const materialBody = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(120),
  category: z.enum(MATERIAL_CATEGORIES),
  unit: z.string().trim().min(1).max(30).default('pieces'),
  perCase: rule.default(0),
  perAligner: rule.default(0),
  minStock: rule.default(0),
});

const listQuery = z.object({
  status: z.enum(SHIPMENT_STATUSES).optional(),
  siteCode: z.string().max(20).optional(),
  orgId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Partner supplied materials (BRIEF section 16). Shipment documents use the upload routes with purpose `shipment`. */
export async function materialRoutes(app: FastifyInstance): Promise<void> {
  const meta = (req: any) => ({ ip: req.ip as string, headers: req.headers as Record<string, any> });
  const reader = { preHandler: guard({ permission: 'material.read', apiKey: true }) };
  const manager = { preHandler: guard({ permission: 'material.manage' }) };
  const declarer = { preHandler: guard({ permission: 'material.declare' }) };
  const receiver = { preHandler: guard({ permission: 'material.receive' }) };

  // ------------------------------------------------------------------ partner
  app.get('/api/materials', reader, async (req) => {
    const a = getAuth(req);
    return listMaterials(dbCtx(a), a, {});
  });

  app.post('/api/materials', manager, async (req, reply) => {
    const a = getAuth(req);
    const body = parse(materialBody, req.body);
    const out = await createMaterial(dbCtx(a), a, body, meta(req));
    reply.code(201);
    return out;
  });

  app.patch('/api/materials/:id', manager, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(materialBody.partial().extend({ active: z.boolean().optional() }), req.body);
    return updateMaterial(dbCtx(a), a, id, body, meta(req));
  });

  app.get('/api/material-shipments', reader, async (req) => {
    const a = getAuth(req);
    return listShipments(dbCtx(a), a, parse(listQuery, req.query));
  });

  app.get('/api/material-shipments/:id', reader, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    return getShipment(dbCtx(a), a, id);
  });

  app.post('/api/material-shipments', declarer, async (req, reply) => {
    const a = getAuth(req);
    const body = parse(
      z.object({
        siteCode: z.string().trim().min(2).max(20),
        carrier: z.string().max(60).optional(),
        tracking: z.string().max(100).optional(),
        expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        lines: z.array(z.object({ materialId: z.string().uuid(), quantity: z.number().int().min(1).max(QUANTITY_MAX) })).min(1).max(50),
      }),
      req.body,
    );
    const out = await declareShipment(dbCtx(a), a, body, meta(req));
    reply.code(201);
    return out;
  });

  app.post('/api/material-shipments/:id/cancel', declarer, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    return cancelShipment(dbCtx(a), a, id, meta(req));
  });

  // ------------------------------------------------------------------ K Line
  app.get('/api/console/materials', reader, async (req) => {
    const a = kline(getAuth(req));
    const { orgId } = parse(z.object({ orgId: z.string().uuid().optional() }), req.query);
    return listMaterials(dbCtx(a), a, { orgId });
  });

  app.get('/api/console/material-shipments', reader, async (req) => {
    const a = kline(getAuth(req));
    return listShipments(dbCtx(a), a, parse(listQuery, req.query));
  });

  app.get('/api/console/material-shipments/:id', reader, async (req) => {
    const a = kline(getAuth(req));
    const { id } = parse(idParam, req.params);
    return getShipment(dbCtx(a), a, id);
  });

  app.post('/api/console/material-shipments/:id/receive', receiver, async (req) => {
    const a = kline(getAuth(req));
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        lines: z.array(z.object({ lineId: z.string().uuid(), receivedQuantity: z.number().int().min(0).max(QUANTITY_MAX) })).min(1).max(50),
        note: z.string().max(1000).optional(),
      }),
      req.body,
    );
    return receiveShipment(dbCtx(a), a, id, body, meta(req));
  });

  app.post('/api/console/materials/adjust', receiver, async (req) => {
    const a = kline(getAuth(req));
    const body = parse(
      z.object({
        orgId: z.string().uuid(),
        materialId: z.string().uuid(),
        siteCode: z.string().trim().min(2).max(20),
        quantity: z.number().int().min(-QUANTITY_MAX).max(QUANTITY_MAX).refine((n) => n !== 0, 'The quantity cannot be zero.'),
        reason: z.string().min(1).max(300),
      }),
      req.body,
    );
    return adjustStock(dbCtx(a), a, body, meta(req));
  });
}
