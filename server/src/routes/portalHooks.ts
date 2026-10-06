import type { FastifyInstance } from 'fastify';
import { tooMany } from '../http/errors';
import { HOOK_BODY_LIMIT, HOOK_PATH_PREFIX, HOOK_RATE_PER_IP, hookRateAllowed, receiveHook } from '../services/portalHooks';

/**
 * Public receiver for K Line portal webhooks: `POST /api/hooks/kline-portal/:hookId`.
 * No session and no CSRF (see app.ts). The secret in `X-KLINE-SECRET-TOKEN` is the only credential.
 * The body is read as raw bytes, parsed defensively inside the service and never logged, stored or echoed.
 */
export async function portalHookRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    // Whatever the sender calls its content type, the bytes are kept as they are. A bad body must never turn into a 400 before the secret is checked.
    const keepRaw = (_req: unknown, body: Buffer, done: (err: Error | null, body?: Buffer) => void) => done(null, body);
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: HOOK_BODY_LIMIT }, keepRaw);
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: HOOK_BODY_LIMIT }, keepRaw);

    scope.post<{ Params: { hookId: string } }>(
      `${HOOK_PATH_PREFIX}:hookId`,
      {
        bodyLimit: HOOK_BODY_LIMIT,
        config: { rateLimit: { max: HOOK_RATE_PER_IP, timeWindow: '1 minute', keyGenerator: (req: any) => `hook-ip:${req.ip}` } },
      },
      async (req, reply) => {
        const hookId = String(req.params.hookId ?? '');
        // The API document names the header X-KLINE-SECRET-TOKEN, but the portal's own form says X-KLINE-SECRET_TOKEN (underscore), so both are read.
        const dashed = req.headers['x-kline-secret-token'];
        const underscored = req.headers['x-kline-secret_token'];
        const seen = dashed !== undefined && underscored !== undefined ? 'both' : dashed !== undefined ? 'hyphen' : underscored !== undefined ? 'underscore' : 'none';
        const out = await receiveHook(hookId, dashed ?? underscored, req.body, req.ip, () => hookRateAllowed(hookId), seen);
        if (out === 'rate_limited') throw tooMany();
        return reply.code(out.status).send(out.body);
      },
    );
  });
}
