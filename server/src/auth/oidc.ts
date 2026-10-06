import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey as NodeJwk } from 'node:crypto';
import { request } from 'undici';
import { config } from '../config';
import { decryptField, encryptField, safeEqual } from '../crypto/keys';

/**
 * Google Workspace sign in (OpenID Connect authorisation code flow with PKCE) for K Line staff.
 * This module holds the protocol: discovery, key set, ID token verification and the token exchange.
 * The routes (routes/oidc.ts) decide what a verified identity may do. Nothing here is ever logged.
 */

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const OIDC_FLOW_MINUTES = 10;
const CLOCK_SKEW_SECONDS = 60;
const HTTP_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  hd?: string;
  azp?: string;
  name?: string;
}

/** Every failure of the protocol. The message is for logs and tests only and never reaches a browser. */
export class OidcError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');
const b64u = (b: Buffer) => b.toString('base64url');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function readJson(url: string, init: Parameters<typeof request>[1] = {}): Promise<{ status: number; json: any; cacheSeconds: number | null }> {
  const res = await request(url, { ...init, headersTimeout: HTTP_TIMEOUT_MS, bodyTimeout: HTTP_TIMEOUT_MS, maxRedirections: 0 } as any);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of res.body) {
    total += (c as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      res.body.destroy();
      throw new OidcError('response_too_large');
    }
    chunks.push(c as Buffer);
  }
  let json: any = null;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    /* not json */
  }
  const cc = /max-age=(\d+)/i.exec(String(res.headers['cache-control'] ?? ''));
  return { status: res.statusCode, json, cacheSeconds: cc ? Number(cc[1]) : null };
}

// ---------------------------------------------------------------------------
// Discovery and key set caches
// ---------------------------------------------------------------------------
const discoveryCache = new Map<string, { doc: OidcDiscovery; at: number }>();
const jwksCache = new Map<string, { keys: Jwk[]; at: number; ttlMs: number; lastForcedAt: number }>();
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

export function resetOidcCache(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

function sameOriginOrHttps(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (!config.isProd && u.protocol === 'http:');
  } catch {
    return false;
  }
}

export async function getDiscovery(discoveryUrl: string = config.oidc.discoveryUrl): Promise<OidcDiscovery> {
  const hit = discoveryCache.get(discoveryUrl);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc;
  const r = await readJson(discoveryUrl);
  const d = r.json;
  if (r.status !== 200 || !d || typeof d !== 'object') throw new OidcError('discovery_failed');
  for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof d[k] !== 'string' || !sameOriginOrHttps(d[k])) throw new OidcError('discovery_invalid');
  }
  const doc: OidcDiscovery = { issuer: d.issuer, authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri };
  discoveryCache.set(discoveryUrl, { doc, at: Date.now() });
  return doc;
}

/** Key set of the provider. A key id that is not in the cache triggers at most one refresh a minute. */
async function getKeys(jwksUri: string, kid: string | undefined): Promise<Jwk[]> {
  const now = Date.now();
  let entry = jwksCache.get(jwksUri);
  const fresh = entry && now - entry.at < entry.ttlMs;
  const hasKid = !!entry && (!kid || entry.keys.some((k) => k.kid === kid));
  if (!entry || !fresh || (!hasKid && now - entry.lastForcedAt > 60_000)) {
    const r = await readJson(jwksUri);
    if (r.status !== 200 || !Array.isArray(r.json?.keys)) throw new OidcError('jwks_failed');
    const ttl = Math.min(Math.max((r.cacheSeconds ?? 3600) * 1000, 5 * 60_000), 24 * 3600_000);
    entry = { keys: r.json.keys as Jwk[], at: now, ttlMs: ttl, lastForcedAt: !hasKid && entry ? now : (entry?.lastForcedAt ?? 0) };
    jwksCache.set(jwksUri, entry);
  }
  return entry.keys;
}

// ---------------------------------------------------------------------------
// ID token verification
// ---------------------------------------------------------------------------
export interface VerifyOptions {
  clientId: string;
  allowedDomain: string;
  /** SHA-256 hex of the nonce sent in the authorisation request (what the flow row stores), or the plain nonce. */
  nonceHash?: string;
  nonce?: string;
  discoveryUrl?: string;
  /** Seconds since the epoch, for tests. */
  now?: number;
}

const decodePart = (s: string): any => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/**
 * Verifies a Google ID token: RS256 signature against the provider's key set, issuer, audience, expiry, nonce,
 * verified email and hosted domain. Anything else (including alg none or an HMAC token signed with a public key) is refused.
 */
export async function verifyGoogleIdToken(idToken: string, o: VerifyOptions): Promise<IdTokenClaims> {
  if (typeof idToken !== 'string' || idToken.length > 8192) throw new OidcError('token_malformed');
  const parts = idToken.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]*$/.test(parts[2]!)) throw new OidcError('token_malformed');
  let header: any;
  let claims: IdTokenClaims;
  try {
    header = decodePart(parts[0]!);
    claims = decodePart(parts[1]!);
  } catch {
    throw new OidcError('token_malformed');
  }
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') throw new OidcError('token_malformed');
  // Only RS256. The algorithm is never taken from the token to choose a verifier.
  if (header.alg !== 'RS256') throw new OidcError('alg_not_allowed');
  if (typeof header.kid !== 'string' || !header.kid) throw new OidcError('kid_missing');

  const disc = await getDiscovery(o.discoveryUrl);
  const keys = await getKeys(disc.jwks_uri, header.kid);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig') || !jwk.n || !jwk.e) throw new OidcError('key_not_found');
  if (Buffer.from(jwk.n, 'base64url').length < 256) throw new OidcError('key_too_small'); // at least 2048 bits
  let ok = false;
  try {
    const pub = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e } as NodeJwk, format: 'jwk' });
    ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), pub, Buffer.from(parts[2]!, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw new OidcError('signature_invalid');

  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== GOOGLE_ISSUER) throw new OidcError('issuer_invalid');
  const aud = claims.aud;
  if (typeof aud === 'string') {
    if (aud !== o.clientId) throw new OidcError('audience_invalid');
  } else if (Array.isArray(aud)) {
    if (!aud.includes(o.clientId) || (aud.length > 1 && claims.azp !== o.clientId)) throw new OidcError('audience_invalid');
  } else throw new OidcError('audience_invalid');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) throw new OidcError('token_expired');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > now) throw new OidcError('token_from_future');
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > now) throw new OidcError('token_not_yet_valid');
  const wantNonce = o.nonceHash ?? (o.nonce ? sha256Hex(o.nonce) : null);
  if (!wantNonce || typeof claims.nonce !== 'string' || !safeEqual(sha256Hex(claims.nonce), wantNonce)) throw new OidcError('nonce_invalid');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new OidcError('subject_missing');
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) throw new OidcError('email_missing');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new OidcError('email_not_verified');
  const domain = o.allowedDomain.toLowerCase();
  if (typeof claims.hd !== 'string' || claims.hd.toLowerCase() !== domain) throw new OidcError('domain_invalid');
  if (!claims.email.toLowerCase().endsWith(`@${domain}`)) throw new OidcError('domain_invalid');
  return claims;
}

// ---------------------------------------------------------------------------
// Flow: start and code exchange
// ---------------------------------------------------------------------------
export interface FlowStart {
  /** Where to send the browser. The only place the plain state and nonce exist. */
  url: string;
  /** Random value for the browser cookie that binds the flow to this browser. */
  browserToken: string;
  stateHash: string;
  nonceHash: string;
  encryptedVerifier: string;
  browserHash: string;
}

export const redirectUri = () => `${config.publicUrl}/api/auth/oidc/google/callback`;
export const verifierAad = (stateHash: string) => `oidc|${stateHash}|verifier`;
export const hashValue = sha256Hex;

/** Builds the authorisation URL and the values to store. State, nonce and the browser token are random and only hashes are kept. */
export async function startFlow(): Promise<FlowStart> {
  const { googleClientId, allowedDomain } = config.oidc;
  if (!config.oidc.googleEnabled || !googleClientId || !allowedDomain) throw new OidcError('not_configured');
  const disc = await getDiscovery();
  const state = b64u(randomBytes(32));
  const nonce = b64u(randomBytes(32));
  const verifier = b64u(randomBytes(48));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const browserToken = b64u(randomBytes(32));
  const stateHash = sha256Hex(state);
  const u = new URL(disc.authorization_endpoint);
  u.searchParams.set('client_id', googleClientId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('hd', allowedDomain);
  u.searchParams.set('prompt', 'select_account');
  return {
    url: u.toString(),
    browserToken,
    stateHash,
    nonceHash: sha256Hex(nonce),
    encryptedVerifier: encryptField(verifier, verifierAad(stateHash)),
    browserHash: sha256Hex(browserToken),
  };
}

/** Sends the authorisation code to the token endpoint from the server and returns the raw ID token. */
export async function exchangeCode(code: string, encryptedVerifier: string, stateHash: string): Promise<string> {
  const { googleClientId, googleClientSecret } = config.oidc;
  if (!googleClientId || !googleClientSecret) throw new OidcError('not_configured');
  const disc = await getDiscovery();
  const verifier = decryptField(encryptedVerifier, verifierAad(stateHash));
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: googleClientId,
    client_secret: googleClientSecret,
    code_verifier: verifier,
  }).toString();
  const r = await readJson(disc.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (r.status !== 200 || typeof r.json?.id_token !== 'string') throw new OidcError('exchange_failed');
  return r.json.id_token;
}
