import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { decryptField, encryptField, fieldAad } from '../src/crypto/keys';
import { insertCase } from '../src/services/cases';
import { closeSafeAgent, resetNetOptions, setNetOptions } from '../src/services/netSafety';
import { FakePortalClient, setPortalClientFactory } from '../src/services/portal';
import { runPortalSync } from '../src/services/portalSync';
import { runRetention } from '../src/services/retention';
import { RETRY_MINUTES, deliverOne, sweepDueDeliveries } from '../src/services/webhookDelivery';
import { WEBHOOK_EVENTS, emitCaseWebhook, emitMaterialsWebhook, setHookObserver } from '../src/services/webhooks';
import { runDueJobs } from '../src/worker';
import { Client, createDemoUser, cubeStl, orgIdOf } from './helpers';
import { api, q, startReceiver, type Hit, type Receiver } from './helpers6';

let app: FastifyInstance;
let acmeId: string;
let contosoId: string;
let admin: Client;
let up: Client;
let aq: Client;
let af: Client;
let av: Client;
let contoso: Client;
let klAdmin: Client;
let intake: Client;
let svcKey: string;
let main: Receiver; // the partner's endpoint for the main flow
const fake = new FakePortalClient();

const NAME = 'Zelda Quimby';
const TYPED = ['Zelda', 'Quimby', 'needs the attachments', 'Quimby reason text'];
let counter = 0;
const uid = () => `WH-${Date.now().toString(36)}-${counter++}`;
const PUBLIC_URL = 'http://localhost:4000';

const mailbox = (where = 'true', params: unknown[] = []) => q(`SELECT * FROM dev_mailbox WHERE ${where} ORDER BY created_at, id`, params);
/** Mail ids so far, to tell what arrives later (mail ids are random, so the order of the table says nothing). */
const snap = async () => new Set((await mailbox()).map((m) => m.id as string));
const forRef = async (seen: Set<string>, ref: string) => (await since(seen)).filter((m) => m.subject.includes(ref));
const since = async (seen: Set<string>) => (await mailbox()).filter((m) => !seen.has(m.id));

/** Independent implementation of the documented verification, written from the contract and not from the server code. */
function verify(hit: Hit, secret: string, toleranceSeconds = 300): { ok: boolean; reason?: string } {
  const header = String(hit.headers['x-kph-signature'] ?? '');
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return { ok: false, reason: 'malformed' };
  const t = Number(m[1]);
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return { ok: false, reason: 'stale' };
  const expected = createHmac('sha256', secret).update(`${t}.${hit.body}`, 'utf8').digest('hex');
  return expected === m[2] ? { ok: true } : { ok: false, reason: 'mismatch' };
}

async function createHook(c: Client, url: string, events: string[] = [...WEBHOOK_EVENTS], description?: string) {
  await fresh(c === contoso ? 'admin@contoso.demo' : 'admin@acme.demo');
  const r = await c.call('POST', '/api/webhooks', { url, events, ...(description ? { description } : {}) });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { id: r.json.id as string, secret: r.json.secret as string };
}

/** A webhook row written straight to the database, for addresses the API would refuse. */
async function rawHook(orgId: string, url: string, events = ['materials.low_stock']) {
  const id = randomUUID();
  const secret = 'whsec_' + 'R'.repeat(43);
  await q(`INSERT INTO webhooks (id, org_id, url, events, secret_enc) VALUES ($1, $2, $3, $4, $5)`, [id, orgId, url, events, encryptField(secret, fieldAad.webhook(id))]);
  return { id, secret };
}

/** Queues one materials.low_stock event for the organisation and returns the delivery ids created for it. */
async function emitLowStock(orgId: string, sku = 'SKU-' + counter++) {
  const before = new Set((await q(`SELECT id FROM webhook_deliveries`)).map((r) => r.id));
  await tx(SYSTEM, (c) => emitMaterialsWebhook(c, orgId, 'materials.low_stock', { materialId: randomUUID(), sku, siteCode: 'PT-CHV', onHand: 3, minStock: 10 }));
  return (await q(`SELECT id, webhook_id FROM webhook_deliveries`)).filter((r) => !before.has(r.id));
}

const deliveryOf = async (id: string) => (await q(`SELECT * FROM webhook_deliveries WHERE id = $1`, [id]))[0];
const hookOf = async (id: string) => (await q(`SELECT * FROM webhooks WHERE id = $1`, [id]))[0];
/** Runs every job that is due (runDueJobs alone stops after 100). */
const drain = () => runDueJobs(10_000);
/** Makes the last authenticator code count as just entered (the step up route itself is rate limited). */
const fresh = (email: string) => q(`UPDATE sessions SET step_up_at = now() WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE email = $1)`, [email]);
const auditOf = (orgId: string, action: string) => q(`SELECT * FROM audit_log WHERE org_id = $1 AND action = $2 ORDER BY seq`, [orgId, action]);
const mes = (events: Record<string, unknown>[]) => api(app, svcKey, 'POST', '/api/mes/v1/events', { events });

/** A case that K Line has already routed, with a real STL, so claims and the factory flow work. */
async function readyCase(name = NAME) {
  const r = await up.call('POST', '/api/cases', { caseId: uid(), patientName: name, instructions: 'Zelda Quimby needs the attachments' });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.case.id as string;
  await up.uploadFile(id, 'U01.stl', cubeStl(50, 'model one'));
  const sub = await up.call('POST', `/api/cases/${id}/submit`, { acknowledgeWarnings: true });
  expect(sub.status, JSON.stringify(sub.json)).toBe(200);
  expect(sub.json.case.status).toBe('ready');
  return { id, ref: r.json.case.ref as string };
}

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
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
  klAdmin = await new Client(app).full('admin@kline.demo');
  intake = await new Client(app).full('intake@kline.demo');
  const k = await klAdmin.call('POST', '/api/service-keys', { name: 'Phase 6 factory system', scopes: ['mes:intake', 'mes:files', 'mes:events'], expiresInDays: 30 });
  svcKey = k.json.key;
  main = await startReceiver();
  setPortalClientFactory((org) => (org.id === acmeId ? fake : null));
});

afterAll(async () => {
  setPortalClientFactory(undefined);
  setHookObserver(null);
  resetNetOptions();
  await main.close();
  await closeSafeAgent();
  await app.close();
  await closePools();
});

// ---------------------------------------------------------------------------------------------------------------------
describe('webhook endpoints', () => {
  it('creates one with step up, shows the secret once and stores it encrypted', async () => {
    await q(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE email = 'admin@acme.demo')`);
    const body = { url: `${main.url}/tok_SECRETTOKEN`, events: ['case.shipped', 'case.shipped', 'claim.updated'], description: '  My   ERP\n  ' };
    const no = await admin.call('POST', '/api/webhooks', body);
    expect(no.status).toBe(403);
    expect(no.json.code).toBe('step_up_required');

    await fresh('admin@acme.demo');
    const r = await admin.call('POST', '/api/webhooks', body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(r.json.webhook).toMatchObject({ id: r.json.id, url: body.url, events: ['case.shipped', 'claim.updated'], description: 'My ERP', active: true, status: 'active', consecutiveFailures: 0, lastOutcome: null, lastAttemptAt: null, createdByName: 'Alex Acme' });
    expect(r.json.webhook).not.toHaveProperty('secret');

    // stored as an encrypted field bound to this row
    const row = await hookOf(r.json.id);
    expect(row.secret_enc).toMatch(/^f1\./);
    expect(JSON.stringify(row)).not.toContain(r.json.secret);
    expect(decryptField(row.secret_enc, fieldAad.webhook(r.json.id))).toBe(r.json.secret);
    expect(() => decryptField(row.secret_enc, fieldAad.webhook(randomUUID()))).toThrow();

    // never again: not in the list, not in a change, not in the audit log
    const list = await admin.call('GET', '/api/webhooks');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain(r.json.secret);
    expect(list.json.events).toEqual([...WEBHOOK_EVENTS]);
    expect(list.json.limits).toEqual({ maxWebhooks: 10 });
    expect(list.json.retryMinutes).toEqual([1, 5, 30, 120, 360, 720, 1440]);
    expect(list.json.items.find((w: any) => w.id === r.json.id)).toBeTruthy();
    const log = (await q(`SELECT * FROM audit_log WHERE org_id = $1 AND action LIKE 'webhook.%'`, [acmeId])).filter((e) => e.target_id === r.json.id);
    expect(log.map((e) => e.action)).toEqual(['webhook.created']);
    expect(JSON.stringify(log)).not.toContain(r.json.secret);
    expect(JSON.stringify(log)).not.toContain('tok_SECRETTOKEN'); // addresses can carry tokens: only the host is logged
    expect(log[0].details).toMatchObject({ host: `127.0.0.1:${main.port}`, events: ['case.shipped', 'claim.updated'] });
    await admin.call('DELETE', `/api/webhooks/${r.json.id}`);
  });

  it('checks the request', async () => {
    await fresh('admin@acme.demo');
    const post = (b: Record<string, unknown>) => admin.call('POST', '/api/webhooks', { url: main.url, events: ['case.shipped'], ...b });
    expect((await post({ events: [] })).status).toBe(400);
    const unknown = await post({ events: ['case.shipped', 'case.exploded'] });
    expect(unknown.status).toBe(400);
    expect(unknown.json.code).toBe('invalid_event');
    expect((await post({ events: ['webhook.test'] })).json.code).toBe('invalid_event'); // the test event is not subscribable
    expect((await post({ url: '' })).status).toBe(400);
    expect((await post({ url: 'x'.repeat(501) })).status).toBe(400);
    expect((await post({ description: 'd'.repeat(201) })).status).toBe(400);
    expect((await post({ url: 'not a url' })).json.code).toBe('invalid_webhook_url');
  });

  it('refuses private and unsafe addresses at save time', async () => {
    await fresh('admin@acme.demo');
    setNetOptions({
      allowLocal: false,
      resolver: async (h) => {
        if (h === 'public.partner.example') return [{ address: '93.184.216.34', family: 4 }];
        if (h === 'inside.partner.example') return [{ address: '10.1.2.3', family: 4 }];
        if (h === 'mixed.partner.example') return [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }];
        throw Object.assign(new Error('nxdomain'), { code: 'ENOTFOUND' });
      },
    });
    try {
      const post = (url: string) => admin.call('POST', '/api/webhooks', { url, events: ['case.shipped'] });
      const cases: [string, string][] = [
        ['http://public.partner.example/hook', 'not_https'],
        [`${main.url}`, 'not_https'],
        ['https://user:pw@public.partner.example/hook', 'has_credentials'],
        ['https://localhost/hook', 'blocked_host'],
        ['https://printer.local/hook', 'blocked_host'],
        ['https://db.internal/hook', 'blocked_host'],
        ['https://127.0.0.1/hook', 'blocked_address'],
        ['https://10.0.0.5/hook', 'blocked_address'],
        ['https://192.168.1.10/hook', 'blocked_address'],
        ['https://169.254.169.254/latest/meta-data', 'blocked_address'],
        ['https://100.64.0.1/hook', 'blocked_address'],
        ['https://[::1]/hook', 'blocked_address'],
        ['https://[fd00::1]/hook', 'blocked_address'],
        ['https://2130706433/hook', 'blocked_address'],
        ['https://inside.partner.example/hook', 'blocked_address'], // the name points inside
        ['https://mixed.partner.example/hook', 'blocked_address'],
        ['https://nowhere.partner.example/hook', 'unresolvable'],
      ];
      for (const [url, reason] of cases) {
        const r = await post(url);
        expect(r.status, url).toBe(400);
        expect(r.json.code, url).toBe('invalid_webhook_url');
        expect(r.json.reason ?? r.json.fields, url).toBeDefined();
        expect(r.json.reason, url).toBe(reason);
        expect(r.json.message, url).not.toMatch(/ [-–—] /);
      }
      const ok = await post('https://public.partner.example/hook');
      expect(ok.status, JSON.stringify(ok.json)).toBe(201);
      await admin.call('DELETE', `/api/webhooks/${ok.json.id}`);
    } finally {
      resetNetOptions();
    }
    expect((await q(`SELECT count(*)::int AS n FROM webhooks WHERE org_id = $1`, [acmeId]))[0].n).toBe(0);
  });

  it('allows at most ten per company', async () => {
    await fresh('admin@contoso.demo');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await createHook(contoso, `${main.url}/${i}`, ['case.shipped'])).id);
    const r = await contoso.call('POST', '/api/webhooks', { url: main.url, events: ['case.shipped'] });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('too_many_webhooks');
    await contoso.call('DELETE', `/api/webhooks/${ids[0]}`);
    expect((await contoso.call('POST', '/api/webhooks', { url: main.url, events: ['case.shipped'] })).status).toBe(201);
    await q(`DELETE FROM webhooks WHERE org_id = $1`, [contosoId]);
  });

  it('changes, switches off and on, rotates the secret and deletes, all with step up and in the audit log', async () => {
    const h = await createHook(admin, main.url, ['case.shipped']);
    await q(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE email = 'admin@acme.demo')`);
    for (const [m, u, b] of [
      ['PATCH', `/api/webhooks/${h.id}`, { description: 'x' }],
      ['POST', `/api/webhooks/${h.id}/rotate-secret`, {}],
      ['DELETE', `/api/webhooks/${h.id}`],
    ] as [string, string, unknown?][]) {
      const r = await admin.call(m, u, b);
      expect(r.status, `${m} ${u}`).toBe(403);
      expect(r.json.code).toBe('step_up_required');
    }
    await fresh('admin@acme.demo');
    const upd = await admin.call('PATCH', `/api/webhooks/${h.id}`, { events: ['case.delivered', 'case.shipped'], description: 'Production ERP', url: main.url + '/v2' });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    expect(upd.json.webhook).toMatchObject({ events: ['case.delivered', 'case.shipped'], description: 'Production ERP', url: main.url + '/v2', active: true });
    expect((await admin.call('PATCH', `/api/webhooks/${h.id}`, { events: ['nope'] })).json.code).toBe('invalid_event');
    expect((await admin.call('PATCH', `/api/webhooks/${h.id}`, { url: 'ftp://x.example.com' })).status).toBe(400);
    expect((await admin.call('PATCH', `/api/webhooks/${h.id}`, { description: null })).json.webhook.description).toBeNull();

    const off = await admin.call('PATCH', `/api/webhooks/${h.id}`, { active: false });
    expect(off.json.webhook).toMatchObject({ active: false, status: 'disabled', disabledReason: 'switched_off' });
    // a switched off endpoint receives nothing new
    expect(await emitLowStockFor(h.id, ['materials.low_stock'])).toBe(0);
    await q(`UPDATE webhooks SET consecutive_failures = 7 WHERE id = $1`, [h.id]);
    const on = await admin.call('PATCH', `/api/webhooks/${h.id}`, { active: true });
    expect(on.json.webhook).toMatchObject({ active: true, status: 'active', disabledReason: null, disabledAt: null, consecutiveFailures: 0 });

    const before = (await hookOf(h.id)).secret_enc;
    const rot = await admin.call('POST', `/api/webhooks/${h.id}/rotate-secret`, {});
    expect(rot.status).toBe(200);
    expect(rot.json.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(rot.json.secret).not.toBe(h.secret);
    const row = await hookOf(h.id);
    expect(row.secret_enc).not.toBe(before);
    expect(decryptField(row.secret_enc, fieldAad.webhook(h.id))).toBe(rot.json.secret);
    expect(JSON.stringify((await admin.call('GET', '/api/webhooks')).json)).not.toContain(rot.json.secret);

    expect((await admin.call('DELETE', `/api/webhooks/${h.id}`)).json).toEqual({ ok: true });
    expect((await admin.call('DELETE', `/api/webhooks/${h.id}`)).status).toBe(404);
    const log = (await q(`SELECT action, details FROM audit_log WHERE org_id = $1 AND target_id = $2 ORDER BY seq`, [acmeId, h.id]));
    expect(log.map((e) => e.action)).toEqual(['webhook.created', 'webhook.updated', 'webhook.updated', 'webhook.disabled', 'webhook.enabled', 'webhook.secret_rotated', 'webhook.deleted']);
    const text = JSON.stringify(log);
    for (const secret of [h.secret, rot.json.secret]) expect(text).not.toContain(secret);
    expect(log[1].details.changed.sort()).toEqual(['description', 'events', 'url']);
  });

  /** How many deliveries the organisation's events would create for this one endpoint. */
  async function emitLowStockFor(hookId: string, events: string[]): Promise<number> {
    const before = (await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1`, [hookId]))[0].n as number;
    await q(`UPDATE webhooks SET events = $2 WHERE id = $1`, [hookId, events]);
    await emitLowStock(acmeId);
    return ((await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1`, [hookId]))[0].n as number) - before;
  }
});

// ---------------------------------------------------------------------------------------------------------------------
describe('delivery', () => {
  it('posts a signed event that an independent check accepts, and stores only the status', async () => {
    const h = await createHook(admin, main.url + '/signed', ['materials.low_stock']);
    main.hits.length = 0;
    main.mode = { status: 200 };
    const [d] = await emitLowStock(acmeId, 'SKU-SIGNED');
    const queued = await deliveryOf(d!.id);
    expect(queued).toMatchObject({ status: 'pending', attempts: 0, event: 'materials.low_stock' });
    expect(queued.payload).toMatchObject({ id: d!.id, type: 'materials.low_stock', org_code: 'ACME', data: { sku: 'SKU-SIGNED', site: 'PT-CHV', on_hand: 3, min_stock: 10 } });
    // one job per delivery
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'webhook.deliver' AND payload->>'deliveryId' = $1`, [d!.id]))[0].n).toBe(1);

    await drain();
    expect(main.hits).toHaveLength(1);
    const hit = main.hits[0]!;
    expect(hit.method).toBe('POST');
    expect(hit.path).toBe('/hook/signed');
    expect(hit.headers['content-type']).toBe('application/json');
    expect(hit.headers['user-agent']).toBe('KPH-Webhooks/1');
    expect(hit.headers['x-kph-event']).toBe('materials.low_stock');
    expect(hit.headers['x-kph-delivery']).toBe(d!.id);
    expect(verify(hit, h.secret)).toEqual({ ok: true });
    // anything else fails: a wrong secret, a changed body, an old time
    expect(verify(hit, h.secret + 'x').ok).toBe(false);
    expect(verify({ ...hit, body: hit.body + ' ' }, h.secret).ok).toBe(false);
    expect(verify(hit, h.secret, -1).reason).toBe('stale');
    const body = JSON.parse(hit.body);
    expect(Object.keys(body)).toEqual(['id', 'type', 'created_at', 'org_code', 'data']);
    expect(body).toMatchObject({ id: d!.id, type: 'materials.low_stock', org_code: 'ACME' });
    expect(new Date(body.created_at).toISOString()).toBe(body.created_at);
    const t = Number(/t=(\d+)/.exec(String(hit.headers['x-kph-signature']))![1]);
    expect(Math.abs(Date.now() / 1000 - t)).toBeLessThan(30);

    const done = await deliveryOf(d!.id);
    expect(done).toMatchObject({ status: 'delivered', attempts: 1, last_status_code: 200, last_error: null, next_attempt_at: null });
    expect(done.delivered_at).toBeTruthy();
    // the answer of the endpoint is not kept anywhere
    expect(JSON.stringify(done)).not.toContain('thanks');
    const w = await hookOf(h.id);
    expect(w).toMatchObject({ consecutive_failures: 0, last_outcome: 'delivered', last_status_code: 200 });
    expect(w.last_success_at).toBeTruthy();
    // running the job again sends nothing more
    expect(await deliverOne(d!.id)).toBe('skipped');
    expect(main.hits).toHaveLength(1);
    await q(`DELETE FROM webhooks WHERE id = $1`, [h.id]);
  });

  it('a manual retry of a delivered event clears its delivery time until it is delivered again', async () => {
    const h = await createHook(admin, main.url + '/again', ['materials.low_stock']);
    main.hits.length = 0;
    main.mode = { status: 200 };
    const [d] = await emitLowStock(acmeId, 'SKU-AGAIN');
    await drain();
    const done = await deliveryOf(d!.id);
    expect(done.status).toBe('delivered');
    expect(done.delivered_at).toBeTruthy();
    // sent again by hand: it is pending, and it no longer claims to have been delivered
    const r = await admin.call('POST', `/api/webhooks/${h.id}/deliveries/${d!.id}/retry`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.delivery).toMatchObject({ id: d!.id, status: 'pending', deliveredAt: null });
    expect((await deliveryOf(d!.id)).delivered_at).toBeNull();
    // the endpoint fails this time: still no delivery time
    main.mode = { status: 500 };
    await drain();
    expect(await deliveryOf(d!.id)).toMatchObject({ status: 'retrying', delivered_at: null });
    // and when it works, the time is set again
    main.mode = { status: 200 };
    expect((await admin.call('POST', `/api/webhooks/${h.id}/deliveries/${d!.id}/retry`, {})).status).toBe(200);
    await drain();
    const again = await deliveryOf(d!.id);
    expect(again.status).toBe('delivered');
    expect(again.delivered_at).toBeTruthy();
    expect(new Date(again.delivered_at).getTime()).toBeGreaterThanOrEqual(new Date(done.delivered_at).getTime());
    await q(`DELETE FROM webhooks WHERE id = $1`, [h.id]);
  });

  it('follows the retry plan of 1, 5, 30, 120, 360, 720 and 1440 minutes, then gives up', async () => {
    const h = await createHook(admin, main.url + '/failing', ['materials.low_stock']);
    main.hits.length = 0;
    main.mode = { status: 500 };
    const [d] = await emitLowStock(acmeId);
    await drain();
    let row = await deliveryOf(d!.id);
    expect(row).toMatchObject({ status: 'retrying', attempts: 1, last_status_code: 500, last_error: 'The endpoint answered with status 500.' });
    const gapMinutes = (r: any) => Math.round((new Date(r.next_attempt_at).getTime() - new Date(r.last_attempt_at).getTime()) / 60_000);
    expect(gapMinutes(row)).toBe(1);
    // not due yet: a worker that wakes early does nothing
    expect(await deliverOne(d!.id)).toBe('skipped');
    expect(main.hits).toHaveLength(1);
    // the next attempt is queued as a job for the right time
    const job = (await q(`SELECT run_at FROM jobs WHERE kind = 'webhook.deliver' AND payload->>'deliveryId' = $1 AND status = 'queued'`, [d!.id]))[0];
    expect(new Date(job.run_at).getTime()).toBeGreaterThan(Date.now() + 50_000);

    const expected = [...RETRY_MINUTES];
    for (let attempt = 2; attempt <= 8; attempt++) {
      await q(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [d!.id]);
      const outcome = await deliverOne(d!.id);
      row = await deliveryOf(d!.id);
      expect(row.attempts).toBe(attempt);
      if (attempt < 8) {
        expect(outcome).toBe('retry');
        expect(row.status).toBe('retrying');
        expect(gapMinutes(row), `after attempt ${attempt}`).toBe(expected[attempt - 1]);
      } else {
        expect(outcome).toBe('dead');
        expect(row).toMatchObject({ status: 'dead', attempts: 8, next_attempt_at: null, last_status_code: 500 });
      }
    }
    expect(main.hits).toHaveLength(8);
    // the same delivery id and the same body every time
    expect(new Set(main.hits.map((x) => x.headers['x-kph-delivery'])).size).toBe(1);
    expect(new Set(main.hits.map((x) => x.body)).size).toBe(1);
    expect(await deliverOne(d!.id)).toBe('skipped'); // dead stays dead
    expect((await hookOf(h.id)).consecutive_failures).toBe(8);

    // a manual retry starts a new round with the same event id, and a success resets the failure count
    main.mode = { status: 204 };
    const r = await admin.call('POST', `/api/webhooks/${h.id}/deliveries/${d!.id}/retry`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.delivery).toMatchObject({ id: d!.id, status: 'pending', attempts: 0 });
    await drain();
    row = await deliveryOf(d!.id);
    expect(row).toMatchObject({ status: 'delivered', attempts: 1, last_status_code: 204 });
    expect(main.hits).toHaveLength(9);
    expect(main.hits[8]!.headers['x-kph-delivery']).toBe(d!.id);
    expect(verify(main.hits[8]!, h.secret)).toEqual({ ok: true });
    expect((await hookOf(h.id)).consecutive_failures).toBe(0);
    expect((await auditOf(acmeId, 'webhook.delivery_retried')).pop()!.details).toMatchObject({ deliveryId: d!.id });
    await q(`DELETE FROM webhooks WHERE id = $1`, [h.id]);
    main.mode = { status: 200 };
  });

  it('switches an endpoint off after 25 failures in a row, tells the administrators and stops sending', async () => {
    const h = await createHook(admin, main.url + '/dying', ['materials.low_stock']);
    main.hits.length = 0;
    main.mode = { status: 503 };
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(...(await emitLowStock(acmeId)).map((d) => d.id));
    expect(ids).toHaveLength(25);
    await drain();
    expect(main.hits).toHaveLength(25);
    const w = await hookOf(h.id);
    expect(w).toMatchObject({ active: false, disabled_reason: 'too_many_failures', consecutive_failures: 25 });
    expect(w.disabled_at).toBeTruthy();
    const log = (await auditOf(acmeId, 'webhook.auto_disabled')).filter((e) => e.target_id === h.id);
    expect(log).toHaveLength(1);
    expect(log[0].actor_type).toBe('system');

    // in app and by email, fixed text, only to people who manage integrations
    const notes = await q(`SELECT n.*, u.email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'webhook_disabled' AND n.org_id = $1`, [acmeId]);
    expect(notes.map((n) => n.email)).toEqual(['admin@acme.demo']);
    expect(notes[0].data).toEqual({ webhookId: h.id });
    expect(notes[0].title).toBe('A webhook was switched off');
    await drain();
    const mail = await mailbox(`subject = 'A webhook was switched off'`);
    expect(mail.map((m) => m.to_addr)).toEqual(['admin@acme.demo']);
    expect(mail[0].body).toContain(`${PUBLIC_URL}/portal/integrations`);
    expect(mail[0].body).toContain('failed 25 times in a row');
    expect(mail[0].body).not.toContain(main.url);
    expect(mail[0].body).not.toMatch(/ [-–—] /);

    // new events no longer queue deliveries for it; waiting retries end as dead when they come due
    expect(await (async () => (await emitLowStock(acmeId)).filter((d) => d.webhook_id === h.id).length)()).toBe(0);
    await q(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [ids[0]]);
    expect(await deliverOne(ids[0]!)).toBe('skipped');
    expect(await deliveryOf(ids[0]!)).toMatchObject({ status: 'dead', last_error: 'The endpoint was switched off before this could be sent.' });
    expect(main.hits).toHaveLength(25);

    // switching it back on starts clean
    await fresh('admin@acme.demo');
    const on = await admin.call('PATCH', `/api/webhooks/${h.id}`, { active: true });
    expect(on.json.webhook).toMatchObject({ active: true, consecutiveFailures: 0, disabledReason: null });
    main.mode = { status: 200 };
    const r = await admin.call('POST', `/api/webhooks/${h.id}/deliveries/${ids[0]}/retry`, {});
    expect(r.status).toBe(200);
    await drain();
    expect((await deliveryOf(ids[0]!)).status).toBe('delivered');
    // a retry on a switched off endpoint is refused
    await admin.call('PATCH', `/api/webhooks/${h.id}`, { active: false });
    const refused = await admin.call('POST', `/api/webhooks/${h.id}/deliveries/${ids[1]}/retry`, {});
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('webhook_disabled');
    await q(`DELETE FROM webhooks WHERE id = $1`, [h.id]);
  });

  it('does not follow redirects', async () => {
    const other = await startReceiver();
    try {
      const h = await createHook(admin, main.url + '/moved', ['materials.low_stock']);
      main.hits.length = 0;
      main.mode = { status: 200, redirectTo: `${other.url}/elsewhere` };
      const [d] = await emitLowStock(acmeId);
      await drain();
      expect(main.hits).toHaveLength(1);
      expect(other.hits).toHaveLength(0); // never asked
      expect(await deliveryOf(d!.id)).toMatchObject({ status: 'retrying', last_status_code: 302, last_error: 'The endpoint answered with a redirect, which is not followed.' });
      await q(`DELETE FROM webhooks WHERE id = $1`, [h.id]);
    } finally {
      main.mode = { status: 200 };
      await other.close();
    }
  });

  it('counts a refused connection as a failure', async () => {
    // nothing listens on that port
    const h = await rawHook(acmeId, 'http://127.0.0.1:9/closed-port'); // nothing listens there
    const [d] = await emitLowStock(acmeId);
    await drain();
    const row = await deliveryOf(d!.id);
    expect(row.status).toBe('retrying');
    expect(row.last_status_code).toBeNull();
    expect(row.last_error).toBe('Could not connect to the endpoint.');
    await q(`DELETE FROM webhooks WHERE id = $1`, [h.id]);
  });

  it('refuses private targets when it connects, also for names that changed their answer (DNS rebinding)', async () => {
    main.hits.length = 0;
    main.mode = { status: 200 };
    const hosts: Record<string, string[]> = { 'hooks.partner.example': ['93.184.216.34'] };
    setNetOptions({
      allowLocal: true,
      resolver: async (h) => {
        const a = hosts[h];
        if (!a) throw Object.assign(new Error('nxdomain'), { code: 'ENOTFOUND' });
        return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
      },
    });
    try {
      // saved while the name points to a public address
      const h = await createHook(admin, 'https://hooks.partner.example/hook', ['materials.low_stock']);
      // the name now points to loopback, where the test endpoint listens; an answer that mixes in a private address is refused too
      for (const answer of [['127.0.0.1'], ['93.184.216.34', '10.0.0.7'], ['169.254.169.254'], ['::1'], ['fd12::1']]) {
        hosts['hooks.partner.example'] = answer;
        const [d] = await emitLowStock(acmeId);
        await drain();
        const row = await deliveryOf(d!.id);
        expect(row.status, answer.join()).toBe('retrying');
        expect(row.last_error, answer.join()).toBe('The address is not allowed because it points to a private or reserved network.');
        expect(row.last_status_code).toBeNull();
      }
      expect(main.hits).toHaveLength(0);
      await q(`DELETE FROM webhooks WHERE id = $1`, [h.id]);

      // an address that was stored before the rules were applied is judged when it is used
      const literal = await rawHook(acmeId, 'https://10.0.0.5/hook');
      const http = await rawHook(acmeId, `http://169.254.169.254/latest`);
      const [d1] = await emitLowStock(acmeId);
      await drain();
      for (const hookId of [literal.id, http.id]) {
        const rows = await q(`SELECT * FROM webhook_deliveries WHERE webhook_id = $1`, [hookId]);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('retrying');
        expect(rows[0].last_status_code).toBeNull();
        expect(rows[0].last_error).toMatch(/not allowed|must start with https/);
      }
      expect(d1).toBeTruthy();
      await q(`DELETE FROM webhooks WHERE id IN ($1, $2)`, [literal.id, http.id]);

      // through a name: the local allowance covers localhost only, and the resolver's answer is what is connected to
      hosts['localhost'] = ['127.0.0.1'];
      const local = await rawHook(acmeId, `http://localhost:${main.port}/via-name`);
      const [d2] = await emitLowStock(acmeId);
      await drain();
      expect(await deliveryOf(d2!.id)).toMatchObject({ status: 'delivered', last_status_code: 200 });
      expect(main.hits.map((x) => x.path)).toEqual(['/via-name']);
      await q(`DELETE FROM webhooks WHERE id = $1`, [local.id]);
    } finally {
      resetNetOptions();
    }
  });

  it('refuses http and loopback targets altogether when local targets are not allowed (production)', async () => {
    main.hits.length = 0;
    const h = await rawHook(acmeId, `http://127.0.0.1:${main.port}/prod`);
    setNetOptions({ allowLocal: false });
    try {
      const [d] = await emitLowStock(acmeId);
      await drain();
      expect(main.hits).toHaveLength(0);
      expect(await deliveryOf(d!.id)).toMatchObject({ status: 'retrying', last_error: 'The address must start with https://.' });
      // and the test button says the same
      const r = await (async () => {
        await fresh('admin@acme.demo');
        return admin.call('POST', `/api/webhooks/${h.id}/test`, {});
      })();
      expect(r.json).toMatchObject({ ok: false, status: null });
      expect(main.hits).toHaveLength(0);
    } finally {
      resetNetOptions();
      await q(`DELETE FROM webhooks WHERE id = $1`, [h.id]);
    }
  });

  it('tests an endpoint at once, limited to ten a minute, and stores nothing', async () => {
    const h = await createHook(admin, main.url + '/test', ['case.shipped']);
    main.hits.length = 0;
    main.mode = { status: 200 };
    const r = await admin.call('POST', `/api/webhooks/${h.id}/test`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ ok: true, status: 200 });
    expect(typeof r.json.durationMs).toBe('number');
    expect(r.json.durationMs).toBeGreaterThanOrEqual(0);
    expect(main.hits).toHaveLength(1);
    expect(verify(main.hits[0]!, h.secret)).toEqual({ ok: true });
    const body = JSON.parse(main.hits[0]!.body);
    expect(body).toMatchObject({ type: 'webhook.test', org_code: 'ACME' });
    expect(main.hits[0]!.headers['x-kph-event']).toBe('webhook.test');
    expect(main.hits[0]!.headers['x-kph-delivery']).toBe(body.id);
    expect(JSON.stringify(body.data)).not.toMatch(/Zelda|Quimby/);
    expect((await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1`, [h.id]))[0].n).toBe(0);
    expect((await hookOf(h.id)).consecutive_failures).toBe(0);
    expect((await auditOf(acmeId, 'webhook.tested')).pop()!.details).toMatchObject({ ok: true, status: 200 });

    main.mode = { status: 500 };
    const bad = await admin.call('POST', `/api/webhooks/${h.id}/test`, {});
    expect(bad.json).toMatchObject({ ok: false, status: 500, error: 'The endpoint answered with status 500.' });
    expect((await hookOf(h.id)).consecutive_failures).toBe(0); // a test never counts against the endpoint
    main.mode = { status: 200 };
    // 2 used, 8 left; the 11th call in the minute is refused
    for (let i = 0; i < 8; i++) expect((await admin.call('POST', `/api/webhooks/${h.id}/test`, {})).status).toBe(200);
    const limited = await admin.call('POST', `/api/webhooks/${h.id}/test`, {});
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe('rate_limited');
    // the limit is per endpoint
    const h2 = await createHook(admin, main.url + '/test2', ['case.shipped']);
    expect((await admin.call('POST', `/api/webhooks/${h2.id}/test`, {})).status).toBe(200);
    // it also works on a switched off endpoint, to check it before switching on
    await admin.call('PATCH', `/api/webhooks/${h2.id}`, { active: false });
    expect((await admin.call('POST', `/api/webhooks/${h2.id}/test`, {})).json.ok).toBe(true);
    await q(`DELETE FROM webhooks WHERE id IN ($1, $2)`, [h.id, h2.id]);
  });

  it('lists deliveries with filters and shows the payload', async () => {
    const h = await createHook(admin, main.url + '/history', ['materials.low_stock']);
    main.mode = { status: 200 };
    const ok = await emitLowStock(acmeId, 'SKU-OK');
    await drain();
    main.mode = { status: 500 };
    const bad = await emitLowStock(acmeId, 'SKU-BAD');
    await drain();
    main.mode = { status: 200 };
    const list = await admin.call('GET', `/api/webhooks/${h.id}/deliveries`);
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    const byId = Object.fromEntries(list.json.items.map((d: any) => [d.id, d]));
    expect(byId[ok[0]!.id]).toMatchObject({ event: 'materials.low_stock', status: 'delivered', attempts: 1, maxAttempts: 8, lastStatusCode: 200, lastError: null, nextAttemptAt: null });
    expect(byId[bad[0]!.id]).toMatchObject({ status: 'retrying', attempts: 1, lastStatusCode: 500, lastError: 'The endpoint answered with status 500.' });
    expect(new Date(byId[bad[0]!.id].nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect(byId[ok[0]!.id]).not.toHaveProperty('payload');
    for (const [status, n] of [['delivered', 1], ['retrying', 1], ['dead', 0], ['pending', 0]] as const) {
      expect((await admin.call('GET', `/api/webhooks/${h.id}/deliveries?status=${status}`)).json.total, status).toBe(n);
    }
    expect((await admin.call('GET', `/api/webhooks/${h.id}/deliveries?status=odd`)).status).toBe(400);
    expect((await admin.call('GET', `/api/webhooks/${h.id}/deliveries?event=case.shipped`)).json.total).toBe(0);
    const p = await admin.call('GET', `/api/webhooks/${h.id}/deliveries?pageSize=1&page=2`);
    expect(p.json.items).toHaveLength(1);
    expect(p.json).toMatchObject({ total: 2, page: 2, pageSize: 1 });

    const detail = await admin.call('GET', `/api/webhooks/${h.id}/deliveries/${ok[0]!.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.delivery.id).toBe(ok[0]!.id);
    expect(detail.json.payload).toMatchObject({ id: ok[0]!.id, type: 'materials.low_stock', data: { sku: 'SKU-OK' } });
    // a delivery of another endpoint is not found through this one
    const h2 = await createHook(admin, main.url + '/other', ['case.shipped']);
    expect((await admin.call('GET', `/api/webhooks/${h2.id}/deliveries/${ok[0]!.id}`)).status).toBe(404);
    expect((await admin.call('POST', `/api/webhooks/${h2.id}/deliveries/${ok[0]!.id}/retry`, {})).status).toBe(404);
    await q(`DELETE FROM webhooks WHERE id IN ($1, $2)`, [h.id, h2.id]);
  });

  it('writes the outbox in the same transaction as the change', async () => {
    const h = await createHook(admin, main.url + '/atomic', ['materials.low_stock', 'case.cancelled']);
    const count = async () => ({
      deliveries: (await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1`, [h.id]))[0].n as number,
      jobs: (await q(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'webhook.deliver'`))[0].n as number,
    });
    const before = await count();
    await expect(
      tx(SYSTEM, async (c) => {
        await emitMaterialsWebhook(c, acmeId, 'materials.low_stock', { materialId: randomUUID(), sku: 'ROLLED-BACK', siteCode: 'PT-CHV', onHand: 1, minStock: 2 });
        // visible inside the transaction
        const n = (await c.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1`, [h.id])).rows[0].n;
        expect(n).toBe(before.deliveries + 1);
        throw new Error('the business change failed');
      }),
    ).rejects.toThrow('the business change failed');
    expect(await count()).toEqual(before);

    // a real change that is rolled back: the partner cancels a draft but the transaction fails afterwards
    const c1 = await up.call('POST', '/api/cases', { caseId: uid() });
    const caseId = c1.json.case.id as string;
    await expect(
      tx({ orgId: acmeId, bypass: false }, async (c) => {
        await c.query(`UPDATE cases SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [caseId]);
        await emitCaseWebhook(c, caseId, 'case.cancelled', { status: 'cancelled' });
        throw new Error('later step failed');
      }),
    ).rejects.toThrow();
    expect(await count()).toEqual(before);
    expect((await up.call('GET', `/api/cases/${caseId}`)).json.case.status).toBe('draft');
    // committed, it is there
    expect((await up.call('POST', `/api/cases/${caseId}/cancel`, {})).status).toBe(200);
    const after = await count();
    expect(after.deliveries).toBe(before.deliveries + 1);
    expect(after.jobs).toBe(before.jobs + 1);
    await q(`DELETE FROM webhooks WHERE id = $1`, [h.id]);
  });

  it('picks up deliveries whose job got lost, and deletes old ones after 90 days', async () => {
    const h = await createHook(admin, main.url + '/lost', ['materials.low_stock']);
    main.hits.length = 0;
    const [d] = await emitLowStock(acmeId);
    await q(`DELETE FROM jobs WHERE kind = 'webhook.deliver' AND payload->>'deliveryId' = $1`, [d!.id]); // the job is lost
    await drain();
    expect(main.hits).toHaveLength(0);
    expect(await sweepDueDeliveries()).toBe(0); // too fresh
    await q(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '5 minutes' WHERE id = $1`, [d!.id]);
    expect(await sweepDueDeliveries()).toBe(1);
    expect(await sweepDueDeliveries()).toBe(0); // a job exists now
    await drain();
    expect(main.hits).toHaveLength(1);
    expect((await deliveryOf(d!.id)).status).toBe('delivered');

    // retention
    const [old] = await emitLowStock(acmeId);
    await q(`UPDATE webhook_deliveries SET created_at = now() - interval '91 days' WHERE id = $1`, [d!.id]);
    const report = await runRetention();
    expect(report.webhookDeliveries).toBeGreaterThanOrEqual(1);
    expect(await deliveryOf(d!.id)).toBeUndefined();
    expect(await deliveryOf(old!.id)).toBeTruthy();
    await q(`DELETE FROM webhooks WHERE id = $1`, [h.id]);
  });

  it('does not queue a payload larger than 64 KB', async () => {
    const h = await createHook(admin, main.url + '/big', ['materials.low_stock']);
    const made = await emitLowStock(acmeId, 'x'.repeat(70_000));
    expect(made).toHaveLength(0);
    await q(`DELETE FROM webhooks WHERE id = $1`, [h.id]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('events from the real flows', () => {
  let hooks: { all: { id: string; secret: string }; shippedOnly: { id: string; secret: string }; off: { id: string }; other: { id: string; secret: string } };
  let otherRx: Receiver;
  let shippedRx: Receiver;
  const byType = (hits: Hit[]) => {
    const out: Record<string, any[]> = {};
    for (const h of hits) (out[JSON.parse(h.body).type] ??= []).push(JSON.parse(h.body));
    return out;
  };

  it('delivers every event type once, to the right endpoints, without patient data or typed text', async () => {
    otherRx = await startReceiver();
    shippedRx = await startReceiver();
    main.hits.length = 0;
    main.mode = { status: 200 };
    const all = await createHook(admin, main.url + '/all');
    const shippedOnly = await createHook(admin, shippedRx.url, ['case.shipped']);
    const off = await createHook(admin, main.url + '/off');
    await admin.call('PATCH', `/api/webhooks/${off.id}`, { active: false });
    const other = await createHook(contoso, otherRx.url);
    hooks = { all, shippedOnly, off, other };

    // submitted
    const x = await readyCase();
    // on hold, released, routed again
    expect((await intake.call('POST', `/api/cases/${x.id}/hold`, { reason: 'Quimby reason text, please check' })).status).toBe(200);
    expect((await intake.call('POST', `/api/cases/${x.id}/release`, {})).status).toBe(200);
    expect((await intake.call('POST', `/api/cases/${x.id}/route`, { siteCode: 'PT-CHV' })).status).toBe(200);
    // acknowledged by the factory, then stage, shipped
    expect((await api(app, svcKey, 'POST', `/api/mes/v1/cases/${x.ref}/ack`, { mes_case_id: 'MES-' + x.ref })).json).toMatchObject({ ok: true });
    const at = () => new Date(Date.now() - 1000).toISOString();
    const ev = await mes([{ event_id: randomUUID(), case_ref: x.ref, stage_code: 'PRINT', occurred_at: at() }]);
    expect(ev.json.results[0].outcome).toBe('applied');
    // a claim while it is at the factory
    const claim = await aq.call('POST', '/api/claims', { caseId: x.id, summary: 'Zelda Quimby scratched the upper', description: 'Quimby description', items: [{ arch: 'upper', step: 1, defectCode: 'SCRATCHES', note: 'Quimby note' }] });
    expect(claim.status, JSON.stringify(claim.json)).toBe(201);
    const ship = await mes([{ event_id: randomUUID(), case_ref: x.ref, stage_code: 'SHIP', occurred_at: at(), carrier: 'DHL', tracking_number: 'TRK-123', aligners_shipped: 3 }]);
    expect(ship.json.results[0].outcome).toBe('applied');
    const del = await mes([{ event_id: randomUUID(), case_ref: x.ref, stage_code: 'DELIVERED', occurred_at: at() }]);
    expect(del.json.results[0].outcome).toBe('applied');
    // a cancelled draft
    const y = await up.call('POST', '/api/cases', { caseId: uid(), patientName: NAME });
    expect((await up.call('POST', `/api/cases/${y.json.case.id}/cancel`, {})).status).toBe(200);
    // a specification proposal
    const spec = await admin.call('POST', '/api/specs', {});
    expect(spec.status, JSON.stringify(spec.json)).toBe(201);
    await fresh('admin@acme.demo');
    expect((await admin.call('POST', `/api/specs/${spec.json.spec.id}/propose`, {})).status).toBe(200);
    // low stock
    const mat = await admin.call('POST', '/api/materials', { sku: 'BOX-7', name: 'Case box', category: 'box', perCase: 1, minStock: 10 });
    expect(mat.status, JSON.stringify(mat.json)).toBe(201);
    const adj = await klAdmin.call('POST', '/api/console/materials/adjust', { orgId: acmeId, materialId: mat.json.material.id, siteCode: 'PT-CHV', quantity: 5, reason: 'Opening stock' });
    expect(adj.status, JSON.stringify(adj.json)).toBe(200);

    await drain();

    const types = byType(main.hits.filter((h) => h.path === '/hook/all'));
    expect(Object.keys(types).sort()).toEqual([...WEBHOOK_EVENTS].sort());
    for (const t of WEBHOOK_EVENTS) expect(types[t], t).toHaveLength(1);
    // every delivery verifies with an independent check and carries its event and delivery ids
    for (const h of main.hits.filter((x) => x.path === '/hook/all')) {
      expect(verify(h, all.secret)).toEqual({ ok: true });
      const b = JSON.parse(h.body);
      expect(h.headers['x-kph-event']).toBe(b.type);
      expect(h.headers['x-kph-delivery']).toBe(b.id);
      expect(Object.keys(b)).toEqual(['id', 'type', 'created_at', 'org_code', 'data']);
      expect(b.org_code).toBe('ACME');
    }

    // exact payload shapes: references and counts only
    const keys = (o: any) => Object.keys(o.data).sort();
    const caseKeys = ['case_id', 'ref', 'simple_status', 'site', 'stage', 'stage_label', 'status'];
    const shipKeys = [...caseKeys, 'aligners_shipped', 'carrier', 'tracking_number'].sort();
    expect(keys(types['case.submitted']![0])).toEqual(caseKeys);
    expect(types['case.submitted']![0].data).toMatchObject({ ref: x.ref, status: 'ready', simple_status: 'submitted', stage: null, stage_label: null, site: 'PT-CHV' });
    expect(types['case.on_hold']![0].data).toMatchObject({ ref: x.ref, status: 'on_hold', simple_status: 'submitted' });
    expect(keys(types['case.on_hold']![0])).toEqual(caseKeys);
    expect(types['case.received']![0].data).toMatchObject({ ref: x.ref, status: 'received', simple_status: 'production', stage: 'received', stage_label: 'Received at factory' });
    expect(types['case.stage_changed']![0].data).toMatchObject({ ref: x.ref, status: 'in_production', simple_status: 'production', stage: 'printing', stage_label: '3D printing' });
    expect(keys(types['case.shipped']![0])).toEqual(shipKeys);
    expect(types['case.shipped']![0].data).toMatchObject({ ref: x.ref, status: 'shipped', simple_status: 'shipped', stage: 'shipped', carrier: 'DHL', tracking_number: 'TRK-123', aligners_shipped: 3 });
    expect(types['case.delivered']![0].data).toMatchObject({ ref: x.ref, status: 'delivered', simple_status: 'shipped', stage: 'delivered', carrier: 'DHL', tracking_number: 'TRK-123', aligners_shipped: 3 });
    expect(types['case.cancelled']![0].data).toMatchObject({ ref: y.json.case.ref, status: 'cancelled', simple_status: 'cancelled' });
    expect(types['claim.updated']![0].data).toEqual({ claim_number: claim.json.claim.number, case_ref: x.ref, status: 'open' });
    expect(types['spec.updated']![0].data).toEqual({ version: expect.any(Number), status: 'proposed' });
    expect(types['materials.low_stock']![0].data).toEqual({ sku: 'BOX-7', site: 'PT-CHV', on_hand: 5, min_stock: 10 });

    // none of what people typed, and no names, anywhere in any body or in the queue
    const everything = JSON.stringify(main.hits) + JSON.stringify(await q(`SELECT payload FROM webhook_deliveries`)) + JSON.stringify(await q(`SELECT payload FROM jobs WHERE kind = 'webhook.deliver'`));
    for (const t of [...TYPED, 'Case box', 'Opening stock', 'scratched', 'description', NAME, 'Marc']) expect(everything, t).not.toContain(t);

    // the other endpoints: only what they subscribed to, only their own company's events
    expect(shippedRx.hits).toHaveLength(1);
    expect(JSON.parse(shippedRx.hits[0]!.body).type).toBe('case.shipped');
    expect(verify(shippedRx.hits[0]!, shippedOnly.secret)).toEqual({ ok: true });
    expect(verify(shippedRx.hits[0]!, all.secret).ok).toBe(false); // every endpoint has its own secret
    expect(main.hits.filter((h) => h.path === '/hook/off')).toHaveLength(0);
    expect(otherRx.hits).toHaveLength(0);
    expect((await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1`, [other.id]))[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1`, [off.id]))[0].n).toBe(0);
    // none is left undelivered
    expect((await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = ANY($1) AND status <> 'delivered'`, [[all.id, shippedOnly.id]]))[0].n).toBe(0);
  });

  it('sends the events of direct manufacturing cases that the portal status sync finds', async () => {
    main.hits.length = 0;
    const pid = '9' + String(Date.now()).slice(-5);
    const { uuid } = await fake.createCase({ firstName: 'Zelda', lastName: 'Quimby', gender: 2, productType: 0 });
    const id = await tx(SYSTEM, async (c) => {
      const r = await insertCase(c, { orgId: acmeId, actor: { actorType: 'user', actorId: null }, mode: 'direct', caseId: pid, firstName: 'Zelda', lastName: 'Quimby' });
      await c.query(`UPDATE cases SET status = 'submitted', submitted_at = now(), portal_case_uuid = $2, portal_push = $3::jsonb WHERE id = $1`, [r.id, uuid, JSON.stringify({ status: 'pushed', attempts: 1 })]);
      return r.id;
    });
    const ref = (await q(`SELECT ref FROM cases WHERE id = $1`, [id]))[0].ref;
    fake.setPortalState(uuid, { status: 'InProduction' });
    await runPortalSync({ caseId: id });
    fake.setPortalState(uuid, { status: 'Shipped', trackingNumber: 'DHL Express JD014600003' });
    await runPortalSync({ caseId: id });
    await drain();
    const mine = main.hits.filter((h) => h.path === '/hook/all').map((h) => JSON.parse(h.body)).filter((b) => b.data.ref === ref)
      // deliveries run side by side, so the order of arrival is not fixed: put the events in the order they happened
      .sort((x, y) => ['case.stage_changed', 'case.shipped'].indexOf(x.type) - ['case.stage_changed', 'case.shipped'].indexOf(y.type));
    expect(mine.map((b) => b.type)).toEqual(['case.stage_changed', 'case.shipped']);
    expect(mine[0].data).toMatchObject({ case_id: pid, status: 'in_production', simple_status: 'production', stage: null, stage_label: null });
    expect(mine[1].data).toMatchObject({ case_id: pid, status: 'shipped', simple_status: 'shipped', carrier: 'DHL Express', tracking_number: 'JD014600003' });
    expect(JSON.stringify(main.hits)).not.toMatch(/Zelda|Quimby/);
    for (const h of main.hits.filter((x) => x.path === '/hook/all')) expect(verify(h, hooks.all.secret)).toEqual({ ok: true });
  });

  it('sends the submit event of a replacement order too', async () => {
    main.hits.length = 0;
    const shipped = await q(`SELECT id, ref FROM cases WHERE org_id = $1 AND status = 'delivered' AND manufacturing_mode = 'standard' LIMIT 1`, [acmeId]);
    const r = await up.call('POST', `/api/cases/${shipped[0].id}/replacement`, { items: [{ arch: 'upper', step: 1 }], reason: 'Lost in the post' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    await drain();
    const mine = main.hits.filter((h) => h.path === '/hook/all').map((h) => JSON.parse(h.body)).filter((b) => b.data.ref === r.json.case.ref);
    expect(mine.map((b) => b.type)).toEqual(['case.submitted']);
    expect(JSON.stringify(main.hits)).not.toContain('Lost in the post');
  });

  it('reports the events the observer sees, as before', async () => {
    const seen: string[] = [];
    setHookObserver((h) => seen.push(`${h.kind}:${h.event}`));
    try {
      const x = await up.call('POST', '/api/cases', { caseId: uid() });
      await up.call('POST', `/api/cases/${x.json.case.id}/cancel`, {});
    } finally {
      setHookObserver(null);
    }
    expect(seen).toEqual(['case:case.cancelled']);
    await otherRx.close();
    await shippedRx.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('email notices', () => {
  const box = (to: string, like: string) => mailbox(`to_addr = $1 AND subject LIKE $2`, [to, like]);
  let caseId: string;
  let ref: string;
  const team = ['admin@acme.demo', 'upload@acme.demo', 'quality@acme.demo', 'finance@acme.demo', 'viewer@acme.demo'];

  async function routedCase() {
    const id = await tx(SYSTEM, async (c) => {
      const r = await insertCase(c, { orgId: acmeId, actor: { actorType: 'user', actorId: null }, mode: 'standard', caseId: uid(), patientName: NAME, instructions: 'Zelda Quimby needs the attachments' });
      await c.query(`UPDATE cases SET status = 'ready', submitted_at = now(), ready_at = now(), site_id = (SELECT id FROM sites WHERE code = 'PT-CHV') WHERE id = $1`, [r.id]);
      return r.id as string;
    });
    return { id, ref: (await q(`SELECT ref FROM cases WHERE id = $1`, [id]))[0].ref as string };
  }

  it('lets each person switch email notices off without losing the bell', async () => {
    expect((await af.call('GET', '/api/account/notifications')).json).toEqual({ email: true });
    expect((await af.call('PUT', '/api/account/notifications', { email: 'no' })).status).toBe(400);
    expect((await af.call('PUT', '/api/account/notifications', {})).status).toBe(400);
    expect((await af.call('PUT', '/api/account/notifications', { email: false })).json).toEqual({ email: false });
    expect((await af.call('GET', '/api/account/notifications')).json).toEqual({ email: false });
    expect((await q(`SELECT notify_email FROM users WHERE email = 'finance@acme.demo'`))[0].notify_email).toBe(false);
    expect((await q(`SELECT notify_email FROM users WHERE email = 'admin@acme.demo'`))[0].notify_email).toBe(true); // nobody else is touched
    expect((await auditOf(acmeId, 'account.notifications_updated')).pop()!.details).toEqual({ email: false });
  });

  it('emails everyone who wants it when a case enters production, with fixed text and a link', async () => {
    const c = await routedCase();
    caseId = c.id;
    ref = c.ref;
    const before = await snap();
    expect((await api(app, svcKey, 'POST', `/api/mes/v1/cases/${ref}/ack`, { mes_case_id: 'MES-N-' + ref })).json.ok).toBe(true);
    await drain();
    const mails = (await since(before)).filter((m) => m.subject === `Case ${ref} is in production`);
    expect(mails.map((m) => m.to_addr).sort()).toEqual(team.filter((e) => e !== 'finance@acme.demo').sort());
    const m = mails[0];
    expect(m.body).toContain(`Case ${ref} is now in production at K Line.`);
    expect(m.body).toContain(`${PUBLIC_URL}/portal/cases/${caseId}`);
    expect(m.body).toContain(`${PUBLIC_URL}/portal/account`);
    expect(m.body).not.toMatch(/ [-–—] /);
    for (const mail of mails) for (const t of [...TYPED, NAME, 'U01', '.stl']) expect(mail.body + mail.subject).not.toContain(t);
    // the bell still has it, for the person who switched emails off as well
    const bell = await q(`SELECT u.email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'case_stage' AND (n.data->>'caseId') = $1`, [caseId]);
    expect(bell.map((b) => b.email).sort()).toEqual(team.sort());
  });

  it('holds back further changes of the same case for 15 minutes and sends the latest one when the window ends', async () => {
    const before = await snap();
    // printing is not worth an email; shipping is, but it comes inside the window
    await mes([{ event_id: randomUUID(), case_ref: ref, stage_code: 'PRINT', occurred_at: new Date(Date.now() - 2000).toISOString() }]);
    await mes([{ event_id: randomUUID(), case_ref: ref, stage_code: 'SHIP', occurred_at: new Date(Date.now() - 1000).toISOString(), carrier: 'DHL', tracking_number: 'TRK-N1', aligners_shipped: 2 }]);
    await drain();
    expect(await forRef(before, ref)).toHaveLength(0); // nothing new yet
    const pending = await q(`SELECT user_id FROM email_notice_log WHERE dedupe_key = $1 AND pending IS NOT NULL`, [`case:${caseId}`]);
    expect(pending).toHaveLength(4);
    // one closing job per person, even when more changes arrive
    await mes([{ event_id: randomUUID(), case_ref: ref, stage_code: 'DELIVERED', occurred_at: new Date().toISOString() }]);
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'notice.flush' AND status = 'queued' AND payload->>'key' = $1`, [`case:${caseId}`]))[0].n).toBe(4);
    await drain();
    expect(await forRef(before, ref)).toHaveLength(0);

    // a flush that wakes early waits for the real end of the window
    await q(`UPDATE jobs SET run_at = now() WHERE kind = 'notice.flush' AND status = 'queued' AND payload->>'key' = $1`, [`case:${caseId}`]);
    await drain();
    expect(await forRef(before, ref)).toHaveLength(0);
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'notice.flush' AND status = 'queued' AND payload->>'key' = $1`, [`case:${caseId}`]))[0].n).toBe(4);

    await q(`UPDATE email_notice_log SET sent_at = now() - interval '20 minutes' WHERE dedupe_key = $1`, [`case:${caseId}`]);
    await q(`UPDATE jobs SET run_at = now() WHERE kind = 'notice.flush' AND status = 'queued' AND payload->>'key' = $1`, [`case:${caseId}`]);
    await drain();
    const mails = await forRef(before, ref);
    expect(mails).toHaveLength(4); // one combined email each, and it is the newest state
    expect(mails.every((m) => m.subject === `Case ${ref} was delivered`)).toBe(true);
    expect(mails.map((m) => m.to_addr).sort()).toEqual(team.filter((e) => e !== 'finance@acme.demo').sort());
    expect(mails.some((m) => m.to_addr === 'finance@acme.demo')).toBe(false);
    expect((await q(`SELECT count(*)::int AS n FROM email_notice_log WHERE pending IS NOT NULL AND dedupe_key = $1`, [`case:${caseId}`]))[0].n).toBe(0);
    // the window starts again: the next change is held back again
    const again = await tx(SYSTEM, async (c) => (await c.query(`SELECT sent_at > now() - interval '1 minute' AS fresh FROM email_notice_log WHERE dedupe_key = $1 LIMIT 1`, [`case:${caseId}`])).rows[0]);
    expect(again.fresh).toBe(true);
  });

  it('does not email someone who switched emails off in the meantime, and treats another case on its own', async () => {
    const c = await routedCase();
    const before = await snap();
    await api(app, svcKey, 'POST', `/api/mes/v1/cases/${c.ref}/ack`, { mes_case_id: 'MES-M-' + c.ref });
    await drain();
    let mails = (await since(before)).filter((m) => m.subject === `Case ${c.ref} is in production`);
    expect(mails).toHaveLength(4); // a different case has its own window
    // an administrator switches off; the held back notice is dropped at the end of the window
    await mes([{ event_id: randomUUID(), case_ref: c.ref, stage_code: 'SHIP', occurred_at: new Date(Date.now() - 1000).toISOString(), carrier: 'UPS', tracking_number: 'TRK-M', aligners_shipped: 1 }]);
    await av.call('PUT', '/api/account/notifications', { email: false });
    const mid = await snap();
    await q(`UPDATE email_notice_log SET sent_at = now() - interval '20 minutes'`);
    await q(`UPDATE jobs SET run_at = now() WHERE kind = 'notice.flush' AND status = 'queued'`);
    await drain();
    mails = (await since(mid)).filter((m) => m.subject === `Case ${c.ref} has shipped`);
    expect(mails.map((m) => m.to_addr).sort()).toEqual(['admin@acme.demo', 'quality@acme.demo', 'upload@acme.demo']);
    await av.call('PUT', '/api/account/notifications', { email: true });
    await af.call('PUT', '/api/account/notifications', { email: true });
  });

  it('says a case is on hold without the reason, and mails the people who act on claims, specifications and low stock', async () => {
    const c = await routedCase();
    const before = await snap();
    expect((await intake.call('POST', `/api/cases/${c.id}/hold`, { reason: 'Quimby reason text, secret detail' })).status).toBe(200);
    await drain();
    const hold = (await since(before)).filter((m) => m.subject === `Case ${c.ref} is on hold`);
    expect(hold).toHaveLength(5);
    expect(hold[0].body).toContain('See the reason in the platform.');
    for (const m of hold) expect(m.body).not.toMatch(/Quimby|secret detail/);

    // K Line side: the claim of the main flow and the proposed specification reached K Line staff who can act on them
    const claim = await mailbox(`subject LIKE 'Update on claim CLM-%' AND to_addr = 'quality@kline.demo'`);
    expect(claim.length).toBeGreaterThan(0);
    const claimId = (await q(`SELECT id FROM claims ORDER BY created_at LIMIT 1`))[0].id;
    expect(claim[0].body).toContain(`${PUBLIC_URL}/console/claims/${claimId}`);
    expect(claim[0].body).not.toMatch(/Quimby|scratched/);
    expect(await mailbox(`subject LIKE 'Update on claim%' AND to_addr = 'finance@kline.demo'`)).toHaveLength(0); // no claim rights
    const spec = await mailbox(`subject = 'A production specification is waiting for your signature' AND to_addr = 'admin@kline.demo'`);
    expect(spec.length).toBeGreaterThan(0);
    expect(spec[0].body).toMatch(new RegExp(`${PUBLIC_URL}/console/specs/${acmeId}/[0-9a-f-]{36}`));
    // low stock goes to the people who manage materials, with no material name
    const stock = await mailbox(`subject = 'Materials running low at K Line'`);
    expect(stock.map((m) => m.to_addr)).toEqual(['admin@acme.demo']);
    expect(stock[0].body).toContain('K Line site PT-CHV');
    expect(stock[0].body).not.toMatch(/Case box|BOX-7/);
    expect(await mailbox(`to_addr = 'upload@acme.demo' AND subject LIKE 'Materials%'`)).toHaveLength(0);
  });

  it('never mails anything that is not a notice kind, and keeps registration emails as they were', async () => {
    const before = await snap();
    await tx(SYSTEM, async (c) => {
      const { notifyOrg } = await import('../src/services/notify');
      await notifyOrg(c, { orgId: acmeId, kind: 'case_routed', title: 'Case approved for production', body: 'Case X' });
      await notifyOrg(c, { orgId: acmeId, kind: 'case_stage', title: '3D printing', body: 'Case X', data: { caseId: randomUUID(), ref: 'X', stage: 'printing' } });
    });
    await drain();
    expect(await since(before)).toHaveLength(0);
  });
});
