import type { FastifyInstance, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { dbCtx, getAuth, guard, type AuthContext } from '../auth/context';
import { tx } from '../db';
import { AppError, forbidden, notFound } from '../http/errors';
import { parse } from '../http/util';
import { fileContentStream } from '../services/files';
import {
  brandNameSchema, clearLogo, createBrand, deleteBrand, deleteDocument, getProfile, listAgreements, listBrands, listDocuments, listOrgSites, logoRow,
  onboardingChecklist, profileSchema, renameBrand, setLogo, updateProfile, type LogoTarget,
} from '../services/profile';

const idParam = z.object({ id: z.string().uuid() });
const fileBody = z.object({ fileId: z.string().uuid() });

/** These routes are about the caller's own partner company. K Line staff use the partner pages of the console instead. */
function partnerOnly(a: AuthContext): AuthContext {
  if (a.orgKind !== 'partner') throw forbidden('This page is for partner companies.');
  return a;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml']);

/** Sandbox for every logo response, SVG included: no script, no network, no framing, only inline styles for the SVG itself. */
export const LOGO_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * Streams a stored logo: decrypted on the fly, never sniffed, sandboxed so an image can never run anything.
 * It works as an <img src> with the session cookie. The browser may keep it for an hour (the web app adds ?v=<version> to bust the cache).
 */
export async function replyWithLogo(reply: FastifyReply, row: any) {
  const type = IMAGE_TYPES.has(row.content_type) ? row.content_type : 'application/octet-stream';
  reply
    .header('content-type', type)
    .header('content-length', String(row.size))
    .header('content-disposition', 'inline')
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, max-age=3600')
    .header('content-security-policy', LOGO_CSP);
  const it = fileContentStream(row);
  let first: IteratorResult<Buffer>;
  try {
    first = await it.next();
  } catch {
    reply.removeHeader('content-length');
    reply.removeHeader('cache-control');
    reply.removeHeader('content-disposition');
    throw new AppError(500, 'file_unreadable', 'This image could not be read. Please contact K Line support.');
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

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: guard({ permission: 'org.read' }) };
  const write = { preHandler: guard({ permission: 'org.edit' }) };
  // The company logo is open to every team role except viewer (org.logo). Brand logos and the rest of the profile stay with org.edit.
  const logoWrite = { preHandler: guard({ permission: 'org.logo' }) };

  app.get('/api/org/onboarding', read, async (req) => onboardingChecklist(partnerOnly(getAuth(req))));

  // ----------------------------------------------------------------- profile
  app.get('/api/org/profile', read, async (req) => getProfile(partnerOnly(getAuth(req))));
  app.put('/api/org/profile', write, async (req) => {
    const a = partnerOnly(getAuth(req));
    return updateProfile(a, req, parse(profileSchema, req.body));
  });

  // ------------------------------------------------------------------ brands
  app.get('/api/org/brands', read, async (req) => listBrands(partnerOnly(getAuth(req))));
  app.post('/api/org/brands', write, async (req, reply) => {
    const a = partnerOnly(getAuth(req));
    const { name } = parse(z.object({ name: brandNameSchema }), req.body);
    reply.code(201);
    return createBrand(a, req, name);
  });
  app.patch('/api/org/brands/:id', write, async (req) => {
    const a = partnerOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    const { name } = parse(z.object({ name: brandNameSchema }), req.body);
    return renameBrand(a, req, id, name);
  });
  app.delete('/api/org/brands/:id', write, async (req) => {
    const a = partnerOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    await deleteBrand(a, req, id);
    return { ok: true };
  });

  // ------------------------------------------------------------------- logos
  const logoTargets: [string, (req: any) => LogoTarget, typeof write][] = [
    ['/api/org/logo', () => ({ kind: 'org' }), logoWrite],
    ['/api/org/brands/:id/logo', (req) => ({ kind: 'brand', id: parse(idParam, req.params).id }), write],
  ];
  for (const [path, target, canWrite] of logoTargets) {
    app.post(path, canWrite, async (req) => {
      const a = partnerOnly(getAuth(req));
      const { fileId } = parse(fileBody, req.body);
      return setLogo(a, req, target(req), fileId);
    });
    app.delete(path, canWrite, async (req) => {
      const a = partnerOnly(getAuth(req));
      await clearLogo(a, req, target(req));
      return { ok: true };
    });
    app.get(path, read, async (req, reply) => {
      const a = partnerOnly(getAuth(req));
      const t = target(req);
      const row = await tx(dbCtx(a), (c) => logoRow(c, a.orgId, t));
      if (!row) throw notFound('There is no logo yet.');
      return replyWithLogo(reply, row);
    });
  }

  // --------------------------------------------------------------- documents
  app.get('/api/org/documents', read, async (req) => listDocuments(partnerOnly(getAuth(req))));
  app.delete('/api/org/documents/:id', write, async (req) => {
    const a = partnerOnly(getAuth(req));
    const { id } = parse(idParam, req.params);
    await deleteDocument(a, req, id);
    return { ok: true };
  });

  // ------------------------------------------------- agreements (read only), sites
  app.get('/api/org/agreements', read, async (req) => listAgreements(partnerOnly(getAuth(req))));
  app.get('/api/org/sites', read, async (req) => listOrgSites(partnerOnly(getAuth(req))));
}
