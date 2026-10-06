import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dbCtx, getAuth, guard } from '../auth/context';
import { badRequest } from '../http/errors';
import { parse, userAgent } from '../http/util';
import { DOCUMENT_KINDS, completeUpload, createUpload, putChunk } from '../services/files';

const fileIdParam = z.object({ fileId: z.string().uuid() });

/** Resumable chunked uploads. Chunks are sealed and stored as they arrive: nothing readable is ever written to disk. */
export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // Which permission applies depends on the purpose (case.write, claim.write or material.declare); the service checks it.
  const writer = { preHandler: guard({ anyPermission: ['case.write', 'claim.write', 'material.declare', 'org.edit', 'org.logo'], apiKey: true }) };

  app.post('/api/uploads', writer, async (req) => {
    const a = getAuth(req);
    const body = parse(
      z
        .object({
        purpose: z.enum(['case', 'claim', 'shipment', 'logo', 'document']).default('case'),
        kind: z.enum(DOCUMENT_KINDS).optional(),
        caseId: z.string().uuid().optional(),
        claimId: z.string().uuid().optional(),
        shipmentId: z.string().uuid().optional(),
        name: z.string().min(1).max(600),
        size: z.number().int().min(1).max(4 * 1024 * 1024 * 1024),
        arch: z.enum(['upper', 'lower']).nullable().optional(),
        step: z.number().int().min(0).max(999).nullable().optional(),
        template: z.boolean().optional(),
        })
        .refine(
          (b) => (b.purpose === 'case' ? !!b.caseId : b.purpose === 'claim' ? !!b.claimId : b.purpose === 'shipment' ? !!b.shipmentId : true),
          'Say which case, claim or shipment the file belongs to.',
        ),
      req.body,
    );
    return createUpload(dbCtx(a), a, body);
  });

  // Many chunks per second are normal during a bulk upload.
  app.put('/api/uploads/:fileId/chunks/:idx', { ...writer, config: { rateLimit: { max: 6000, timeWindow: '1 minute' } } }, async (req) => {
    const a = getAuth(req);
    const { fileId } = parse(fileIdParam, req.params);
    const idx = Number((req.params as any).idx);
    if (!Number.isInteger(idx) || idx < 0) throw badRequest('That chunk number is not valid.', 'invalid_chunk');
    const sha = req.headers['x-chunk-sha256'];
    const body = req.body;
    if (!Buffer.isBuffer(body)) throw badRequest('Send the chunk as application/octet-stream.', 'invalid_request');
    return putChunk(dbCtx(a), fileId, idx, body, typeof sha === 'string' ? sha : undefined, a);
  });

  app.post('/api/uploads/:fileId/complete', writer, async (req) => {
    const a = getAuth(req);
    const { fileId } = parse(fileIdParam, req.params);
    return completeUpload(dbCtx(a), a, fileId, { ip: req.ip, ua: userAgent(req) });
  });
}
