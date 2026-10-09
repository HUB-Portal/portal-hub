import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { ROLE_PERMISSIONS } from '../../shared/roles';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { config } from '../src/config';
import { seedDemo } from '../src/demo/seed';
import { DEMO_PASSWORD } from '../src/services/demo';
import { createUserToken } from '../src/services/userTokens';
import { fileName } from '../src/services/files';
import { Client, createDemoUser, orgIdOf, totp } from './helpers';
import { api, mkKey } from './helpers6';
import { expireStepUp, readyStandardCase, svcCall } from './helpers9';

let app: FastifyInstance;
let tunnelApp: FastifyInstance;
let acmeId: string;
let klineId: string;
let admin: Client; // Acme admin
let up: Client; // Acme uploader
let klAdmin: Client;
let svcKey: string;

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });
let userN = 0;

const userRow = async (email: string) => (await q('SELECT * FROM users WHERE lower(email) = $1', [email]))[0];
const userIdOf = async (email: string) => (await userRow(email)).id as string;

/** A new person of Acme (or K Line) with the demo password and authenticator, so the tests can lock them without touching the seeded accounts. */
async function newUser(roles: string[] = ['viewer'], org: 'acme' | 'kline' = 'acme') {
  const email = `h${++userN}-${Math.random().toString(36).slice(2, 6)}@${org === 'acme' ? 'acme' : 'kline'}.demo`;
  await createDemoUser(org === 'acme' ? acmeId : klineId, email, `Hardening User${userN}`, roles);
  return email;
}
/** Password sign in only (stage password). A new client means a new address and a new session. */
async function passwordLogin(email: string, password = DEMO_PASSWORD) {
  const c = new Client(app);
  const r = await c.call('POST', '/api/auth/login', { email, password });
  return { c, r };
}
const wrongCode = (c: Client) => c.call('POST', '/api/auth/mfa/verify', { code: '000000' });
const wrongRecovery = (c: Client) => c.call('POST', '/api/auth/mfa/recovery', { code: 'AAAAAA-BBBBBB' });
const lockMinutes = (row: any) => (new Date(row.locked_until).getTime() - Date.now()) / 60_000;

beforeAll(async () => {
  // Partner administrators no longer hold integration.manage in production (nobody can reach the Portal connection or its
  // receiver). The feature code stays, so the tests grant the permission to the partner administrator role for this run.
  // Permissions are evaluated per request (auth/context.ts), so this takes effect at once.
  if (!ROLE_PERMISSIONS.admin.includes('integration.manage')) ROLE_PERMISSIONS.admin.push('integration.manage');
  await seedDemo({ force: true });
  app = await buildApp({ logStream: quiet() });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  klineId = await orgIdOf('KLINE').catch(async () => (await q(`SELECT id FROM organizations WHERE kind = 'kline'`))[0].id);
  admin = await new Client(app).full('admin@acme.demo');
  up = await new Client(app).full('upload@acme.demo');
  klAdmin = await new Client(app).full('admin@kline.demo');
  const k = await klAdmin.call('POST', '/api/service-keys', { name: 'Hardening factory system', scopes: ['mes:intake', 'mes:files', 'mes:events'], expiresInDays: 30 });
  expect(k.status, JSON.stringify(k.json)).toBe(201);
  svcKey = k.json.key;
});

afterAll(async () => {
  await app.close();
  await tunnelApp?.close();
  await closePools();
});

// =====================================================================================================================
// 1. Wrong second factor codes count per user, across sessions
// =====================================================================================================================
describe('second factor brute force', () => {
  it('does not give five fresh guesses at every password sign in, and a correct password does not reset the counter', async () => {
    const email = await newUser();
    const a = (await passwordLogin(email)).c;
    for (let i = 0; i < 3; i++) expect((await wrongCode(a)).json.code).toBe('invalid_code');
    // a new sign in with the correct password
    const b = await passwordLogin(email);
    expect(b.r.status).toBe(200);
    expect((await userRow(email)).mfa_failed_codes).toBe(3);
    expect((await wrongCode(b.c)).json.code).toBe('invalid_code'); // the fourth wrong code of the person
    const fifth = await wrongCode(b.c);
    expect(fifth.status).toBe(401);
    expect(fifth.json.code).toBe('session_revoked');

    const row = await userRow(email);
    expect(lockMinutes(row)).toBeGreaterThan(13);
    expect(lockMinutes(row)).toBeLessThan(16);
    expect(row).toMatchObject({ mfa_lockout_count: 1, mfa_failed_codes: 0 });
    // every session of the person ended, also the first one
    expect((await a.call('GET', '/api/auth/me')).status).toBe(401);
    expect((await b.c.call('GET', '/api/auth/me')).status).toBe(401);
    // the correct password is refused while locked, with the usual generic answer
    const again = await passwordLogin(email);
    expect(again.r.status).toBe(401);
    expect(again.r.json.code).toBe('invalid_credentials');
    // audited, without any code
    const logged = await q(`SELECT action, details FROM audit_log WHERE actor_id = $1 AND action IN ('auth.mfa_failed', 'auth.mfa_locked') ORDER BY seq`, [await userIdOf(email)]);
    expect(logged.filter((x) => x.action === 'auth.mfa_failed')).toHaveLength(5);
    expect(logged.filter((x) => x.action === 'auth.mfa_locked')).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain('000000');
  });

  it('clears the counter only after a correct authenticator code', async () => {
    const email = await newUser();
    const a = (await passwordLogin(email)).c;
    for (let i = 0; i < 3; i++) await wrongCode(a);
    expect((await userRow(email)).mfa_failed_codes).toBe(3);
    // a new password sign in leaves it alone ...
    const b = (await passwordLogin(email)).c;
    expect((await userRow(email)).mfa_failed_codes).toBe(3);
    // ... and a correct code clears it
    const ok = await b.call('POST', '/api/auth/mfa/verify', { code: totp(email) });
    expect(ok.status).toBe(200);
    expect(await userRow(email)).toMatchObject({ mfa_failed_codes: 0, mfa_lockout_count: 0, mfa_fail_window_start: null });
  });

  it('counts wrong recovery codes the same way, also mixed with wrong authenticator codes', async () => {
    const email = await newUser();
    const a = (await passwordLogin(email)).c;
    for (let i = 0; i < 4; i++) expect((await wrongRecovery(a)).json.code).toBe('invalid_code');
    const last = await wrongRecovery(a);
    expect(last.json.code).toBe('session_revoked');
    expect(lockMinutes(await userRow(email))).toBeGreaterThan(13);

    const mixed = await newUser();
    const m1 = (await passwordLogin(mixed)).c;
    for (let i = 0; i < 3; i++) await wrongCode(m1);
    const m2 = (await passwordLogin(mixed)).c;
    expect((await wrongRecovery(m2)).json.code).toBe('invalid_code');
    expect((await wrongRecovery(m2)).json.code).toBe('session_revoked');
    expect((await userRow(mixed)).locked_until).not.toBeNull();
  });

  it('counts five wrong codes within 15 minutes: an older window starts again', async () => {
    const email = await newUser();
    await q(`UPDATE users SET mfa_failed_codes = 4, mfa_fail_window_start = now() - interval '16 minutes' WHERE lower(email) = $1`, [email]);
    const a = (await passwordLogin(email)).c;
    expect((await wrongCode(a)).json.code).toBe('invalid_code');
    expect(await userRow(email)).toMatchObject({ mfa_failed_codes: 1, locked_until: null });
    // inside the window the fifth one locks
    await q(`UPDATE users SET mfa_failed_codes = 4, mfa_fail_window_start = now() - interval '5 minutes' WHERE lower(email) = $1`, [email]);
    expect((await wrongCode(a)).json.code).toBe('session_revoked');
    expect((await userRow(email)).locked_until).not.toBeNull();
  });

  it('doubles the lock on every repeat, up to 24 hours', async () => {
    const email = await newUser();
    const lockOnce = async () => {
      await q(`UPDATE users SET locked_until = NULL WHERE lower(email) = $1`, [email]);
      const c = (await passwordLogin(email)).c;
      for (let i = 0; i < 4; i++) await wrongCode(c);
      expect((await wrongCode(c)).json.code).toBe('session_revoked');
      return userRow(email);
    };
    expect(lockMinutes(await lockOnce())).toBeGreaterThan(13);
    const second = await lockOnce();
    expect(lockMinutes(second)).toBeGreaterThan(28);
    expect(lockMinutes(second)).toBeLessThan(31);
    expect(second.mfa_lockout_count).toBe(2);
    await q(`UPDATE users SET mfa_lockout_count = 12 WHERE lower(email) = $1`, [email]);
    const capped = await lockOnce();
    expect(lockMinutes(capped)).toBeGreaterThan(23 * 60);
    expect(lockMinutes(capped)).toBeLessThan(24 * 60 + 1);
  });

  it('refuses a partial session of a locked account even with the right code, and counts nothing', async () => {
    const email = await newUser();
    const c = (await passwordLogin(email)).c;
    await q(`UPDATE users SET locked_until = now() + interval '15 minutes' WHERE lower(email) = $1`, [email]);
    const r = await c.call('POST', '/api/auth/mfa/verify', { code: totp(email) });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('session_revoked');
    expect((await c.call('GET', '/api/auth/me')).status).toBe(401);
    expect((await userRow(email)).mfa_failed_codes).toBe(0);
  });

  it('counts wrong step up codes too, and a lock ends every session of the person', async () => {
    const email = await newUser();
    const first = await new Client(app).full(email);
    const second = await new Client(app).full(email);
    for (let i = 0; i < 4; i++) expect((await first.call('POST', '/api/auth/step-up', { code: '000000' })).json.code).toBe('invalid_code');
    const last = await first.call('POST', '/api/auth/step-up', { code: '000000' });
    expect(last.status).toBe(401);
    expect((await second.call('GET', '/api/auth/me')).status).toBe(401);
    expect((await userRow(email)).locked_until).not.toBeNull();
  });

  it('counts guesses that arrive at the same time one by one: no more than five tries', async () => {
    const email = await newUser();
    const id = await userIdOf(email);
    const { c } = await passwordLogin(email);
    const results = await Promise.all(Array.from({ length: 8 }, () => wrongCode(c)));
    expect(results.filter((r) => r.json.code === 'invalid_code').length).toBeLessThanOrEqual(4);
    expect(results.every((r) => r.status === 400 || r.status === 401)).toBe(true);
    const counted = await q(`SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND action = 'auth.mfa_failed'`, [id]);
    expect(counted[0]!.n).toBe(5);
    expect(lockMinutes(await userRow(email))).toBeGreaterThan(13);
    // the sessions are really ended in the database, not only in the browser
    expect(await q(`SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [id])).toHaveLength(0);
  });

  it('ends the partial session in the database when a locked account tries to finish a sign in', async () => {
    const email = await newUser();
    const id = await userIdOf(email);
    const { c } = await passwordLogin(email);
    await q(`UPDATE users SET locked_until = now() + interval '10 minutes' WHERE id = $1`, [id]);
    const r = await c.call('POST', '/api/auth/mfa/verify', { code: totp(email) });
    expect(r.json.code).toBe('session_revoked');
    expect(await q(`SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [id])).toHaveLength(0);
    // and the password sign in itself is refused while the lock lasts
    expect((await passwordLogin(email)).r.status).toBe(401);
  });

  it('keeps the password lock as it was (five wrong passwords), and a password lock never touches the code counter', async () => {
    const email = await newUser();
    for (let i = 0; i < 5; i++) expect((await passwordLogin(email, 'not-the-password-1')).r.status).toBe(401);
    expect((await userRow(email)).locked_until).not.toBeNull();
    expect((await userRow(email)).mfa_failed_codes).toBe(0);
  });
});

// =====================================================================================================================
// 6. A password reset lifts a lock; administrators can unlock
// =====================================================================================================================
describe('lock, reset and unlock', () => {
  it('a password reset by email link clears the lock and every wrong attempt counter', async () => {
    const email = await newUser();
    await q(
      `UPDATE users SET failed_logins = 3, lockout_count = 2, locked_until = now() + interval '2 hours', mfa_failed_codes = 4, mfa_fail_window_start = now(), mfa_lockout_count = 3 WHERE lower(email) = $1`,
      [email],
    );
    const row = await userRow(email);
    const token = await tx(SYSTEM, (c) => createUserToken(c, { orgId: acmeId, userId: row.id, kind: 'reset', ttlMinutes: 60 }));
    // a weak password is refused first
    const weak = await new Client(app).call('POST', '/api/auth/password/reset', { token, newPassword: 'Password12345678' });
    expect(weak.status).toBe(400);
    expect(weak.json.code).toBe('weak_password');
    const ok = await new Client(app).call('POST', '/api/auth/password/reset', { token, newPassword: 'Blue-Harbour-Kettle-2026!' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await userRow(email)).toMatchObject({ failed_logins: 0, lockout_count: 0, locked_until: null, mfa_failed_codes: 0, mfa_fail_window_start: null, mfa_lockout_count: 0 });
    expect((await passwordLogin(email, 'Blue-Harbour-Kettle-2026!')).r.status).toBe(200);
  });

  it('lets a partner administrator unlock a person: step up, audited, and visible as Locked in the team list', async () => {
    const email = await newUser();
    const id = await userIdOf(email);
    await q(`UPDATE users SET locked_until = now() + interval '2 hours', mfa_failed_codes = 2, mfa_lockout_count = 2, failed_logins = 3 WHERE id = $1`, [id]);
    const list = await admin.call('GET', '/api/team');
    const mine = list.json.users.find((u: any) => u.id === id);
    expect(mine).toMatchObject({ locked: true });
    expect(mine.lockedUntil).toBeTruthy();
    expect(list.json.users.find((u: any) => u.email === 'upload@acme.demo')).toMatchObject({ locked: false, lockedUntil: null });

    // without a fresh authenticator code
    await expireStepUp('admin@acme.demo');
    const refused = await admin.call('POST', `/api/team/${id}/unlock`, {});
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('step_up_required');
    await admin.stepUp('admin@acme.demo');
    // a person without team.manage cannot
    expect((await up.call('POST', `/api/team/${id}/unlock`, {})).status).toBe(403);
    const ok = await admin.call('POST', `/api/team/${id}/unlock`, {});
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await userRow(email)).toMatchObject({ locked_until: null, mfa_failed_codes: 0, mfa_lockout_count: 0, failed_logins: 0, lockout_count: 0 });
    expect((await passwordLogin(email)).r.status).toBe(200);
    expect((await admin.call('GET', '/api/team')).json.users.find((u: any) => u.id === id)).toMatchObject({ locked: false });
    const logged = await q(`SELECT details FROM audit_log WHERE action = 'team.unlocked' AND target_id = $1`, [id]);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.details).toMatchObject({ wasLocked: true });
    // another company's people are not found
    const kline = (await klAdmin.call('GET', '/api/staff')).json.users.find((u: any) => u.email === 'admin@kline.demo');
    expect((await admin.call('POST', `/api/team/${kline.id}/unlock`, {})).status).toBe(404);
  });

  it('lets a K Line administrator unlock staff', async () => {
    const email = await newUser(['kl_admin'], 'kline');
    const id = await userIdOf(email);
    await q(`UPDATE users SET locked_until = now() + interval '3 hours' WHERE id = $1`, [id]);
    expect((await klAdmin.call('GET', '/api/staff')).json.users.find((u: any) => u.id === id)).toMatchObject({ locked: true });
    const ok = await klAdmin.call('POST', `/api/staff/${id}/unlock`, {});
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await userRow(email)).locked_until).toBeNull();
    expect((await q(`SELECT 1 FROM audit_log WHERE action = 'staff.unlocked' AND target_id = $1`, [id])).length).toBe(1);
    expect((await klAdmin.call('POST', `/api/staff/00000000-0000-4000-8000-000000000000/unlock`, {})).status).toBe(404);
  });

  it('refuses the same password as the current one when changing it, and a weak new one', async () => {
    const email = await newUser();
    const c = await new Client(app).full(email);
    const same = await c.call('POST', '/api/auth/password/change', { currentPassword: DEMO_PASSWORD, newPassword: DEMO_PASSWORD });
    expect(same.status).toBe(400);
    expect(same.json.code).toBe('same_password');
    const weak = await c.call('POST', '/api/auth/password/change', { currentPassword: DEMO_PASSWORD, newPassword: 'Admin@123456789' });
    expect(weak.json.code).toBe('weak_password');
    const wrong = await c.call('POST', '/api/auth/password/change', { currentPassword: 'not-my-password-1', newPassword: 'Blue-Harbour-Kettle-2026!' });
    expect(wrong.json.code).toBe('invalid_current_password');
    const ok = await c.call('POST', '/api/auth/password/change', { currentPassword: DEMO_PASSWORD, newPassword: 'Blue-Harbour-Kettle-2026!' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await passwordLogin(email, 'Blue-Harbour-Kettle-2026!')).r.status).toBe(200);
  });
});

// =====================================================================================================================
// 2. Demo data and tunnels
// =====================================================================================================================
describe('demo data is for direct local use only', () => {
  const PROXY = [
    ['x-forwarded-for', '203.0.113.7'], ['forwarded', 'for=203.0.113.7'], ['cf-connecting-ip', '203.0.113.7'], ['cf-ray', '8a1b2c3d4e5f-FRA'], ['x-real-ip', '203.0.113.7'],
  ] as const;
  const ROUTES = ['/api/demo/accounts', '/api/demo/mailbox', '/api/demo/registrations', '/api/demo/sample-cases.zip'];

  it('answers directly from this computer or a private network', async () => {
    for (const url of ROUTES) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
    }
    const lan = await app.inject({ method: 'GET', url: '/api/demo/accounts', remoteAddress: '192.168.1.40' });
    expect(lan.statusCode).toBe(200);
    expect(lan.json().password).toBe(DEMO_PASSWORD);
  });

  it('answers 404 to every route when the request carries any proxy or tunnel header', async () => {
    for (const [h, v] of PROXY) {
      for (const url of ROUTES) {
        const r = await app.inject({ method: 'GET', url, headers: { [h]: v } });
        expect(r.statusCode, `${h} ${url}`).toBe(404);
        expect(r.json()).toMatchObject({ code: 'not_found' });
        expect(r.body).not.toContain(DEMO_PASSWORD);
      }
    }
  });

  it('answers 404 when the socket peer is a public address', async () => {
    for (const url of ROUTES) {
      const r = await app.inject({ method: 'GET', url, remoteAddress: '203.0.113.9' });
      expect(r.statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: '/api/demo/accounts', remoteAddress: '8.8.8.8' })).statusCode).toBe(404);
  });

  it('leaves the demo hints out of /api/auth/me behind a proxy or from a public address', async () => {
    const c = await new Client(app).full('quality@acme.demo');
    const direct = await c.call('GET', '/api/auth/me');
    expect(direct.json.demo.enabled).toBe(true);
    expect(direct.json.demo.code?.code).toMatch(/^\d{6}$/);
    for (const [h, v] of PROXY) {
      const r = await c.call('GET', '/api/auth/me', undefined, { headers: { [h]: v } });
      expect(r.status, h).toBe(200);
      expect(r.json.demo, h).toEqual({ enabled: false, code: null });
      expect(JSON.stringify(r.json), h).not.toMatch(/"code":"\d{6}"/);
    }
    c.ip = '203.0.113.50';
    expect((await c.call('GET', '/api/auth/me')).json.demo).toEqual({ enabled: false, code: null });
  });

  it('is off when demo mode is off', async () => {
    config.demoMode = false;
    try {
      expect((await app.inject({ method: 'GET', url: '/api/demo/accounts' })).statusCode).toBe(404);
    } finally {
      config.demoMode = true;
    }
  });
});

describe('TUNNEL_HOOKS_ONLY', () => {
  const PROXY = [{ 'cf-connecting-ip': '203.0.113.7' }, { 'x-forwarded-for': '203.0.113.7' }, { forwarded: 'for=203.0.113.7' }, { 'cf-ray': 'abc-FRA' }, { 'x-real-ip': '203.0.113.7' }];

  beforeAll(async () => {
    config.tunnelHooksOnly = true;
    try {
      tunnelApp = await buildApp({ logStream: quiet() });
      await tunnelApp.ready();
    } finally {
      config.tunnelHooksOnly = false;
    }
  });

  it('through a tunnel only the portal webhook receiver and the health check answer', async () => {
    // a real receiver of Acme, as the settings page creates it
    await admin.stepUp('admin@acme.demo');
    const made = await admin.call('POST', '/api/org/portal-api/webhook', {});
    expect(made.status, JSON.stringify(made.json)).toBeLessThan(300);
    const hookPath = new URL(made.json.url).pathname;
    const secret = made.json.secret as string;
    for (const headers of PROXY) {
      const h = await tunnelApp.inject({ method: 'GET', url: '/api/health', headers });
      expect(h.statusCode, JSON.stringify(headers)).toBe(200);
      // the receiver is reached: the right secret is accepted, a wrong one gets the receiver's own 401
      const hook = await tunnelApp.inject({ method: 'POST', url: hookPath, headers: { ...headers, 'content-type': 'application/json', 'x-kline-secret-token': secret }, payload: '{"type":"case"}' });
      expect(hook.statusCode, JSON.stringify(headers)).toBe(200);
      const wrong = await tunnelApp.inject({ method: 'POST', url: hookPath, headers: { ...headers, 'content-type': 'application/json', 'x-kline-secret-token': 'whsec_nope' }, payload: '{}' });
      expect(wrong.statusCode, JSON.stringify(headers)).toBe(401);
      for (const [method, url] of [
        ['GET', '/api/auth/me'], ['GET', '/api/public/config'], ['POST', '/api/auth/login'], ['GET', '/api/demo/accounts'], ['GET', '/'], ['GET', '/login'],
        ['GET', '/assets/app-abc123.js'], ['GET', '/api/hooks/kline-portal/a/b'], ['GET', '/api/hooks/kline-portal/'], ['GET', '/api/healthz'], ['GET', '/api/v1/cases'],
      ] as const) {
        const r = await tunnelApp.inject({ method, url, headers });
        expect(r.statusCode, `${method} ${url} ${JSON.stringify(headers)}`).toBe(404);
        expect(r.json()).toMatchObject({ code: 'not_found' });
      }
    }
  });

  it('does not touch direct requests (no proxy headers)', async () => {
    expect((await tunnelApp.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401); // nobody signed in, but the route answers
    expect((await tunnelApp.inject({ method: 'GET', url: '/api/demo/accounts' })).statusCode).toBe(200);
    expect((await tunnelApp.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
  });

  it('is off by default: the normal app does not hide anything behind a proxy', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { 'x-forwarded-for': '203.0.113.7' } })).statusCode).toBe(401); // the route answers
    expect((await app.inject({ method: 'GET', url: '/', headers: { 'cf-ray': 'x' } })).statusCode).toBe(200);
  });
});

// =====================================================================================================================
// 3. Hold bypass
// =====================================================================================================================
describe('a case on hold goes back to K Line review', () => {
  it('goes to submitted (never ready) after K Line put it on hold, keeps the resubmitted event, and K Line can route it', async () => {
    const made = await readyStandardCase(up);
    expect((await q('SELECT status FROM cases WHERE id = $1', [made.id]))[0].status).toBe('ready');
    const hold = await klAdmin.call('POST', `/api/cases/${made.id}/hold`, { reason: 'Please check the trim line.' });
    expect(hold.status, JSON.stringify(hold.json)).toBe(200);
    expect(hold.json.case.status).toBe('on_hold');
    const re = await up.call('POST', `/api/cases/${made.id}/submit`, { acknowledgeWarnings: true });
    expect(re.status, JSON.stringify(re.json)).toBe(200);
    expect(re.json.case.status).toBe('submitted');
    expect(re.json.case.siteCode).toBeNull();
    expect(re.json.case.readyAt).toBeNull();
    expect(re.json.case.dueDate).toBeNull();
    const events = await q(`SELECT type, data FROM case_events WHERE case_id = $1 ORDER BY created_at, id`, [made.id]);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['on_hold', 'resubmitted']));
    expect(events.find((e) => e.type === 'resubmitted')!.data).toMatchObject({ status: 'submitted' });
    expect((await q(`SELECT action FROM audit_log WHERE target_id = $1 AND action = 'case.resubmitted'`, [made.id])).length).toBe(1);
    // the factory cannot see it until K Line approves it
    const hidden = await svcCall(app, svcKey, 'GET', '/api/mes/v1/intake?site=PT-CHV');
    expect(hidden.json.cases.map((c: any) => c.ref)).not.toContain(made.ref);
    // K Line is told, and routes it
    const routed = await klAdmin.call('POST', `/api/cases/${made.id}/route`, { siteCode: 'PT-CHV' });
    expect(routed.status, JSON.stringify(routed.json)).toBe(200);
    expect(routed.json.case.status).toBe('ready');
  });

  it('is the same after a factory HOLD event', async () => {
    const made = await readyStandardCase(up);
    const ack = await svcCall(app, svcKey, 'POST', `/api/mes/v1/cases/${made.ref}/ack`, { mes_case_id: `MES-H-${made.ref}` });
    expect(ack.status, JSON.stringify(ack.json)).toBe(200);
    const ev = await svcCall(app, svcKey, 'POST', '/api/mes/v1/events', {
      events: [{ event_id: `H-${made.ref}`, case_ref: made.ref, stage_code: 'HOLD', occurred_at: new Date().toISOString(), hold_reason: 'Model for step 1 is damaged.' }],
    });
    expect(ev.json.results[0]).toMatchObject({ outcome: 'applied' });
    expect((await q('SELECT status FROM cases WHERE id = $1', [made.id]))[0].status).toBe('on_hold');
    const re = await up.call('POST', `/api/cases/${made.id}/submit`, { acknowledgeWarnings: true });
    expect(re.status, JSON.stringify(re.json)).toBe(200);
    expect(re.json.case.status).toBe('submitted');
    const row = (await q('SELECT status, stage, site_id, ready_at, received_at FROM cases WHERE id = $1', [made.id]))[0];
    expect(row).toMatchObject({ status: 'submitted', stage: null, site_id: null, ready_at: null, received_at: null });
    expect((await q(`SELECT type FROM case_events WHERE case_id = $1`, [made.id])).map((e) => e.type)).toContain('resubmitted');
  });

  it('stays submitted when the partner reviews manually as well', async () => {
    await q(`UPDATE organizations SET settings = jsonb_set(settings, '{manual_review}', 'true') WHERE id = $1`, [acmeId]);
    try {
      const made = await readyStandardCase(up);
      expect((await q('SELECT status FROM cases WHERE id = $1', [made.id]))[0].status).toBe('submitted');
      const hold = await klAdmin.call('POST', `/api/cases/${made.id}/hold`, { reason: 'Please add the second model.' });
      expect(hold.status, JSON.stringify(hold.json)).toBe(200);
      const re = await up.call('POST', `/api/cases/${made.id}/submit`, { acknowledgeWarnings: true });
      expect(re.json.case.status).toBe('submitted');
    } finally {
      await q(`UPDATE organizations SET settings = jsonb_set(settings, '{manual_review}', 'false') WHERE id = $1`, [acmeId]);
    }
  });

  it('a first submission of a draft still goes straight to ready when the partner does not review', async () => {
    const made = await readyStandardCase(up);
    expect((await q('SELECT status FROM cases WHERE id = $1', [made.id]))[0].status).toBe('ready');
  });
});

// =====================================================================================================================
// 5. Patient fields for partner API keys without patients:read
// =====================================================================================================================
describe('partner API keys without patients:read', () => {
  const PATIENT = /patientMasked|hasPatientName|Quentin Quokka|Q\*\*\*/;
  let made: Awaited<ReturnType<typeof readyStandardCase>>;
  let plain: { key: string };
  let withNames: { key: string };

  beforeAll(async () => {
    made = await readyStandardCase(up, { patientName: 'Quentin Quokka' });
    plain = await mkKey(acmeId, ['cases:read', 'cases:write'], { name: 'no patients scope' });
    withNames = await mkKey(acmeId, ['cases:read', 'cases:write', 'patients:read'], { name: 'with patients scope' });
  });

  it('never sees patient fields on the list, the detail, create, change and submit', async () => {
    const list = await api(app, plain.key, 'GET', '/api/cases?pageSize=100');
    expect(list.status).toBe(200);
    expect(list.json.items.length).toBeGreaterThan(0);
    expect(list.text).not.toMatch(PATIENT);
    const one = await api(app, plain.key, 'GET', `/api/cases/${made.id}`);
    expect(one.status).toBe(200);
    expect(one.json.case.ref).toBe(made.ref);
    expect(one.text).not.toMatch(PATIENT);
    const created = await api(app, plain.key, 'POST', '/api/cases', { caseId: `KEY-${Math.random().toString(36).slice(2, 7)}`, patientName: 'Gwen Gone' });
    expect(created.status, created.text).toBe(201);
    expect(created.text).not.toMatch(/patientMasked|hasPatientName|Gwen/);
    expect((await q('SELECT patient_enc FROM cases WHERE id = $1', [created.json.case.id]))[0].patient_enc).toMatch(/^f1\./); // the name is still stored
    const patched = await api(app, plain.key, 'PATCH', `/api/cases/${created.json.case.id}`, { priority: 'rush' });
    expect(patched.status).toBe(200);
    expect(patched.text).not.toMatch(/patientMasked|hasPatientName/);
    expect(patched.json.case.priority).toBe('rush');
    // nothing else is lost
    expect(one.json.case).toMatchObject({ id: made.id, status: 'ready', caseId: made.caseId, counts: expect.any(Object) });
  });

  it('cannot find a case by patient name either', async () => {
    const byName = await api(app, plain.key, 'GET', '/api/cases?search=Quentin%20Quokka');
    expect(byName.status).toBe(200);
    expect(byName.json.items).toHaveLength(0);
    const byRef = await api(app, plain.key, 'GET', `/api/cases?search=${made.ref}`);
    expect(byRef.json.items.map((c: any) => c.ref)).toEqual([made.ref]);
  });

  it('sees them with the patients:read scope, and people in the web app are not affected', async () => {
    const one = await api(app, withNames.key, 'GET', `/api/cases/${made.id}`);
    expect(one.json.case).toMatchObject({ hasPatientName: true, patientMasked: expect.stringMatching(/^Q\*+ Q\*+$/) });
    const found = await api(app, withNames.key, 'GET', '/api/cases?search=Quentin%20Quokka');
    expect(found.json.items.map((c: any) => c.ref)).toEqual([made.ref]);
    const web = await admin.call('GET', `/api/cases/${made.id}`);
    expect(web.json.case).toMatchObject({ hasPatientName: true });
    expect((await admin.call('GET', '/api/cases?search=Quentin%20Quokka')).json.items.map((c: any) => c.ref)).toEqual([made.ref]);
  });

  it('keeps /api/v1 correct', async () => {
    const v1 = await api(app, plain.key, 'GET', `/api/v1/cases?case_id=${encodeURIComponent(made.caseId)}`);
    expect(v1.status).toBe(200);
    expect(v1.text).not.toMatch(/Quentin|Quokka|patient_name/);
    const v1n = await api(app, withNames.key, 'GET', `/api/v1/cases?case_id=${encodeURIComponent(made.caseId)}`);
    expect(v1n.status).toBe(200);
    expect(v1n.text).toMatch(/Quentin/);
  });
});

// =====================================================================================================================
// 7. NUL characters
// =====================================================================================================================
describe('a NUL character in any text is a 400, never a 500', () => {
  const nul = '%00';
  const bad = (r: { status: number; json: any }, label: string) => {
    expect(r.status, label).toBe(400);
    expect(r.json, label).toMatchObject({ code: 'invalid_request' });
    expect(r.json.message, label).toMatch(/character/);
  };

  it('is refused in query strings', async () => {
    bad(await admin.call('GET', `/api/cases?search=a${nul}b`), 'search');
    bad(await klAdmin.call('GET', `/api/cases?siteCode=PT${nul}`), 'siteCode');
    bad(await klAdmin.call('GET', `/api/partners?search=ac${nul}me`), 'partners search');
    bad(await admin.call('GET', `/api/audit?action=a${nul}`), 'audit');
    bad(await admin.call('GET', `/api/cases?status=%00draft`), 'status');
    // and the normal ones still work
    expect((await admin.call('GET', '/api/cases?search=a')).status).toBe(200);
    expect((await klAdmin.call('GET', '/api/partners?search=ac')).status).toBe(200);
  });

  it('is refused in route parameters', async () => {
    bad(await admin.call('GET', `/api/cases/${nul}`), 'case id');
    bad(await admin.call('GET', `/api/files/abc${nul}`), 'file id');
  });

  it('is refused in JSON bodies, also nested, in values and in keys', async () => {
    bad(await admin.call('POST', '/api/org/brands', { name: 'Brand\u0000One' }), 'brand');
    bad(await admin.call('POST', '/api/materials', { sku: 'SKU\u0000', name: 'Box', category: 'box' }), 'sku');
    bad(await admin.call('POST', '/api/materials', { sku: 'SKU-NUL', name: 'Bo\u0000x', category: 'box' }), 'name');
    bad(await admin.call('POST', '/api/team/invite', { email: 'nul@acme.demo', name: 'Nul\u0000Person', roles: ['viewer'] }), 'team invite name');
    bad(await up.call('POST', '/api/cases', { caseId: 'C-\u0000', patientName: 'X' }), 'case id body');
    bad(await up.call('POST', '/api/cases', { caseId: 'C-1', instructions: 'line\u0000two' }), 'instructions');
    bad(await klAdmin.call('POST', '/api/mes/events/import', { csv: 'event_id,stage_code\n1,PR\u0000INT' }), 'import');
    const nested = await admin.call('PUT', '/api/org/menu', { claims: true, deep: { a: [{ b: 'x\u0000' }] } });
    bad(nested, 'nested');
    const key = await admin.call('PUT', '/api/org/menu', { ['k\u0000']: true });
    bad(key, 'key');
    // public routes too
    const login = await new Client(app).call('POST', '/api/auth/login', { email: 'a\u0000@b.test', password: 'x' });
    bad(login, 'login');
    const reg = await new Client(app).call('POST', '/api/auth/register', { companyName: 'Nul\u0000 Dental', email: 'n@x.example' });
    bad(reg, 'register');
  });

  it('is refused for API keys and /api/v1 as well, and leaves binary uploads alone', async () => {
    const k = await mkKey(acmeId, ['cases:read', 'cases:write']);
    bad(await api(app, k.key, 'GET', `/api/v1/cases?case_id=a${nul}`), 'v1');
    bad(await api(app, k.key, 'POST', '/api/cases', { caseId: 'a\u0000' }), 'key body');
    const made = await up.call('POST', '/api/cases', { caseId: `BIN-${Math.random().toString(36).slice(2, 6)}` });
    const init = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: made.json.case.id, name: 'U01.pts', size: 4 });
    expect(init.status).toBe(200);
    const chunk = await up.putChunk(init.json.fileId, 0, Buffer.from([0, 0, 0, 0]));
    expect(chunk.status).toBe(200);
  });
});

// =====================================================================================================================
// 9. Factory events: believable times and delivery only after shipping
// =====================================================================================================================
describe('factory events make sense', () => {
  const send = (events: unknown[]) => svcCall(app, svcKey, 'POST', '/api/mes/v1/events', { events });
  const row = async (id: string) => (await q('SELECT status, stage, shipped_at, delivered_at, carrier, tracking, aligners_shipped, started_at, received_at FROM cases WHERE id = $1', [id]))[0];
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it('refuses a time long before the case existed, or years old, and the same event can be sent again', async () => {
    const made = await readyStandardCase(up);
    const old = await send([{ event_id: `T-${made.ref}-1`, case_ref: made.ref, stage_code: 'PRINT', occurred_at: hoursAgo(72) }]);
    expect(old.json.results[0]).toEqual({ event_id: `T-${made.ref}-1`, outcome: 'error', message: 'The time is not plausible for this case.' });
    const years = await send([{ event_id: `T-${made.ref}-2`, case_ref: made.ref, stage_code: 'PRINT', occurred_at: '2019-03-01T10:00:00Z' }]);
    expect(years.json.results[0]).toMatchObject({ outcome: 'error', message: 'The time is not plausible for this case.' });
    expect((await row(made.id)).status).toBe('ready');
    // an error does not use up the event id
    const fixed = await send([{ event_id: `T-${made.ref}-1`, case_ref: made.ref, stage_code: 'PRINT', occurred_at: hoursAgo(2) }]);
    expect(fixed.json.results[0]).toEqual({ event_id: `T-${made.ref}-1`, outcome: 'applied' });
    expect((await row(made.id)).status).toBe('in_production');
    // the error is in the event log with its message
    const logged = await q(`SELECT outcome, message FROM mes_events WHERE message = 'The time is not plausible for this case.'`);
    expect(logged.length).toBeGreaterThanOrEqual(2);
  });

  it('allows a little clock difference (hours before the case) and treats the future as now', async () => {
    const made = await readyStandardCase(up);
    const a = await send([{ event_id: `C-${made.ref}-1`, case_ref: made.ref, stage_code: 'RECEIVED', occurred_at: hoursAgo(5) }]);
    expect(a.json.results[0].outcome).toBe('applied');
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const b = await send([{ event_id: `C-${made.ref}-2`, case_ref: made.ref, stage_code: 'PRINT', occurred_at: future }]);
    expect(b.json.results[0].outcome).toBe('applied');
    expect(new Date((await row(made.id)).started_at).getTime()).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('does not let DELIVERED skip SHIP, and delivers a shipped case', async () => {
    const made = await readyStandardCase(up);
    const early = await send([{ event_id: `D-${made.ref}-1`, case_ref: made.ref, stage_code: 'DELIVERED', occurred_at: new Date().toISOString() }]);
    expect(early.json.results[0]).toEqual({ event_id: `D-${made.ref}-1`, outcome: 'ignored', message: 'Send SHIP before DELIVERED.' });
    expect(await row(made.id)).toMatchObject({ status: 'ready', delivered_at: null, shipped_at: null, carrier: null, tracking: null });
    // after PRINT too
    await send([{ event_id: `D-${made.ref}-2`, case_ref: made.ref, stage_code: 'PRINT', occurred_at: new Date().toISOString() }]);
    const mid = await send([{ event_id: `D-${made.ref}-3`, case_ref: made.ref, stage_code: 'DELIVERED', occurred_at: new Date().toISOString() }]);
    expect(mid.json.results[0]).toMatchObject({ outcome: 'ignored', message: 'Send SHIP before DELIVERED.' });
    expect((await row(made.id)).status).toBe('in_production');
    // the manual update by K Line follows the same rule
    const manual = await klAdmin.call('POST', `/api/cases/${made.id}/stage`, { stage: 'delivered' });
    expect(manual.status).toBe(409);
    expect(manual.json.message).toBe('Send SHIP before DELIVERED.');
    // SHIP, then DELIVERED
    const ship = await send([{ event_id: `D-${made.ref}-4`, case_ref: made.ref, stage_code: 'SHIP', occurred_at: new Date().toISOString(), carrier: 'DHL', tracking_number: 'JD0146', aligners_shipped: 2 }]);
    expect(ship.json.results[0].outcome).toBe('applied');
    const done = await send([{ event_id: `D-${made.ref}-5`, case_ref: made.ref, stage_code: 'DELIVERED', occurred_at: new Date().toISOString() }]);
    expect(done.json.results[0]).toEqual({ event_id: `D-${made.ref}-5`, outcome: 'applied' });
    expect(await row(made.id)).toMatchObject({ status: 'delivered', carrier: 'DHL', tracking: 'JD0146', aligners_shipped: 2 });
    expect((await row(made.id)).shipped_at).not.toBeNull();
    expect((await row(made.id)).delivered_at).not.toBeNull();
  });

  it('CSV import follows the same rules', async () => {
    const made = await readyStandardCase(up);
    const csv = ['event_id,case_ref,stage_code,occurred_at,carrier,tracking_number,aligners_shipped', `,${made.ref},DELIVERED,${new Date().toISOString()},,,`, `,${made.ref},PRINT,2019-01-01T00:00:00Z,,,`].join('\n');
    const r = await klAdmin.call('POST', '/api/mes/events/import', { csv });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.results.map((x: any) => x.outcome)).toEqual(['ignored', 'error']);
    expect(r.json.results[0].message).toBe('Send SHIP before DELIVERED.');
    expect(r.json.results[1].message).toBe('The time is not plausible for this case.');
  });
});

describe('the factory intake leaves one audit entry per call', () => {
  it('writes one entry with the count and up to 20 references, no entry per case', async () => {
    const made = [] as Awaited<ReturnType<typeof readyStandardCase>>[];
    for (let i = 0; i < 3; i++) made.push(await readyStandardCase(up));
    const before = (await q(`SELECT coalesce(max(seq), 0)::int AS s FROM audit_log`))[0].s as number;
    const r = await svcCall(app, svcKey, 'GET', '/api/mes/v1/intake?site=PT-CHV&limit=100');
    expect(r.status).toBe(200);
    const listed = r.json.cases.map((c: any) => c.ref) as string[];
    for (const m of made) expect(listed).toContain(m.ref);
    const rows = await q(`SELECT org_id, target_type, target_id, details FROM audit_log WHERE seq > $1 AND action = 'mes.intake_read'`, [before]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: klineId, target_type: null, target_id: null });
    expect(rows[0]!.details).toMatchObject({ cases: listed.length, site: 'PT-CHV' });
    expect(rows[0]!.details.refs).toEqual(listed.slice(0, 20));
    // a second poll is one more entry, and an empty poll is one entry as well
    await svcCall(app, svcKey, 'GET', '/api/mes/v1/intake?site=PT-CHV&limit=1');
    await svcCall(app, svcKey, 'GET', '/api/mes/v1/intake?site=MX-TIJ');
    const all = await q(`SELECT details FROM audit_log WHERE seq > $1 AND action = 'mes.intake_read' ORDER BY seq`, [before]);
    expect(all).toHaveLength(3);
    expect(all[1]!.details).toMatchObject({ cases: 1 });
    expect(all[2]!.details).toMatchObject({ cases: 0, refs: [] });
    // the references are references only: no patient data
    expect(JSON.stringify(all)).not.toMatch(/Erin|Erasable|Quentin/);
  });

  it('lists at most 20 references however many cases there are', async () => {
    const cases = Array.from({ length: 22 }, (_, i) => `ACME-9${String(i).padStart(5, '0')}`);
    // the entry builder is exercised through the real call: create the cases directly so the test stays fast
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      const r = await q(
        `INSERT INTO cases (org_id, ref, partner_case_id, status, manufacturing_mode, site_id, ready_at, due_date)
         VALUES ($1, $2, $3, 'ready', 'standard', (SELECT id FROM sites WHERE code = 'PT-CHV'), now(), current_date + 3) RETURNING id`,
        [acmeId, cases[i], `BULK-${i}`],
      );
      ids.push(r[0].id);
    }
    const before = (await q(`SELECT coalesce(max(seq), 0)::int AS s FROM audit_log`))[0].s as number;
    const r = await svcCall(app, svcKey, 'GET', '/api/mes/v1/intake?site=PT-CHV&limit=200');
    expect(r.status).toBe(200);
    expect(r.json.cases.length).toBeGreaterThanOrEqual(22);
    const rows = await q(`SELECT details FROM audit_log WHERE seq > $1 AND action = 'mes.intake_read'`, [before]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details.cases).toBe(r.json.cases.length);
    expect(rows[0]!.details.refs).toHaveLength(20);
    await q(`DELETE FROM cases WHERE id = ANY($1::uuid[])`, [ids]);
  });
});

describe('the stage map', () => {
  it('refuses a code twice whatever its capitals, and needs a fresh authenticator code', async () => {
    const current = (await klAdmin.call('GET', '/api/mes/stage-map')).json.items as { code: string; target: string; note: string }[];
    expect(current.length).toBeGreaterThan(5);
    const dup = await klAdmin.call('PUT', '/api/mes/stage-map', { items: [...current, { code: current[0]!.code.toLowerCase(), target: 'ignore', note: '' }] });
    expect(dup.status).toBe(400);
    expect(dup.json.code).toBe('duplicate_code');
    expect((await klAdmin.call('GET', '/api/mes/stage-map')).json.items).toEqual(current); // nothing changed

    await expireStepUp('admin@kline.demo');
    const noStep = await klAdmin.call('PUT', '/api/mes/stage-map', { items: current });
    expect(noStep.status).toBe(403);
    expect(noStep.json.code).toBe('step_up_required');
    await klAdmin.stepUp('admin@kline.demo');
    const ok = await klAdmin.call('PUT', '/api/mes/stage-map', { items: current.map((x, i) => (i === 0 ? { ...x, code: x.code.toLowerCase() } : x)) });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.items.map((x: any) => x.code).sort()).toEqual(current.map((x) => x.code).sort());
    // reading it is still allowed without a fresh code
    await expireStepUp('admin@kline.demo');
    expect((await klAdmin.call('GET', '/api/mes/stage-map')).status).toBe(200);
    await klAdmin.stepUp('admin@kline.demo');
  });
});

// =====================================================================================================================
// 12. Smaller fixes
// =====================================================================================================================
describe('stock corrections', () => {
  it('never take the stock below zero at a site', async () => {
    const m = await admin.call('POST', '/api/materials', { sku: `NEG-${Math.random().toString(36).slice(2, 6)}`, name: 'Negative test box', category: 'box' });
    expect(m.status, JSON.stringify(m.json)).toBe(201);
    const materialId = m.json.material.id as string;
    const adjust = (quantity: number) => klAdmin.call('POST', '/api/console/materials/adjust', { orgId: acmeId, materialId, siteCode: 'PT-CHV', quantity, reason: 'Counted again' });
    const stockNow = async () => Number((await q(`SELECT coalesce(sum(quantity), 0) AS n FROM material_movements WHERE material_id = $1`, [materialId]))[0].n);

    const none = await adjust(-1);
    expect(none.status).toBe(409);
    expect(none.json.code).toBe('would_go_negative');
    expect(none.json.message).toMatch(/below zero/);
    expect(await stockNow()).toBe(0);
    expect((await adjust(10)).status).toBe(200);
    expect((await adjust(-4)).status).toBe(200);
    const tooMany = await adjust(-7);
    expect(tooMany.status).toBe(409);
    expect(tooMany.json.code).toBe('would_go_negative');
    expect(tooMany.json.message).toContain('6');
    expect(await stockNow()).toBe(6);
    expect((await adjust(-6)).status).toBe(200);
    expect(await stockNow()).toBe(0);
    // another site has its own stock: it does not borrow from PT-CHV
    const other = await klAdmin.call('POST', '/api/console/materials/adjust', { orgId: acmeId, materialId, siteCode: 'EG-CFZ', quantity: -1, reason: 'Counted again' });
    expect(other.json.code).toBe('would_go_negative');
    // a correction that adds stock is always fine, even when consumption already took the stock below zero
    await q(`INSERT INTO material_movements (org_id, material_id, site_id, kind, quantity) VALUES ($1, $2, (SELECT id FROM sites WHERE code = 'PT-CHV'), 'consumption', -3)`, [acmeId, materialId]);
    expect((await adjust(1)).status).toBe(200);
  });
});

describe('file names', () => {
  it('keeps the extension of a long name and does not answer 415', async () => {
    const made = await up.call('POST', '/api/cases', { caseId: `LN-${Math.random().toString(36).slice(2, 7)}` });
    const caseId = made.json.case.id as string;
    const name = 'a'.repeat(300) + '.stl';
    const r = await up.call('POST', '/api/uploads', { purpose: 'case', caseId, name, size: 100 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const stored = (await q('SELECT id, name_enc, ext, kind FROM files WHERE id = $1', [r.json.fileId]))[0];
    expect(fileName(stored)).toHaveLength(255);
    expect(fileName(stored).endsWith('.stl')).toBe(true);
    expect(stored).toMatchObject({ ext: 'stl', kind: 'stl' });
    // a name that is far too long is a plain 400
    const huge = await up.call('POST', '/api/uploads', { purpose: 'case', caseId, name: 'b'.repeat(700) + '.stl', size: 100 });
    expect(huge.status).toBe(400);
    // a really unknown type is still 415
    expect((await up.call('POST', '/api/uploads', { purpose: 'case', caseId, name: 'c'.repeat(300) + '.xyz', size: 100 })).status).toBe(415);
  });
});

describe('hidden text direction characters', () => {
  it('are refused in file names, team names, material names and claim text', async () => {
    const bidi = '\u202E';
    const made = await up.call('POST', '/api/cases', { caseId: `BD-${Math.random().toString(36).slice(2, 7)}` });
    const file = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: made.json.case.id, name: `photo${bidi}gnp.stl`, size: 100 });
    expect(file.status).toBe(400);
    expect(file.json.code).toBe('invalid_text');
    expect(file.json.message).toMatch(/direction/);
    expect((await admin.call('POST', '/api/team/invite', { email: 'bidi@acme.demo', name: `Eve${bidi}lE`, roles: ['viewer'] })).json.code).toBe('invalid_text');
    expect((await admin.call('POST', '/api/materials', { sku: 'BIDI-1', name: `Box${bidi}`, category: 'box' })).json.code).toBe('invalid_text');
    expect((await admin.call('POST', '/api/materials', { sku: `BIDI${bidi}2`, name: 'Box', category: 'box' })).status).toBe(400);
    const ok = await admin.call('POST', '/api/materials', { sku: `OK-${Math.random().toString(36).slice(2, 6)}`, name: 'Arabic عربي box', category: 'box' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect((await admin.call('PATCH', `/api/materials/${ok.json.material.id}`, { name: `Renamed${bidi}` })).json.code).toBe('invalid_text');
    expect((await klAdmin.call('POST', '/api/staff/invite', { email: 'bidi@kline.demo', name: `Kay${bidi}`, roles: ['kl_admin'] })).json.code).toBe('invalid_text');
  });

  it('are refused in specification clauses, while a normal edit is accepted', async () => {
    const quality = await new Client(app).full('quality@acme.demo');
    const draft = await quality.call('POST', '/api/specs', {});
    expect(draft.status, JSON.stringify(draft.json)).toBe(201);
    const id = draft.json.spec.id as string;
    const content = structuredClone(draft.json.spec.content);
    content.material.clauses[0].text = 'Use medical grade material';
    const ok = await quality.call('PUT', `/api/specs/${id}`, { content });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    for (const field of ['title', 'text'] as const) {
      const bad = structuredClone(content);
      bad.material.clauses[0][field] = `Medical‮grade`;
      const r = await quality.call('PUT', `/api/specs/${id}`, { content: bad });
      expect(r.status, field).toBe(400);
      expect(r.json.code, field).toBe('invalid_spec');
      expect(r.json.message, field).toMatch(/direction/);
    }
    // the draft still holds the good text
    expect((await quality.call('GET', `/api/specs/${id}`)).json.spec.content.material.clauses[0].text).toBe('Use medical grade material');
    await quality.call('DELETE', `/api/specs/${id}`);
  });
});

describe('quality claims', () => {
  let quality: Client;
  let shipped: Awaited<ReturnType<typeof readyStandardCase>>;

  beforeAll(async () => {
    quality = await new Client(app).full('quality@acme.demo');
    shipped = await readyStandardCase(up);
    const s = await klAdmin.call('POST', `/api/cases/${shipped.id}/stage`, { stage: 'shipped', carrier: 'DHL', trackingNumber: 'TRK-HARD-1', alignersShipped: 1 });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
  });

  it('refuses the same aligner with the same defect twice in one claim', async () => {
    const dup = await quality.call('POST', '/api/claims', {
      caseId: shipped.id, summary: 'Scratched', items: [{ arch: 'upper', step: 1, defectCode: 'SCRATCHES' }, { arch: 'upper', step: 1, defectCode: 'SCRATCHES', note: 'again' }],
    });
    expect(dup.status).toBe(400);
    expect(dup.json.code).toBe('duplicate_item');
    expect(dup.json.message).toMatch(/more than once/);
    expect((await q(`SELECT 1 FROM claims WHERE case_id = $1`, [shipped.id])).length).toBe(0);
    // one aligner with two different defects is fine
    const ok = await quality.call('POST', '/api/claims', {
      caseId: shipped.id, summary: 'Scratched and cloudy', items: [{ arch: 'upper', step: 1, defectCode: 'SCRATCHES' }, { arch: 'upper', step: 1, defectCode: 'TRANSPARENCY' }],
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.items).toHaveLength(2);
  });

  it('refuses hidden text direction characters in the summary, description, item notes and messages', async () => {
    const bidi = '\u2067';
    const base = { caseId: shipped.id, items: [{ arch: 'upper', step: 1, defectCode: 'CRACK' }] };
    for (const body of [
      { ...base, summary: `Cracked${bidi}` },
      { ...base, summary: 'Cracked', description: `Edge${bidi}` },
      { ...base, summary: 'Cracked', items: [{ arch: 'upper', step: 1, defectCode: 'CRACK', note: `Note${bidi}` }] },
    ]) {
      const r = await quality.call('POST', '/api/claims', body);
      expect(r.status).toBe(400);
      expect(r.json.code).toBe('invalid_text');
    }
    const claimId = (await q(`SELECT id FROM claims WHERE case_id = $1 LIMIT 1`, [shipped.id]))[0].id;
    const msg = await quality.call('POST', `/api/claims/${claimId}/messages`, { body: `Please look${bidi}` });
    expect(msg.status).toBe(400);
    expect(msg.json.code).toBe('invalid_text');
    expect((await quality.call('POST', `/api/claims/${claimId}/messages`, { body: 'Please look at it.' })).status).toBe(201);
  });
});

describe('case ID rules', () => {
  it('refuses two dots, and a dot or slash at the start or the end', async () => {
    for (const bad of ['a..b', '..', '.abc', 'abc.', '/abc', 'abc/', 'a/../b']) {
      const r = await up.call('POST', '/api/cases', { caseId: bad });
      expect(r.status, bad).toBe(400);
      expect(r.json.code, bad).toBe('invalid_case_id');
    }
    for (const ok of ['A.B', 'A/B', 'A-1.2/3']) {
      const r = await up.call('POST', '/api/cases', { caseId: `${ok}-${Math.random().toString(36).slice(2, 6)}` });
      expect(r.status, ok).toBe(201);
    }
    const made = await up.call('POST', '/api/cases', { caseId: `ID-${Math.random().toString(36).slice(2, 7)}` });
    expect((await up.call('PATCH', `/api/cases/${made.json.case.id}`, { caseId: 'x..y' })).json.code).toBe('invalid_case_id');
    expect((await up.call('PATCH', `/api/cases/${made.json.case.id}`, { caseId: '/x' })).json.code).toBe('invalid_case_id');
    expect((await up.call('PATCH', `/api/cases/${made.json.case.id}`, { caseId: 'x.y' })).status).toBe(200);
  });
});
