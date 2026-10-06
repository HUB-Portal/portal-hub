import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dbCtx, getAuth, guard, type AuthContext } from '../auth/context';
import { forbidden } from '../http/errors';
import { parse } from '../http/util';
import { SPEC_LIMITS } from '../../../shared/spec';
import {
  createDraft, defaultSpec, deleteDraft, diffById, getActiveSpec, getSpec, listSpecs, partnerSpecSummaries, proposeSpec, rejectSpec, signSpec, updateDraft,
} from '../services/specs';

const idParam = z.object({ id: z.string().uuid() });
const diffParam = z.object({ id: z.string().uuid(), otherId: z.string().uuid() });
const orgQuery = z.object({ orgId: z.string().uuid().optional() });

/** Production specification (BRIEF section 15). The same handlers serve `/api/specs` and, for K Line staff, `/api/console/specs`. */
export async function specRoutes(app: FastifyInstance): Promise<void> {
  const meta = (req: any) => ({ ip: req.ip as string, headers: req.headers as Record<string, any> });
  const reader = { preHandler: guard({ permission: 'spec.read' }) };
  // Partners need spec.edit; K Line staff also qualify with claim.decide (quality) or admin.partners (the service decides which applies).
  const editorPerms = ['spec.edit', 'claim.decide', 'admin.partners'] as const;
  const editor = { preHandler: guard({ anyPermission: [...editorPerms] }) };
  const proposer = { preHandler: guard({ anyPermission: [...editorPerms], stepUp: true }) };
  const signer = { preHandler: guard({ permission: 'spec.sign', stepUp: true }) };
  const klineOnly = (a: AuthContext) => {
    if (a.orgKind !== 'kline') throw forbidden();
    return a;
  };

  for (const base of ['/api/specs', '/api/console/specs']) {
    const staffOnly = base.includes('console');
    const who = (req: any) => {
      const a = getAuth(req);
      return staffOnly ? klineOnly(a) : a;
    };

    app.get(base, reader, async (req) => {
      const a = who(req);
      const { orgId } = parse(orgQuery, req.query);
      return listSpecs(dbCtx(a), a, orgId);
    });

    app.get(`${base}/active`, reader, async (req) => {
      const a = who(req);
      const { orgId } = parse(orgQuery, req.query);
      return getActiveSpec(dbCtx(a), a, orgId);
    });

    app.get(`${base}/default`, reader, async (req) => {
      who(req);
      return defaultSpec();
    });

    app.get(`${base}/:id`, reader, async (req) => {
      const a = who(req);
      const { id } = parse(idParam, req.params);
      return getSpec(dbCtx(a), a, id);
    });

    app.get(`${base}/:id/diff/:otherId`, reader, async (req) => {
      const a = who(req);
      const { id, otherId } = parse(diffParam, req.params);
      return diffById(dbCtx(a), a, id, otherId);
    });

    app.post(base, editor, async (req, reply) => {
      const a = who(req);
      const body = parse(
        z.object({
          orgId: z.string().uuid().optional(),
          baseSpecId: z.string().uuid().optional(),
          changeNote: z.string().max(SPEC_LIMITS.changeNoteMax).optional(),
          title: z.string().max(120).optional(),
        }),
        req.body,
      );
      const out = await createDraft(dbCtx(a), a, body, meta(req));
      reply.code(201);
      return out;
    });

    app.put(`${base}/:id`, editor, async (req) => {
      const a = who(req);
      const { id } = parse(idParam, req.params);
      const body = parse(
        z.object({ content: z.unknown(), changeNote: z.string().max(SPEC_LIMITS.changeNoteMax).nullish(), title: z.string().max(120).optional() }),
        req.body,
      );
      return updateDraft(dbCtx(a), a, id, { content: body.content, changeNote: body.changeNote === null ? '' : body.changeNote, title: body.title }, meta(req));
    });

    app.delete(`${base}/:id`, editor, async (req) => {
      const a = who(req);
      const { id } = parse(idParam, req.params);
      await deleteDraft(dbCtx(a), a, id, meta(req));
      return { ok: true };
    });

    app.post(`${base}/:id/propose`, proposer, async (req) => {
      const a = who(req);
      const { id } = parse(idParam, req.params);
      return proposeSpec(dbCtx(a), a, id, meta(req));
    });

    app.post(`${base}/:id/sign`, signer, async (req) => {
      const a = who(req);
      const { id } = parse(idParam, req.params);
      const body = parse(z.object({ contentHash: z.string().regex(/^[0-9a-fA-F]{64}$/).optional() }), req.body);
      return signSpec(dbCtx(a), a, id, body, meta(req));
    });

    app.post(`${base}/:id/reject`, signer, async (req) => {
      const a = who(req);
      const { id } = parse(idParam, req.params);
      const { note } = parse(z.object({ note: z.string().max(SPEC_LIMITS.rejectNoteMax) }), req.body);
      return rejectSpec(dbCtx(a), a, id, note, meta(req));
    });
  }

  // K Line: every partner and the state of its specification.
  app.get('/api/console/specs/partners', reader, async (req) => {
    const a = klineOnly(getAuth(req));
    return partnerSpecSummaries(dbCtx(a));
  });
}
