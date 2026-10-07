import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { insertCase } from '../src/services/cases';
import { setExportLimits } from '../src/services/exports';
import { runDueJobs } from '../src/worker';
import { Client, createDemoUser, cubeStl, orgIdOf } from './helpers';
import { api, csvObjects, mkKey, parseCsv, q } from './helpers6';

let app: FastifyInstance;
let acmeId: string;
let contosoId: string;
let klineId: string;
let admin: Client; // Acme admin (export.run, reveal_name, integration.manage)
let up: Client; // Acme uploader
let aq: Client; // Acme quality
let af: Client; // Acme finance (export.run, no reveal_name)
let av: Client; // Acme viewer
let contoso: Client; // second active partner
let owner: Client; // a partner that K Line has not approved yet
let klAdmin: Client;
let intake: Client;
let kf: Client; // K Line finance (export.run, no reveal_name)
let svcKey: string;

const NAME = 'Zelda Quimby'; // synthetic patient name that must never show up where names are not allowed
/** Runs every job that is due (runDueJobs alone stops after 100). */
const drain = () => runDueJobs(10_000);
/** Makes the last authenticator code count as just entered (the step up route itself is rate limited). */
const fresh = (email: string) => q(`UPDATE sessions SET step_up_at = now() WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE email = $1)`, [email]);
const auditOf = (orgId: string, action: string) => q(`SELECT * FROM audit_log WHERE org_id = $1 AND action = $2 ORDER BY seq`, [orgId, action]);
let counter = 0;
const uid = () => `P6-${Date.now().toString(36)}-${counter++}`;

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  klineId = await orgIdOf('KLINE');
  contosoId = await tx(SYSTEM, async (c) => (await c.query(`INSERT INTO organizations (kind, name, code, country, status) VALUES ('partner', 'Contoso Smile', 'CONTOSO', 'PT', 'active') RETURNING id`)).rows[0].id);
  await createDemoUser(contosoId, 'admin@contoso.demo', 'Cora Contoso', ['admin']);
  await q(`INSERT INTO agreements (org_id, type, signed_at, signed_by) VALUES ($1, 'dpa', current_date, 'Cora Contoso')`, [contosoId]);
  await createDemoUser(acmeId, 'viewer@acme.demo', 'Vic Viewer', ['viewer']);
  up = await new Client(app).full('upload@acme.demo');
  admin = await new Client(app).full('admin@acme.demo');
  aq = await new Client(app).full('quality@acme.demo');
  af = await new Client(app).full('finance@acme.demo');
  av = await new Client(app).full('viewer@acme.demo');
  contoso = await new Client(app).full('admin@contoso.demo');
  owner = await new Client(app).full('owner@contoso.demo');
  klAdmin = await new Client(app).full('admin@kline.demo');
  intake = await new Client(app).full('intake@kline.demo');
  kf = await new Client(app).full('finance@kline.demo');
  // a few cases in every state, with synthetic patient names
  await tx(SYSTEM, async (c) => {
    const make = async (caseId: string, name: string, status: string, site: string | null, extra: Record<string, unknown> = {}) => {
      const r = await insertCase(c, { orgId: acmeId, actor: { actorType: 'user', actorId: null }, mode: 'standard', caseId, patientName: name });
      await c.query(
        `UPDATE cases SET status = $2, stage = $3, hold_reason = $4, site_id = (SELECT id FROM sites WHERE code = $5), submitted_at = now(), ready_at = CASE WHEN $2 <> 'submitted' THEN now() END WHERE id = $1`,
        [r.id, status, extra.stage ?? null, extra.hold ?? null, site],
      );
    };
    await make('AC-1001', 'Marc Alonso', 'submitted', null);
    await make('AC-1002', 'Iris Petrov', 'on_hold', null, { hold: 'The trim line for the lower step 3 looks open.' });
    await make('AC-1003', 'Tomas Berg', 'ready', 'PT-CHV');
    await make('AC-1004', 'Lena Fischer', 'in_production', 'PT-CHV', { stage: 'thermoforming' });
    await make('AC-1005', 'Noor Haddad', 'cancelled', null);
  });
  const k = await klAdmin.call('POST', '/api/service-keys', { name: 'Phase 6 factory system', scopes: ['mes:intake', 'mes:files', 'mes:events'], expiresInDays: 30 });
  expect(k.status, JSON.stringify(k.json)).toBe(201);
  svcKey = k.json.key;
});

afterAll(async () => {
  setExportLimits();
  await app.close();
  await closePools();
});

// ---------------------------------------------------------------------------------------------------------------------
describe('API keys', () => {
  let created: { id: string; key: string; prefix: string; expiresAt: string };

  it('lists nothing secret and needs the right person', async () => {
    const r = await admin.call('GET', '/api/api-keys');
    expect(r.status).toBe(200);
    expect(r.json.scopes).toEqual(['cases:read', 'cases:write', 'patients:read', 'claims:read', 'materials:read']);
    expect(r.json.limits).toMatchObject({ maxActive: 20, maxCidrs: 20, maxExpiryDays: 730, defaultExpiryDays: 365 });
    expect(Array.isArray(r.json.items)).toBe(true);
    // the people without integration.manage, and K Line staff, get nothing
    for (const c of [up, aq, af, av]) expect((await c.call('GET', '/api/api-keys')).status).toBe(403);
    expect((await klAdmin.call('GET', '/api/api-keys')).status).toBe(403);
    expect((await intake.call('GET', '/api/api-keys')).status).toBe(403);
    expect((await api(app, null, 'GET', '/api/api-keys')).status).toBe(401);
  });

  it('creates a key with step up, shows it once, stores only a hash and audits it without the key', async () => {
    const body = { name: 'ERP production', scopes: ['cases:read', 'cases:write'], cidrs: ['203.0.113.0/24'], expiresInDays: 90 };
    await q(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE email = 'admin@acme.demo')`);
    const no = await admin.call('POST', '/api/api-keys', body);
    expect(no.status).toBe(403);
    expect(no.json.code).toBe('step_up_required');

    await fresh('admin@acme.demo');
    const r = await admin.call('POST', '/api/api-keys', body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    created = r.json;
    expect(created.key).toMatch(/^kph_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(created.prefix).toBe(created.key.slice(0, 16));
    const days = (new Date(created.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);

    // the secret is stored as a keyed hash only
    const row = (await q(`SELECT * FROM api_keys WHERE id = $1`, [created.id]))[0];
    const secret = created.key.slice(17);
    expect(row.secret_hash).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.org_id).toBe(acmeId);
    expect(row.cidrs).toEqual(['203.0.113.0/24']);

    // the list never shows it again
    const list = await admin.call('GET', '/api/api-keys');
    const item = list.json.items.find((x: any) => x.id === created.id);
    expect(item).toMatchObject({ name: 'ERP production', prefix: created.prefix, scopes: ['cases:read', 'cases:write'], cidrs: ['203.0.113.0/24'], status: 'active', createdByName: 'Alex Acme', lastUsedAt: null, revokedAt: null });
    expect(JSON.stringify(list.json)).not.toContain(secret);
    expect(JSON.stringify(list.json)).not.toContain('secret_hash');
    expect(item).not.toHaveProperty('key');

    const log = await auditOf(acmeId, 'api_key.created');
    const e = log.find((x) => x.target_id === created.id)!;
    expect(e.actor_type).toBe('user');
    expect(e.details).toMatchObject({ prefix: created.prefix, scopes: ['cases:read', 'cases:write'], cidrs: 1 });
    expect(JSON.stringify(e)).not.toContain(secret);
    expect(JSON.stringify(e)).not.toContain(row.secret_hash);
    // the partner reads it in its own access log
    const seen = await admin.call('GET', '/api/audit?action=api_key.created');
    expect(seen.json.entries.length).toBeGreaterThan(0);
  });

  it('checks the request', async () => {
    await fresh('admin@acme.demo');
    const post = (b: Record<string, unknown>) => admin.call('POST', '/api/api-keys', { name: 'x', scopes: ['cases:read'], expiresInDays: 30, ...b });
    expect((await post({ name: '' })).status).toBe(400);
    expect((await post({ name: 'n'.repeat(81) })).status).toBe(400);
    expect((await post({ scopes: [] })).status).toBe(400);
    expect((await post({ scopes: ['cases:read', 'nothing:here'] })).status).toBe(400);
    expect((await post({ scopes: ['mes:intake'] })).status).toBe(400); // a service scope is not a partner scope
    const dep = await post({ scopes: ['patients:read'] });
    expect(dep.status).toBe(400);
    expect(dep.json.code).toBe('scope_dependency');
    expect((await post({ scopes: ['patients:read', 'cases:read'] })).status).toBe(201);
    const bad = await post({ cidrs: ['not-an-ip'] });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('invalid_cidr');
    expect((await post({ cidrs: ['10.0.0.0/33'] })).json.code).toBe('invalid_cidr');
    expect((await post({ cidrs: Array.from({ length: 21 }, (_, i) => `10.0.${i}.0/24`) })).status).toBe(400);
    expect((await post({ expiresInDays: 0 })).status).toBe(400);
    expect((await post({ expiresInDays: 731 })).status).toBe(400);
    expect((await post({ expiresInDays: 730 })).status).toBe(201);
    // default expiry is a year
    const d = await post({ expiresInDays: undefined });
    expect(d.status).toBe(201);
    const days = (new Date(d.json.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(366);
    await q(`UPDATE api_keys SET revoked_at = now() WHERE org_id = $1 AND name = 'x'`, [acmeId]);
  });

  it('allows at most 20 active keys per company', async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM api_keys WHERE org_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [contosoId]))[0].n as number;
    for (let i = before; i < 20; i++) await mkKey(contosoId, ['cases:read']);
    await fresh('admin@contoso.demo');
    const r = await contoso.call('POST', '/api/api-keys', { name: 'one too many', scopes: ['cases:read'], expiresInDays: 30 });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('too_many_keys');
    // a revoked or expired key does not count
    const list = await contoso.call('GET', '/api/api-keys');
    await contoso.call('DELETE', `/api/api-keys/${list.json.items[0].id}`);
    const ok = await contoso.call('POST', '/api/api-keys', { name: 'fits now', scopes: ['cases:read'], expiresInDays: 30 });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    await q(`UPDATE api_keys SET revoked_at = now() WHERE org_id = $1`, [contosoId]);
  });

  it('is locked until K Line has approved the company, for changes only', async () => {
    await fresh('owner@contoso.demo');
    expect((await owner.call('GET', '/api/api-keys')).status).toBe(200);
    const r = await owner.call('POST', '/api/api-keys', { name: 'early', scopes: ['cases:read'], expiresInDays: 30 });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('org_not_approved');
    const w = await owner.call('POST', '/api/webhooks', { url: 'https://erp.partner-example.com/hook', events: ['case.shipped'] });
    expect(w.status).toBe(403);
    expect(w.json.code).toBe('org_not_approved');
    expect((await owner.call('GET', '/api/webhooks')).status).toBe(200);
  });

  it('works on the API until it is revoked, and revoking needs step up', async () => {
    const k = await mkKey(acmeId, ['cases:read']);
    expect((await api(app, k.key, 'GET', '/api/v1/cases?page_size=1')).status).toBe(200);
    await q(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE email = 'admin@acme.demo')`);
    const no = await admin.call('DELETE', `/api/api-keys/${k.id}`);
    expect(no.status).toBe(403);
    expect(no.json.code).toBe('step_up_required');
    expect((await api(app, k.key, 'GET', '/api/v1/cases?page_size=1')).status).toBe(200);
    await fresh('admin@acme.demo');
    expect((await admin.call('DELETE', `/api/api-keys/${k.id}`)).json).toEqual({ ok: true });
    const gone = await api(app, k.key, 'GET', '/api/v1/cases?page_size=1');
    expect(gone.status).toBe(401);
    expect(gone.json.code).toBe('invalid_api_key');
    const again = await admin.call('DELETE', `/api/api-keys/${k.id}`);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('already_revoked');
    const list = await admin.call('GET', '/api/api-keys');
    expect(list.json.items.find((x: any) => x.id === k.id)).toMatchObject({ status: 'revoked' });
    const log = await auditOf(acmeId, 'api_key.revoked');
    expect(log.find((x) => x.target_id === k.id)!.details).toMatchObject({ prefix: k.prefix, scopes: ['cases:read'] });
    expect(JSON.stringify(log)).not.toContain(k.key.slice(17));
    // a key that does not exist
    expect((await admin.call('DELETE', '/api/api-keys/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('stops working when it expires and shows as expired', async () => {
    const k = await mkKey(acmeId, ['cases:read']);
    expect((await api(app, k.key, 'GET', '/api/v1/cases?page_size=1')).status).toBe(200);
    await q(`UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1`, [k.id]);
    expect((await api(app, k.key, 'GET', '/api/v1/cases?page_size=1')).status).toBe(401);
    const list = await admin.call('GET', '/api/api-keys');
    expect(list.json.items.find((x: any) => x.id === k.id)).toMatchObject({ status: 'expired' });
  });

  it('honours the IP allow list, for IPv4, IPv6 and mapped addresses', async () => {
    const k = await mkKey(acmeId, ['cases:read'], { cidrs: ['203.0.113.0/24', '2001:db8::/32'] });
    const call = (ip: string) => api(app, k.key, 'GET', '/api/v1/cases?page_size=1', undefined, { ip });
    expect((await call('203.0.113.5')).status).toBe(200);
    expect((await call('::ffff:203.0.113.6')).status).toBe(200);
    expect((await call('2001:db8::77')).status).toBe(200);
    const no = await call('198.51.100.9');
    expect(no.status).toBe(401);
    expect(no.json.code).toBe('invalid_api_key'); // same answer as any other failure
    expect((await call('2001:db9::1')).status).toBe(401);
  });

  it('writes the last use at most once a minute, with the address', async () => {
    const k = await mkKey(acmeId, ['cases:read']);
    const row = async () => (await q(`SELECT last_used_at, last_used_ip, xmin::text AS x FROM api_keys WHERE id = $1`, [k.id]))[0];
    expect((await row()).last_used_at).toBeNull();
    expect((await api(app, k.key, 'GET', '/api/v1/cases?page_size=1', undefined, { ip: '203.0.113.50' })).status).toBe(200);
    const first = await row();
    expect(first.last_used_at).toBeTruthy();
    expect(first.last_used_ip).toBe('203.0.113.50');
    // a burst of parallel requests from other addresses writes nothing
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => api(app, k.key, 'GET', '/api/v1/cases?page_size=1', undefined, { ip: `203.0.113.${60 + i}` })));
    expect(burst.every((b) => b.status === 200)).toBe(true);
    const second = await row();
    expect(second.x).toBe(first.x);
    expect(second.last_used_ip).toBe('203.0.113.50');
    expect(new Date(second.last_used_at).getTime()).toBe(new Date(first.last_used_at).getTime());
    // after a minute the next request writes
    await q(`UPDATE api_keys SET last_used_at = now() - interval '2 minutes' WHERE id = $1`, [k.id]);
    expect((await api(app, k.key, 'GET', '/api/v1/cases?page_size=1', undefined, { ip: '203.0.113.99' })).status).toBe(200);
    const third = await row();
    expect(third.last_used_ip).toBe('203.0.113.99');
    expect(new Date(third.last_used_at).getTime()).toBeGreaterThan(Date.now() - 10_000);
    // the list shows it
    const list = await admin.call('GET', '/api/api-keys');
    expect(list.json.items.find((x: any) => x.id === k.id)).toMatchObject({ lastUsedIp: '203.0.113.99' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('API v1: access', () => {
  it('refuses session cookies, anonymous calls, bad keys and service keys', async () => {
    const k = await mkKey(acmeId, ['cases:read', 'cases:write']);
    // a fully signed in session is not accepted, with or without a CSRF token
    const cookie = admin.cookie;
    expect(cookie).toContain('kph_session=');
    const viaCookie = await api(app, null, 'GET', '/api/v1/cases', undefined, { cookie });
    expect(viaCookie.status).toBe(401);
    expect(viaCookie.json.code).toBe('api_key_required');
    expect((await api(app, null, 'POST', '/api/v1/cases', { case_id: uid() }, { cookie, headers: { 'x-csrf-token': admin.csrf } })).status).toBe(401);
    // the same session does work on the normal routes (the two ways do not mix)
    expect((await admin.call('GET', '/api/cases?pageSize=1')).status).toBe(200);
    // a key next to a cookie: the key decides, the cookie is not looked at
    const both = await api(app, k.key, 'GET', '/api/v1/cases?page_size=1', undefined, { cookie });
    expect(both.status).toBe(200);
    const asContoso = await api(app, k.key, 'GET', '/api/v1/cases?page_size=1', undefined, { cookie: contoso.cookie });
    expect(asContoso.json.items.every((c: any) => c.ref.startsWith('ACME-'))).toBe(true);

    expect((await api(app, null, 'GET', '/api/v1/cases')).json.code).toBe('api_key_required');
    expect((await api(app, 'kph_000000000000_' + 'a'.repeat(43), 'GET', '/api/v1/cases')).json.code).toBe('invalid_api_key');
    expect((await api(app, 'nonsense', 'GET', '/api/v1/cases')).json.code).toBe('invalid_api_key');
    // a K Line service key never reaches the partner API
    const svc = await api(app, svcKey, 'GET', '/api/v1/cases');
    expect(svc.status).toBe(403);
    expect(svc.json.code).toBe('wrong_key_type');
    expect((await api(app, svcKey, 'GET', '/api/v1/shipments?from=2026-01-01&to=2026-01-02')).status).toBe(403);
    expect((await api(app, svcKey, 'POST', '/api/v1/cases', { case_id: 'x' })).status).toBe(403);
    // unknown paths under /api/v1 need a key too, and then are plain 404s
    expect((await api(app, null, 'GET', '/api/v1/nothing')).status).toBe(401);
    expect((await api(app, k.key, 'GET', '/api/v1/nothing')).json.code).toBe('not_found');
  });

  it('keeps partner keys out of the factory API, the console and the people only routes', async () => {
    const k = await mkKey(acmeId, ['cases:read', 'cases:write', 'patients:read', 'claims:read', 'materials:read']);
    for (const [m, u, b] of [
      ['GET', '/api/mes/v1/intake'],
      ['GET', '/api/mes/v1/stage-map'],
      ['POST', '/api/mes/v1/events', { events: [] }],
      ['GET', '/api/mes/v1/files/00000000-0000-4000-8000-000000000000'],
      ['POST', '/api/mes/v1/cases/ACME-000001/ack', { mes_case_id: 'X1' }],
      ['GET', '/api/mes/stage-map'],
      ['GET', '/api/service-keys'],
      ['GET', '/api/console/overview'],
      ['GET', '/api/console/cases'],
      ['GET', '/api/console/claims'],
      ['GET', '/api/api-keys'],
      ['POST', '/api/api-keys', { name: 'x', scopes: ['cases:read'], expiresInDays: 30 }],
      ['GET', '/api/webhooks'],
      ['POST', '/api/webhooks', { url: 'https://erp.partner-example.com/h', events: ['case.shipped'] }],
      ['GET', '/api/exports/cases.csv?from=2026-01-01&to=2026-01-31'],
      ['GET', '/api/exports/shipments.csv?from=2026-01-01&to=2026-01-31'],
      ['GET', '/api/account/notifications'],
      ['GET', '/api/team'],
      ['GET', '/api/notifications'],
    ] as [string, string, unknown?][]) {
      const r = await api(app, k.key, m, u, b);
      expect(r.status, `${m} ${u}`).toBe(403);
    }
    // and the service key reaches none of the partner routes
    for (const [m, u] of [['GET', '/api/cases'], ['GET', '/api/claims'], ['GET', '/api/materials'], ['POST', '/api/uploads'], ['GET', '/api/api-keys'], ['GET', '/api/webhooks'], ['GET', '/api/exports/cases.csv?from=2026-01-01&to=2026-01-31']] as [string, string][]) {
      const r = await api(app, svcKey, m, u, m === 'POST' ? {} : undefined);
      expect([400, 403], `${m} ${u} ${r.status}`).toContain(r.status);
      if (m === 'GET') expect(r.status, `${m} ${u}`).toBe(403);
    }
  });

  it('answers with a request id, rate limit headers and the standard error body', async () => {
    const k = await mkKey(acmeId, ['cases:read']);
    const r = await api(app, k.key, 'GET', '/api/v1/cases?page_size=1');
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(r.headers['x-ratelimit-limit'])).toBeGreaterThan(0);
    expect(r.headers['x-ratelimit-remaining']).toBeDefined();
    const echoed = await api(app, k.key, 'GET', '/api/v1/cases?page_size=1', undefined, { headers: { 'x-request-id': 'erp-request-12345' } });
    expect(echoed.headers['x-request-id']).toBe('erp-request-12345');
    const evil = await api(app, k.key, 'GET', '/api/v1/cases?page_size=1', undefined, { headers: { 'x-request-id': 'bad id\twith spaces' } });
    expect(evil.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const bad = await api(app, k.key, 'GET', '/api/v1/cases?page_size=500');
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.json).sort()).toEqual(['code', 'fields', 'message']);
    expect(bad.headers['x-request-id']).toBeTruthy();
    expect(bad.headers['cache-control']).toBe('no-store');
  });

  it('checks the scope of every endpoint', async () => {
    const r = await mkKey(acmeId, ['cases:read']);
    const w = await mkKey(acmeId, ['cases:write']);
    const c = await mkKey(acmeId, ['claims:read']);
    const m = await mkKey(acmeId, ['materials:read']);
    const none = async (key: string, method: string, url: string, body?: unknown) => {
      const x = await api(app, key, method, url, body);
      return [x.status, x.json?.code];
    };
    expect(await none(r.key, 'POST', '/api/v1/cases', { case_id: uid() })).toEqual([403, 'insufficient_scope']);
    expect(await none(r.key, 'POST', '/api/v1/cases/ACME-000001/files', { name: 'U01.stl', size: 10 })).toEqual([403, 'insufficient_scope']);
    expect(await none(r.key, 'POST', '/api/v1/cases/ACME-000001/submit', {})).toEqual([403, 'insufficient_scope']);
    expect(await none(w.key, 'GET', '/api/v1/cases')).toEqual([403, 'insufficient_scope']);
    expect(await none(w.key, 'GET', '/api/v1/cases/ACME-000001')).toEqual([403, 'insufficient_scope']);
    expect(await none(w.key, 'GET', '/api/v1/files/00000000-0000-4000-8000-000000000000')).toEqual([403, 'insufficient_scope']);
    expect(await none(w.key, 'GET', '/api/v1/shipments?from=2026-01-01&to=2026-01-02')).toEqual([403, 'insufficient_scope']);
    expect(await none(r.key, 'GET', '/api/v1/claims')).toEqual([403, 'insufficient_scope']);
    expect(await none(r.key, 'GET', '/api/v1/materials')).toEqual([403, 'insufficient_scope']);
    expect(await none(c.key, 'GET', '/api/v1/claims')).toEqual([200, undefined]);
    expect(await none(c.key, 'GET', '/api/v1/materials')).toEqual([403, 'insufficient_scope']);
    expect(await none(m.key, 'GET', '/api/v1/materials')).toEqual([200, undefined]);
    expect(await none(m.key, 'GET', '/api/v1/cases')).toEqual([403, 'insufficient_scope']);
    // the upload routes check the write permission in the same way
    expect((await api(app, r.key, 'POST', '/api/uploads', { purpose: 'case', caseId: '00000000-0000-4000-8000-000000000000', name: 'U01.stl', size: 10 })).status).toBe(403);
    expect((await api(app, r.key, 'PUT', '/api/uploads/00000000-0000-4000-8000-000000000000/chunks/0', Buffer.from('x'), { headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': 'a'.repeat(64) } })).status).toBe(403);
    // claims:read gives no case access through the normal routes either
    expect((await api(app, c.key, 'GET', '/api/cases')).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('API v1: cases, files and submit', () => {
  let rw: string; // cases:read + cases:write
  let rwp: string; // plus patients:read
  let caseRef: string;
  let caseKey: string; // the partner's own case ID
  let fileId: string;

  beforeAll(async () => {
    rw = (await mkKey(acmeId, ['cases:read', 'cases:write'])).key;
    rwp = (await mkKey(acmeId, ['cases:read', 'cases:write', 'patients:read'])).key;
  });

  it('creates a draft case and refuses bad input', async () => {
    caseKey = uid();
    const r = await api(app, rw, 'POST', '/api/v1/cases', { case_id: caseKey, patient_name: NAME, instructions: 'Zelda Quimby wants attachments.', priority: 'rush' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    caseRef = r.json.ref;
    expect(r.json).toMatchObject({
      case_id: caseKey, status: 'draft', simple_status: 'draft', stage: null, stage_label: null, kind: 'new', mode: 'standard', priority: 'rush', brand: null, site: null,
      hold_reason: null, aligners: { upper: 0, lower: 0, templates: 0, shipped: 0 }, carrier: null, tracking_number: null, warnings_acknowledged: false, parent_ref: null,
    });
    expect(caseRef).toMatch(/^ACME-\d{6}$/);
    expect(r.json.created_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(r.json.checks).toEqual({ errors: [], warnings: [] });
    // the answer never echoes the name, and there is no patient key at all
    expect(r.json).not.toHaveProperty('patient');
    expect(JSON.stringify(r.json)).not.toContain('Quimby');
    expect(r.json).not.toHaveProperty('portal'); // standard cases have no portal block
    // created by the key, in the partner's log
    const log = (await auditOf(acmeId, 'case.created')).filter((e) => e.details.ref === caseRef);
    expect(log[0].actor_type).toBe('api_key');

    const dup = await api(app, rw, 'POST', '/api/v1/cases', { case_id: caseKey.toLowerCase() });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe('case_id_exists');
    expect((await api(app, rw, 'POST', '/api/v1/cases', {})).json.code).toBe('identifier_required');
    expect((await api(app, rw, 'POST', '/api/v1/cases', { case_id: 'bad;id' })).json.code).toBe('invalid_case_id');
    expect((await api(app, rw, 'POST', '/api/v1/cases', { case_id: uid(), instructions: 'x'.repeat(8001) })).status).toBe(400);
    expect((await api(app, rw, 'POST', '/api/v1/cases', { case_id: uid(), priority: 'urgent' })).status).toBe(400);
    expect((await api(app, rw, 'POST', '/api/v1/cases', { case_id: uid(), brand: 'No such brand' })).json.code).toBe('invalid_brand');
    // a known brand is found by name, in any case
    await q(`INSERT INTO brands (org_id, name) VALUES ($1, 'Smile Line')`, [acmeId]);
    const b = await api(app, rw, 'POST', '/api/v1/cases', { case_id: uid(), brand: 'smile line' });
    expect(b.status).toBe(201);
    expect(b.json.brand).toBe('Smile Line');
    // a patient name alone is enough
    expect((await api(app, rw, 'POST', '/api/v1/cases', { patient_name: 'Only Name' })).status).toBe(201);
  });

  it('runs the whole chunked upload with a key, including resume and checksum checks', async () => {
    const data = cubeStl(50, 'v1 model');
    const reg = await api(app, rw, 'POST', `/api/v1/cases/${caseRef}/files`, { name: 'U01.stl', size: data.length });
    expect(reg.status, JSON.stringify(reg.json)).toBe(200);
    expect(reg.json).toMatchObject({ chunk_size: 8388608, chunk_count: 1, received: [], state: 'uploading' });
    fileId = reg.json.file_id;
    const put = (id: string, idx: number, buf: Buffer, sha?: string) =>
      api(app, rw, 'PUT', `/api/uploads/${id}/chunks/${idx}`, buf, { headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha ?? createHash('sha256').update(buf).digest('hex') } });
    // complete before anything arrived
    const early = await api(app, rw, 'POST', `/api/uploads/${fileId}/complete`, {});
    expect(early.status).toBe(409);
    expect(early.json.code).toBe('upload_incomplete');
    // a damaged chunk
    const bad = await put(fileId, 0, data, 'f'.repeat(64));
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe('checksum_mismatch');
    expect((await put(fileId, 0, data)).json).toEqual({ received: 1 });
    // registering again resumes
    const again = await api(app, rw, 'POST', `/api/v1/cases/${caseRef}/files`, { name: 'U01.stl', size: data.length });
    expect(again.json).toMatchObject({ file_id: fileId, received: [0] });
    expect((await api(app, rw, 'POST', `/api/uploads/${fileId}/complete`, {})).json).toEqual({ state: 'processing' });
    // still processing, then ready, with the canonical name and checksum
    const before = await api(app, rw, 'GET', `/api/v1/files/${fileId}`);
    expect(before.status).toBe(200);
    expect(before.json.state).toBe('processing');
    await drain();
    const done = await api(app, rw, 'GET', `/api/v1/files/${fileId}`);
    expect(done.json).toMatchObject({ id: fileId, name: 'upper/U01.stl', kind: 'stl', arch: 'upper', step: 1, template: false, state: 'ready', case_ref: caseRef, size: data.length, errors: [], warnings: [] });
    expect(done.json.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    // the upload is recorded against the key
    const up = (await auditOf(acmeId, 'file.uploaded')).filter((e) => e.target_id === fileId);
    expect(up[0].actor_type).toBe('api_key');
  });

  it('uploads a file of two chunks', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 5000, 'k');
    const reg = await api(app, rw, 'POST', `/api/v1/cases/${caseKey}/files`, { name: 'notes.txt', size: big.length, arch: null, step: null });
    expect(reg.status, JSON.stringify(reg.json)).toBe(200);
    expect(reg.json).toMatchObject({ chunk_count: 2, received: [] });
    const id = reg.json.file_id;
    const put = (idx: number) => {
      const part = big.subarray(idx * reg.json.chunk_size, (idx + 1) * reg.json.chunk_size);
      return api(app, rw, 'PUT', `/api/uploads/${id}/chunks/${idx}`, part, { headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': createHash('sha256').update(part).digest('hex') } });
    };
    expect((await put(1)).status).toBe(200); // any order
    expect((await api(app, rw, 'POST', `/api/uploads/${id}/complete`, {})).json.code).toBe('upload_incomplete');
    expect((await put(0)).json).toEqual({ received: 2 });
    expect((await api(app, rw, 'POST', `/api/uploads/${id}/complete`, {})).status).toBe(200);
    await drain();
    const f = await api(app, rw, 'GET', `/api/v1/files/${id}`);
    expect(f.json).toMatchObject({ state: 'ready', name: 'other/document.txt', kind: 'other', arch: null, step: null, size: big.length });
  });

  it('shows the case with canonical file names and fixed event wording, without names', async () => {
    const r = await api(app, rw, 'GET', `/api/v1/cases/${encodeURIComponent(caseKey)}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.ref).toBe(caseRef);
    expect(r.json.files.map((f: any) => f.name)).toEqual(['upper/U01.stl', 'other/document.txt']);
    expect(r.json.files[0]).toMatchObject({ kind: 'stl', arch: 'upper', step: 1, template: false, state: 'ready' });
    expect(r.json.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json.events[0]).toMatchObject({ type: 'created', message: 'Case created.', source: 'Partner', stage: null });
    expect(r.json).not.toHaveProperty('patient');
    // neither the partner's file names nor the typed text come back
    const text = JSON.stringify(r.json);
    expect(text).not.toContain('notes.txt');
    expect(text).not.toContain('Quimby');
    expect(text).not.toContain('v1 model');
    expect(r.json.counts ?? r.json.aligners).toMatchObject({ upper: 1 });
    // by reference works too, in any case
    expect((await api(app, rw, 'GET', `/api/v1/cases/${caseRef.toLowerCase()}`)).json.ref).toBe(caseRef);
    expect((await api(app, rw, 'GET', '/api/v1/cases/ACME-999999')).status).toBe(404);
    expect((await api(app, rw, 'GET', '/api/v1/cases/no-such-case')).status).toBe(404);
  });

  it('submits the case and moves it along', async () => {
    const ok = await api(app, rw, 'POST', `/api/v1/cases/${caseRef}/submit`, {});
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ ref: caseRef, status: 'ready', simple_status: 'submitted', site: 'PT-CHV' });
    expect(ok.json.ready_at).toBeTruthy();
    expect(ok.json.due_date).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(ok.json.expected_ship_date).toBe(ok.json.due_date);
    const again = await api(app, rw, 'POST', `/api/v1/cases/${caseRef}/submit`, {});
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('case_not_open');
    // files can no longer be added
    const late = await api(app, rw, 'POST', `/api/v1/cases/${caseRef}/files`, { name: 'U02.stl', size: 100 });
    expect(late.status).toBe(409);
    // the audit says the key submitted it
    const log = (await auditOf(acmeId, 'case.submitted')).filter((e) => e.details.ref === caseRef);
    expect(log[0].actor_type).toBe('api_key');
  });

  it('submits with warnings, which are reported in snake_case and stored when acknowledged', async () => {
    // U01 without its trim line is fine, but a missing step warns: upload U01 and U03
    const c = await api(app, rw, 'POST', '/api/v1/cases', { case_id: uid() });
    for (const name of ['U01.stl', 'U03.stl']) {
      const data = cubeStl(50, name);
      const reg = await api(app, rw, 'POST', `/api/v1/cases/${c.json.ref}/files`, { name, size: data.length });
      await api(app, rw, 'PUT', `/api/uploads/${reg.json.file_id}/chunks/0`, data, { headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': createHash('sha256').update(data).digest('hex') } });
      await api(app, rw, 'POST', `/api/uploads/${reg.json.file_id}/complete`, {});
    }
    await drain();
    const pre = await api(app, rw, 'GET', `/api/v1/cases/${c.json.ref}`);
    expect(pre.json.checks.warnings.map((x: any) => x.code)).toContain('missing_steps');
    for (const x of pre.json.checks.warnings) expect(Object.keys(x).every((k) => !/[A-Z]/.test(k))).toBe(true);
    const ok = await api(app, rw, 'POST', `/api/v1/cases/${c.json.ref}/submit`, { acknowledge_warnings: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.warnings_acknowledged).toBe(true);
    expect(ok.json.checks.warnings.length).toBeGreaterThan(0);
  });

  it('lists cases with pagination and filters', async () => {
    const total = (await q(`SELECT count(*)::int AS n FROM cases WHERE org_id = $1`, [acmeId]))[0].n as number;
    const p1 = await api(app, rw, 'GET', '/api/v1/cases?page_size=2');
    expect(p1.status).toBe(200);
    expect(p1.json).toMatchObject({ total, page: 1, page_size: 2 });
    expect(p1.json.items).toHaveLength(2);
    const p2 = await api(app, rw, 'GET', '/api/v1/cases?page_size=2&page=2');
    expect(p2.json.page).toBe(2);
    expect(p2.json.items.map((x: any) => x.ref)).not.toEqual(p1.json.items.map((x: any) => x.ref));
    const all: string[] = [];
    for (let page = 1; page <= Math.ceil(total / 100); page++) all.push(...(await api(app, rw, 'GET', `/api/v1/cases?page_size=100&page=${page}`)).json.items.map((x: any) => x.ref));
    expect(new Set(all).size).toBe(total);
    expect((await api(app, rw, 'GET', '/api/v1/cases?page_size=0')).status).toBe(400);
    expect((await api(app, rw, 'GET', '/api/v1/cases?page_size=101')).status).toBe(400);
    expect((await api(app, rw, 'GET', '/api/v1/cases?page=0')).status).toBe(400);

    // filters
    const byStatus = await api(app, rw, 'GET', '/api/v1/cases?status=ready&page_size=100');
    expect(byStatus.json.items.length).toBeGreaterThan(0);
    expect(byStatus.json.items.every((x: any) => x.status === 'ready')).toBe(true);
    const simple = await api(app, rw, 'GET', '/api/v1/cases?simple_status=submitted&page_size=100');
    expect(simple.json.items.every((x: any) => x.simple_status === 'submitted')).toBe(true);
    expect(simple.json.items.map((x: any) => x.status).sort()).toEqual(expect.arrayContaining(['ready', 'on_hold', 'submitted']));
    const prod = await api(app, rw, 'GET', '/api/v1/cases?simple_status=production&page_size=100');
    expect(prod.json.items.every((x: any) => ['received', 'in_production'].includes(x.status))).toBe(true);
    expect((await api(app, rw, 'GET', '/api/v1/cases?simple_status=nonsense')).status).toBe(400);
    expect((await api(app, rw, 'GET', '/api/v1/cases?status=nonsense')).status).toBe(400);
    const byId = await api(app, rw, 'GET', `/api/v1/cases?case_id=${encodeURIComponent(caseKey.toLowerCase())}`);
    expect(byId.json.items.map((x: any) => x.ref)).toEqual([caseRef]);
    const direct = await api(app, rw, 'GET', '/api/v1/cases?mode=direct');
    expect(direct.json.items.every((x: any) => x.mode === 'direct')).toBe(true);
    expect((await api(app, rw, 'GET', '/api/v1/cases?mode=standard&page_size=100')).json.items.every((x: any) => x.mode === 'standard')).toBe(true);
    expect((await api(app, rw, 'GET', '/api/v1/cases?from=2026-13-01')).status).toBe(400);
    expect((await api(app, rw, 'GET', '/api/v1/cases?from=yesterday')).status).toBe(400);
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await api(app, rw, 'GET', `/api/v1/cases?from=${yesterday}&to=${tomorrow}&case_id=${encodeURIComponent(caseKey)}`)).json.total).toBe(1);
    expect((await api(app, rw, 'GET', `/api/v1/cases?from=${tomorrow}&case_id=${encodeURIComponent(caseKey)}`)).json.total).toBe(0);
    expect((await api(app, rw, 'GET', `/api/v1/cases?to=${yesterday}&case_id=${encodeURIComponent(caseKey)}`)).json.total).toBe(0);
    expect(today).toBeTruthy();
    // updated_since: oldest change first, for incremental syncing
    const since = new Date(Date.now() - 60_000).toISOString();
    const upd = await api(app, rw, 'GET', `/api/v1/cases?updated_since=${encodeURIComponent(since)}&page_size=100`);
    expect(upd.json.items.some((x: any) => x.ref === caseRef)).toBe(true);
    const times = upd.json.items.map((x: any) => x.updated_at);
    expect([...times].sort()).toEqual(times);
    expect((await api(app, rw, 'GET', `/api/v1/cases?updated_since=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`)).json.total).toBe(0);
    expect((await api(app, rw, 'GET', '/api/v1/cases?updated_since=soon')).status).toBe(400);
  });

  it('shows names only to keys with patients:read, and audits every reveal', async () => {
    const plain = await api(app, rw, 'GET', `/api/v1/cases?case_id=${encodeURIComponent(caseKey)}`);
    expect(plain.json.items[0]).not.toHaveProperty('patient');
    expect(JSON.stringify(plain.json)).not.toMatch(/Zelda|Quimby|patient/);
    const allPlain = await api(app, rw, 'GET', '/api/v1/cases?page_size=100');
    expect(JSON.stringify(allPlain.json)).not.toMatch(/Zelda|Quimby|Marc Alonso|"patient"/);
    const detailPlain = await api(app, rw, 'GET', `/api/v1/cases/${caseRef}`);
    expect(JSON.stringify(detailPlain.json)).not.toMatch(/Zelda|Quimby|"patient"/);
    expect(await auditOf(acmeId, 'case.names_revealed')).toHaveLength(0);

    const named = await api(app, rwp, 'GET', `/api/v1/cases?case_id=${encodeURIComponent(caseKey)}`);
    expect(named.json.items[0].patient).toEqual({ first_name: null, last_name: null, name: NAME });
    const bulk = await auditOf(acmeId, 'case.names_revealed');
    expect(bulk).toHaveLength(1);
    expect(bulk[0].actor_type).toBe('api_key');
    expect(bulk[0].details).toMatchObject({ via: 'api_v1_list', count: 1, refs: [caseRef] });
    expect(JSON.stringify(bulk[0])).not.toMatch(/Zelda|Quimby/);

    const before = (await auditOf(acmeId, 'case.name_revealed')).length;
    const d = await api(app, rwp, 'GET', `/api/v1/cases/${caseRef}`);
    expect(d.json.patient.name).toBe(NAME);
    const after = await auditOf(acmeId, 'case.name_revealed');
    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1]).toMatchObject({ actor_type: 'api_key', target_id: (await q(`SELECT id FROM cases WHERE ref = $1`, [caseRef]))[0].id });
    expect(after[after.length - 1].details).toMatchObject({ ref: caseRef, via: 'api_v1' });
    // a whole page of named cases is one bulk entry with the number of names
    const page = await api(app, rwp, 'GET', '/api/v1/cases?page_size=100');
    const withNames = page.json.items.filter((x: any) => x.patient && x.patient.name).length;
    expect(withNames).toBeGreaterThan(3);
    const last = (await auditOf(acmeId, 'case.names_revealed')).pop()!;
    expect(last.details.count).toBe(withNames);
    // the partner reads it in its own access log
    const seen = await admin.call('GET', '/api/audit?action=case.names_revealed');
    expect(seen.json.entries[0]).toMatchObject({ action: 'case.names_revealed', actorType: 'api_key', actorLabel: 'API key' });
    // the normal reveal route stays audited as before
    expect((await api(app, rwp, 'POST', `/api/cases/${(await q(`SELECT id FROM cases WHERE ref = $1`, [caseRef]))[0].id}/reveal-name`, {})).status).toBe(200);
  });

  it('keeps one company away from another', async () => {
    const other = (await mkKey(contosoId, ['cases:read', 'cases:write', 'patients:read'])).key;
    expect((await api(app, other, 'GET', `/api/v1/cases/${caseRef}`)).status).toBe(404);
    expect((await api(app, other, 'GET', `/api/v1/cases/${encodeURIComponent(caseKey)}`)).status).toBe(404);
    expect((await api(app, other, 'POST', `/api/v1/cases/${caseRef}/submit`, {})).status).toBe(404);
    expect((await api(app, other, 'POST', `/api/v1/cases/${caseRef}/files`, { name: 'U02.stl', size: 100 })).status).toBe(404);
    expect((await api(app, other, 'GET', `/api/v1/files/${fileId}`)).status).toBe(404);
    const list = await api(app, other, 'GET', '/api/v1/cases?page_size=100');
    expect(list.json.total).toBe(0);
    expect(list.json.items).toEqual([]);
    // their own cases are theirs
    const mine = await api(app, other, 'POST', '/api/v1/cases', { case_id: caseKey });
    expect(mine.status).toBe(201); // the same partner case ID is fine for another company
    expect(mine.json.ref).toMatch(/^CONTOSO-/);
    // chunks and completion of another company's upload read as not found
    expect((await api(app, rw, 'POST', `/api/v1/cases/${uid()}/files`, { name: 'U01.stl', size: 100 })).status).toBe(404);
    const draft = await api(app, rw, 'POST', '/api/v1/cases', { case_id: uid() });
    const r2 = await api(app, rw, 'POST', `/api/v1/cases/${draft.json.ref}/files`, { name: 'U01.stl', size: 100 });
    expect(r2.status).toBe(200);
    expect((await api(app, other, 'PUT', `/api/uploads/${r2.json.file_id}/chunks/0`, Buffer.alloc(100), { headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': createHash('sha256').update(Buffer.alloc(100)).digest('hex') } })).status).toBe(404);
    expect((await api(app, other, 'POST', `/api/uploads/${r2.json.file_id}/complete`, {})).status).toBe(404);
    // the rows are invisible to the other company in the database as well
    const n = await tx({ orgId: contosoId, bypass: false }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM cases WHERE org_id = $1`, [acmeId])).rows[0].n);
    expect(n).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('API v1: shipments for invoicing', () => {
  let rk: string;
  const made: Record<string, string> = {};

  /** A shipped case with an exact shipping time. */
  async function shipped(label: string, shippedAt: string, o: { mode?: 'standard' | 'direct'; status?: string; upper?: number; lower?: number; templates?: number; shipped?: number; carrier?: string | null; tracking?: string | null; org?: string } = {}) {
    const org = o.org ?? acmeId;
    const id = await tx(SYSTEM, async (c) => {
      const pid = uid();
      const r =
        o.mode === 'direct'
          ? await insertCase(c, { orgId: org, actor: { actorType: 'user', actorId: null }, mode: 'direct', caseId: pid, firstName: 'Zelda', lastName: 'Quimby' })
          : await insertCase(c, { orgId: org, actor: { actorType: 'user', actorId: null }, mode: 'standard', caseId: pid });
      await c.query(
        `UPDATE cases SET status = $2, shipped_at = $3, carrier = $4, tracking = $5, aligners_shipped = $6, aligners_upper = $7, aligners_lower = $8, aligners_templates = $9,
                site_id = (SELECT id FROM sites WHERE code = 'PT-CHV'), kind = 'new', submitted_at = $3::timestamptz - interval '5 days' WHERE id = $1`,
        [r.id, o.status ?? 'shipped', shippedAt, o.carrier === undefined ? 'DHL' : o.carrier, o.tracking === undefined ? 'TRK' + label : o.tracking, o.shipped ?? 10, o.upper ?? 6, o.lower ?? 5, o.templates ?? 1],
      );
      made[label] = r.ref;
      return r.id;
    });
    return id;
  }

  beforeAll(async () => {
    rk = (await mkKey(acmeId, ['cases:read'])).key;
    // Berlin is UTC+1 until 29 March 2026 and UTC+2 from then on
    await shipped('A', '2026-03-14T23:30:00Z'); // 15 March 00:30 in Berlin
    await shipped('B', '2026-03-15T22:59:59Z'); // 15 March 23:59:59 in Berlin
    await shipped('C', '2026-03-15T23:00:00Z'); // 16 March 00:00 in Berlin
    await shipped('D', '2026-06-30T21:59:59Z'); // 30 June 23:59:59 in Berlin (summer time)
    await shipped('E', '2026-06-30T22:00:00Z'); // 1 July 00:00 in Berlin
    await shipped('F', '2026-03-20T10:00:00Z', { status: 'delivered', shipped: 7 });
    await shipped('G', '2026-03-20T11:00:00Z', { mode: 'direct', shipped: 0, upper: 8, lower: 9 }); // the portal gives no count
    await shipped('H', '2026-03-20T12:00:00Z', { status: 'cancelled' }); // never shipped
    await shipped('I', '2026-03-20T13:00:00Z', { org: contosoId }); // another company
    await shipped('J', '2026-03-21T13:00:00Z', { carrier: null, tracking: null, shipped: 3 });
  });

  const refs = (r: any) => r.json.items.map((i: any) => i.ref);

  it('picks cases by shipping date in Berlin time', async () => {
    const day = async (from: string, to = from) => api(app, rk, 'GET', `/api/v1/shipments?from=${from}&to=${to}`);
    const d15 = await day('2026-03-15');
    expect(d15.status, JSON.stringify(d15.json)).toBe(200);
    expect(refs(d15)).toEqual([made.A, made.B]);
    expect(refs(await day('2026-03-14'))).toEqual([]);
    expect(refs(await day('2026-03-16'))).toEqual([made.C]);
    expect(refs(await day('2026-03-15', '2026-03-16'))).toEqual([made.A, made.B, made.C]);
    // summer time
    expect(refs(await day('2026-06-30'))).toEqual([made.D]);
    expect(refs(await day('2026-07-01'))).toEqual([made.E]);
    // a single day or a long period
    const wide = await day('2026-03-01', '2026-07-31');
    expect(refs(wide)).toEqual([made.A, made.B, made.C, made.F, made.G, made.J, made.D, made.E]);
  });

  it('gives invoicing details and totals', async () => {
    const r = await api(app, rk, 'GET', '/api/v1/shipments?from=2026-03-20&to=2026-03-21');
    expect(r.json.items.map((i: any) => i.ref)).toEqual([made.F, made.G, made.J]);
    const [f, g, j] = r.json.items;
    expect(f).toMatchObject({ ref: made.F, carrier: 'DHL', tracking_number: 'TRKF', aligners_shipped: 7, aligners_upper: 6, aligners_lower: 5, templates: 1, mode: 'standard', kind: 'new', site: 'PT-CHV', shipped_at: '2026-03-20T10:00:00.000Z' });
    expect(f.case_id).toMatch(/^P6-/);
    // a direct manufacturing case is invoiced by the aligners in the order
    expect(g).toMatchObject({ mode: 'direct', aligners_shipped: 17, aligners_upper: 8, aligners_lower: 9 });
    expect(j).toMatchObject({ carrier: null, tracking_number: null, aligners_shipped: 3 });
    expect(r.json.total).toBe(3);
    expect(r.json.total_aligners).toBe(7 + 17 + 3);
    // never another company's case, never a cancelled one
    expect(refs(r)).not.toContain(made.H);
    expect(refs(r)).not.toContain(made.I);
    expect(JSON.stringify(r.json)).not.toMatch(/Zelda|Quimby/);
    expect(Object.keys(f).sort()).toEqual(['aligners_lower', 'aligners_shipped', 'aligners_upper', 'carrier', 'case_id', 'kind', 'mode', 'ref', 'shipped_at', 'site', 'templates', 'tracking_number']);
  });

  it('checks the period', async () => {
    const get = (qs: string) => api(app, rk, 'GET', `/api/v1/shipments${qs}`);
    expect((await get('')).status).toBe(400);
    expect((await get('?from=2026-03-01')).status).toBe(400);
    expect((await get('?to=2026-03-01')).status).toBe(400);
    expect((await get('?from=2026-03-01&to=2026-02-01')).json.code).toBe('invalid_period');
    expect((await get('?from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await get('?from=2026-01-01&to=2027-01-03')).json.code).toBe('period_too_long'); // 366 days apart is the most
    expect((await get('?from=2026-01-01&to=2027-01-02')).status).toBe(200);
    expect((await get('?from=2026-03-01&to=2026-03-01')).status).toBe(200);
  });

  it('sees only its own shipments', async () => {
    const other = (await mkKey(contosoId, ['cases:read'])).key;
    const r = await api(app, other, 'GET', '/api/v1/shipments?from=2026-03-01&to=2026-03-31');
    expect(refs(r)).toEqual([made.I]);
    expect(r.json.total_aligners).toBe(10);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('API v1: claims and materials', () => {
  it('lists claims without any typed text or patient data', async () => {
    const k = await mkKey(acmeId, ['claims:read']);
    const caseRow = (await q(`SELECT id, ref FROM cases WHERE org_id = $1 LIMIT 1`, [acmeId]))[0];
    await q(
      `INSERT INTO claims (org_id, case_id, number, status, resolution, summary, description, opened_by)
       VALUES ($1, $2, 'CLM-2026-09001', 'accepted', 'remake', 'Zelda Quimby scratched', 'Quimby description', NULL)`,
      [acmeId, caseRow.id],
    );
    const claimId = (await q(`SELECT id FROM claims WHERE number = 'CLM-2026-09001'`))[0].id;
    await q(`INSERT INTO claim_items (org_id, claim_id, arch, step, is_template, defect_code, note, pos) VALUES ($1, $2, 'upper', 1, false, 'SCRATCHES', 'Quimby note', 0)`, [acmeId, claimId]);
    await q(`INSERT INTO claim_messages (org_id, claim_id, side, body) VALUES ($1, $2, 'partner', 'Zelda Quimby said so')`, [acmeId, claimId]);
    const r = await api(app, k.key, 'GET', '/api/v1/claims?page_size=100');
    expect(r.status).toBe(200);
    const mine = r.json.items.find((c: any) => c.number === 'CLM-2026-09001');
    expect(mine).toEqual({ number: 'CLM-2026-09001', case_ref: caseRow.ref, status: 'accepted', resolution: 'remake', created_at: expect.stringMatching(/Z$/), item_count: 1 });
    expect(JSON.stringify(r.json)).not.toMatch(/Zelda|Quimby|scratched/);
    expect(r.json).toMatchObject({ page: 1, page_size: 100 });
    const accepted = await api(app, k.key, 'GET', '/api/v1/claims?status=accepted');
    expect(accepted.json.items.every((c: any) => c.status === 'accepted')).toBe(true);
    expect(accepted.json.items.map((c: any) => c.number)).toContain('CLM-2026-09001');
    const active = await api(app, k.key, 'GET', '/api/v1/claims?status=active');
    expect(active.json.items.every((c: any) => ['open', 'in_review', 'awaiting_partner'].includes(c.status))).toBe(true);
    expect((await api(app, k.key, 'GET', '/api/v1/claims?status=nonsense')).status).toBe(400);
    // the API reads dates in Berlin time, which is already tomorrow late in the evening in UTC
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
    expect((await api(app, k.key, 'GET', `/api/v1/claims?from=${today}&to=${today}`)).json.items.map((c: any) => c.number)).toContain('CLM-2026-09001');
    expect((await api(app, k.key, 'GET', '/api/v1/claims?to=2020-01-01')).json.total).toBe(0);
    // another company sees none of it
    const other = await mkKey(contosoId, ['claims:read']);
    expect((await api(app, other.key, 'GET', '/api/v1/claims')).json.total).toBe(0);
  });

  it('lists materials and stock per site as the portal shows them', async () => {
    const made = await admin.call('POST', '/api/materials', { sku: 'BOX-9', name: 'Case box', category: 'box', perCase: 1, minStock: 10 });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const k = await mkKey(acmeId, ['materials:read']);
    const r = await api(app, k.key, 'GET', '/api/v1/materials');
    expect(r.status).toBe(200);
    expect(r.json.items.length).toBeGreaterThan(0);
    const portal = await admin.call('GET', '/api/materials');
    expect(r.json.items.map((m: any) => m.sku).sort()).toEqual(portal.json.items.map((m: any) => m.sku).sort());
    const m = r.json.items[0];
    expect(Object.keys(m).sort()).toEqual(['active', 'category', 'min_stock', 'name', 'per_aligner', 'per_case', 'sku', 'stock', 'unit']);
    const p = portal.json.items.find((x: any) => x.sku === m.sku);
    expect(m.stock).toEqual(p.stock.map((s: any) => ({ site: s.siteCode, on_hand: s.onHand, in_transit: s.inTransit, used_28d: s.used28d, days_of_cover: s.daysOfCover, low_stock: s.lowStock })));
    const other = await mkKey(contosoId, ['materials:read']);
    expect((await api(app, other.key, 'GET', '/api/v1/materials')).json.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('exports', () => {
  const today = () => new Date().toISOString().slice(0, 10);
  const range = () => `from=${new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)}`;
  let evil: string[] = [];

  beforeAll(async () => {
    // a case whose typed fields try to run as spreadsheet formulas
    const ids: string[] = [];
    await tx(SYSTEM, async (c) => {
      await c.query(`INSERT INTO brands (org_id, name) VALUES ($1, '@SUM(1+1)')`, [acmeId]);
      const brand = (await c.query(`SELECT id FROM brands WHERE org_id = $1 AND name = '@SUM(1+1)'`, [acmeId])).rows[0].id;
      for (const [i, name] of ['=HYPERLINK("http://evil.example","click")', '+49 170 1234567', '-2+3', '@cmd|\' /C calc\'!A0'].entries()) {
        const r = await insertCase(c, { orgId: acmeId, actor: { actorType: 'user', actorId: null }, mode: 'standard', caseId: i === 2 ? '-2+3' + Date.now() : `X${Date.now()}${i}`, patientName: name, brandId: brand });
        await c.query(`UPDATE cases SET carrier = $2, tracking = $3 WHERE id = $1`, [r.id, i === 0 ? '=1+1' : 'DHL', i === 1 ? '+cmd' : 'T' + i]);
        ids.push(r.ref);
      }
    });
    evil = ids;
  });

  const get = (c: Client, qs: string, path = 'cases') => c.call('GET', `/api/exports/${path}.csv?${qs}`);

  it('exports the company cases as a streamed CSV download', async () => {
    const r = await get(af, range());
    expect(r.status, r.res.body.slice(0, 200)).toBe(200);
    expect(r.res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.res.headers['content-disposition']).toMatch(/^attachment; filename="cases_\d{4}-\d\d-\d\d_to_\d{4}-\d\d-\d\d\.csv"$/);
    expect(r.res.headers['cache-control']).toBe('no-store');
    expect(r.res.headers['x-content-type-options']).toBe('nosniff');
    const text = r.res.body;
    expect(text.charCodeAt(0)).toBe(0xfeff); // byte order mark
    expect(text).toContain('\r\n');
    const head = parseCsv(text)[0]!;
    expect(head).toEqual(['ref', 'case_id', 'mode', 'kind', 'status', 'simple_status', 'stage', 'priority', 'brand', 'site', 'created_at', 'submitted_at', 'shipped_at', 'delivered_at', 'aligners_upper', 'aligners_lower', 'templates', 'aligners_shipped', 'carrier', 'tracking_number']);
    const rows = csvObjects(text);
    const mine = (await q(`SELECT count(*)::int AS n FROM cases WHERE org_id = $1 AND (created_at AT TIME ZONE 'Europe/Berlin')::date BETWEEN current_date - 2 AND current_date + 2`, [acmeId]))[0].n as number;
    expect(rows).toHaveLength(mine);
    expect(rows.every((x) => x.ref.startsWith('ACME-'))).toBe(true);
    // no names without asking for them
    expect(text).not.toMatch(/Marc Alonso|Zelda|Quimby|first_name/);
    expect(head).not.toContain('first_name');
    const shipped = rows.find((x) => x.status === 'shipped' && x.site);
    expect(shipped!.simple_status).toBe('shipped');
    // audited in the partner's own log, with the number of rows and no names
    const log = await auditOf(acmeId, 'export.cases_csv');
    expect(log[log.length - 1].details).toMatchObject({ rows: mine, includeNames: false, dateField: 'created' });
    expect(log[log.length - 1].actor_type).toBe('user');
  });

  it('keeps names behind the permission and a fresh step up', async () => {
    // finance may export but may not reveal names
    const f = await get(af, range() + '&include_names=1');
    expect(f.status).toBe(403);
    expect(f.json.code).toBe('forbidden');
    // the administrator may, after an authenticator code
    await q(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE email = 'admin@acme.demo')`);
    const no = await get(admin, range() + '&include_names=1');
    expect(no.status).toBe(403);
    expect(no.json.code).toBe('step_up_required');
    const exportReveals = async () => (await auditOf(acmeId, 'case.names_revealed')).filter((e) => e.details.via === 'export');
    expect(await exportReveals()).toHaveLength(0);
    await fresh('admin@acme.demo');
    const ok = await get(admin, range() + '&include_names=1');
    expect(ok.status, ok.res.body.slice(0, 200)).toBe(200);
    const rows = csvObjects(ok.res.body);
    expect(Object.keys(rows[0]!).slice(-3)).toEqual(['first_name', 'last_name', 'name']);
    expect(rows.find((x) => x.name === 'Marc Alonso')).toBeTruthy();
    // one bulk entry per export with the number of rows, visible to the partner
    const log = await exportReveals();
    expect(log).toHaveLength(1);
    expect(log[0].details).toMatchObject({ via: 'export', export: 'cases.csv', count: rows.length });
    expect(log[0].actor_type).toBe('user');
    const seen = await admin.call('GET', '/api/audit?action=case.names_revealed');
    expect(seen.json.entries[0]).toMatchObject({ action: 'case.names_revealed', details: { via: 'export', count: rows.length } });
    expect(JSON.stringify(seen.json)).not.toMatch(/Marc Alonso|Zelda/);
    // people without the permission get the same refusal for shipments
    expect((await get(af, range() + '&include_names=1', 'shipments')).status).toBe(403);
    expect((await get(admin, range() + '&include_names=1', 'shipments')).status).toBe(200);
  });

  it('defuses spreadsheet formulas in every cell', async () => {
    await fresh('admin@acme.demo');
    const r = await get(admin, range() + '&include_names=1');
    const rows = csvObjects(r.res.body);
    const mine = rows.filter((x) => evil.includes(x.ref));
    expect(mine).toHaveLength(4);
    const byName = Object.fromEntries(mine.map((x) => [x.name, x]));
    expect(byName['=HYPERLINK("http://evil.example","click")']).toBeUndefined();
    expect(byName[`'=HYPERLINK("http://evil.example","click")`]).toBeTruthy();
    expect(byName["'+49 170 1234567"]).toBeTruthy();
    expect(byName["'-2+3"]).toBeTruthy();
    const cmd = mine.find((x) => x.name.startsWith("'@cmd"))!;
    expect(cmd.brand).toBe("'@SUM(1+1)");
    expect(mine.find((x) => x.carrier === "'=1+1")).toBeTruthy();
    expect(mine.find((x) => x.tracking_number === "'+cmd")).toBeTruthy();
    expect(mine.find((x) => x.case_id.startsWith("'-2+3"))).toBeTruthy();
    // no cell anywhere starts with a formula character (other than plain numbers)
    for (const row of parseCsv(r.res.body).slice(1)) for (const cell of row) expect(/^[=+@\t\r]/.test(cell) || (/^-/.test(cell) && !/^-\d+([.,]\d+)?$/.test(cell))).toBe(false);
  });

  it('exports shipments by shipping date, and both date fields for cases', async () => {
    const s = await get(af, 'from=2026-03-15&to=2026-03-16', 'shipments');
    expect(s.status).toBe(200);
    const rows = csvObjects(s.res.body);
    expect(Object.keys(rows[0]!)).toEqual(['ref', 'case_id', 'mode', 'kind', 'site', 'shipped_at', 'delivered_at', 'carrier', 'tracking_number', 'aligners_shipped', 'aligners_upper', 'aligners_lower', 'templates']);
    expect(rows).toHaveLength(3); // A, B and C of the shipments test, in the order shipped
    expect(rows.map((x) => x.shipped_at)).toEqual(['2026-03-14T23:30:00.000Z', '2026-03-15T22:59:59.000Z', '2026-03-15T23:00:00.000Z']);
    expect(rows.every((x) => x.aligners_shipped === '10')).toBe(true);
    const c = await get(af, 'from=2026-03-15&to=2026-03-16&date_field=shipped');
    expect(csvObjects(c.res.body).map((x) => x.shipped_at)).toEqual(rows.map((x) => x.shipped_at));
    // by creation date the old shipments are not in the range
    expect(csvObjects((await get(af, 'from=2026-03-15&to=2026-03-16&date_field=created')).res.body)).toHaveLength(0);
    const log = await auditOf(acmeId, 'export.shipments_csv');
    expect(log[log.length - 1].details).toMatchObject({ rows: 3, dateField: 'shipped' });
  });

  it('checks the request and refuses periods that hold too many rows', async () => {
    expect((await get(af, '')).status).toBe(400);
    expect((await get(af, 'from=2026-03-01')).status).toBe(400);
    expect((await get(af, 'from=2026-03-02&to=2026-03-01')).json.code).toBe('invalid_period');
    expect((await get(af, range() + '&include_names=yes')).status).toBe(400);
    expect((await get(af, range() + '&date_field=updated')).status).toBe(400);
    setExportLimits({ maxRows: 3 });
    try {
      const r = await get(af, range());
      expect(r.status).toBe(413);
      expect(r.json.code).toBe('too_many_rows');
      expect(r.json.message).toMatch(/shorter period/);
      expect(r.res.body).not.toContain('ACME-');
      // a refused export writes nothing to the log
      const n = (await auditOf(acmeId, 'export.cases_csv')).length;
      await get(af, range());
      expect((await auditOf(acmeId, 'export.cases_csv')).length).toBe(n);
    } finally {
      setExportLimits();
    }
  });

  it('streams every row exactly once across batches', async () => {
    setExportLimits({ batch: 2 });
    try {
      const r = await get(af, range());
      const rows = csvObjects(r.res.body);
      const n = (await q(`SELECT count(*)::int AS n FROM cases WHERE org_id = $1 AND (created_at AT TIME ZONE 'Europe/Berlin')::date BETWEEN current_date - 2 AND current_date + 2`, [acmeId]))[0].n as number;
      expect(n).toBeGreaterThan(6);
      expect(rows).toHaveLength(n);
      expect(new Set(rows.map((x) => x.ref)).size).toBe(n);
      const times = rows.map((x) => x.created_at);
      expect([...times].sort()).toEqual(times);
    } finally {
      setExportLimits();
    }
  });

  it('lets K Line finance, intake and administrators export for a chosen partner', async () => {
    const r = await get(kf, `${range()}&orgId=${acmeId}`);
    expect(r.status, r.res.body.slice(0, 200)).toBe(200);
    expect(csvObjects(r.res.body).every((x) => x.ref.startsWith('ACME-'))).toBe(true);
    // without a partner: everyone's rows
    const all = csvObjects((await get(kf, range())).res.body);
    expect(all.some((x) => x.ref.startsWith('CONTOSO-'))).toBe(true);
    expect(all.some((x) => x.ref.startsWith('ACME-'))).toBe(true);
    expect((await get(kf, `${range()}&orgId=${klineId}`)).status).toBe(404); // the K Line organisation has no partner cases
    expect((await get(kf, `${range()}&orgId=00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    // the partner sees K Line's export of its data in its own log
    const financeId = (await q(`SELECT id FROM users WHERE email = 'finance@kline.demo'`))[0].id;
    expect((await auditOf(acmeId, 'export.cases_csv')).some((e) => e.actor_id === financeId)).toBe(true);
    const entries = (await admin.call('GET', '/api/audit?action=export.cases_csv&limit=200')).json.entries;
    expect(entries.some((e: any) => e.actorLabel === 'K Line staff')).toBe(true);
    // names: permission first (finance has none), then a partner must be named, then a fresh code
    expect((await get(kf, `${range()}&orgId=${acmeId}&include_names=1`)).status).toBe(403);
    await q(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE email = 'intake@kline.demo')`);
    expect((await get(intake, `${range()}&orgId=${acmeId}&include_names=1`)).json.code).toBe('step_up_required');
    await fresh('intake@kline.demo');
    expect((await get(intake, `${range()}&include_names=1`)).json.code).toBe('org_required');
    const named = await get(intake, `${range()}&orgId=${acmeId}&include_names=1`);
    expect(named.status).toBe(200);
    const log2 = await auditOf(acmeId, 'case.names_revealed');
    expect(log2[log2.length - 1].actor_type).toBe('user');
    expect(log2[log2.length - 1].details).toMatchObject({ via: 'export', count: csvObjects(named.res.body).length });
  });

  it('never shows one company the rows of another, and only export.run may export', async () => {
    const r = await get(contoso, `${range()}&orgId=${acmeId}`); // the parameter has no effect for partners
    expect(r.status).toBe(200);
    const rows = csvObjects(r.res.body);
    expect(rows.every((x) => x.ref.startsWith('CONTOSO-'))).toBe(true);
    expect(r.res.body).not.toContain('ACME-');
    const named = await (async () => {
      await fresh('admin@contoso.demo');
      return get(contoso, `${range()}&include_names=1`);
    })();
    expect(named.status).toBe(200);
    expect(named.res.body).not.toMatch(/Marc Alonso|Zelda Quimby/);
    // the roles without export.run
    for (const c of [up, aq, av]) expect((await get(c, range())).status).toBe(403);
    expect((await api(app, null, 'GET', `/api/exports/cases.csv?${range()}`)).status).toBe(401);
    expect(today()).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('permissions of the new routes', () => {
  const W = 'https://erp.partner-example.com/hook';
  it('follows the matrix', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/api-keys'],
      ['POST', '/api/api-keys', { name: 'x', scopes: ['cases:read'], expiresInDays: 30 }],
      ['DELETE', `/api/api-keys/${id}`],
      ['GET', '/api/webhooks'],
      ['POST', '/api/webhooks', { url: W, events: ['case.shipped'] }],
      ['PATCH', `/api/webhooks/${id}`, { active: false }],
      ['POST', `/api/webhooks/${id}/rotate-secret`, {}],
      ['DELETE', `/api/webhooks/${id}`],
      ['GET', `/api/webhooks/${id}/deliveries`],
      ['GET', `/api/webhooks/${id}/deliveries/${id}`],
      ['POST', `/api/webhooks/${id}/deliveries/${id}/retry`, {}],
      ['POST', `/api/webhooks/${id}/test`, {}],
    ];
    // partner roles without integration.manage, and all of K Line, are refused before anything happens
    for (const c of [up, aq, af, av, klAdmin, intake, kf]) {
      for (const [m, u, b] of routes) {
        const r = await c.call(m, u, b);
        expect(r.status, `${m} ${u}`).toBe(403);
      }
    }
    // signed out
    for (const [m, u, b] of routes) expect((await api(app, null, m, u, b)).status, `${m} ${u}`).toBe(401);
    // the administrator passes the permission check (an unknown id is then a 404, changes need step up first)
    await fresh('admin@acme.demo');
    for (const [m, u, b] of routes.filter(([, u]) => u.includes(id))) {
      const r = await admin.call(m, u, b);
      expect(r.status, `${m} ${u}`).toBe(404);
    }
    // the account preference is for everyone who is signed in, and only for people
    for (const c of [up, aq, af, av, admin, klAdmin, intake]) expect((await c.call('GET', '/api/account/notifications')).status).toBe(200);
    expect((await api(app, null, 'GET', '/api/account/notifications')).status).toBe(401);
  });

  it('does not let K Line administrators manage partner integrations even though they hold the permission', async () => {
    await fresh('admin@kline.demo');
    expect((await klAdmin.call('POST', '/api/api-keys', { name: 'x', scopes: ['cases:read'], expiresInDays: 30 })).status).toBe(403);
    expect((await klAdmin.call('POST', '/api/webhooks', { url: W, events: ['case.shipped'] })).status).toBe(403);
    expect((await q(`SELECT count(*)::int AS n FROM api_keys WHERE org_id = $1 AND name = 'x'`, [klineId]))[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM webhooks WHERE org_id = $1`, [klineId]))[0].n).toBe(0);
  });

  it('keeps keys, webhooks and deliveries of one company invisible to another', async () => {
    await fresh('admin@acme.demo');
    const hook = await admin.call('POST', '/api/webhooks', { url: 'http://127.0.0.1:9/never', events: ['case.shipped'] });
    expect(hook.status, JSON.stringify(hook.json)).toBe(201);
    const key = await mkKey(acmeId, ['cases:read']);
    await fresh('admin@contoso.demo');
    expect((await contoso.call('GET', '/api/api-keys')).json.items.find((k: any) => k.id === key.id)).toBeUndefined();
    expect((await contoso.call('DELETE', `/api/api-keys/${key.id}`)).status).toBe(404);
    expect((await contoso.call('GET', '/api/webhooks')).json.items.find((w: any) => w.id === hook.json.id)).toBeUndefined();
    for (const [m, u, b] of [
      ['PATCH', `/api/webhooks/${hook.json.id}`, { active: false }],
      ['POST', `/api/webhooks/${hook.json.id}/rotate-secret`, {}],
      ['DELETE', `/api/webhooks/${hook.json.id}`],
      ['GET', `/api/webhooks/${hook.json.id}/deliveries`],
      ['POST', `/api/webhooks/${hook.json.id}/test`, {}],
    ] as [string, string, unknown?][]) {
      expect((await contoso.call(m, u, b)).status, `${m} ${u}`).toBe(404);
    }
    // the same at the database: a partner sees only its own rows in every new table
    const counts = async (orgId: string) =>
      tx({ orgId, bypass: false }, async (c) => {
        const out: Record<string, number> = {};
        for (const t of ['api_keys', 'webhooks', 'webhook_deliveries', 'email_notice_log']) out[t] = (await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE org_id <> $1`, [orgId])).rows[0].n;
        return out;
      });
    expect(await counts(contosoId)).toEqual({ api_keys: 0, webhooks: 0, webhook_deliveries: 0, email_notice_log: 0 });
    expect(await counts(acmeId)).toEqual({ api_keys: 0, webhooks: 0, webhook_deliveries: 0, email_notice_log: 0 });
    // and a partner cannot write a row for another company
    await expect(
      tx({ orgId: contosoId, bypass: false }, (c) =>
        c.query(`INSERT INTO webhooks (org_id, url, events, secret_enc) VALUES ($1, 'https://x.example.com', ARRAY['case.shipped'], 'x')`, [acmeId]),
      ),
    ).rejects.toThrow();
    await admin.call('DELETE', `/api/webhooks/${hook.json.id}`);
  });

});
