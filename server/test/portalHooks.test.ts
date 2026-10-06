import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { CSRF_EXEMPT, buildApp, isCsrfExempt } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { decryptField, fieldAad } from '../src/crypto/keys';
import { redactUrl } from '../src/http/util';
import { registeredJobKinds } from '../src/jobs';
import { runDueJobs } from '../src/worker';
import { insertCase } from '../src/services/cases';
import { FakePortalClient, setPortalClientFactory } from '../src/services/portal';
import { HOOK_RATE_PER_HOOK, hookRateAllowed, publicUrlWarning, readHint, resetHookRates, tokensMatch } from '../src/services/portalHooks';
import { Client, createDemoUser, orgIdOf } from './helpers';

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);

const logs: string[] = [];
let app: FastifyInstance;
let acmeId: string;
let contosoId: string;
let admin: Client;
let uploader: Client;
let contosoAdmin: Client;
let kline: Client;
const fakes: Record<string, FakePortalClient> = {};
let n = 0;
let ipN = 0;

// Names that appear in a message and must never be kept anywhere.
const LEAK = 'Fernsby';
const PATIENT_IN_MESSAGE = `Hedwig ${LEAK}`;

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (chunk, _e, cb) => { logs.push(String(chunk)); cb(); } }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  contosoId = await tx(SYSTEM, async (c) => (await c.query(`INSERT INTO organizations (kind, name, code, country, status) VALUES ('partner', 'Contoso Smile', 'CONTOSO', 'PT', 'active') RETURNING id`)).rows[0].id);
  await createDemoUser(contosoId, 'admin@contoso.demo', 'Cora Contoso', ['admin']);
  fakes[acmeId] = new FakePortalClient();
  fakes[contosoId] = new FakePortalClient();
  setPortalClientFactory((org) => fakes[org.id] ?? null);
  admin = await new Client(app).full('admin@acme.demo');
  uploader = await new Client(app).full('upload@acme.demo');
  contosoAdmin = await new Client(app).full('admin@contoso.demo');
  kline = await new Client(app).full('admin@kline.demo');
});

afterAll(async () => {
  setPortalClientFactory(undefined);
  await app.close();
  await closePools();
});

const nextIp = () => `10.77.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
const expireStepUp = async (email: string) => {
  await tx(SYSTEM, (c) => c.query(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE lower(email) = $1) AND revoked_at IS NULL`, [email]));
};
const hookIdOf = (url: string) => url.split('/').pop()!;

/** Creates or rotates a receiver the way the settings page does. */
async function makeHook(c: Client, email: string) {
  await c.stepUp(email);
  const r = await c.call('POST', '/api/org/portal-api/webhook', {});
  expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);
  return { url: r.json.url as string, secret: r.json.secret as string, hookId: hookIdOf(r.json.url), status: r.status };
}

interface HitOpts { header?: string; secret?: string | null; body?: unknown; raw?: string | Buffer; ip?: string; contentType?: string | null; cookie?: string }
/** What the K Line portal does: POST JSON with the secret token header. */
async function hit(hookId: string, o: HitOpts = {}) {
  const headers: Record<string, string> = {};
  if (o.secret !== null && o.secret !== undefined) headers[o.header ?? 'x-kline-secret-token'] = o.secret;
  if (o.contentType !== null) headers['content-type'] = o.contentType ?? 'application/json';
  if (o.cookie) headers.cookie = o.cookie;
  const payload = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  const res = await app.inject({ method: 'POST', url: `/api/hooks/kline-portal/${hookId}`, headers, payload: payload as any, remoteAddress: o.ip ?? nextIp() });
  let json: any = null;
  try { json = res.json(); } catch { /* empty */ }
  return { status: res.statusCode, json, text: res.body };
}

/** A submitted direct case that the portal already has. */
async function pushedCase(orgId: string, opts: { status?: string } = {}) {
  n++;
  const pid = `8${String(n).padStart(5, '0')}`;
  const fake = fakes[orgId]!;
  const { uuid } = await fake.createCase({ firstName: 'Zelda', lastName: 'Quimby', gender: 2, productType: 0 });
  const id = await tx(SYSTEM, async (c) => {
    const r = await insertCase(c, { orgId, actor: { actorType: 'user', actorId: null }, mode: 'direct', caseId: pid, firstName: 'Zelda', lastName: 'Quimby' });
    await c.query(`UPDATE cases SET status = $2, submitted_at = now(), portal_case_uuid = $3, portal_push = $4::jsonb WHERE id = $1`, [r.id, opts.status ?? 'submitted', uuid, JSON.stringify({ status: 'pushed', attempts: 1 })]);
    return r.id;
  });
  return { id, uuid, fake };
}
const caseRow = async (id: string) => (await q('SELECT * FROM cases WHERE id = $1', [id]))[0];
const syncJobs = (caseId?: string) => q(`SELECT * FROM jobs WHERE kind = 'portal.sync.case' ${caseId ? `AND payload->>'caseId' = $1` : ''} ORDER BY id`, caseId ? [caseId] : []);
const openJobs = async (caseId: string) => (await q(`SELECT * FROM jobs WHERE kind = 'portal.sync.case' AND payload->>'caseId' = $1 AND status IN ('queued', 'running')`, [caseId])).length;
const hookRow = async (orgId: string) => (await q('SELECT * FROM portal_hooks WHERE org_id = $1', [orgId]))[0];
const casePortalMessage = (uuid: string, extra: Record<string, unknown> = {}) => ({
  event: 'update', type: 'case', uuid,
  data: { case_id: 123, first_name: 'Hedwig', last_name: LEAK, patient_name: PATIENT_IN_MESSAGE, case_status: 'Shipped', tracking_number: 'DHL LEAK-TRACK-1', ...extra },
});

describe('helpers', () => {
  it('registers the job kind and adds the receiver to the CSRF exempt list', () => {
    expect(registeredJobKinds()).toContain('portal.sync.case');
    expect(isCsrfExempt('/api/hooks/kline-portal/abc')).toBe(true);
    expect(isCsrfExempt('/api/org/portal-api/webhook')).toBe(false);
    expect(CSRF_EXEMPT.has('/api/auth/login')).toBe(true);
  });

  it('flags a public address the portal cannot reach', () => {
    for (const u of ['http://localhost:4000', 'https://localhost', 'http://hub.example.com', 'https://127.0.0.1:4000', 'https://10.1.2.3', 'https://172.20.0.5', 'https://192.168.1.20', 'https://169.254.1.1', 'https://[::1]', 'https://hub.local', 'https://hub', 'not a url']) {
      expect(publicUrlWarning(u), u).toBe(true);
    }
    for (const u of ['https://hub.example.com', 'https://abc-123.trycloudflare.com', 'https://172.32.0.1', 'https://8.8.8.8']) expect(publicUrlWarning(u), u).toBe(false);
  });

  it('compares tokens in constant time without caring about length, and reads only a type and a uuid from a message', () => {
    expect(tokensMatch('whsec_abc', 'whsec_abc')).toBe(true);
    expect(tokensMatch('whsec_abd', 'whsec_abc')).toBe(false);
    expect(tokensMatch('x', 'whsec_abc')).toBe(false);
    expect(tokensMatch('', '')).toBe(false);
    expect(tokensMatch(undefined, 'a')).toBe(false);
    expect(tokensMatch(['whsec_abc'], 'whsec_abc')).toBe(false);
    const uuid = '3f0c7a52-8d0c-4e3b-9f3e-1a2b3c4d5e6f';
    expect(readHint(Buffer.from(JSON.stringify({ type: 'case', uuid, data: { name: 'x' } })))).toEqual({ type: 'case', uuid });
    expect(readHint(Buffer.from('not json'))).toBeNull();
    expect(readHint(Buffer.from('[]'))).toBeNull();
    expect(readHint(Buffer.from('null'))).toBeNull();
    expect(readHint(Buffer.from(JSON.stringify({ type: 'case', uuid: "x'; DROP TABLE cases;--" })))).toBeNull();
    expect(readHint(Buffer.from(JSON.stringify({ type: 5, uuid })))).toBeNull();
    expect(readHint(undefined)).toBeNull();
  });

  it('hides the receiver address in logged URLs', () => {
    expect(redactUrl('/api/hooks/kline-portal/AbCdEf123_-')).toBe('/api/hooks/kline-portal/[redacted]');
  });

  it('limits one receiver to 600 messages a minute', () => {
    resetHookRates();
    const t = 1_000_000;
    for (let i = 0; i < HOOK_RATE_PER_HOOK; i++) expect(hookRateAllowed('h1', t)).toBe(true);
    expect(hookRateAllowed('h1', t + 10)).toBe(false);
    expect(hookRateAllowed('h2', t + 10)).toBe(true);
    expect(hookRateAllowed('h1', t + 61_000)).toBe(true);
    resetHookRates();
  });
});

describe('managing the receiver', () => {
  it('shows nothing set up at first, and warns that a local address cannot be reached', async () => {
    const r = await admin.call('GET', '/api/org/portal-api');
    expect(r.status).toBe(200);
    expect(r.json.webhook).toMatchObject({ configured: false, url: null, lastReceivedAt: null, receivedCount: 0, lastResult: null, publicUrlWarning: true });
  });

  it('needs step up, the permission and an approved company', async () => {
    await expireStepUp('admin@acme.demo');
    for (const method of ['POST', 'DELETE']) {
      const r = await admin.call(method, '/api/org/portal-api/webhook', {});
      expect(r.status, method).toBe(403);
      expect(r.json.code, method).toBe('step_up_required');
    }
    expect(await hookRow(acmeId)).toBeUndefined();
    // uploaders do not hold integration.manage
    for (const [method, url] of [['GET', '/api/org/portal-api'], ['POST', '/api/org/portal-api/webhook'], ['DELETE', '/api/org/portal-api/webhook']] as const) {
      expect((await uploader.call(method, url, method === 'GET' ? undefined : {})).status, method).toBe(403);
    }
    // K Line staff have no receiver of their own to manage
    await kline.stepUp('admin@kline.demo');
    expect((await kline.call('POST', '/api/org/portal-api/webhook', {})).status).toBe(403);
    // a company that K Line has not approved yet is locked out of changes, but can still read
    await admin.stepUp('admin@acme.demo');
    await q(`UPDATE organizations SET status = 'onboarding' WHERE id = $1`, [acmeId]);
    try {
      const locked = await admin.call('POST', '/api/org/portal-api/webhook', {});
      expect(locked.status).toBe(403);
      expect(locked.json.code).toBe('org_not_approved');
      expect((await admin.call('DELETE', '/api/org/portal-api/webhook', {})).json.code).toBe('org_not_approved');
      expect((await admin.call('GET', '/api/org/portal-api')).status).toBe(200);
    } finally {
      await q(`UPDATE organizations SET status = 'active' WHERE id = $1`, [acmeId]);
    }
    expect(await hookRow(acmeId)).toBeUndefined();
  });

  it('creates a receiver, shows the secret once and stores it encrypted', async () => {
    await admin.stepUp('admin@acme.demo');
    const r = await admin.call('POST', '/api/org/portal-api/webhook', {});
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.rotated).toBe(false);
    expect(r.json.url).toMatch(/^http:\/\/localhost:4000\/api\/hooks\/kline-portal\/[A-Za-z0-9_-]{32}$/);
    expect(r.json.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);

    const row = await hookRow(acmeId);
    expect(row.hook_id).toBe(hookIdOf(r.json.url));
    expect(row.secret_enc.startsWith('f1.')).toBe(true);
    expect(row.secret_enc).not.toContain(r.json.secret);
    expect(decryptField(row.secret_enc, fieldAad.portalHook(acmeId))).toBe(r.json.secret);
    expect(() => decryptField(row.secret_enc, fieldAad.portalHook(contosoId))).toThrow();

    const g = await admin.call('GET', '/api/org/portal-api');
    expect(g.json.webhook).toMatchObject({ configured: true, url: r.json.url, receivedCount: 0, lastReceivedAt: null, publicUrlWarning: true });
    expect(JSON.stringify(g.json)).not.toContain(r.json.secret);
    const a = await q(`SELECT details, target_type FROM audit_log WHERE action = 'portal_hook.created' AND org_id = $1`, [acmeId]);
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a)).not.toContain(r.json.secret);
  });

  it('rotating gives a new secret on the same address and stops the old one at once', async () => {
    const first = await makeHook(admin, 'admin@acme.demo'); // this is a rotation: one exists already
    expect(first.status).toBe(200);
    const row = await hookRow(acmeId);
    expect(row.rotated_at).toBeTruthy();
    const second = await makeHook(admin, 'admin@acme.demo');
    expect(second.url).toBe(first.url);
    expect(second.secret).not.toBe(first.secret);
    expect((await hit(first.hookId, { secret: first.secret, body: { type: 'doctor', uuid: '3f0c7a52-8d0c-4e3b-9f3e-1a2b3c4d5e6f' } })).status).toBe(401);
    expect((await hit(second.hookId, { secret: second.secret, body: { type: 'doctor', uuid: '3f0c7a52-8d0c-4e3b-9f3e-1a2b3c4d5e6f' } })).status).toBe(200);
    const actions = (await q(`SELECT action, details FROM audit_log WHERE action LIKE 'portal_hook.%' AND org_id = $1 ORDER BY seq`, [acmeId])).map((x) => x.action);
    expect(actions.filter((a) => a === 'portal_hook.rotated')).toHaveLength(2);
    expect(JSON.stringify(await q(`SELECT details FROM audit_log WHERE action LIKE 'portal_hook.%'`))).not.toMatch(/whsec_/);
  });

  it('keeps each organisation to its own receiver', async () => {
    const mine = (await admin.call('GET', '/api/org/portal-api')).json.webhook;
    const theirsBefore = (await contosoAdmin.call('GET', '/api/org/portal-api')).json.webhook;
    expect(mine.configured).toBe(true);
    expect(theirsBefore).toMatchObject({ configured: false, url: null });
    const c = await makeHook(contosoAdmin, 'admin@contoso.demo');
    expect(c.hookId).not.toBe(hookIdOf(mine.url));
    // row level security: a session of one company sees only its own row
    const seenByContoso = await tx({ orgId: contosoId, bypass: false }, async (cl) => (await cl.query('SELECT org_id FROM portal_hooks')).rows);
    expect(seenByContoso.map((r: any) => r.org_id)).toEqual([contosoId]);
    const seenByAcme = await tx({ orgId: acmeId, bypass: false }, async (cl) => (await cl.query('SELECT org_id FROM portal_hooks')).rows);
    expect(seenByAcme.map((r: any) => r.org_id)).toEqual([acmeId]);
    // a company cannot write a receiver for another company
    await expect(tx({ orgId: contosoId, bypass: false }, (cl) => cl.query(`UPDATE portal_hooks SET secret_enc = 'x' WHERE org_id = $1`, [acmeId]))).resolves.toMatchObject({ rowCount: 0 });
    await expect(tx({ orgId: contosoId, bypass: false }, (cl) => cl.query(`INSERT INTO portal_hooks (org_id, hook_id, secret_enc) VALUES ($1, $2, 'x')`, [acmeId, 'x'.repeat(32)]))).rejects.toThrow();
    // the other company's secret does not open this company's receiver
    expect((await hit(hookIdOf(mine.url), { secret: c.secret, body: {} })).status).toBe(401);
    // remove it again so later tests start clean
    await contosoAdmin.stepUp('admin@contoso.demo');
    expect((await contosoAdmin.call('DELETE', '/api/org/portal-api/webhook', {})).status).toBe(200);
    expect((await hit(c.hookId, { secret: c.secret, body: {} })).status).toBe(404);
    expect((await admin.call('GET', '/api/org/portal-api')).json.webhook.configured).toBe(true);
  });

  it('deletes the receiver, and the address stops answering', async () => {
    const h = await makeHook(admin, 'admin@acme.demo');
    expect((await hit(h.hookId, { secret: h.secret, body: {} })).status).toBe(200);
    await expireStepUp('admin@acme.demo');
    expect((await admin.call('DELETE', '/api/org/portal-api/webhook', {})).json.code).toBe('step_up_required');
    await admin.stepUp('admin@acme.demo');
    const d = await admin.call('DELETE', '/api/org/portal-api/webhook', {});
    expect(d.status).toBe(200);
    expect(await hookRow(acmeId)).toBeUndefined();
    expect((await hit(h.hookId, { secret: h.secret, body: {} })).status).toBe(404);
    expect((await admin.call('DELETE', '/api/org/portal-api/webhook', {})).status).toBe(404);
    expect((await admin.call('GET', '/api/org/portal-api')).json.webhook.configured).toBe(false);
    expect((await q(`SELECT 1 FROM audit_log WHERE action = 'portal_hook.deleted' AND org_id = $1`, [acmeId])).length).toBe(1);
  });
});

describe('receiving messages', () => {
  let hook: { url: string; secret: string; hookId: string };
  beforeAll(async () => {
    hook = await makeHook(admin, 'admin@acme.demo');
  });

  it('accepts the secret in the underscore header name that the portal form shows, and ignores spaces around it', async () => {
    const h = hook;
    expect((await hit(h.hookId, { header: 'x-kline-secret_token', secret: h.secret, body: { type: 'doctor', uuid: '3f0c7a52-8d0c-4e3b-9f3e-1a2b3c4d5e6f' } })).status).toBe(200);
    expect((await hit(h.hookId, { header: 'x-kline-secret-token', secret: `  ${h.secret}  `, body: {} })).status).toBe(200);
    expect((await hit(h.hookId, { header: 'x-kline-secret_token', secret: 'wrong-secret-wrong-secret-12345', body: {} })).status).toBe(401);
  });

  it('answers 404 for an unknown or malformed address', async () => {
    for (const id of ['A'.repeat(32), 'short', 'x'.repeat(40), '..%2f..%2fetc']) {
      const r = await hit(id, { secret: hook.secret, body: {} });
      expect(r.status, id).toBe(404);
      expect(r.json.code).toBe('not_found');
    }
  });

  it('answers 401 with a generic body for a missing or wrong secret, and does nothing', async () => {
    const c = await pushedCase(acmeId);
    c.fake.setPortalState(c.uuid, { status: 'InProduction' });
    const before = (await syncJobs()).length;
    const calls = [
      await hit(hook.hookId, { body: casePortalMessage(c.uuid) }),
      await hit(hook.hookId, { secret: '', body: casePortalMessage(c.uuid) }),
      await hit(hook.hookId, { secret: 'whsec_' + 'a'.repeat(43), body: casePortalMessage(c.uuid) }),
      await hit(hook.hookId, { secret: hook.secret.slice(0, -1), body: casePortalMessage(c.uuid) }),
      await hit(hook.hookId, { secret: hook.secret + 'x', raw: 'not json at all' }),
    ];
    for (const r of calls) {
      expect(r.status).toBe(401);
      expect(r.json).toEqual({ code: 'unauthorised', message: 'Not authorised.' });
    }
    expect((await syncJobs()).length).toBe(before);
    expect((await caseRow(c.id)).status).toBe('submitted');
    expect((await hookRow(acmeId)).last_result).toBe('bad_secret');
  });

  it('writes at most one audit entry a minute for wrong secrets, with counts only', async () => {
    await q(`UPDATE portal_hooks SET last_bad_audit_at = NULL, bad_secret_count = 0 WHERE org_id = $1`, [acmeId]);
    const countAudit = async () => (await q(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'portal_hook.bad_secret' AND org_id = $1`, [acmeId]))[0].n as number;
    const start = await countAudit();
    for (let i = 0; i < 6; i++) expect((await hit(hook.hookId, { secret: `wrong-secret-${i}-padding`, body: casePortalMessage('3f0c7a52-8d0c-4e3b-9f3e-1a2b3c4d5e6f') })).status).toBe(401);
    expect(await countAudit()).toBe(start + 1);
    expect(Number((await hookRow(acmeId)).bad_secret_count)).toBe(6);
    await q(`UPDATE portal_hooks SET last_bad_audit_at = now() - interval '2 minutes' WHERE org_id = $1`, [acmeId]);
    await hit(hook.hookId, { secret: 'wrong-again-padding-x', body: {} });
    expect(await countAudit()).toBe(start + 2);
    const entries = await q(`SELECT details, actor_type FROM audit_log WHERE action = 'portal_hook.bad_secret' AND org_id = $1 ORDER BY seq DESC LIMIT 2`, [acmeId]);
    expect(entries[0].details).toMatchObject({ badSecretAttempts: 7 });
    // which header name the sender used is recorded (never its value), to help with set up problems
    expect(['hyphen', 'underscore', 'both', 'none']).toContain((entries[0].details as any).tokenHeader);
    const dump = JSON.stringify(entries);
    expect(dump).not.toContain('wrong-');
    expect(dump).not.toContain(LEAK);
    // valid messages do not count as wrong ones
    expect(Number((await hookRow(acmeId)).bad_secret_count)).toBe(7);
  });

  it('queues exactly one job for an own case, reads the REAL status from the portal, and ships the case with tracking', async () => {
    const c = await pushedCase(acmeId);
    c.fake.setPortalState(c.uuid, { status: 'Shipped', trackingNumber: 'DHL Express JD014600003' });
    const reads = () => c.fake.calls.filter((x) => x.op === 'getCase' && x.caseUuid === c.uuid).length;
    const r = await hit(hook.hookId, { secret: hook.secret, body: casePortalMessage(c.uuid) });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    const jobs = await syncJobs(c.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'queued', org_id: acmeId });
    expect(jobs[0].payload).toEqual({ caseId: c.id });
    expect(reads()).toBe(0); // nothing is read inside the request
    expect((await caseRow(c.id)).status).toBe('submitted');

    await runDueJobs();
    expect((await syncJobs(c.id))[0].status).toBe('done');
    expect(reads()).toBe(1);
    expect(await caseRow(c.id)).toMatchObject({ status: 'shipped', carrier: 'DHL Express', tracking: 'JD014600003' });

    const row = await hookRow(acmeId);
    expect(row.last_result).toBe('ok');
    expect(row.last_received_at).toBeTruthy();
    expect(Number(row.received_count)).toBeGreaterThanOrEqual(1);
    const g = (await admin.call('GET', '/api/org/portal-api')).json.webhook;
    expect(g).toMatchObject({ configured: true, lastResult: 'ok' });
    expect(g.receivedCount).toBe(Number(row.received_count));
    expect(typeof g.lastReceivedAt).toBe('string');
  });

  it('takes the status from the portal and never from the message: a forged message changes nothing', async () => {
    const c = await pushedCase(acmeId);
    // The portal still says New. The message claims the case shipped with a tracking number.
    const r = await hit(hook.hookId, { secret: hook.secret, body: casePortalMessage(c.uuid, { case_status: 'Shipped', tracking_number: 'FORGED 1234' }) });
    expect(r.status).toBe(200);
    expect(await openJobs(c.id)).toBe(1);
    await runDueJobs();
    expect(await caseRow(c.id)).toMatchObject({ status: 'submitted', tracking: null, carrier: null });
    expect((await q(`SELECT 1 FROM case_events WHERE case_id = $1 AND data::text LIKE '%FORGED%'`, [c.id])).length).toBe(0);
  });

  it('ignores a case uuid that belongs to another organisation, whatever the portal says', async () => {
    const theirs = await pushedCase(contosoId);
    theirs.fake.setPortalState(theirs.uuid, { status: 'Shipped', trackingNumber: 'DHL 555' });
    const before = (await syncJobs()).length;
    const r = await hit(hook.hookId, { secret: hook.secret, body: casePortalMessage(theirs.uuid) });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect((await syncJobs()).length).toBe(before);
    await runDueJobs();
    expect(await caseRow(theirs.id)).toMatchObject({ status: 'submitted', tracking: null });
    expect(theirs.fake.calls.filter((x) => x.op === 'getCase' && x.caseUuid === theirs.uuid)).toHaveLength(0);
    expect(fakes[acmeId]!.calls.filter((x) => x.caseUuid === theirs.uuid)).toHaveLength(0);
    expect((await hookRow(acmeId)).last_result).toBe('ignored');
    // the answer is the same as for a case that exists nowhere
    const nowhere = await hit(hook.hookId, { secret: hook.secret, body: casePortalMessage('3f0c7a52-8d0c-4e3b-9f3e-1a2b3c4d5e6f') });
    expect(nowhere).toMatchObject({ status: 200, json: { ok: true }, text: r.text });
  });

  it('coalesces a burst of messages for one case into one job, and queues another once it is done', async () => {
    const c = await pushedCase(acmeId);
    c.fake.setPortalState(c.uuid, { status: 'InProduction' });
    const rs = await Promise.all(Array.from({ length: 12 }, () => hit(hook.hookId, { secret: hook.secret, body: casePortalMessage(c.uuid) })));
    expect(rs.every((r) => r.status === 200 && r.json.ok === true)).toBe(true);
    expect(await syncJobs(c.id)).toHaveLength(1);

    // a job that waits out a retry delay is brought forward instead of queueing a second one
    await q(`UPDATE jobs SET run_at = now() + interval '1 hour' WHERE kind = 'portal.sync.case' AND payload->>'caseId' = $1`, [c.id]);
    await hit(hook.hookId, { secret: hook.secret, body: casePortalMessage(c.uuid) });
    let jobs = await syncJobs(c.id);
    expect(jobs).toHaveLength(1);
    expect(new Date(jobs[0].run_at).getTime()).toBeLessThanOrEqual(Date.now());

    // while it is running no second job is queued either
    await q(`UPDATE jobs SET status = 'running', locked_at = now() WHERE id = $1`, [jobs[0].id]);
    await hit(hook.hookId, { secret: hook.secret, body: casePortalMessage(c.uuid) });
    expect(await syncJobs(c.id)).toHaveLength(1);
    await q(`UPDATE jobs SET status = 'queued', locked_at = NULL WHERE id = $1`, [jobs[0].id]);

    await runDueJobs();
    expect((await caseRow(c.id)).status).toBe('in_production');
    expect((await syncJobs(c.id))[0].status).toBe('done');
    // later news about the same case gets a new job
    c.fake.setPortalState(c.uuid, { status: 'Shipped', trackingNumber: 'UPS 1Z777' });
    await hit(hook.hookId, { secret: hook.secret, body: casePortalMessage(c.uuid) });
    jobs = await syncJobs(c.id);
    expect(jobs).toHaveLength(2);
    await runDueJobs();
    expect(await caseRow(c.id)).toMatchObject({ status: 'shipped', carrier: 'UPS', tracking: '1Z777' });
  });

  it('answers 200 and does nothing for comments, doctors, treatment plans, test requests and odd bodies', async () => {
    const c = await pushedCase(acmeId);
    c.fake.setPortalState(c.uuid, { status: 'InProduction' });
    const before = (await syncJobs()).length;
    const messages: HitOpts[] = [
      { body: { event: 'insert', type: 'comment', uuid: '3f0c7a52-8d0c-4e3b-9f3e-1a2b3c4d5e6f', data: { author: 'kline', case_id: 5, case_uuid: c.uuid, comments: `Please call ${PATIENT_IN_MESSAGE}` } } },
      { body: { event: 'insert', type: 'comment', uuid: c.uuid, data: { case_uuid: c.uuid } } },
      { body: { event: 'insert', type: 'doctor', uuid: c.uuid, data: {} } },
      { body: { event: 'update', type: 'treatment_plan', uuid: c.uuid, data: {} } },
      { body: { event: 'update', type: 'case', uuid: '3f0c7a52-8d0c-4e3b-9f3e-1a2b3c4d5e6f', data: {} } },
      { body: { event: 'test', message: 'Test request' } },
      { body: {} },
      { body: [] },
      { body: null },
      { raw: '{"type":"case","uuid":' },
      { raw: 'plain text' },
      { raw: '' },
      { raw: Buffer.from([0xff, 0xfe, 0x00, 0x01]) },
      { raw: JSON.stringify({ type: 'case', uuid: { $ne: 1 } }) },
      { raw: JSON.stringify(casePortalMessage(c.uuid)), contentType: 'text/plain' },
    ];
    // The last one is a real case message sent as text/plain: it is handled like any other and queues one job.
    for (const m of messages.slice(0, -1)) {
      const r = await hit(hook.hookId, { secret: hook.secret, ...m });
      expect(r.status, JSON.stringify(m).slice(0, 80)).toBe(200);
      expect(r.json).toEqual({ ok: true });
    }
    expect((await syncJobs()).length).toBe(before);
    expect((await hookRow(acmeId)).last_result).toBe('ignored');
    // no content type at all, and a body sent as text, still work
    const textual = await hit(hook.hookId, { secret: hook.secret, ...messages[messages.length - 1]! });
    expect(textual.status).toBe(200);
    expect(await openJobs(c.id)).toBe(1);
    expect((await hit(hook.hookId, { secret: hook.secret, contentType: null })).status).toBe(200);
  });

  it('refuses a body over 256 KB', async () => {
    const big = JSON.stringify({ type: 'comment', uuid: 'x', data: { comments: 'a'.repeat(300 * 1024) } });
    const r = await hit(hook.hookId, { secret: hook.secret, raw: big });
    expect(r.status).toBe(413);
    expect(r.text).not.toContain('aaaa');
    const ok = JSON.stringify({ type: 'comment', uuid: 'x', data: { comments: 'a'.repeat(200 * 1024) } });
    expect((await hit(hook.hookId, { secret: hook.secret, raw: ok })).status).toBe(200);
  });

  it('does nothing for cancelled or shipped cases, or when the company is not approved', async () => {
    const done = await pushedCase(acmeId, { status: 'cancelled' });
    const before = (await syncJobs()).length;
    expect((await hit(hook.hookId, { secret: hook.secret, body: casePortalMessage(done.uuid) })).status).toBe(200);
    expect((await syncJobs()).length).toBe(before);

    const c = await pushedCase(acmeId);
    await q(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [acmeId]);
    try {
      expect((await hit(hook.hookId, { secret: hook.secret, body: casePortalMessage(c.uuid) })).status).toBe(200);
      expect(await openJobs(c.id)).toBe(0);
    } finally {
      await q(`UPDATE organizations SET status = 'active' WHERE id = $1`, [acmeId]);
    }
  });

  it('retries with the normal backoff when the portal cannot be read, with a fixed error text', async () => {
    // Jobs left over from earlier tests would run in parallel and could take the planned failure, so finish them first.
    await runDueJobs();
    expect(await q("SELECT 1 FROM jobs WHERE kind = 'portal.sync.case' AND status IN ('queued', 'running')")).toHaveLength(0);
    const c = await pushedCase(acmeId);
    c.fake.setPortalState(c.uuid, { status: 'InProduction' });
    c.fake.failNext('getCase', 'server', 1, 503);
    await hit(hook.hookId, { secret: hook.secret, body: casePortalMessage(c.uuid) });
    await runDueJobs();
    let job = (await syncJobs(c.id))[0];
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(1);
    expect(new Date(job.run_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(job.last_error).toBe('The status check for the case failed.');
    expect(JSON.stringify(job)).not.toContain(LEAK);
    expect((await caseRow(c.id)).status).toBe('submitted');
    // a new message brings the waiting job forward; the next run succeeds
    await hit(hook.hookId, { secret: hook.secret, body: casePortalMessage(c.uuid) });
    expect(await syncJobs(c.id)).toHaveLength(1);
    await runDueJobs();
    job = (await syncJobs(c.id))[0];
    expect(job).toMatchObject({ status: 'done', attempts: 2 });
    expect((await caseRow(c.id)).status).toBe('in_production');
  });

  it('works without a session or CSRF token, even when a session cookie is sent along', async () => {
    const r = await hit(hook.hookId, { secret: hook.secret, body: { type: 'doctor', uuid: '3f0c7a52-8d0c-4e3b-9f3e-1a2b3c4d5e6f' }, cookie: admin.cookie });
    expect(r.status).toBe(200);
    // other writes with that cookie still need the CSRF token
    const noCsrf = await app.inject({ method: 'POST', url: '/api/org/portal-api/webhook', headers: { cookie: admin.cookie }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().code).toBe('csrf_invalid');
    // only POST exists
    expect((await app.inject({ method: 'GET', url: `/api/hooks/kline-portal/${hook.hookId}` })).statusCode).toBe(404);
  });

  it('limits each address to 120 requests a minute and each receiver to 600', async () => {
    const ip = nextIp();
    const codes: number[] = [];
    for (let i = 0; i < 125; i++) codes.push((await hit('B'.repeat(32), { secret: 'x', body: {}, ip })).status);
    expect(codes.slice(0, 120).every((c) => c === 404)).toBe(true);
    expect(codes.slice(120).every((c) => c === 429)).toBe(true);
    // another address is not affected
    expect((await hit(hook.hookId, { secret: hook.secret, body: {} })).status).toBe(200);
    // the receiver as a whole: fill its window, then any address is refused
    resetHookRates();
    for (let i = 0; i < HOOK_RATE_PER_HOOK; i++) hookRateAllowed(hook.hookId);
    const over = await hit(hook.hookId, { secret: hook.secret, body: {} });
    expect(over.status).toBe(429);
    expect(over.json.code).toBe('rate_limited');
    resetHookRates();
    expect((await hit(hook.hookId, { secret: hook.secret, body: {} })).status).toBe(200);
  });

  it('never keeps anything from a message: not in jobs, events, audit entries, the receiver row, notifications or the case', async () => {
    const c = await pushedCase(acmeId);
    c.fake.setPortalState(c.uuid, { status: 'Shipped', trackingNumber: 'DHL 4242' });
    const msg = casePortalMessage(c.uuid, { comments: `Call ${PATIENT_IN_MESSAGE} on 555 0100`, email: `${LEAK.toLowerCase()}@example.test` });
    const good = await hit(hook.hookId, { secret: hook.secret, body: msg });
    const bad = await hit(hook.hookId, { secret: 'wrong-secret-for-leak-scan', body: msg });
    await runDueJobs();
    expect(good.status).toBe(200);
    expect(bad.status).toBe(401);
    const dump = JSON.stringify([
      await q('SELECT * FROM jobs'),
      await q('SELECT * FROM case_events'),
      await q('SELECT * FROM audit_log'),
      await q('SELECT * FROM portal_hooks'),
      await q('SELECT * FROM notifications'),
      await q(`SELECT portal_push, tracking, carrier FROM cases`),
      await q('SELECT * FROM webhook_deliveries'),
      good.text, bad.text,
    ]);
    for (const word of [LEAK, 'Hedwig', 'LEAK-TRACK', '555 0100', 'wrong-secret-for-leak-scan']) expect(dump, word).not.toContain(word);
  });

  it('keeps secrets and message content out of the request logs', async () => {
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('/api/hooks/kline-portal/[redacted]');
    for (const word of [hook.secret, 'wrong-secret', 'whsec_', LEAK, 'Hedwig', 'LEAK-TRACK', hook.hookId, 'x-kline-secret-token']) expect(text, word).not.toContain(word);
    // no logged request carries headers or a body at all
    for (const line of text.split('\n').filter((l) => l.includes('kline-portal'))) {
      const j = JSON.parse(line);
      expect(Object.keys(j.req ?? {}).sort()).toEqual(['method', 'remoteAddress', 'url']);
    }
  });

  it('never returns the secret after it was created', async () => {
    const all = JSON.stringify([
      (await admin.call('GET', '/api/org/portal-api')).json,
      (await hit(hook.hookId, { secret: hook.secret, body: {} })).json,
      (await hit(hook.hookId, { secret: 'nope', body: {} })).json,
    ]);
    expect(all).not.toContain(hook.secret);
    expect(all).not.toContain('secret_enc');
  });
});
