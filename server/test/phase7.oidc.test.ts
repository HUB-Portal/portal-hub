import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { OidcError, resetOidcCache, verifyGoogleIdToken } from '../src/auth/oidc';
import { createDemoUser, orgIdOf, resetTotpStep, totp } from './helpers';

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);
const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const CLIENT_ID = 'test-client-id.apps.example.test';
const CLIENT_SECRET = 'test-client-secret-value';
const DOMAIN = 'kline.demo';

// ---------------------------------------------------------------------------
// A fake Google: discovery document, key set, token endpoint
// ---------------------------------------------------------------------------
interface Code {
  nonce: string;
  challenge: string;
  claims: Record<string, unknown>;
  sign?: { key?: KeyObject; kid?: string; alg?: string };
  failExchange?: boolean;
}

const goodKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';

function jwkOf(pub: KeyObject, kid: string) {
  return { ...(pub.export({ format: 'jwk' }) as object), kid, alg: 'RS256', use: 'sig' };
}

function mint(claims: Record<string, unknown>, o: { key?: KeyObject; kid?: string; alg?: string } = {}): string {
  const alg = o.alg ?? 'RS256';
  const header = b64u(JSON.stringify({ alg, typ: 'JWT', kid: o.kid ?? KID }));
  const payload = b64u(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  if (alg === 'none') return `${input}.`;
  if (alg === 'HS256') {
    // the classic confusion attack: sign with the public key as if it were a shared secret
    const pem = goodKeys.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    return `${input}.${createHmac('sha256', pem).update(input).digest('base64url')}`;
  }
  const sig = createSign('RSA-SHA256').update(input).sign(o.key ?? goodKeys.privateKey);
  return `${input}.${sig.toString('base64url')}`;
}

class FakeGoogle {
  server!: http.Server;
  base = '';
  codes = new Map<string, Code>();
  tokenRequests: URLSearchParams[] = [];
  jwksFetches = 0;
  jwks: object[] = [jwkOf(goodKeys.publicKey, KID)];

  async start() {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.base);
      if (url.pathname === '/.well-known/openid-configuration') {
        res.setHeader('content-type', 'application/json');
        return void res.end(JSON.stringify({ issuer: 'https://accounts.google.com', authorization_endpoint: `${this.base}/auth`, token_endpoint: `${this.base}/token`, jwks_uri: `${this.base}/jwks` }));
      }
      if (url.pathname === '/jwks') {
        this.jwksFetches++;
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'public, max-age=3600');
        return void res.end(JSON.stringify({ keys: this.jwks }));
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          this.tokenRequests.push(form);
          const rec = this.codes.get(form.get('code') ?? '');
          const bad = (msg: string) => {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: msg }));
          };
          if (!rec || rec.failExchange) return bad('invalid_grant');
          this.codes.delete(form.get('code')!); // a code works once
          if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET || form.get('grant_type') !== 'authorization_code') return bad('invalid_client');
          if (form.get('redirect_uri') !== `${config.publicUrl}/api/auth/oidc/google/callback`) return bad('redirect_uri_mismatch');
          const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
          if (challenge !== rec.challenge) return bad('invalid_grant');
          const now = Math.floor(Date.now() / 1000);
          const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'sub-default', iat: now, exp: now + 600, nonce: rec.nonce, email_verified: true, hd: DOMAIN, ...rec.claims };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ access_token: 'unused', token_type: 'Bearer', id_token: mint(claims, rec.sign) }));
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
  get discoveryUrl() {
    return `${this.base}/.well-known/openid-configuration`;
  }
}

const fake = new FakeGoogle();
let app: FastifyInstance;
let ipN = 1;
const ip = () => `10.7.${Math.floor(ipN / 250)}.${ipN++ % 250}`;

beforeAll(async () => {
  await fake.start();
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
});
afterAll(async () => {
  config.oidc.googleEnabled = false;
  await app.close();
  await fake.stop();
  await closePools();
});

// ===========================================================================
describe('ID token verification', () => {
  const now = Math.floor(Date.now() / 1000);
  const base = () => ({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 's1', iat: now, exp: now + 600, nonce: 'n-1', email: `ada@${DOMAIN}`, email_verified: true, hd: DOMAIN });
  const opts = () => ({ clientId: CLIENT_ID, allowedDomain: DOMAIN, nonce: 'n-1', discoveryUrl: fake.discoveryUrl });
  const reason = async (token: string, o = opts()) => {
    try {
      await verifyGoogleIdToken(token, o);
      return 'accepted';
    } catch (e) {
      return e instanceof OidcError ? e.reason : `other:${(e as Error).message}`;
    }
  };

  beforeEach(() => {
    resetOidcCache();
    fake.jwks = [jwkOf(goodKeys.publicKey, KID)];
  });

  it('accepts a good token and returns the claims', async () => {
    const c = await verifyGoogleIdToken(mint(base()), opts());
    expect(c).toMatchObject({ sub: 's1', email: `ada@${DOMAIN}`, hd: DOMAIN });
  });

  it('caches the key set', async () => {
    const before = fake.jwksFetches;
    await verifyGoogleIdToken(mint(base()), opts());
    await verifyGoogleIdToken(mint(base()), opts());
    expect(fake.jwksFetches - before).toBe(1);
  });

  it('refuses a wrong audience, issuer, expiry, nonce, domain and unverified email', async () => {
    expect(await reason(mint({ ...base(), aud: 'someone-else' }))).toBe('audience_invalid');
    expect(await reason(mint({ ...base(), aud: ['a', 'b', CLIENT_ID] }))).toBe('audience_invalid'); // several audiences need azp
    expect(await reason(mint({ ...base(), iss: 'https://evil.example.test' }))).toBe('issuer_invalid');
    expect(await reason(mint({ ...base(), iss: 'accounts.google.com' }))).toBe('issuer_invalid');
    expect(await reason(mint({ ...base(), exp: now - 600 }))).toBe('token_expired');
    expect(await reason(mint({ ...base(), iat: now + 3600, exp: now + 7200 }))).toBe('token_from_future');
    expect(await reason(mint({ ...base(), nonce: 'other' }))).toBe('nonce_invalid');
    expect(await reason(mint({ ...base(), nonce: undefined }))).toBe('nonce_invalid');
    expect(await reason(mint({ ...base(), hd: 'example.org', email: 'ada@example.org' }))).toBe('domain_invalid');
    expect(await reason(mint({ ...base(), hd: undefined }))).toBe('domain_invalid');
    expect(await reason(mint({ ...base(), email: 'ada@example.org' }))).toBe('domain_invalid');
    expect(await reason(mint({ ...base(), email_verified: false }))).toBe('email_not_verified');
    expect(await reason(mint({ ...base(), email_verified: undefined }))).toBe('email_not_verified');
    expect(await reason(mint({ ...base(), sub: undefined }))).toBe('subject_missing');
  });

  it('refuses a bad signature and an unknown key id', async () => {
    expect(await reason(mint(base(), { key: otherKeys.privateKey }))).toBe('signature_invalid');
    expect(await reason(mint(base(), { kid: 'nope' }))).toBe('key_not_found');
    const good = mint(base());
    const [h, p, s] = good.split('.');
    const forged = `${h}.${b64u(JSON.stringify({ ...base(), email: `boss@${DOMAIN}` }))}.${s}`;
    expect(await reason(forged)).toBe('signature_invalid');
    expect(p).toBeTruthy();
  });

  it('refuses alg none, HS256 confusion and other algorithms', async () => {
    expect(await reason(mint(base(), { alg: 'none' }))).toBe('alg_not_allowed');
    expect(await reason(mint(base(), { alg: 'HS256' }))).toBe('alg_not_allowed');
    expect(await reason(mint(base(), { alg: 'RS512' }))).toBe('alg_not_allowed');
    expect(await reason(mint(base(), { alg: 'ES256' }))).toBe('alg_not_allowed');
  });

  it('refuses malformed input', async () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '!!.@@.##', 'x'.repeat(9000)]) expect(await reason(bad)).toBe('token_malformed');
  });

  it('refuses a key of the wrong type or strength', async () => {
    fake.jwks = [{ ...jwkOf(goodKeys.publicKey, KID), alg: 'RS384' }];
    expect(await reason(mint(base()))).toBe('key_not_found');
    resetOidcCache();
    fake.jwks = [{ kty: 'RSA', kid: KID, n: b64u(randomBytes(64)), e: 'AQAB' }];
    expect(await reason(mint(base()))).toBe('key_too_small');
  });

  it('picks up a rotated key after one refresh', async () => {
    await verifyGoogleIdToken(mint(base()), opts());
    const fresh = generateKeyPairSync('rsa', { modulusLength: 2048 });
    fake.jwks = [jwkOf(goodKeys.publicKey, KID), jwkOf(fresh.publicKey, 'test-key-2')];
    // an unknown key id triggers one refresh of the key set
    await expect(verifyGoogleIdToken(mint(base(), { key: fresh.privateKey, kid: 'test-key-2' }), opts())).resolves.toBeTruthy();
  });
});

// ===========================================================================
describe('Google sign in flow', () => {
  const cookieOf = (res: any, name: string): string | undefined => res.cookies.find((c: any) => c.name === name)?.value;

  async function start() {
    const res = await app.inject({ method: 'GET', url: '/api/auth/oidc/google/start', remoteAddress: ip() });
    return res;
  }

  /** Runs start, then answers the authorisation request as the fake Google would, and returns what the callback needs. */
  async function begin(claims: Record<string, unknown>, code: Partial<Code> = {}) {
    const res = await start();
    expect(res.statusCode).toBe(302);
    const loc = new URL(String(res.headers.location));
    const state = loc.searchParams.get('state')!;
    const authCode = 'code-' + randomBytes(8).toString('hex');
    fake.codes.set(authCode, { nonce: loc.searchParams.get('nonce')!, challenge: loc.searchParams.get('code_challenge')!, claims, ...code });
    return { res, loc, state, authCode, flowCookie: cookieOf(res, 'kph_oidc')! };
  }

  async function callback(state: string | null, code: string | null, flowCookie?: string, extra = '') {
    const qs = [state !== null ? `state=${state}` : '', code !== null ? `code=${code}` : '', extra].filter(Boolean).join('&');
    return app.inject({ method: 'GET', url: `/api/auth/oidc/google/callback?${qs}`, headers: flowCookie ? { cookie: `kph_oidc=${flowCookie}` } : {}, remoteAddress: ip() });
  }

  const failedRedirect = (res: any) => {
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=google');
    expect(cookieOf(res, 'kph_session')).toBeFalsy();
  };

  beforeAll(async () => {
    config.oidc.googleEnabled = true;
    config.oidc.googleClientId = CLIENT_ID;
    config.oidc.googleClientSecret = CLIENT_SECRET;
    config.oidc.allowedDomain = DOMAIN;
    config.oidc.discoveryUrl = fake.discoveryUrl;
    // Google-only staff member who has not set up an authenticator yet, and a disabled one
    const klineId = await orgIdOf('KLINE');
    await q(`INSERT INTO users (org_id, email, name, roles, status, auth_provider) VALUES ($1, $2, 'Gina Google', '{kl_admin}', 'invited', 'google')`, [klineId, `gina@${DOMAIN}`]);
    await createDemoUser(klineId, `gone@${DOMAIN}`, 'Gone Away', ['kl_admin']);
    // two more K Line administrators with an authenticator, besides admin@kline.demo
    await createDemoUser(klineId, `second@${DOMAIN}`, 'Second Admin', ['kl_admin']);
    await createDemoUser(klineId, `third@${DOMAIN}`, 'Third Admin', ['kl_admin']);
    await q(`UPDATE users SET status = 'disabled' WHERE email = $1`, [`gone@${DOMAIN}`]);
  });
  beforeEach(() => {
    resetOidcCache();
  });

  it('is advertised in the public configuration only when configured', async () => {
    const on = await app.inject({ method: 'GET', url: '/api/public/config' });
    expect(on.json().googleSignIn).toBe(true);
    config.oidc.googleEnabled = false;
    expect((await app.inject({ method: 'GET', url: '/api/public/config' })).json().googleSignIn).toBe(false);
    config.oidc.googleEnabled = true;
  });

  it('start redirects to Google with PKCE S256, state, nonce and the domain hint, and stores only hashes', async () => {
    const res = await start();
    expect(res.statusCode).toBe(302);
    const loc = new URL(String(res.headers.location));
    expect(loc.origin + loc.pathname).toBe(`${fake.base}/auth`);
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({
      client_id: CLIENT_ID, response_type: 'code', code_challenge_method: 'S256', hd: DOMAIN, redirect_uri: `${config.publicUrl}/api/auth/oidc/google/callback`,
    });
    expect(loc.searchParams.get('scope')).toContain('openid');
    const state = loc.searchParams.get('state')!;
    const nonce = loc.searchParams.get('nonce')!;
    expect(state.length).toBeGreaterThanOrEqual(40);
    const rows = await q(`SELECT state, nonce, code_verifier, browser_hash, expires_at, created_at FROM oidc_flows WHERE state = $1`, [sha(state)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].nonce).toBe(sha(nonce));
    expect(await q(`SELECT 1 FROM oidc_flows WHERE state = $1 OR nonce = $1`, [state])).toHaveLength(0);
    expect(rows[0].code_verifier.startsWith('f1.')).toBe(true); // the PKCE verifier is sealed, not plain
    const minutes = (new Date(rows[0].expires_at).getTime() - new Date(rows[0].created_at).getTime()) / 60_000;
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThan(10.1);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  it('sends staff on to the authenticator step when the local second factor is required', async () => {
    await resetTotpStep('admin@kline.demo');
    const b = await begin({ sub: 'sub-admin', email: `admin@${DOMAIN}` });
    const res = await callback(b.state, b.authCode, b.flowCookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/mfa');
    const session = cookieOf(res, 'kph_session')!;
    expect(session).toBeTruthy();
    // The exchange was done by the server with the secret and the PKCE verifier
    const last = fake.tokenRequests.at(-1)!;
    expect(last.get('client_secret')).toBe(CLIENT_SECRET);
    expect(last.get('code_verifier')!.length).toBeGreaterThan(40);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `kph_session=${session}` } });
    expect(me.json().stage).toBe('password');
    expect(me.json().permissions).toEqual([]); // nothing is open yet
    const data = await app.inject({ method: 'GET', url: '/api/console/overview', headers: { cookie: `kph_session=${session}` } });
    expect(data.statusCode).toBe(401);

    // the authenticator code completes the sign in
    const csrf = me.json().csrfToken;
    const v = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { code: totp('admin@kline.demo') }, headers: { cookie: `kph_session=${session}`, 'x-csrf-token': csrf } });
    expect(v.statusCode, v.body).toBe(200);
    const full = cookieOf(v, 'kph_session')!;
    expect((await app.inject({ method: 'GET', url: '/api/console/overview', headers: { cookie: `kph_session=${full}` } })).statusCode).toBe(200);
    expect((await q(`SELECT oidc_subject FROM users WHERE email = $1`, [`admin@${DOMAIN}`]))[0].oidc_subject).toBe('sub-admin');
  });

  it('remembers the Google account id at the first sign in and refuses a different one afterwards', async () => {
    const b1 = await begin({ sub: 'sub-second', email: `second@${DOMAIN}` });
    expect((await callback(b1.state, b1.authCode, b1.flowCookie)).headers.location).toBe('/mfa');
    expect((await q(`SELECT oidc_subject FROM users WHERE email = 'second@kline.demo'`))[0].oidc_subject).toBe('sub-second');
    const b2 = await begin({ sub: 'sub-second', email: `second@${DOMAIN}` });
    expect((await callback(b2.state, b2.authCode, b2.flowCookie)).headers.location).toBe('/mfa');
    const b3 = await begin({ sub: 'sub-someone-else', email: `second@${DOMAIN}` });
    failedRedirect(await callback(b3.state, b3.authCode, b3.flowCookie));
  });

  it('sends a member of staff without an authenticator to authenticator setup', async () => {
    const b = await begin({ sub: 'sub-gina', email: `gina@${DOMAIN}` });
    const res = await callback(b.state, b.authCode, b.flowCookie);
    expect(res.headers.location).toBe('/mfa-setup');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `kph_session=${cookieOf(res, 'kph_session')}` } });
    expect(me.json().stage).toBe('mfa_setup');
  });

  it('never creates a full session: the authenticator comes next, whatever the setting says', async () => {
    const b = await begin({ sub: 'sub-third', email: `third@${DOMAIN}` });
    const res = await callback(b.state, b.authCode, b.flowCookie);
    expect(res.headers.location).toBe('/mfa');
    const session = cookieOf(res, 'kph_session')!;
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `kph_session=${session}` } })).json().stage).toBe('password');
    // No session created by a Google sign in is ever at stage full.
    const s = await q(`SELECT count(*)::int AS n FROM sessions WHERE stage = 'full' AND user_id = (SELECT id FROM users WHERE email = 'third@kline.demo') AND created_at > now() - interval '1 minute'`);
    expect(s[0].n).toBe(0);
  });

  it('fails the same generic way for every problem, and never creates an account', async () => {
    const users = (await q(`SELECT count(*)::int AS n FROM users`))[0].n;

    // no such account, a partner user with a matching address, a disabled member of staff
    for (const email of [`nobody@${DOMAIN}`, `admin@acme.demo`, `gone@${DOMAIN}`]) {
      const b = await begin({ sub: 'sub-x', email, hd: email.endsWith('.demo') ? DOMAIN : DOMAIN });
      const r = await callback(b.state, b.authCode, b.flowCookie);
      // admin@acme.demo has another domain, so the domain check refuses it before the account lookup
      failedRedirect(r);
    }
    // a partner user whose address is in the staff domain is still refused
    const acmeId = await orgIdOf('ACME');
    await createDemoUser(acmeId, `partner-person@${DOMAIN}`, 'Partner Person', ['admin']);
    const bp = await begin({ sub: 'sub-p', email: `partner-person@${DOMAIN}` });
    failedRedirect(await callback(bp.state, bp.authCode, bp.flowCookie));

    // token problems
    const bad: Record<string, Record<string, unknown>> = {
      'wrong audience': { aud: 'other' },
      expired: { exp: Math.floor(Date.now() / 1000) - 3600 },
      'wrong domain': { hd: 'example.org' },
      'unverified email': { email_verified: false },
      'wrong nonce': { nonce: 'not-the-one' },
      'wrong issuer': { iss: 'https://evil.example.test' },
    };
    for (const [label, over] of Object.entries(bad)) {
      const b = await begin({ sub: 'sub-a', email: `admin@${DOMAIN}`, ...over });
      failedRedirect(await callback(b.state, b.authCode, b.flowCookie));
      expect(label).toBeTruthy();
    }
    const badSig = await begin({ sub: 'sub-a', email: `admin@${DOMAIN}` }, { sign: { key: otherKeys.privateKey } });
    failedRedirect(await callback(badSig.state, badSig.authCode, badSig.flowCookie));
    const none = await begin({ sub: 'sub-a', email: `admin@${DOMAIN}` }, { sign: { alg: 'none' } });
    failedRedirect(await callback(none.state, none.authCode, none.flowCookie));
    const hs = await begin({ sub: 'sub-a', email: `admin@${DOMAIN}` }, { sign: { alg: 'HS256' } });
    failedRedirect(await callback(hs.state, hs.authCode, hs.flowCookie));
    const refused = await begin({ sub: 'sub-a', email: `admin@${DOMAIN}` }, { failExchange: true });
    failedRedirect(await callback(refused.state, refused.authCode, refused.flowCookie));

    // protocol problems
    const ok = await begin({ sub: 'sub-a', email: `admin@${DOMAIN}` });
    failedRedirect(await callback(ok.state, ok.authCode)); // no browser cookie
    failedRedirect(await callback(ok.state, ok.authCode, 'a-different-browser-token')); // another browser
    failedRedirect(await callback('x'.repeat(43), ok.authCode, ok.flowCookie)); // unknown state
    failedRedirect(await callback('short', ok.authCode, ok.flowCookie));
    failedRedirect(await callback(null, ok.authCode, ok.flowCookie));
    failedRedirect(await callback(ok.state, null, ok.flowCookie));
    failedRedirect(await callback(ok.state, ok.authCode, ok.flowCookie, 'error=access_denied'));

    // a used state cannot be used again
    const b = await begin({ sub: 'sub-a', email: `admin@${DOMAIN}` });
    expect((await callback(b.state, b.authCode, b.flowCookie)).statusCode).toBe(302);
    fake.codes.set(b.authCode, { nonce: b.loc.searchParams.get('nonce')!, challenge: b.loc.searchParams.get('code_challenge')!, claims: { sub: 'sub-a', email: `admin@${DOMAIN}` } });
    failedRedirect(await callback(b.state, b.authCode, b.flowCookie));

    // an expired flow
    const e = await begin({ sub: 'sub-a', email: `admin@${DOMAIN}` });
    await q(`UPDATE oidc_flows SET expires_at = now() - interval '1 minute' WHERE state = $1`, [sha(e.state)]);
    failedRedirect(await callback(e.state, e.authCode, e.flowCookie));

    expect((await q(`SELECT count(*)::int AS n FROM users`))[0].n).toBe(users + 1); // only the partner user added above
    const failures = await q(`SELECT details FROM audit_log WHERE action = 'auth.oidc_failed'`);
    expect(failures.length).toBeGreaterThan(15);
    expect(JSON.stringify(failures)).not.toMatch(/@/); // no addresses in the log
  });

  it('does not sign in when Google sign in is not configured', async () => {
    config.oidc.googleEnabled = false;
    const res = await start();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=google');
    config.oidc.googleEnabled = true;
  });

  it('keeps Google accounts out of password sign in', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `gina@${DOMAIN}`, password: 'Demo2026PartnerHub' }, remoteAddress: ip() });
    expect(r.statusCode).toBe(401);
  });

  it('keeps the flow code and state out of the request log', async () => {
    const { redactUrl } = await import('../src/http/util');
    expect(redactUrl('/api/auth/oidc/google/callback?state=abcDEF123&code=4%2F0Aabc')).toBe('/api/auth/oidc/google/callback?state=[redacted]&code=[redacted]');
  });
});
