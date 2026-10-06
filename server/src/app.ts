import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { ZodError } from 'zod';
import { config } from './config';
import { randomUUID } from 'node:crypto';
import { authenticateRequest } from './auth/context';
import { apiKeyPrefix } from './auth/apikeys';
import { csrfFor, safeEqual } from './crypto/tokens';
import { AppError, badRequest, forbidden, tooMany, unauthorized } from './http/errors';
import { containsNul, NUL_MESSAGE } from './http/nulBytes';
import { keyCanSeePatients, stripPatientFields } from './http/patientFields';
import { hasProxyHeaders } from './http/proxy';
import { redactUrl } from './http/util';
import { registerRoutes } from './routes';

/** Writes that carry no session yet, so they cannot carry a CSRF token. */
export const CSRF_EXEMPT = new Set([
  '/api/auth/login',
  '/api/auth/password/forgot',
  '/api/auth/password/reset',
  '/api/auth/invite/accept',
  '/api/auth/register',
  '/api/auth/verify',
]);
/** Public receivers that are called by another system with their own secret: no session, no CSRF. */
export const CSRF_EXEMPT_PREFIXES = ['/api/hooks/kline-portal/'];
export const isCsrfExempt = (url: string) => CSRF_EXEMPT.has(url) || CSRF_EXEMPT_PREFIXES.some((p) => url.startsWith(p));
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface BuildOptions {
  /** Where request logs go (tests capture them). Defaults to stdout. */
  logStream?: Writable;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const logger: any = {
    level: config.logLevel,
    // Never log cookies, authorization headers, CSRF tokens or bodies: only these fields are serialised.
    serializers: {
      req: (req: any) => ({ method: req.method, url: redactUrl(String(req.url ?? '')), remoteAddress: req.ip }),
      res: (res: any) => ({ statusCode: res.statusCode }),
      err: (err: any) => ({ type: err?.name, code: err?.code, message: typeof err?.message === 'string' ? err.message.slice(0, 300) : undefined, stack: config.isProd ? undefined : err?.stack }),
    },
  };
  if (opts.logStream) logger.stream = opts.logStream;

  // Every answer carries an X-Request-Id: the caller's own (when it is short and harmless) or a fresh one, also used in the logs.
  const genReqId = (req: { headers: Record<string, string | string[] | undefined> }) => {
    const h = req.headers['x-request-id'];
    return typeof h === 'string' && /^[A-Za-z0-9._:-]{8,64}$/.test(h) ? h : randomUUID();
  };
  const app: FastifyInstance = Fastify({ logger, trustProxy: config.trustProxy, bodyLimit: 1024 * 1024, genReqId } as FastifyServerOptions);

  app.decorateRequest('auth', null);

  // Development tunnels (TUNNEL_HOOKS_ONLY): a request that arrives through a proxy or tunnel (it carries proxy headers) may only reach the
  // portal webhook receiver and the health check. Everything else answers 404, as if it did not exist. This runs before every other hook.
  if (config.tunnelHooksOnly) {
    app.addHook('onRequest', async (req, reply) => {
      if (!hasProxyHeaders(req.headers as Record<string, unknown>)) return;
      const url = req.url.split('?')[0]!;
      if (url === '/api/health' || /^\/api\/hooks\/kline-portal\/[^/]+$/.test(url)) return;
      return reply.code(404).header('cache-control', 'no-store').send({ code: 'not_found', message: 'That could not be found.' });
    });
  }

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Styles only: React sets style attributes through the DOM. Scripts stay strictly external.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.isProd ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    xContentTypeOptions: true,
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    global: true,
    max: 900,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const h = req.headers.authorization;
      if (typeof h === 'string' && /^bearer\s+/i.test(h)) {
        const p = apiKeyPrefix(h.replace(/^bearer\s+/i, '').trim());
        if (p) return `key:${p}`;
      }
      return `ip:${req.ip}`;
    },
    errorResponseBuilder: () => tooMany(),
  });

  // Chunk uploads (phase 2) send raw bytes.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 + 4096 }, (_req, body, done) => done(null, body));

  // Authentication and CSRF for every API request.
  app.addHook('onRequest', async (req) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    // The partner ERP API takes an API key and nothing else: no session cookie, no CSRF, and never a K Line service key.
    if (url === '/api/v1' || url.startsWith('/api/v1/')) {
      req.auth = await authenticateRequest(req, { bearerOnly: true });
      if (!req.auth) throw unauthorized('Send your API key as "Authorization: Bearer <key>". Sessions are not accepted on this API.', 'api_key_required');
      if (req.auth.orgKind !== 'partner') throw forbidden('K Line service keys cannot use this API.', 'wrong_key_type');
      return;
    }
    // The portal webhook receiver is called by the K Line portal with a secret token: cookies are not read for it at all.
    if (CSRF_EXEMPT_PREFIXES.some((p) => url.startsWith(p))) return;
    req.auth = await authenticateRequest(req);
    if (UNSAFE.has(req.method) && req.auth?.kind === 'user' && !isCsrfExempt(url)) {
      const sent = req.headers['x-csrf-token'];
      if (typeof sent !== 'string' || !safeEqual(sent, csrfFor(req.auth.sessionId!))) {
        throw new AppError(403, 'csrf_invalid', 'Your session needs refreshing. Reload the page and try again.');
      }
    }
  });

  // A NUL character (U+0000) cannot be stored by PostgreSQL and would end as a server error. Refused once, early, for every API route:
  // the raw address, the query string, the route parameters and the body (nested JSON or text).
  app.addHook('preValidation', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (/%00/i.test(req.url) || containsNul(req.query) || containsNul(req.params) || containsNul(req.body)) throw badRequest(NUL_MESSAGE, 'invalid_request');
  });

  // A partner API key without the patients:read scope never sees anything about a patient, whichever route answers (cases, child cases, bulk).
  app.addHook('preSerialization', async (req, _reply, payload) => {
    const a = req.auth;
    if (!a || a.kind !== 'api_key' || keyCanSeePatients(a)) return payload;
    return stripPatientFields(payload);
  });

  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      // Every API answer is no-store unless a route chose its own caching (only the company logo does, and never on an error).
      if (!reply.hasHeader('cache-control') || reply.statusCode >= 400) reply.header('cache-control', 'no-store');
      reply.header('x-request-id', req.id);
    }
  });

  app.setErrorHandler((err: FastifyError | AppError | ZodError, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ code: err.code, message: err.message, ...(err.extra ?? {}) });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ code: 'invalid_request', message: 'Some details are missing or not valid.' });
    }
    const e = err as FastifyError;
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      if (e.statusCode === 413) return reply.code(413).send({ code: 'too_large', message: 'That request is too large.' });
      if (e.statusCode === 415) return reply.code(415).send({ code: 'unsupported_media_type', message: 'That content type is not supported.' });
      if (e.statusCode === 429) return reply.code(429).send({ code: 'rate_limited', message: 'Too many requests. Please wait a moment and try again.' });
      return reply.code(400).send({ code: 'invalid_request', message: 'The request was not valid.' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'internal_error', message: 'Something went wrong on our side. Please try again.' });
  });

  // Built web app with single page fallback.
  const indexFile = path.join(config.webDist, 'index.html');
  const haveWeb = existsSync(indexFile);
  if (haveWeb) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: true,
      index: ['index.html'],
      dotfiles: 'ignore',
      cacheControl: false,
      setHeaders: (reply, filePath) => {
        const p = filePath.replace(/\\/g, '/');
        reply.header('cache-control', p.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0];
    if (url.startsWith('/api/') || url === '/api') {
      return reply.code(404).send({ code: 'not_found', message: 'That could not be found.' });
    }
    if (haveWeb && (req.method === 'GET' || req.method === 'HEAD')) {
      return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ code: 'not_found', message: 'That could not be found.' });
  });

  await registerRoutes(app);
  return app;
}
