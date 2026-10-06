import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { auditReq } from '../audit';
import { dbCtx, getAuth, guard } from '../auth/context';
import { tx } from '../db';
import { AppError, conflict } from '../http/errors';
import { parse, userAgent } from '../http/util';
import { deleteFile, fileContentStream, fileDto, fileName, getFileRow, updateFileMapping } from '../services/files';

const idParam = z.object({ id: z.string().uuid() });

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

/** Sends a decrypted file as an attachment. The caller has already checked access and written the audit entry. */
export async function replyWithFile(reply: FastifyReply, row: any, downloadName?: string) {
  reply
    .header('content-type', 'application/octet-stream')
    .header('content-length', String(row.size))
    .header('content-disposition', contentDisposition(downloadName ?? fileName(row)))
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'no-store')
    .header('content-security-policy', "default-src 'none'; sandbox");
  // Read the first chunk before answering so damaged or tampered data fails cleanly instead of as a broken download.
  const it = fileContentStream(row);
  let first: IteratorResult<Buffer>;
  try {
    first = await it.next();
  } catch {
    reply.removeHeader('content-length');
    throw new AppError(500, 'file_unreadable', 'This file could not be read. Please contact K Line support.');
  }
  return reply.send(
    Readable.from(
      (async function* () {
        if (!first.done) yield first.value;
        yield* it;
      })(),
    ),
  );
}

/** Decrypts and streams a file. Every access is audited against the case's organisation so partners see K Line access. */
async function sendFile(req: FastifyRequest, reply: FastifyReply, action: 'file.download' | 'file.view') {
  const a = getAuth(req);
  const { id } = parse(idParam, req.params);
  const row = await tx(dbCtx(a), async (c) => {
    const f = await getFileRow(c, id, a);
    if (f.state !== 'ready') throw conflict('This file is not available for download.', 'file_not_available');
    await auditReq(c, req, { orgId: f.org_id, action, targetType: 'file', targetId: id, details: { caseId: f.case_id, ...(f.claim_id ? { claimId: f.claim_id } : {}), ...(f.shipment_id ? { shipmentId: f.shipment_id } : {}), kind: f.kind, size: Number(f.size) } });
    return f;
  });
  return replyWithFile(reply, row);
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  const reader = { preHandler: guard({ permission: 'case.read', apiKey: true }) };
  const writer = { preHandler: guard({ permission: 'case.write', apiKey: true }) };
  // Claim evidence and shipment documents can be removed by the partner people who added them; the service checks the purpose's permission.
  const remover = { preHandler: guard({ anyPermission: ['case.write', 'claim.write', 'material.declare'], apiKey: true }) };
  const downloader = { preHandler: guard({ permission: 'file.download', apiKey: true }) };

  app.get('/api/files/:id', reader, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    return tx(dbCtx(a), async (c) => fileDto(await getFileRow(c, id, a)));
  });

  app.patch('/api/files/:id', writer, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        arch: z.enum(['upper', 'lower']).nullable().optional(),
        step: z.number().int().min(0).max(999).nullable().optional(),
        template: z.boolean().optional(),
      }),
      req.body,
    );
    return fileDto(await updateFileMapping(dbCtx(a), id, body));
  });

  app.delete('/api/files/:id', remover, async (req) => {
    const a = getAuth(req);
    const { id } = parse(idParam, req.params);
    await deleteFile(dbCtx(a), a, id, { ip: req.ip, ua: userAgent(req) });
    return { ok: true };
  });

  app.get('/api/files/:id/download', downloader, (req, reply) => sendFile(req, reply, 'file.download'));
  app.get('/api/files/:id/content', downloader, (req, reply) => sendFile(req, reply, 'file.view'));
}
