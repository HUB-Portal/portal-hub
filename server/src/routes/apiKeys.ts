import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAuth, guard } from '../auth/context';
import { parse, userAgent } from '../http/util';
import { MAX_CIDRS, DEFAULT_EXPIRY_DAYS, createKey, listKeys, revokeKey } from '../services/apiKeysAdmin';
import { PARTNER_API_SCOPES } from '../../../shared/roles';

const idParam = z.object({ id: z.string().uuid() });

/** Partner API keys. Session only: a key can never create or revoke keys. */
export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: guard({ permission: 'integration.manage' }) };
  const write = { preHandler: guard({ permission: 'integration.manage', stepUp: true }) };
  const meta = (req: any) => ({ ip: req.ip as string, headers: { 'user-agent': userAgent(req) ?? undefined } as Record<string, any> });

  app.get('/api/api-keys', read, async (req) => listKeys(getAuth(req)));

  app.post('/api/api-keys', write, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(80),
        scopes: z.array(z.enum(PARTNER_API_SCOPES)).min(1).max(PARTNER_API_SCOPES.length),
        cidrs: z.array(z.string().max(64)).max(MAX_CIDRS).optional(),
        expiresInDays: z.number().int().min(1).max(730).default(DEFAULT_EXPIRY_DAYS),
      }),
      req.body,
    );
    const out = await createKey(getAuth(req), meta(req), body);
    reply.code(201);
    return out;
  });

  app.delete('/api/api-keys/:id', write, async (req) => {
    const { id } = parse(idParam, req.params);
    await revokeKey(getAuth(req), meta(req), id);
    return { ok: true };
  });
}
