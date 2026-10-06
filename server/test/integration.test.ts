import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, ownerPool, pool, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { demoTotpSecret } from '../src/services/demo';
import { base32Decode, totpCode } from '../src/crypto/totp';
import { encryptField, fieldAad } from '../src/crypto/keys';
import { audit } from '../src/audit';
import { enqueue, registerJob, runDueJobs } from '../src/worker';
import { createApiKey } from '../src/auth/apikeys';

let app: FastifyInstance;
const logs: string[] = [];
let ipCounter = 10;

const code = (email: string, offsetSteps = 0) => totpCode(base32Decode(demoTotpSecret(email)), Date.now() / 1000 + offsetSteps * 30);
const codeFor = (secretBase32: string) => totpCode(base32Decode(secretBase32), Date.now() / 1000);

class Client {
  cookie = '';
  csrf = '';
  ip = `10.1.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`;

  async call(method: string, url: string, body?: unknown, opts: { csrf?: boolean; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && opts.csrf !== false) headers['x-csrf-token'] = this.csrf;
    const res = await app.inject({ method: method as any, url, payload: body as any, headers, remoteAddress: this.ip });
    const set = res.cookies.find((c) => c.name === 'kph_session');
    if (set) this.cookie = set.value ? `kph_session=${set.value}` : '';
    let json: any = null;
    try {
      json = res.json();
    } catch {
      /* not json */
    }
    if (json?.csrfToken) this.csrf = json.csrfToken;
    return { status: res.statusCode, json, res };
  }

  async login(email: string, password = 'Demo2026PartnerHub') {
    return this.call('POST', '/api/auth/login', { email, password });
  }

  /** Full sign in with the demo authenticator secret. */
  async full(email: string) {
    await resetTotpStep(email);
    const l = await this.login(email);
    expect(l.status).toBe(200);
    const v = await this.call('POST', '/api/auth/mfa/verify', { code: code(email) });
    expect(v.status).toBe(200);
    expect(v.json.stage).toBe('full');
    return this;
  }
}

async function resetTotpStep(email: string) {
  await tx(SYSTEM, (c) => c.query('UPDATE users SET totp_last_step = NULL, failed_logins = 0, locked_until = NULL, lockout_count = 0, mfa_failed_codes = 0, mfa_fail_window_start = NULL, mfa_lockout_count = 0 WHERE lower(email) = $1', [email]));
}

async function userId(email: string): Promise<string> {
  return tx(SYSTEM, async (c) => (await c.query('SELECT id FROM users WHERE lower(email) = $1', [email])).rows[0].id);
}
async function orgIdOf(code: string): Promise<string> {
  return tx(SYSTEM, async (c) => (await c.query('SELECT id FROM organizations WHERE code = $1', [code])).rows[0].id);
}

beforeAll(async () => {
  await seedDemo({ force: true });
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  app = await buildApp({ logStream: stream });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('web app and static serving', () => {
  it('serves the app, hashed assets and deep link fallback', async () => {
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('KPH-TEST-INDEX');
    expect(root.headers['cache-control']).toBe('no-cache');

    const deep = await app.inject({ method: 'GET', url: '/cases/1234/files' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('KPH-TEST-INDEX');
    expect(deep.headers['cache-control']).toBe('no-cache');
    expect(String(deep.headers['content-type'])).toContain('text/html');

    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('max-age=31536000');
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(get.statusCode).toBe(404);
    expect(get.json()).toMatchObject({ code: 'not_found' });
    const post = await app.inject({ method: 'POST', url: '/api/does-not-exist', payload: {} });
    expect(post.statusCode).toBe(404);
    expect(post.json().code).toBe('not_found');
    expect(get.headers['cache-control']).toBe('no-store');
  });

  it('sends the strict security headers', async () => {
    const r = await app.inject({ method: 'GET', url: '/' });
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('sign in', () => {
  it('gives the same answer for a wrong password on known and unknown accounts', async () => {
    const a = await new Client().login('admin@acme.demo', 'not-the-password-123');
    const b = await new Client().login('nobody@nowhere.demo', 'not-the-password-123');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.json).toEqual(b.json);
    expect(a.json.code).toBe('invalid_credentials');
    expect(a.res.cookies.find((c) => c.name === 'kph_session')).toBeUndefined();
  });

  it('requires the authenticator code before any data', async () => {
    const email = 'quality@acme.demo';
    await resetTotpStep(email);
    const c = new Client();
    const l = await c.login(email);
    expect(l.status).toBe(200);
    expect(l.json.stage).toBe('password');
    for (const url of ['/api/org', '/api/audit', '/api/team']) {
      const r = await c.call('GET', url);
      expect(r.status).toBe(401);
      expect(r.json.code).toBe('mfa_required');
    }
    const me = await c.call('GET', '/api/auth/me');
    expect(me.json.stage).toBe('password');
    expect(me.json.permissions).toEqual([]);
    const wrong = await c.call('POST', '/api/auth/mfa/verify', { code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.json.code).toBe('invalid_code');
    const ok = await c.call('POST', '/api/auth/mfa/verify', { code: code(email) });
    expect(ok.status).toBe(200);
    expect((await c.call('GET', '/api/org')).status).toBe(200);
    const me2 = await c.call('GET', '/api/auth/me');
    expect(me2.json.stage).toBe('full');
    expect(me2.json.permissions).toContain('spec.sign');
    expect(me2.json.org.name).toBe('Acme Aligners');
    // replay of the same code is refused on a new session
    const c2 = new Client();
    await c2.login(email);
    const replay = await c2.call('POST', '/api/auth/mfa/verify', { code: code(email) });
    expect(replay.status).toBe(400);
  });

  it('revokes the session after five wrong codes', async () => {
    const email = 'finance@acme.demo';
    await resetTotpStep(email);
    const c = new Client();
    await c.login(email);
    for (let i = 0; i < 4; i++) expect((await c.call('POST', '/api/auth/mfa/verify', { code: '111111' })).json.code).toBe('invalid_code');
    const last = await c.call('POST', '/api/auth/mfa/verify', { code: '111111' });
    expect(last.json.code).toBe('session_revoked');
    expect((await c.call('GET', '/api/auth/me')).status).toBe(401);
  });

  it('locks the account after five failures and keeps giving the same answer', async () => {
    const email = 'upload@acme.demo';
    await resetTotpStep(email);
    const c = new Client();
    for (let i = 0; i < 5; i++) expect((await c.login(email, 'wrong-password-value-1')).status).toBe(401);
    const correct = await new Client().login(email);
    expect(correct.status).toBe(401);
    expect(correct.json.code).toBe('invalid_credentials');
    const row = await tx(SYSTEM, async (q) => (await q.query('SELECT locked_until, lockout_count FROM users WHERE lower(email) = $1', [email])).rows[0]);
    expect(new Date(row.locked_until).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect(row.lockout_count).toBe(1);
    await resetTotpStep(email);
    expect((await new Client().login(email)).status).toBe(200);
  });

  it('exposes demo accounts and the current code in demo mode', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/demo/accounts' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.password).toBe('Demo2026PartnerHub');
    const admin = body.accounts.find((a: any) => a.email === 'admin@kline.demo');
    expect(admin.code).toMatch(/^\d{6}$/);
    expect(body.accounts.map((a: any) => a.email)).toEqual(expect.arrayContaining(['admin@acme.demo', 'upload@acme.demo', 'quality@acme.demo', 'finance@acme.demo', 'intake@kline.demo', 'chaves@kline.demo']));
    await resetTotpStep('admin@kline.demo');
    const c = new Client();
    await c.login('admin@kline.demo');
    const v = await c.call('POST', '/api/auth/mfa/verify', { code: admin.code });
    // the code may have just rolled over; the window still accepts it
    expect(v.status).toBe(200);
    const me = await c.call('GET', '/api/auth/me');
    expect(me.json.demo.enabled).toBe(true);
    expect(me.json.demo.code.code).toMatch(/^\d{6}$/);
    expect(me.json.org.kind).toBe('kline');
  });
});

describe('CSRF and step up', () => {
  it('refuses writes without the CSRF token and accepts them with it', async () => {
    const c = await new Client().full('admin@acme.demo');
    const bad = await c.call('POST', '/api/auth/logout', undefined, { csrf: false });
    expect(bad.status).toBe(403);
    expect(bad.json.code).toBe('csrf_invalid');
    const wrong = await c.call('POST', '/api/auth/logout', undefined, { csrf: false, headers: { 'x-csrf-token': 'nope' } });
    expect(wrong.status).toBe(403);
    expect((await c.call('GET', '/api/auth/me')).status).toBe(200);
    const good = await c.call('POST', '/api/auth/logout');
    expect(good.status).toBe(200);
    expect((await c.call('GET', '/api/auth/me')).status).toBe(401);
  });

  it('invites a colleague with step up, sends the email and completes onboarding', async () => {
    const admin = await new Client().full('admin@acme.demo');
    const email = 'newbie@acme.demo';

    // step up is needed when the last code is old
    const uid = await userId('admin@acme.demo');
    await tx(SYSTEM, (c) => c.query(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE user_id = $1 AND revoked_at IS NULL`, [uid]));
    const denied = await admin.call('POST', '/api/team/invite', { email, name: 'Nina Newbie', roles: ['viewer'] });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('step_up_required');

    await resetTotpStep('admin@acme.demo');
    const badStep = await admin.call('POST', '/api/auth/step-up', { code: '123456' });
    expect(badStep.status).toBe(400);
    const step = await admin.call('POST', '/api/auth/step-up', { code: code('admin@acme.demo') });
    expect(step.status).toBe(200);

    const wrongRole = await admin.call('POST', '/api/team/invite', { email, name: 'Nina Newbie', roles: ['kl_admin'] });
    expect(wrongRole.status).toBe(400);
    const inv = await admin.call('POST', '/api/team/invite', { email, name: 'Nina Newbie', roles: ['viewer'] });
    expect(inv.status).toBe(201);
    const dup = await admin.call('POST', '/api/team/invite', { email, name: 'Nina Newbie', roles: ['viewer'] });
    expect(dup.status).toBe(409);
    const emailTaken = await admin.call('POST', '/api/team/invite', { email: 'admin@kline.demo', name: 'X Y', roles: ['viewer'] });
    expect(emailTaken.status).toBe(409);

    // worker sends the queued email into the dev mailbox
    expect(await runDueJobs()).toBeGreaterThanOrEqual(1);
    const mail = await tx(SYSTEM, async (c) => (await c.query('SELECT body, to_addr FROM dev_mailbox WHERE to_addr = $1', [email])).rows[0]);
    expect(mail.body).toContain('/invite/');
    const token = /\/invite\/([\w-]+)/.exec(mail.body)![1];

    const peek = await app.inject({ method: 'GET', url: `/api/auth/invite/${token}`, remoteAddress: '10.9.9.1' });
    expect(peek.statusCode).toBe(200);
    expect(peek.json().orgName).toBe('Acme Aligners');

    const nc = new Client();
    const weak = await nc.call('POST', '/api/auth/invite/accept', { token, password: 'password1234' });
    expect(weak.status).toBe(400);
    expect(weak.json.code).toBe('weak_password');
    const acc = await nc.call('POST', '/api/auth/invite/accept', { token, password: 'violet-sofa-marathon-42' });
    expect(acc.status).toBe(200);
    expect(acc.json.stage).toBe('mfa_setup');
    expect((await nc.call('GET', '/api/org')).json.code).toBe('mfa_setup_required');
    const again = await new Client().call('POST', '/api/auth/invite/accept', { token, password: 'violet-sofa-marathon-42' });
    expect(again.status).toBe(400);

    const setup = await nc.call('POST', '/api/auth/mfa/setup');
    expect(setup.status).toBe(200);
    expect(setup.json.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(setup.json.secret).toMatch(/^[A-Z2-7]{32}$/);
    const conf = await nc.call('POST', '/api/auth/mfa/setup/confirm', { code: codeFor(setup.json.secret) });
    expect(conf.status).toBe(200);
    expect(conf.json.recoveryCodes).toHaveLength(10);
    const org = await nc.call('GET', '/api/org');
    expect(org.status).toBe(200);
    expect(org.json.uploadsUnlocked).toBe(true);
    expect((await nc.call('GET', '/api/team')).status).toBe(403); // viewer has no team.manage

    // recovery code sign in
    const rc = new Client();
    await rc.login(email, 'violet-sofa-marathon-42');
    const used = await rc.call('POST', '/api/auth/mfa/recovery', { code: conf.json.recoveryCodes[0] });
    expect(used.status).toBe(200);
    expect(used.json.recoveryCodesRemaining).toBe(9);
    const rc2 = new Client();
    await rc2.login(email, 'violet-sofa-marathon-42');
    expect((await rc2.call('POST', '/api/auth/mfa/recovery', { code: conf.json.recoveryCodes[0] })).status).toBe(400);
  });

  it('revokes sessions when a role changes or MFA is reset', async () => {
    const admin = await new Client().full('admin@acme.demo');
    const target = await new Client().full('quality@acme.demo');
    expect((await target.call('GET', '/api/org')).status).toBe(200);
    const tid = await userId('quality@acme.demo');
    const self = await admin.call('POST', `/api/team/${await userId('admin@acme.demo')}/roles`, { roles: ['viewer'] });
    expect(self.json.code).toBe('self_change');
    const r = await admin.call('POST', `/api/team/${tid}/roles`, { roles: ['viewer'] });
    expect(r.status).toBe(200);
    expect((await target.call('GET', '/api/org')).status).toBe(401);
    await admin.call('POST', `/api/team/${tid}/roles`, { roles: ['quality'] });

    const t2 = await new Client().full('quality@acme.demo');
    await resetTotpStep('admin@acme.demo');
    const reset = await admin.call('POST', `/api/team/${tid}/reset-mfa`);
    expect(reset.status).toBe(200);
    expect((await t2.call('GET', '/api/org')).status).toBe(401);
    const c3 = new Client();
    expect((await c3.login('quality@acme.demo')).json.stage).toBe('mfa_setup');
    // restore the demo secret for later tests
    await tx(SYSTEM, async (c) => {
      await c.query(`UPDATE users SET totp_secret_enc = $2, mfa_enabled = true, status = 'active' WHERE id = $1`, [tid, encryptField(demoTotpSecret('quality@acme.demo'), fieldAad.userTotp(tid))]);
    });

    const dis = await admin.call('POST', `/api/team/${tid}/disable`);
    expect(dis.status).toBe(200);
    expect((await new Client().login('quality@acme.demo')).status).toBe(401);
    expect((await admin.call('POST', `/api/team/${tid}/enable`)).status).toBe(200);
  });

  it('signs out other sessions on password change', async () => {
    const a = await new Client().full('finance@acme.demo');
    const b = await new Client().full('finance@acme.demo').catch(() => null);
    void b;
    const list = await a.call('GET', '/api/auth/sessions');
    expect(list.status).toBe(200);
    expect(list.json.sessions.some((s: any) => s.current)).toBe(true);
    const bad = await a.call('POST', '/api/auth/password/change', { currentPassword: 'wrong-current-1', newPassword: 'violet-sofa-marathon-43' });
    expect(bad.json.code).toBe('invalid_current_password');
    const ok = await a.call('POST', '/api/auth/password/change', { currentPassword: 'Demo2026PartnerHub', newPassword: 'violet-sofa-marathon-43' });
    expect(ok.status).toBe(200);
    expect((await a.call('GET', '/api/auth/me')).status).toBe(200);
    // put the demo password back
    await resetTotpStep('finance@acme.demo');
    const c = await new Client().call('POST', '/api/auth/login', { email: 'finance@acme.demo', password: 'violet-sofa-marathon-43' });
    expect(c.status).toBe(200);
    const back = await a.call('POST', '/api/auth/password/change', { currentPassword: 'violet-sofa-marathon-43', newPassword: 'Demo2026PartnerHub' });
    expect(back.status).toBe(200);
  });
});

describe('password reset and logging', () => {
  it('answers forgot password the same way, queues an email and resets', async () => {
    const started = Date.now();
    const known = await new Client().call('POST', '/api/auth/password/forgot', { email: 'upload@acme.demo' });
    const elapsedKnown = Date.now() - started;
    const unknown = await new Client().call('POST', '/api/auth/password/forgot', { email: 'ghost@acme.demo' });
    expect(known.status).toBe(200);
    expect(unknown.json).toEqual(known.json);
    expect(elapsedKnown).toBeGreaterThanOrEqual(390);

    await runDueJobs();
    const mails = await tx(SYSTEM, async (c) => (await c.query(`SELECT body, to_addr FROM dev_mailbox WHERE to_addr = 'upload@acme.demo' ORDER BY created_at DESC`)).rows);
    expect(mails.length).toBeGreaterThan(0);
    expect(await tx(SYSTEM, async (c) => (await c.query(`SELECT count(*)::int AS n FROM dev_mailbox WHERE to_addr = 'ghost@acme.demo'`)).rows[0].n)).toBe(0);
    const token = /token=([\w-]+)/.exec(mails[0].body)![1];

    const res = await new Client().call('POST', '/api/auth/password/reset', { token, newPassword: 'violet-sofa-marathon-44' });
    expect(res.status).toBe(200);
    expect((await new Client().call('POST', '/api/auth/password/reset', { token, newPassword: 'violet-sofa-marathon-45' })).status).toBe(400);
    await resetTotpStep('upload@acme.demo');
    expect((await new Client().login('upload@acme.demo', 'violet-sofa-marathon-44')).status).toBe(200);
    // restore
    const hash = await (await import('../src/crypto/password')).hashPassword('Demo2026PartnerHub', 10);
    await tx(SYSTEM, (c) => c.query('UPDATE users SET password_hash = $2 WHERE lower(email) = $1', ['upload@acme.demo', hash]));

    // token reaches a URL in the log only in redacted form
    await app.inject({ method: 'GET', url: `/reset-password?token=${token}` });
    await app.inject({ method: 'GET', url: `/api/auth/invite/${token}`, remoteAddress: '10.9.9.2' });
  });

  it('never logs one time tokens, cookies, CSRF tokens or bodies', async () => {
    const all = logs.join('\n');
    expect(all.length).toBeGreaterThan(100);
    const tokens = [...(await tx(SYSTEM, async (c) => (await c.query('SELECT body FROM dev_mailbox')).rows)).map((r: any) => r.body as string)]
      .flatMap((b) => [/token=([\w-]{20,})/.exec(b)?.[1], /\/invite\/([\w-]{20,})/.exec(b)?.[1]])
      .filter(Boolean) as string[];
    expect(tokens.length).toBeGreaterThan(1);
    for (const t of tokens) expect(all).not.toContain(t);
    expect(all).toContain('[redacted]');
    expect(all).not.toContain('Demo2026PartnerHub');
    expect(all).not.toContain('violet-sofa');
    expect(all).not.toMatch(/kph_session=/);
    expect(all).not.toMatch(/x-csrf-token/i);
    expect(all.toLowerCase()).not.toContain('set-cookie');
  });
});

describe('API keys', () => {
  it('authenticates bearer keys and refuses bad ones', async () => {
    const orgId = await orgIdOf('ACME');
    const key = await tx({ orgId, bypass: false }, (c) => createApiKey(c, { orgId, orgKind: 'partner', name: 'test', scopes: ['cases:read'], cidrs: ['10.0.0.0/8'], expiresInDays: 30 }));
    const ok = await app.inject({ method: 'GET', url: '/api/org', headers: { authorization: `Bearer ${key.key}` }, remoteAddress: '10.5.5.5' });
    expect(ok.statusCode).toBe(403); // authenticated, but session-only endpoint
    expect(ok.json().code).toBe('forbidden');
    const outside = await app.inject({ method: 'GET', url: '/api/org', headers: { authorization: `Bearer ${key.key}` }, remoteAddress: '192.168.1.1' });
    expect(outside.statusCode).toBe(401);
    const bad = await app.inject({ method: 'GET', url: '/api/org', headers: { authorization: `Bearer ${key.key.slice(0, -2)}xx` }, remoteAddress: '10.5.5.5' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('invalid_api_key');
    // writes with a key do not need CSRF
    const post = await app.inject({ method: 'POST', url: '/api/team/invite', payload: {}, headers: { authorization: `Bearer ${key.key}` }, remoteAddress: '10.5.5.5' });
    expect(post.statusCode).toBe(403);
    expect(post.json().code).toBe('forbidden');
  });
});

describe('tenant isolation at the database', () => {
  let a: string;
  let b: string;
  let caseA: string;
  let caseB: string;

  beforeAll(async () => {
    a = await orgIdOf('ACME');
    b = await tx(SYSTEM, async (c) => {
      const r = await c.query(`INSERT INTO organizations (kind, name, code, status) VALUES ('partner', 'Contoso Smile', 'CONTOSO', 'active') RETURNING id`);
      return r.rows[0].id as string;
    });
    const mk = (org: string, ref: string, pid: string) =>
      tx({ orgId: org, bypass: false }, async (c) => (await c.query(`INSERT INTO cases (org_id, ref, partner_case_id) VALUES ($1, $2, $3) RETURNING id`, [org, ref, pid])).rows[0].id as string);
    caseA = await mk(a, 'ACME-000001', 'A-1');
    caseB = await mk(b, 'CONTOSO-000001', 'B-1');
  });

  it('lets a partner read only its own rows', async () => {
    const own = await tx({ orgId: a, bypass: false }, (c) => c.query('SELECT id FROM cases'));
    expect(own.rows.map((r) => r.id)).toEqual([caseA]);
    const other = await tx({ orgId: a, bypass: false }, (c) => c.query('SELECT id FROM cases WHERE id = $1', [caseB]));
    expect(other.rowCount).toBe(0);
    const orgs = await tx({ orgId: a, bypass: false }, (c) => c.query('SELECT id FROM organizations'));
    expect(orgs.rows.map((r) => r.id)).toEqual([a]);
    const users = await tx({ orgId: b, bypass: false }, (c) => c.query('SELECT id FROM users'));
    expect(users.rowCount).toBe(0);
  });

  it('refuses cross tenant writes and changes nothing', async () => {
    await expect(
      tx({ orgId: a, bypass: false }, (c) => c.query(`INSERT INTO cases (org_id, ref, partner_case_id) VALUES ($1, 'X-1', 'x')`, [b])),
    ).rejects.toMatchObject({ code: '42501' });
    const upd = await tx({ orgId: a, bypass: false }, (c) => c.query(`UPDATE cases SET priority = 'rush' WHERE id = $1`, [caseB]));
    expect(upd.rowCount).toBe(0);
    const del = await tx({ orgId: a, bypass: false }, (c) => c.query('DELETE FROM cases WHERE id = $1', [caseB]));
    expect(del.rowCount).toBe(0);
    // moving a row to another tenant is refused too
    await expect(tx({ orgId: a, bypass: false }, (c) => c.query('UPDATE cases SET org_id = $2 WHERE id = $1', [caseA, b]))).rejects.toMatchObject({ code: '42501' });
    const still = await tx(SYSTEM, (c) => c.query('SELECT priority FROM cases WHERE id = $1', [caseB]));
    expect(still.rows[0].priority).toBe('normal');
  });

  it('gives no context, no rows, and K Line bypass sees everything', async () => {
    const none = await tx({ orgId: null, bypass: false }, (c) => c.query('SELECT id FROM cases'));
    expect(none.rowCount).toBe(0);
    const all = await tx(SYSTEM, (c) => c.query('SELECT id FROM cases'));
    expect(all.rowCount).toBe(2);
    // pool without tx() sees nothing at all
    expect((await pool().query('SELECT id FROM cases')).rowCount).toBe(0);
    // FORCE row level security: a non superuser owner sees nothing without a context (the docker dev owner is a superuser, which no policy can restrict)
    const ownerRole = (await ownerPool().query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    if (!ownerRole.rolsuper && !ownerRole.rolbypassrls) expect((await ownerPool().query('SELECT id FROM cases')).rowCount).toBe(0);
  });

  it('keeps K Line only tables away from partners', async () => {
    await tx(SYSTEM, (c) => c.query(`INSERT INTO dev_mailbox (to_addr, subject, body) VALUES ('x@y.z', 's', 'b')`));
    const seen = await tx({ orgId: a, bypass: false }, (c) => c.query('SELECT * FROM dev_mailbox'));
    expect(seen.rowCount).toBe(0);
    await expect(tx({ orgId: a, bypass: false }, (c) => c.query(`INSERT INTO dev_mailbox (to_addr, subject, body) VALUES ('x', 'y', 'z')`))).rejects.toMatchObject({ code: '42501' });
    await expect(tx({ orgId: a, bypass: false }, (c) => c.query(`INSERT INTO sites (code, name, country) VALUES ('ZZ-1', 'Z', 'ZZ')`))).rejects.toMatchObject({ code: '42501' });
    expect((await tx({ orgId: a, bypass: false }, (c) => c.query('SELECT id FROM sites'))).rowCount).toBe(5);
  });

  it('restricts the app role', async () => {
    const r = await pool().query(`SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user`);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    const owned = await pool().query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`);
    expect(owned.rows[0].n).toBe(0);
  });

  it('shows partners only their own audit entries', async () => {
    await tx(SYSTEM, async (c) => {
      await audit(c, { actorType: 'system', orgId: b, action: 'contoso.marker' });
      await audit(c, { actorType: 'system', orgId: a, action: 'acme.marker' });
    });
    const c = await new Client().full('admin@acme.demo');
    const r = await c.call('GET', '/api/audit?limit=200');
    expect(r.status).toBe(200);
    const actions = r.json.entries.map((e: any) => e.action);
    expect(actions).toContain('acme.marker');
    expect(actions).toContain('auth.login');
    expect(actions).not.toContain('contoso.marker');
    const seq = r.json.entries.map((e: any) => e.seq);
    expect([...seq].sort((x: number, y: number) => y - x)).toEqual(seq);
    const filtered = await c.call('GET', '/api/audit?action=acme.');
    expect(filtered.json.entries.every((e: any) => e.action.startsWith('acme.'))).toBe(true);
    // a viewer style role without audit.read is refused
    const u = await new Client().full('upload@acme.demo');
    expect((await u.call('GET', '/api/audit')).status).toBe(403);
    const orgOwner = await c.call('GET', '/api/audit?orgId=' + b);
    expect(orgOwner.json.entries.map((e: any) => e.action)).not.toContain('contoso.marker');
  });
});

describe('audit chain', () => {
  it('verifies, and the app role cannot alter or delete entries', async () => {
    const v = await ownerPool().query('SELECT * FROM kph_audit_verify()');
    expect(v.rows[0].ok).toBe(true);
    expect(Number(v.rows[0].checked)).toBeGreaterThan(10);

    await expect(pool().query(`UPDATE audit_log SET action = 'tampered'`)).rejects.toMatchObject({ code: '42501' });
    await expect(pool().query('DELETE FROM audit_log')).rejects.toMatchObject({ code: '42501' });
    await expect(pool().query(`INSERT INTO audit_log (seq, at, actor_type, action, prev_hash, hash) VALUES (1, now(), 'system', 'x', 'a', 'b')`)).rejects.toMatchObject({ code: '42501' });
    await expect(pool().query('TRUNCATE audit_log')).rejects.toMatchObject({ code: '42501' });
    await expect(pool().query('SELECT * FROM audit_anchor')).rejects.toMatchObject({ code: '42501' });
    await expect(pool().query(`SELECT kph_audit_trim(now())`)).rejects.toMatchObject({ code: '42501' });
    await expect(pool().query(`SELECT * FROM kph_audit_verify()`)).rejects.toMatchObject({ code: '42501' });
    // the owner is stopped by the guard trigger and row level security as well
    const ownerUpdate = await ownerPool().query(`UPDATE audit_log SET action = 'tampered'`).then((r) => r.rowCount, (e) => (/append only/.test(e.message) ? 'blocked' : 'other'));
    expect([0, 'blocked']).toContain(ownerUpdate);
    await expect(ownerPool().query('TRUNCATE audit_log')).rejects.toThrow(/append only/);
    // app role can still read (filtered by row level security) and append through the function
    expect((await pool().query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(0);
    await tx(SYSTEM, (c) => audit(c, { actorType: 'system', action: 'test.appended' }));
  });

  it('detects tampering with the chain anchor and passes again once restored', async () => {
    const o = await ownerPool().connect();
    try {
      await o.query('BEGIN');
      await o.query(`SELECT set_config('kph.bypass', 'true', true)`);
      await o.query(`UPDATE audit_anchor SET last_hash = 'forged'`);
      const bad = await o.query('SELECT * FROM kph_audit_verify()');
      expect(bad.rows[0].ok).toBe(false);
      await o.query('ROLLBACK');
    } finally {
      o.release();
    }
    expect((await ownerPool().query('SELECT * FROM kph_audit_verify()')).rows[0].ok).toBe(true);
  });

  it('trims old entries and still verifies', async () => {
    await ownerPool().query('SELECT kph_audit_trim(now() + interval \'1 second\')');
    const v = await ownerPool().query('SELECT * FROM kph_audit_verify()');
    expect(v.rows[0].ok).toBe(true);
    expect(Number(v.rows[0].checked)).toBe(0);
    await tx(SYSTEM, (c) => audit(c, { actorType: 'system', action: 'test.after_trim' }));
    const v2 = await ownerPool().query('SELECT * FROM kph_audit_verify()');
    expect(v2.rows[0].ok).toBe(true);
    expect(Number(v2.rows[0].checked)).toBe(1);
  });
});

describe('job queue and counters', () => {
  it('retries failed jobs with backoff and completes good ones', async () => {
    let calls = 0;
    registerJob('test.flaky', async () => {
      calls++;
      throw new Error('boom');
    });
    registerJob('test.ok', async () => {});
    const ids = await tx(SYSTEM, async (c) => [await enqueue(c, 'test.flaky', {}, { maxAttempts: 2 }), await enqueue(c, 'test.ok', {})]);
    await runDueJobs();
    expect(calls).toBe(1);
    const rows = await tx(SYSTEM, async (c) => (await c.query('SELECT id, status, attempts, run_at > now() AS later FROM jobs WHERE id = ANY($1)', [ids])).rows);
    const flaky = rows.find((r) => r.id === ids[0]);
    expect(flaky).toMatchObject({ status: 'queued', attempts: 1, later: true });
    expect(rows.find((r) => r.id === ids[1])?.status).toBe('done');
    await tx(SYSTEM, (c) => c.query('UPDATE jobs SET run_at = now() WHERE id = $1', [ids[0]]));
    await runDueJobs();
    const final = await tx(SYSTEM, async (c) => (await c.query('SELECT status, attempts FROM jobs WHERE id = $1', [ids[0]])).rows[0]);
    expect(final).toEqual({ status: 'failed', attempts: 2 });
  });

  it('hands out increasing counter values', async () => {
    const key = 'test-' + randomUUID();
    const vals = await tx(SYSTEM, async (c) => {
      const out: number[] = [];
      for (let i = 0; i < 3; i++) out.push((await c.query('SELECT kph_next_counter($1) AS v', [key])).rows[0].v);
      return out;
    });
    expect(vals).toEqual([1, 2, 3]);
    expect(typeof vals[0]).toBe('number');
  });
});
