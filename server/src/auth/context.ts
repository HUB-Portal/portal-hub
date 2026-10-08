import type { FastifyRequest } from 'fastify';
import { config } from '../config';
import type { DbCtx } from '../db';
import { forbidden, stepUpRequired, unauthorized } from '../http/errors';
import { permissionsFor, type Permission } from '../../../shared/roles';
import { authenticateApiKey, permissionsForScopes } from './apikeys';
import { loadSession, type SessionStage } from './sessions';

export interface AuthContext {
  kind: 'user' | 'api_key';
  orgId: string;
  orgKind: 'kline' | 'partner';
  orgStatus: string;
  orgName: string | null;
  userId: string | null;
  apiKeyId: string | null;
  email: string | null;
  name: string | null;
  roles: string[];
  siteIds: string[];
  permissions: Set<Permission>;
  scopes: string[];
  /** 'password' and 'mfa_setup' are partial sessions. API keys are always 'full'. */
  stage: SessionStage;
  sessionId: string | null;
  stepUpAt: Date | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/** Reads the session cookie or a Bearer API key and resolves the caller. Returns null when nobody is signed in. */
export async function authenticateRequest(req: FastifyRequest, opts: { bearerOnly?: boolean } = {}): Promise<AuthContext | null> {
  const header = req.headers.authorization;
  if (typeof header === 'string' && /^bearer\s+/i.test(header)) {
    const key = await authenticateApiKey(header.replace(/^bearer\s+/i, '').trim(), req.ip);
    return {
      kind: 'api_key',
      orgId: key.orgId,
      orgKind: key.orgKind,
      orgStatus: key.orgStatus,
      orgName: null,
      userId: null,
      apiKeyId: key.id,
      email: null,
      name: null,
      roles: [],
      siteIds: [],
      permissions: permissionsForScopes(key.scopes),
      scopes: key.scopes,
      stage: 'full',
      sessionId: null,
      stepUpAt: null,
    };
  }
  // Some endpoints (the partner ERP API) only ever take a key: the session cookie is not even looked at.
  if (opts.bearerOnly) return null;
  const token = req.cookies?.[config.cookieName];
  if (!token) return null;
  const s = await loadSession(token);
  if (!s) return null;
  return {
    kind: 'user',
    orgId: s.orgId,
    orgKind: s.orgKind,
    orgStatus: s.orgStatus,
    orgName: s.orgName,
    userId: s.userId,
    apiKeyId: null,
    email: s.email,
    name: s.name,
    roles: s.roles,
    siteIds: s.siteIds,
    permissions: permissionsFor(s.roles),
    scopes: [],
    // With MFA_REQUIRED off, a session that was started while it was on (password only) is as good as full.
    stage: config.mfaRequired ? s.stage : 'full',
    sessionId: s.id,
    stepUpAt: s.stepUpAt,
  };
}

/** Database context for the caller: K Line bypasses row level security, partners are pinned to their own org. */
export function dbCtx(auth: AuthContext): DbCtx {
  return { orgId: auth.orgId, bypass: auth.orgKind === 'kline' };
}

export function getAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Signed in with both factors (or an API key). */
export function requireFull(req: FastifyRequest): AuthContext {
  const a = getAuth(req);
  if (a.stage === 'mfa_setup') throw unauthorized('Set up your authenticator app to continue.', 'mfa_setup_required');
  if (a.stage === 'password') throw unauthorized('Enter your authenticator code to continue.', 'mfa_required');
  return a;
}

export function requirePermission(auth: AuthContext, perm: Permission): void {
  if (!auth.permissions.has(perm)) throw forbidden();
}

export function requireScope(auth: AuthContext, scope: string): void {
  if (auth.kind !== 'api_key' || !auth.scopes.includes(scope)) throw forbidden();
}

/** Sensitive actions need an authenticator code within the last STEP_UP_MINUTES. */
export function requireStepUp(auth: AuthContext): void {
  if (!config.mfaRequired) return; // no authenticator to ask for while two factor sign in is off
  if (auth.kind !== 'user' || !auth.stepUpAt || Date.now() - new Date(auth.stepUpAt).getTime() > config.stepUpMinutes * 60_000) {
    throw stepUpRequired();
  }
}

export interface GuardOptions {
  /** Permission the caller must hold. */
  permission?: Permission;
  /** Any one of these is enough. */
  anyPermission?: Permission[];
  /** Require a recent authenticator code (users only). */
  stepUp?: boolean;
  /** Allow API keys. Default false: routes are for signed in people unless stated. */
  apiKey?: boolean;
  /** Accept partial sessions (password only, or authenticator setup). Default false. */
  partial?: boolean | SessionStage[];
}

/**
 * preHandler factory. Usage: app.get('/api/x', { preHandler: guard({ permission: 'org.read' }) }, handler).
 * Handlers then call getAuth(req) (typed AuthContext).
 */
export function guard(opts: GuardOptions = {}) {
  return async (req: FastifyRequest): Promise<void> => {
    const a = getAuth(req);
    if (a.kind === 'api_key') {
      if (!opts.apiKey) throw forbidden('API keys cannot use this endpoint.');
    } else if (opts.partial) {
      const allowed = opts.partial === true ? ['password', 'mfa_setup', 'full'] : opts.partial;
      if (!allowed.includes(a.stage)) requireFull(req);
    } else {
      requireFull(req);
    }
    if (opts.permission) requirePermission(a, opts.permission);
    if (opts.anyPermission && !opts.anyPermission.some((p) => a.permissions.has(p))) throw forbidden();
    if (opts.stepUp) requireStepUp(a);
  };
}
