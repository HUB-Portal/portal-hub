import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { createApiKey } from '../src/auth/apikeys';
import { runDueJobs } from '../src/worker';
import { runRetention } from '../src/services/retention';
import { bookConsumption } from '../src/services/materials';
import { setHookObserver, type HookCall } from '../src/services/webhooks';
import { storage, chunkKey } from '../src/storage';
import { canonicalJson, defaultSpecContent, hashSpec, type SpecContent } from '../../shared/spec';
import { Client, PNG_BYTES, createDemoUser, cubeStl, minimalPdf, orgIdOf, trimLine } from './helpers';

let app: FastifyInstance;
let acmeId: string;
let contosoId: string;
let klineId: string;
let admin: Client; // Acme admin
let up: Client; // Acme uploader
let aq: Client; // Acme quality (Quinn Quality)
let aq2: Client; // second Acme quality user
let af: Client; // Acme finance
let av: Client; // Acme viewer
let contoso: Client;
let klAdmin: Client;
let kl2: Client; // a second K Line administrator
let svcKey: string;
const hooks: HookCall[] = [];

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const NAME = 'Marc Alonso'; // synthetic patient name that must never appear in notifications, jobs, audit or hook payloads
const ZERO = '00000000-0000-4000-8000-000000000000';
let ipCounter = 1;

const expireStepUp = (email: string) => q(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL`, [email]);
const freshStepUp = () => q(`UPDATE sessions SET step_up_at = now() WHERE revoked_at IS NULL`);

async function svc(method: string, url: string, body?: unknown, key: string = svcKey) {
  const res = await app.inject({ method: method as any, url, payload: body as any, headers: { authorization: `Bearer ${key}` }, remoteAddress: `10.9.1.${ipCounter++ % 250}` });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* binary */
  }
  return { status: res.statusCode, json, res };
}
async function withKey(scopes: string[], method: string, url: string, body?: unknown) {
  const k = await tx({ orgId: acmeId, bypass: false }, (c) => createApiKey(c, { orgId: acmeId, orgKind: 'partner', name: 'p4 test', scopes, expiresInDays: 30 }));
  const res = await app.inject({ method: method as any, url, payload: body as any, headers: { authorization: `Bearer ${k.key}` }, remoteAddress: `10.9.2.${ipCounter++ % 250}` });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* binary */
  }
  return { status: res.statusCode, json };
}

async function newCase(c: Client, body: Record<string, unknown> = {}) {
  const r = await c.call('POST', '/api/cases', { caseId: `P4-${Math.random().toString(36).slice(2, 8)}`, ...body });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.case as any;
}

/** A submitted and routed case with U01 (and its trim line), U02 and L01. */
async function readyCase() {
  const c = await newCase(up, { patientName: NAME, instructions: 'Leave the attachments as designed.' });
  const data = { u1: cubeStl(50, 'model one'), u2: cubeStl(45, 'model two'), l1: cubeStl(40, 'model low'), pts: trimLine() };
  const f1 = await up.uploadFile(c.id, 'U01.stl', data.u1);
  const f1p = await up.uploadFile(c.id, 'U01.pts', data.pts);
  const f2 = await up.uploadFile(c.id, 'U02.stl', data.u2);
  const f3 = await up.uploadFile(c.id, 'L01.stl', data.l1);
  const sub = await up.call('POST', `/api/cases/${c.id}/submit`, { acknowledgeWarnings: true });
  expect(sub.status, JSON.stringify(sub.json)).toBe(200);
  expect(sub.json.case.status).toBe('ready');
  return { id: c.id as string, ref: c.ref as string, case: sub.json.case as any, data, ids: { u1: f1.fileId, pts: f1p.fileId, u2: f2.fileId, l1: f3.fileId } };
}
type Ready = Awaited<ReturnType<typeof readyCase>>;

async function ship(id: string, n = 3) {
  const r = await klAdmin.call('POST', `/api/cases/${id}/stage`, { stage: 'shipped', carrier: 'DHL', trackingNumber: `TRK-${Math.random().toString(36).slice(2, 8)}`, alignersShipped: n });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}

/** Uploads one small file for a claim or shipment through the chunked protocol and waits for the checks. */
async function uploadFor(c: Client, purpose: 'claim' | 'shipment', ownerId: string, name: string, data: Buffer) {
  const init = await c.call('POST', '/api/uploads', { purpose, ...(purpose === 'claim' ? { claimId: ownerId } : { shipmentId: ownerId }), name, size: data.length });
  if (init.status !== 200) return { init, fileId: null as string | null, file: null as any };
  const fileId = init.json.fileId as string;
  const put = await c.putChunk(fileId, 0, data);
  expect(put.status, JSON.stringify(put.json)).toBe(200);
  const done = await c.call('POST', `/api/uploads/${fileId}/complete`, {});
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  await runDueJobs();
  const f = await c.call('GET', `/api/files/${fileId}`);
  return { init, fileId, file: f.json };
}

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(40, 1)]);

async function specContent(c: Client, id: string): Promise<SpecContent> {
  const r = await c.call('GET', `/api/specs/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.spec.content;
}

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
  await createDemoUser(acmeId, 'quality2@acme.demo', 'Quincy Quality', ['quality']);
  await createDemoUser(klineId, 'admin2@kline.demo', 'Kim Admin', ['kl_admin']);
  up = await new Client(app).full('upload@acme.demo');
  admin = await new Client(app).full('admin@acme.demo');
  aq = await new Client(app).full('quality@acme.demo');
  aq2 = await new Client(app).full('quality2@acme.demo');
  af = await new Client(app).full('finance@acme.demo');
  av = await new Client(app).full('viewer@acme.demo');
  contoso = await new Client(app).full('admin@contoso.demo');
  klAdmin = await new Client(app).full('admin@kline.demo');
  kl2 = await new Client(app).full('admin2@kline.demo');
  const k = await klAdmin.call('POST', '/api/service-keys', { name: 'Phase 4 factory system', scopes: ['mes:intake', 'mes:files', 'mes:events'], expiresInDays: 30 });
  expect(k.status, JSON.stringify(k.json)).toBe(201);
  svcKey = k.json.key;
  setHookObserver((h) => hooks.push(h));
});

afterAll(async () => {
  setHookObserver(null);
  await app.close();
  await closePools();
});

let preSpecCase: Ready;

// ---------------------------------------------------------------------------------------------------------------------
describe('production specification', () => {
  let v1: string;
  let v2: string;
  let v3: string;
  let v4: string;

  it('starts without a specification and offers the default template with its hash', async () => {
    const list = await aq.call('GET', '/api/specs');
    expect(list.status).toBe(200);
    expect(list.json).toEqual({ items: [], activeId: null });
    expect((await aq.call('GET', '/api/specs/active')).json).toEqual({ spec: null });
    const def = await aq.call('GET', '/api/specs/default');
    expect(def.status).toBe(200);
    expect(def.json.contentHash).toBe(await hashSpec(defaultSpecContent()));
    expect(def.json.content.bag.lines.length).toBeGreaterThan(0);
    // K Line staff must say which partner they mean
    expect((await klAdmin.call('GET', '/api/specs')).status).toBe(400);
    expect((await klAdmin.call('GET', '/api/specs')).json.code).toBe('org_required');
  });

  it('gives cases submitted before any specification no spec version', async () => {
    preSpecCase = await readyCase();
    expect(preSpecCase.case.specVersion).toBeNull();
  });

  it('lets a partner quality user draft and edit; invalid content is refused with the reason', async () => {
    const c = await aq.call('POST', '/api/specs', { changeNote: 'First version' });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    v1 = c.json.spec.id;
    expect(c.json.spec).toMatchObject({ version: 1, status: 'draft', createdSide: 'partner', changeNote: 'First version', partnerSignature: null, klineSignature: null });
    expect(c.json.spec.actions).toMatchObject({ edit: true, delete: true, propose: true, sign: false });
    expect(c.json.spec.contentHash).toBe(await hashSpec(c.json.spec.content));

    const bad = defaultSpecContent();
    bad.finish.clauses.push({ id: 'FN-1', title: 'Duplicate', text: 'Again' });
    const refused = await aq.call('PUT', `/api/specs/${v1}`, { content: bad });
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe('invalid_spec');
    expect(JSON.stringify(refused.json.problems)).toMatch(/FN-1/);
    expect((await aq.call('PUT', `/api/specs/${v1}`, {})).status).toBe(400);

    const edited = defaultSpecContent();
    edited.marking.clauses.push({ id: 'MK-3', title: 'Batch number', text: 'The batch number is printed on the bag.' });
    const ok = await aq.call('PUT', `/api/specs/${v1}`, { content: edited, changeNote: 'Adds a batch number' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.spec.contentHash).toBe(await hashSpec(edited));
    expect(ok.json.spec.contentHash).toBe(createHash('sha256').update(canonicalJson(edited)).digest('hex'));
    expect(ok.json.spec.changeNote).toBe('Adds a batch number');
  });

  it('keeps a draft private to the side that started it', async () => {
    expect((await klAdmin.call('GET', `/api/console/specs/${v1}`)).status).toBe(404);
    expect((await klAdmin.call('GET', `/api/specs/${v1}`)).status).toBe(404);
    expect((await klAdmin.call('GET', `/api/console/specs?orgId=${acmeId}`)).json.items).toEqual([]);
    expect((await klAdmin.call('PUT', `/api/console/specs/${v1}`, { content: defaultSpecContent() })).status).toBe(404);
    expect((await contoso.call('GET', `/api/specs/${v1}`)).status).toBe(404);
    expect((await contoso.call('GET', '/api/specs')).json.items).toEqual([]);
    expect((await up.call('PUT', `/api/specs/${v1}`, { content: defaultSpecContent() })).status).toBe(403); // spec.edit is needed
  });

  it('needs a fresh authenticator code to propose, then freezes the content', async () => {
    await expireStepUp('quality@acme.demo');
    const denied = await aq.call('POST', `/api/specs/${v1}/propose`, {});
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('step_up_required');
    await aq.stepUp('quality@acme.demo');
    const r = await aq.call('POST', `/api/specs/${v1}/propose`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.spec).toMatchObject({ status: 'proposed', partnerSignature: null, klineSignature: null });
    expect((await aq.call('PUT', `/api/specs/${v1}`, { content: defaultSpecContent() })).json.code).toBe('spec_not_draft');
    expect((await aq.call('DELETE', `/api/specs/${v1}`)).status).toBe(409);
    expect((await aq.call('POST', `/api/specs/${v1}/propose`, {})).status).toBe(409);
    // the proposer's side has not signed just by proposing
    expect(r.json.spec.actions.sign).toBe(true);
    // K Line staff are told
    await runDueJobs();
    const n = await q(`SELECT * FROM notifications WHERE org_id = $1 AND kind = 'spec_proposed'`, [klineId]);
    expect(n.length).toBe(1);
    expect(n[0].user_id).toBeNull();
  });

  it('activates once both sides have signed, with different people, and never twice for one side', async () => {
    await freshStepUp();
    // people without spec.sign cannot sign
    for (const c of [up, af, av]) expect((await c.call('POST', `/api/specs/${v1}/sign`, {})).status).toBe(403);
    // not the version that was shown
    const wrong = await klAdmin.call('POST', `/api/console/specs/${v1}/sign`, { contentHash: '0'.repeat(64) });
    expect(wrong.status).toBe(409);
    expect(wrong.json.code).toBe('hash_mismatch');
    // step up is needed
    await expireStepUp('admin@kline.demo');
    const noStep = await klAdmin.call('POST', `/api/console/specs/${v1}/sign`, {});
    expect(noStep.json.code).toBe('step_up_required');
    await freshStepUp();

    const seen = await klAdmin.call('GET', `/api/console/specs/${v1}`);
    const first = await klAdmin.call('POST', `/api/console/specs/${v1}/sign`, { contentHash: seen.json.spec.contentHash });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.spec.status).toBe('proposed');
    expect(first.json.spec.klineSignature).toMatchObject({ name: 'Katrin Admin' });
    expect(first.json.spec.partnerSignature).toBeNull();
    // the same person, and a colleague on the same side, cannot sign again
    expect((await klAdmin.call('POST', `/api/specs/${v1}/sign`, {})).json.code).toBe('already_signed');
    expect((await kl2.call('POST', `/api/specs/${v1}/sign`, {})).json.code).toBe('already_signed');

    const second = await aq.call('POST', `/api/specs/${v1}/sign`, {});
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(second.json.spec).toMatchObject({ status: 'active', partnerSignature: { name: 'Quinn Quality' }, klineSignature: { name: 'Katrin Admin' } });
    expect(second.json.spec.activatedAt).toBeTruthy();
    expect((await aq2.call('POST', `/api/specs/${v1}/sign`, {})).status).toBe(409); // no longer proposed

    // the signed hash is the SHA-256 of the canonical JSON and the stored text still matches it
    const spec = second.json.spec;
    expect(spec.contentHash).toBe(createHash('sha256').update(canonicalJson(spec.content)).digest('hex'));
    expect(spec.contentHash).toBe(await hashSpec(spec.content));
    // organisation bag layout is taken from the spec
    const org = await q(`SELECT settings FROM organizations WHERE id = $1`, [acmeId]);
    expect(org[0].settings.bag).toEqual(spec.content.bag);
    // signatures recorded with user, name and time
    const row = (await q(`SELECT * FROM specs WHERE id = $1`, [v1]))[0];
    expect(row.partner_signed_by).toBeTruthy();
    expect(row.kline_signed_by).toBeTruthy();
    expect(row.partner_signed_by).not.toBe(row.kline_signed_by);
    expect(hooks.some((h) => h.kind === 'spec' && h.event === 'spec.updated' && h.id === v1 && h.data.status === 'active')).toBe(true);
    const act = await aq.call('GET', '/api/specs/active');
    expect(act.json.spec.id).toBe(v1);
    // both sides were told (K Line through the worker)
    await runDueJobs();
    const n = await q(`SELECT org_id FROM notifications WHERE kind = 'spec_activated' AND data->>'specId' = $1`, [v1]);
    expect(n.map((x) => x.org_id).sort()).toEqual([acmeId, klineId].sort());
  });

  it('attaches the active spec version to a case at submit and passes it to the factory', async () => {
    const k = await readyCase();
    expect(k.case.specVersion).toBe(1);
    const detail = await up.call('GET', `/api/cases/${k.id}`);
    expect(detail.json.case.specVersion).toBe(1);
    expect((await q(`SELECT spec_id FROM cases WHERE id = $1`, [k.id]))[0].spec_id).toBe(v1);
    const r = await svc('GET', '/api/mes/v1/intake?site=PT-CHV');
    expect(r.json.cases.find((x: any) => x.ref === k.ref).spec_version).toBe(1);
    expect(r.json.cases.find((x: any) => x.ref === preSpecCase.ref).spec_version).toBeNull();
    // the case list carries it too
    const list = await up.call('GET', `/api/cases?search=${k.ref}`);
    expect(list.json.items[0].specVersion).toBe(1);
  });

  it('lets K Line propose a change for a partner; the partner rejects it with a note', async () => {
    expect((await klAdmin.call('POST', '/api/console/specs', {})).json.code).toBe('org_required');
    expect((await klAdmin.call('POST', '/api/console/specs', { orgId: klineId })).status).toBe(404); // not a partner
    expect((await aq.call('POST', '/api/console/specs', { orgId: acmeId })).status).toBe(403); // console is for K Line

    const c = await klAdmin.call('POST', '/api/console/specs', { orgId: acmeId, changeNote: 'Shorter wear time' });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    v2 = c.json.spec.id;
    expect(c.json.spec).toMatchObject({ version: 2, status: 'draft', createdSide: 'kline', orgId: acmeId });
    const content = await specContent(klAdmin, v2);
    expect(content.marking.clauses.some((x) => x.id === 'MK-3')).toBe(true); // copied from the active version
    content.bag.wearDays = 10;
    expect((await klAdmin.call('PUT', `/api/console/specs/${v2}`, { content })).status).toBe(200);
    // the partner cannot see the draft
    expect((await aq.call('GET', `/api/specs/${v2}`)).status).toBe(404);

    await expireStepUp('admin@kline.demo');
    expect((await klAdmin.call('POST', `/api/console/specs/${v2}/propose`, {})).json.code).toBe('step_up_required');
    await freshStepUp();
    const p = await klAdmin.call('POST', `/api/console/specs/${v2}/propose`, {});
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.spec.status).toBe('proposed');
    expect((await aq.call('GET', `/api/specs/${v2}`)).status).toBe(200);

    const noNote = await aq.call('POST', `/api/specs/${v2}/reject`, { note: '' });
    expect(noNote.status).toBe(400);
    expect(noNote.json.code).toBe('note_required');
    expect((await aq.call('POST', `/api/specs/${v2}/reject`, {})).status).toBe(400);
    const rej = await aq.call('POST', `/api/specs/${v2}/reject`, { note: 'Ten days is too short for our protocol.' });
    expect(rej.status, JSON.stringify(rej.json)).toBe(200);
    expect(rej.json.spec).toMatchObject({ status: 'rejected', rejectionNote: 'Ten days is too short for our protocol.' });
    expect((await aq.call('POST', `/api/specs/${v2}/sign`, {})).json.code).toBe('spec_not_proposed');
    expect((await aq.call('POST', `/api/specs/${v2}/reject`, { note: 'Again' })).status).toBe(409);
    // the proposer is told; the active version is untouched
    await runDueJobs();
    const n = await q(`SELECT * FROM notifications WHERE org_id = $1 AND kind = 'spec_rejected'`, [klineId]);
    expect(n.length).toBe(1);
    expect((await aq.call('GET', '/api/specs/active')).json.spec.id).toBe(v1);
    // rejected versions cannot be signed by K Line either
    await freshStepUp();
    expect((await klAdmin.call('POST', `/api/console/specs/${v2}/sign`, {})).status).toBe(409);
  });

  it('supersedes the previous version and keeps only one active, whichever side signs first', async () => {
    const c = await klAdmin.call('POST', '/api/console/specs', { orgId: acmeId, baseSpecId: v1, changeNote: 'Clearer bags' });
    v3 = c.json.spec.id;
    expect(c.json.spec.version).toBe(3);
    const content = await specContent(klAdmin, v3);
    content.bag.wearDays = 21;
    content.bag.lines = ['{ref}', 'Custom {aligner}'];
    content.finish.clauses[0]!.text = 'All edges are smooth, polished and free of burrs.';
    expect((await klAdmin.call('PUT', `/api/console/specs/${v3}`, { content })).status).toBe(200);
    await freshStepUp();
    expect((await klAdmin.call('POST', `/api/console/specs/${v3}/propose`, {})).status).toBe(200);

    const first = await aq.call('POST', `/api/specs/${v3}/sign`, {});
    expect(first.json.spec.status).toBe('proposed');
    expect(first.json.spec.partnerSignature).toBeTruthy();
    const second = await kl2.call('POST', `/api/console/specs/${v3}/sign`, {});
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(second.json.spec.status).toBe('active');
    const rows = await q(`SELECT id, status FROM specs WHERE org_id = $1 ORDER BY version`, [acmeId]);
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'rejected', 'active']);
    expect(rows.filter((r) => r.status === 'active').length).toBe(1);
    // the database itself refuses a second active version
    await expect(q(`UPDATE specs SET status = 'active' WHERE id = $1`, [v1])).rejects.toThrow();
    const list = await aq.call('GET', '/api/specs');
    expect(list.json.activeId).toBe(v3);
    expect(list.json.items.map((s: any) => [s.version, s.status])).toEqual([[3, 'active'], [2, 'rejected'], [1, 'superseded']]);
    expect(list.json.items[0].content).toBeUndefined();
    // history is readable, hashes differ, and old signatures are kept
    const old = await aq.call('GET', `/api/specs/${v1}`);
    expect(old.json.spec.status).toBe('superseded');
    expect(old.json.spec.contentHash).not.toBe(second.json.spec.contentHash);
    expect(old.json.spec.partnerSignature).toBeTruthy();
  });

  it('makes the active spec authoritative for the bag layout', async () => {
    const g = await admin.call('GET', '/api/org/bag-layout');
    expect(g.json).toMatchObject({ lockedBySpec: true, specVersion: 3, layout: { wearDays: 21, lines: ['{ref}', 'Custom {aligner}'] } });
    const put = await admin.call('PUT', '/api/org/bag-layout', { ...g.json.layout, wearDays: 5 });
    expect(put.status).toBe(409);
    expect(put.json.code).toBe('bag_in_spec');
    // the factory gets the spec's layout
    const k = await readyCase();
    expect(k.case.specVersion).toBe(3);
    const r = await svc('GET', '/api/mes/v1/intake?site=PT-CHV');
    const item = r.json.cases.find((x: any) => x.ref === k.ref);
    expect(item.spec_version).toBe(3);
    expect(item.bags[0]).toMatchObject({ aligner: 'U01', lines: [k.ref, 'Custom U01'] });
    // a case submitted before any specification keeps having none
    expect((await up.call('GET', `/api/cases/${preSpecCase.id}`)).json.case.specVersion).toBeNull();
  });

  it('shows a clause level diff between versions', async () => {
    const d = await aq.call('GET', `/api/specs/${v3}/diff/${v1}`);
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json.from).toMatchObject({ id: v1, version: 1 });
    expect(d.json.to).toMatchObject({ id: v3, version: 3 });
    const finish = d.json.sections.find((s: any) => s.section === 'finish');
    expect(finish.changed.map((c: any) => c.id)).toEqual(['FN-1']);
    expect(finish.changed[0]).toMatchObject({ textChanged: true, titleChanged: false });
    expect(d.json.bag.changed).toBe(true);
    expect(d.json.changeCount).toBe(2);
    expect((await aq.call('GET', `/api/specs/${v3}/diff/${v3}`)).json.changeCount).toBe(0);
    expect((await contoso.call('GET', `/api/specs/${v3}/diff/${v1}`)).status).toBe(404);
    expect((await klAdmin.call('GET', `/api/console/specs/${v3}/diff/${v1}`)).status).toBe(200);
    expect((await aq.call('GET', `/api/console/specs/${v3}/diff/${v1}`)).status).toBe(403);
  });

  it('lets the partner propose its own version; K Line signs it and the partner countersigns with another person', async () => {
    const c = await aq.call('POST', '/api/specs', { changeNote: 'Add a scratch limit' });
    v4 = c.json.spec.id;
    expect(c.json.spec.version).toBe(4);
    const content = await specContent(aq, v4);
    content.finish.clauses.push({ id: 'FN-4', title: 'Scratch limit', text: 'No scratch deeper than 0.1 mm.' });
    expect((await aq.call('PUT', `/api/specs/${v4}`, { content })).status).toBe(200);
    // drafts of the partner are invisible to K Line
    expect((await klAdmin.call('GET', `/api/console/specs?orgId=${acmeId}`)).json.items.map((s: any) => s.version)).toEqual([3, 2, 1]);
    await freshStepUp();
    expect((await aq.call('POST', `/api/specs/${v4}/propose`, {})).status).toBe(200);
    expect((await klAdmin.call('POST', `/api/console/specs/${v4}/sign`, {})).json.spec.status).toBe('proposed');
    const done = await aq2.call('POST', `/api/specs/${v4}/sign`, {});
    expect(done.json.spec.status).toBe('active');
    expect((await q(`SELECT count(*)::int AS n FROM specs WHERE org_id = $1 AND status = 'active'`, [acmeId]))[0].n).toBe(1);
    expect((await q(`SELECT status FROM specs WHERE id = $1`, [v3]))[0].status).toBe('superseded');
    // deleting: only drafts of your own side
    const d = await aq.call('POST', '/api/specs', {});
    expect(d.status).toBe(201);
    expect((await klAdmin.call('DELETE', `/api/console/specs/${d.json.spec.id}`)).status).toBe(404);
    expect((await aq.call('DELETE', `/api/specs/${d.json.spec.id}`)).json).toEqual({ ok: true });
  });

  it('summarises every partner for K Line and records the workflow in the partner audit log', async () => {
    const s = await klAdmin.call('GET', '/api/console/specs/partners');
    expect(s.status).toBe(200);
    const acme = s.json.items.find((x: any) => x.orgId === acmeId);
    expect(acme).toMatchObject({ name: 'Acme Aligners', activeVersion: 4, proposed: null });
    expect(s.json.items.find((x: any) => x.orgId === contosoId)).toMatchObject({ activeVersion: null });
    expect((await aq.call('GET', '/api/console/specs/partners')).status).toBe(403);
    const audit = await admin.call('GET', '/api/audit?action=spec.&limit=100');
    const actions = audit.json.entries.map((e: any) => e.action);
    for (const a of ['spec.draft_created', 'spec.proposed', 'spec.signed', 'spec.activated', 'spec.rejected', 'spec.superseded']) expect(actions).toContain(a);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('quality claims', () => {
  let k: Ready; // shipped case under spec version 1
  let claimId: string;
  let claimNumber: string;
  let evidenceId: string;
  let reworkId: string;

  it('refuses a claim on a case that has not reached the factory', async () => {
    k = await readyCase();
    const r = await aq.call('POST', '/api/claims', { caseId: k.id, summary: 'Cracked', items: [{ arch: 'upper', step: 2, defectCode: 'CRACK' }] });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('case_not_claimable');
    const draft = await newCase(up);
    expect((await aq.call('POST', '/api/claims', { caseId: draft.id, summary: 'Nothing yet', items: [{ arch: 'upper', step: 1, defectCode: 'CRACK' }] })).json.code).toBe('case_not_claimable');
    await ship(k.id);
  });

  it('validates the request: items, aligners, defect codes, clauses and who may ask', async () => {
    const base = { caseId: k.id, summary: 'Cracked at the edge', items: [{ arch: 'upper', step: 2, defectCode: 'CRACK' }] };
    expect((await aq.call('POST', '/api/claims', { ...base, items: [] })).status).toBe(400);
    expect((await aq.call('POST', '/api/claims', { ...base, summary: '' })).status).toBe(400);
    expect((await aq.call('POST', '/api/claims', { ...base, items: [{ arch: 'upper', step: 2, defectCode: 'BROKEN' }] })).status).toBe(400);
    const unknown = await aq.call('POST', '/api/claims', { ...base, items: [{ arch: 'upper', step: 9, defectCode: 'CRACK' }] });
    expect(unknown.status).toBe(409);
    expect(unknown.json.code).toBe('unknown_aligner');
    expect((await aq.call('POST', '/api/claims', { ...base, items: [{ arch: 'upper', step: 1, template: true, defectCode: 'CRACK' }] })).json.code).toBe('unknown_aligner');
    const clause = await aq.call('POST', '/api/claims', { ...base, specClauseIds: ['ZZ-9'] });
    expect(clause.status).toBe(400);
    expect(clause.json.code).toBe('unknown_clause');
    // a case made before any specification has no clauses to cite
    await ship(preSpecCase.id);
    expect((await aq.call('POST', '/api/claims', { caseId: preSpecCase.id, summary: 'Cite', specClauseIds: ['MT-1'], items: [{ arch: 'upper', step: 1, defectCode: 'CRACK' }] })).json.code).toBe('unknown_clause');
    // permissions
    expect((await up.call('POST', '/api/claims', base)).status).toBe(403); // uploader has claim.read only
    expect((await av.call('POST', '/api/claims', base)).status).toBe(403);
    expect((await klAdmin.call('POST', '/api/claims', base)).status).toBe(403); // K Line staff do not raise claims
    expect((await contoso.call('POST', '/api/claims', base)).status).toBe(404); // not their case
    expect((await withKey(['cases:write', 'cases:read'], 'POST', '/api/claims', base)).status).toBe(403);
    expect((await q(`SELECT count(*)::int AS n FROM claims`))[0].n).toBe(0);
  });

  it('opens a claim, tells K Line by reference only and records it on the case', async () => {
    const r = await aq.call('POST', '/api/claims', {
      caseId: k.id,
      summary: 'Cracked at the edge',
      description: 'Two aligners arrived with a crack near the last tooth.',
      specClauseIds: ['MT-1', 'FN-1'],
      items: [
        { arch: 'upper', step: 2, defectCode: 'CRACK', note: 'Right side' },
        { arch: 'lower', step: 1, defectCode: 'SHARP_EDGE' },
      ],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    claimId = r.json.claim.id;
    claimNumber = r.json.claim.number;
    expect(claimNumber).toMatch(/^CLM-\d{4}-\d{5}$/);
    expect(r.json.claim).toMatchObject({ status: 'open', resolution: null, caseId: k.id, caseRef: k.ref, orgName: 'Acme Aligners', itemCount: 2, specClauseIds: ['MT-1', 'FN-1'] });
    expect(r.json.items).toHaveLength(2);
    expect(r.json.items[0]).toMatchObject({ arch: 'upper', step: 2, template: false, defectCode: 'CRACK', defectLabel: 'Crack', note: 'Right side' });
    expect(r.json.messages).toEqual([expect.objectContaining({ side: 'system', body: 'Claim opened.', authorName: null })]);
    expect(r.json.specClauses).toEqual([{ id: 'MT-1', title: 'Film' }, { id: 'FN-1', title: 'Edges' }]);
    expect(r.json.evidence).toEqual([]);

    const ev = await up.call('GET', `/api/cases/${k.id}`);
    expect(ev.json.events.map((e: any) => e.type)).toContain('claim_opened');
    expect(ev.json.claims).toEqual([expect.objectContaining({ id: claimId, number: claimNumber, status: 'open' })]);
    await runDueJobs();
    const n = await q(`SELECT * FROM notifications WHERE org_id = $1 AND kind = 'claim_opened'`, [klineId]);
    expect(n).toHaveLength(1);
    expect(n[0].body).toBe(`Claim ${claimNumber}, case ${k.ref}`);
    expect(JSON.stringify(n[0])).not.toMatch(/Marc|Alonso|crack/i);
    expect(hooks.some((h) => h.kind === 'claim' && h.event === 'claim.updated' && h.id === claimId && h.data.status === 'open')).toBe(true);
    const a = await admin.call('GET', '/api/audit?action=claim.');
    expect(a.json.entries.map((e: any) => e.action)).toContain('claim.opened');
    // numbers count up
    const second = await aq.call('POST', '/api/claims', { caseId: k.id, summary: 'Second', items: [{ arch: 'upper', step: 1, defectCode: 'DEBRIS' }] });
    expect(second.json.claim.number).toBe(claimNumber.replace(/\d{5}$/, (m) => String(Number(m) + 1).padStart(5, '0')));
    await tx(SYSTEM, (c) => c.query(`DELETE FROM claims WHERE id = $1`, [second.json.claim.id]));
  });

  it('takes photo and video evidence with content checks, limits and the right permissions', async () => {
    const png = await uploadFor(aq, 'claim', claimId, 'photo one.png', PNG_BYTES);
    expect(png.file).toMatchObject({ state: 'ready', kind: 'image', claimId, caseId: null, name: 'photo one.png' });
    evidenceId = png.fileId!;
    const mp4 = await uploadFor(aq, 'claim', claimId, 'clip.mp4', MP4);
    expect(mp4.file).toMatchObject({ state: 'ready', kind: 'video' });
    const pdf = await uploadFor(admin, 'claim', claimId, 'report.pdf', minimalPdf());
    expect(pdf.file).toMatchObject({ state: 'ready', kind: 'pdf' });
    // content that is not what its extension says is rejected by the worker
    const fake = await uploadFor(aq, 'claim', claimId, 'fake.png', Buffer.from('this is not an image at all'));
    expect(fake.file.state).toBe('rejected');
    const fakeVideo = await uploadFor(aq, 'claim', claimId, 'fake.mov', Buffer.from('this is not a video either'));
    expect(fakeVideo.file.state).toBe('rejected');
    // types and sizes
    expect((await aq.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'notes.txt', size: 10 })).status).toBe(415);
    expect((await aq.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'model.stl', size: 10 })).status).toBe(415);
    expect((await aq.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'run.exe', size: 10 })).status).toBe(415);
    expect((await aq.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'big.mp4', size: 512 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await aq.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'big.mov', size: 512 * 1024 * 1024 })).status).toBe(200);
    expect((await aq.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'big.png', size: 50 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await aq.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'big.pdf', size: 50 * 1024 * 1024 + 1 })).status).toBe(413);
    // an executable disguised as a photo is refused at the first chunk
    const disguised = await aq.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'sneaky.png', size: 64 });
    const bad = await aq.putChunk(disguised.json.fileId, 0, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62)]));
    expect(bad.status).toBe(415);
    // who may upload
    expect((await up.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'a.png', size: 10 })).status).toBe(403);
    expect((await klAdmin.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'a.png', size: 10 })).status).toBe(403);
    expect((await withKey(['cases:write', 'cases:read'], 'POST', '/api/uploads', { purpose: 'claim', claimId, name: 'a.png', size: 10 })).status).toBe(403);
    expect((await contoso.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'a.png', size: 10 })).status).toBe(404);
    expect((await aq.call('POST', '/api/uploads', { purpose: 'claim', name: 'a.png', size: 10 })).status).toBe(400);
    // at most 40 files per claim
    await q(`DELETE FROM files WHERE claim_id = $1 AND state IN ('uploading', 'rejected')`, [claimId]);
    const have = (await q(`SELECT count(*)::int AS n FROM files WHERE claim_id = $1`, [claimId]))[0].n;
    await q(`INSERT INTO files (org_id, purpose, claim_id, kind, state, size) SELECT $1, 'claim', $2, 'image', 'ready', 1 FROM generate_series(1, $3)`, [acmeId, claimId, 40 - have]);
    const full = await aq.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'one too many.png', size: 10 });
    expect(full.status).toBe(409);
    expect(full.json.code).toBe('too_many_files');
    await q(`DELETE FROM files WHERE claim_id = $1 AND size = 1`, [claimId]);
    // stored as ciphertext, in the partner's organisation, not attached to the case's own file list
    const row = (await q(`SELECT org_id, purpose, case_id, claim_id, wrapped_key FROM files WHERE id = $1`, [evidenceId]))[0];
    expect(row).toMatchObject({ org_id: acmeId, purpose: 'claim', case_id: null, claim_id: claimId });
    expect(row.wrapped_key).toMatch(/^w1\./);
    const caseFiles = await up.call('GET', `/api/cases/${k.id}`);
    expect(caseFiles.json.files.every((f: any) => f.claimId === null)).toBe(true);
    expect(caseFiles.json.case.fileCount).toBe(4);
    // and the case checks are unaffected
    expect(caseFiles.json.case.checks.errors).toEqual([]);
  });

  it('shows the claim to the partner and K Line, hides it from other partners, and audits K Line access', async () => {
    const d = await aq.call('GET', `/api/claims/${claimId}`);
    expect(d.status).toBe(200);
    expect(d.json.evidence.map((f: any) => f.name).sort()).toEqual(['clip.mp4', 'photo one.png', 'report.pdf']);
    expect(d.json.claim.evidenceCount).toBe(3);
    // other partners see nothing
    expect((await contoso.call('GET', `/api/claims/${claimId}`)).status).toBe(404);
    expect((await contoso.call('GET', '/api/claims')).json).toMatchObject({ items: [], total: 0 });
    expect((await contoso.call('POST', `/api/claims/${claimId}/messages`, { body: 'hello' })).status).toBe(404);
    expect((await contoso.call('GET', `/api/files/${evidenceId}/download`)).status).toBe(404);
    expect((await contoso.call('GET', `/api/console/claims/${claimId}`)).status).toBe(403);
    // K Line: console detail is audited to the partner, downloads too
    const kd = await klAdmin.call('GET', `/api/console/claims/${claimId}`);
    expect(kd.status).toBe(200);
    await klAdmin.call('GET', `/api/console/claims/${claimId}`); // a second view within ten minutes adds nothing
    const dl = await klAdmin.call('GET', `/api/files/${evidenceId}/download`);
    expect(dl.status).toBe(200);
    expect(dl.res.rawPayload.equals(PNG_BYTES)).toBe(true);
    const own = await aq.call('GET', `/api/files/${evidenceId}/download`);
    expect(own.status).toBe(200);
    const log = await admin.call('GET', '/api/audit?limit=200');
    const views = log.json.entries.filter((e: any) => e.action === 'claim.viewed' && e.targetId === claimId);
    expect(views).toHaveLength(1);
    expect(views[0].actorLabel).toBe('K Line staff'); // no name of the K Line person
    const downloads = log.json.entries.filter((e: any) => e.action === 'file.download' && e.targetId === evidenceId);
    expect(downloads).toHaveLength(2);
    expect(downloads.every((e: any) => e.details.claimId === claimId)).toBe(true);
    // the case's own detail also lists the claim for the partner; K Line lists
    const l = await klAdmin.call('GET', '/api/console/claims?status=open');
    expect(l.json.items.map((c: any) => c.id)).toContain(claimId);
    expect((await klAdmin.call('GET', `/api/console/claims?orgId=${contosoId}`)).json.total).toBe(0);
    expect((await aq.call('GET', '/api/console/claims')).status).toBe(403);
    expect((await aq.call('GET', `/api/claims?caseId=${k.id}`)).json.total).toBe(1);
    expect((await aq.call('GET', '/api/claims?status=closed')).json.total).toBe(0);
    expect((await aq.call('GET', '/api/claims?status=bogus')).status).toBe(400);
    const key = await withKey(['claims:read'], 'GET', '/api/claims');
    expect(key.status).toBe(200);
    expect(key.json.total).toBe(1);
    expect((await withKey(['cases:read'], 'GET', '/api/claims')).status).toBe(403);
  });

  it('runs the conversation: messages, waiting for the partner, and back to review', async () => {
    expect((await aq.call('POST', `/api/claims/${claimId}/messages`, { body: '' })).status).toBe(400);
    expect((await aq.call('POST', `/api/claims/${claimId}/messages`, { body: 'x'.repeat(4001) })).status).toBe(400);
    expect((await aq.call('POST', `/api/claims/${claimId}/messages`, { body: 'x'.repeat(4000) })).status).toBe(201);
    const first = await aq.call('POST', `/api/claims/${claimId}/messages`, { body: 'Photos are attached.' });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ message: { side: 'partner', body: 'Photos are attached.' }, status: 'open' });
    expect((await up.call('POST', `/api/claims/${claimId}/messages`, { body: 'Can I write?' })).status).toBe(403);

    // only K Line changes the status
    expect((await aq.call('POST', `/api/claims/${claimId}/status`, { status: 'in_review' })).status).toBe(403);
    expect((await admin.call('POST', `/api/claims/${claimId}/status`, { status: 'in_review' })).status).toBe(403);
    expect((await klAdmin.call('POST', `/api/claims/${claimId}/status`, { status: 'accepted' })).status).toBe(400);
    const review = await klAdmin.call('POST', `/api/claims/${claimId}/status`, { status: 'in_review' });
    expect(review.status, JSON.stringify(review.json)).toBe(200);
    expect(review.json.claim.status).toBe('in_review');
    expect((await klAdmin.call('POST', `/api/claims/${claimId}/status`, { status: 'in_review' })).json.code).toBe('status_unchanged');
    const wait = await klAdmin.call('POST', `/api/claims/${claimId}/status`, { status: 'awaiting_partner' });
    expect(wait.json.claim.status).toBe('awaiting_partner');
    const km = await klAdmin.call('POST', `/api/claims/${claimId}/messages`, { body: 'Please send a photo of the packaging too.' });
    expect(km.status).toBe(201);
    expect(km.json.message.side).toBe('kline');
    expect(km.json.status).toBe('awaiting_partner'); // a K Line message does not change the status
    const back = await aq.call('POST', `/api/claims/${claimId}/messages`, { body: 'Here it is.' });
    expect(back.json.status).toBe('in_review');
    expect((await aq.call('GET', `/api/claims/${claimId}`)).json.claim.status).toBe('in_review');

    const d = await aq.call('GET', `/api/claims/${claimId}`);
    const bodies = d.json.messages.map((m: any) => [m.side, m.authorName]);
    expect(bodies).toContainEqual(['kline', 'K Line']); // partners do not see who at K Line wrote
    const kd = await klAdmin.call('GET', `/api/console/claims/${claimId}`);
    expect(kd.json.messages.find((m: any) => m.side === 'kline').authorName).toBe('Katrin Admin');
    // each side is told about the other side's messages, by claim number only
    const toPartner = await q(`SELECT title, body FROM notifications WHERE org_id = $1 AND kind IN ('claim_status', 'claim_message')`, [acmeId]);
    expect(toPartner.length).toBeGreaterThanOrEqual(3);
    for (const n of toPartner) expect(n.body).toBe(`Claim ${claimNumber}, case ${k.ref}`);
    await runDueJobs();
    const toKline = await q(`SELECT * FROM notifications WHERE org_id = $1 AND kind = 'claim_message'`, [klineId]);
    expect(toKline.length).toBe(3);
    expect(JSON.stringify(toKline)).not.toMatch(/photo|packaging/i);
  });

  it('needs the right rights and a resolution or a note to decide', async () => {
    for (const c of [aq, admin, up]) expect((await c.call('POST', `/api/claims/${claimId}/decision`, { decision: 'rejected', note: 'No.' })).status).toBe(403);
    expect((await klAdmin.call('POST', `/api/claims/${claimId}/decision`, { decision: 'accepted' })).json.code).toBe('resolution_required');
    expect((await klAdmin.call('POST', `/api/claims/${claimId}/decision`, { decision: 'accepted', resolution: 'bogus' })).status).toBe(400);
    expect((await klAdmin.call('POST', `/api/claims/${claimId}/decision`, { decision: 'rejected' })).json.code).toBe('note_required');
    expect((await klAdmin.call('POST', `/api/claims/${claimId}/decision`, { decision: 'rejected', note: 'x' })).json.code).toBe('note_required');
    expect((await klAdmin.call('POST', `/api/claims/${claimId}/close`, {})).json.code).toBe('claim_not_decided');
    expect((await aq.call('POST', `/api/claims/${claimId}/close`, {})).status).toBe(403);
  });

  it('accepts a remake by creating a rush rework case that reuses the parent files and reaches the factory', async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM files`))[0].n;
    const r = await klAdmin.call('POST', `/api/claims/${claimId}/decision`, {
      decision: 'accepted', resolution: 'remake', rootCause: 'Trim tool worn.', correctiveAction: 'Tool replaced.', note: 'We will remake both aligners.',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.claim).toMatchObject({ status: 'accepted', resolution: 'remake', rootCause: 'Trim tool worn.', correctiveAction: 'Tool replaced.', decisionNote: 'We will remake both aligners.' });
    reworkId = r.json.claim.reworkCaseId;
    expect(reworkId).toBeTruthy();
    expect(r.json.claim.reworkCaseRef).toMatch(/^ACME-\d{6}$/);
    expect(r.json.messages.map((m: any) => m.body)).toEqual(expect.arrayContaining([expect.stringMatching(/^Claim accepted\. Resolution: remake\. A rush rework case ACME-\d{6} has been created\.$/), 'We will remake both aligners.']));

    // the partner sees the child in its case list, linked both ways
    const child = await up.call('GET', `/api/cases/${reworkId}`);
    expect(child.status).toBe(200);
    expect(child.json.case).toMatchObject({
      kind: 'rework', priority: 'rush', status: 'ready', parentId: k.id, parentRef: k.ref, claimId, claimNumber, siteCode: 'PT-CHV', specVersion: 4,
      counts: { upper: 1, lower: 1, templates: 0 }, fileCount: 4, manufacturingMode: 'standard',
    });
    expect(child.json.case.requestedItems).toEqual([
      { arch: 'upper', step: 2, template: false, defectCode: 'CRACK' },
      { arch: 'lower', step: 1, template: false, defectCode: 'SHARP_EDGE' },
    ]);
    expect(child.json.instructions).toMatch(/^Rework order for quality claim CLM-\d{4}-\d{5}\./);
    expect(child.json.instructions).toContain('Leave the attachments as designed.');
    expect(child.json.events.map((e: any) => e.type)).toEqual(['created', 'submitted']);
    const parent = await up.call('GET', `/api/cases/${k.id}`);
    expect(parent.json.children).toEqual([expect.objectContaining({ id: reworkId, kind: 'rework', status: 'ready', priority: 'rush' })]);
    expect(parent.json.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['claim_opened', 'rework_ordered']));
    const list = await up.call('GET', `/api/cases?search=${child.json.case.ref}`);
    expect(list.json.items[0]).toMatchObject({ kind: 'rework', parentRef: k.ref });

    // no bytes were stored again: the child points at the parent's objects
    expect((await q(`SELECT count(*)::int AS n FROM files`))[0].n).toBe(before + 4);
    const pf = (await q(`SELECT storage_prefix FROM files WHERE id = $1`, [k.ids.u2]))[0].storage_prefix;
    const cf = await q(`SELECT id, storage_prefix, cipher_file_id, meta FROM files WHERE case_id = $1 ORDER BY created_at, id`, [reworkId]);
    expect(cf.map((f) => f.storage_prefix)).toContain(pf);
    expect(cf.every((f) => f.cipher_file_id)).toBe(true);
    // the child's files decrypt to the same bytes, for the partner and for K Line
    const childFiles = child.json.files as any[];
    const u2 = childFiles.find((f) => f.name === 'U02.stl');
    const dl = await up.call('GET', `/api/files/${u2.id}/download`);
    expect(dl.status).toBe(200);
    expect(sha(dl.res.rawPayload)).toBe(sha(k.data.u2));
    expect((await klAdmin.call('GET', `/api/files/${u2.id}/download`)).res.rawPayload.equals(k.data.u2)).toBe(true);
    const pkg = await up.call('GET', `/api/cases/${reworkId}/package.zip`);
    expect(pkg.status).toBe(200);
    expect(pkg.res.rawPayload.length).toBeGreaterThan(1000);
    // the name was re-encrypted for the child
    const reveal = await klAdmin.call('POST', `/api/cases/${reworkId}/reveal-name`, {});
    expect(reveal.json.patientName).toBe(NAME);

    // it shows up for the factory with its items and only the requested files marked
    const mes = await svc('GET', '/api/mes/v1/intake?site=PT-CHV');
    const item = mes.json.cases.find((x: any) => x.ref === child.json.case.ref);
    expect(item).toBeTruthy();
    expect(item).toMatchObject({ kind: 'rework', priority: 'rush', parent_ref: k.ref, spec_version: 4, claim_number: claimNumber, aligner_counts: { upper: 1, lower: 1, templates: 0 } });
    expect(item.items).toEqual([
      { aligner: 'U02', arch: 'upper', step: 2, template: false, defect_code: 'CRACK' },
      { aligner: 'L01', arch: 'lower', step: 1, template: false, defect_code: 'SHARP_EDGE' },
    ]);
    expect(item.files).toHaveLength(4);
    const req = Object.fromEntries(item.files.map((f: any) => [f.name, f.requested]));
    expect(req).toEqual({ 'upper/U01.stl': false, 'upper/U01.pts': false, 'upper/U02.stl': true, 'lower/L01.stl': true });
    expect(item.bags.map((b: any) => b.aligner)).toEqual(['U02', 'L01']);
    expect(item.notes).toMatch(/^Rework order for quality claim/);
    expect(JSON.stringify(mes.json)).not.toMatch(/Marc|Alonso/);
    const f = await svc('GET', `/api/mes/v1/files/${item.files.find((x: any) => x.name === 'upper/U02.stl').id}`);
    expect(f.status).toBe(200);
    expect(sha(f.res.rawPayload)).toBe(sha(k.data.u2));
    // K Line intake sees it on the ready tab, rush first
    const tab = await klAdmin.call('GET', '/api/intake?tab=ready');
    expect(tab.json.items[0]).toMatchObject({ id: reworkId, priority: 'rush', kind: 'rework' });
    expect(hooks.some((h) => h.kind === 'case' && h.id === reworkId && h.event === 'case.ready')).toBe(true);
    // a decision cannot be taken twice
    expect((await klAdmin.call('POST', `/api/claims/${claimId}/decision`, { decision: 'rejected', note: 'Changed my mind' })).json.code).toBe('claim_decided');
    expect((await klAdmin.call('POST', `/api/claims/${claimId}/status`, { status: 'in_review' })).json.code).toBe('claim_decided');
    const dec = await q(`SELECT title FROM notifications WHERE org_id = $1 AND kind = 'claim_decision'`, [acmeId]);
    expect(dec.map((n) => n.title)).toEqual(['Quality claim accepted']);
  });

  it('closes a claim and then refuses further changes', async () => {
    const r = await klAdmin.call('POST', `/api/claims/${claimId}/close`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.claim.status).toBe('closed');
    expect(r.json.claim.closedAt).toBeTruthy();
    expect((await klAdmin.call('POST', `/api/claims/${claimId}/close`, {})).json.code).toBe('claim_closed');
    expect((await aq.call('POST', `/api/claims/${claimId}/messages`, { body: 'One more thing' })).json.code).toBe('claim_closed');
    expect((await klAdmin.call('POST', `/api/claims/${claimId}/messages`, { body: 'Closed' })).json.code).toBe('claim_closed');
    const late = await aq.call('POST', '/api/uploads', { purpose: 'claim', claimId, name: 'late.png', size: 10 });
    expect(late.status).toBe(409);
    expect(late.json.code).toBe('claim_not_open');
    // evidence stays downloadable after closing
    expect((await aq.call('GET', `/api/files/${evidenceId}/download`)).status).toBe(200);
    expect((await aq.call('GET', '/api/claims?status=closed')).json.total).toBe(1);
    expect(hooks.filter((h) => h.kind === 'claim' && h.id === claimId).map((h) => h.data.status)).toEqual(expect.arrayContaining(['open', 'in_review', 'awaiting_partner', 'accepted', 'closed']));
  });

  it('respects manual review for the rework case and lets K Line intake route it', async () => {
    await q(`UPDATE organizations SET settings = settings || '{"manual_review": true}'::jsonb WHERE id = $1`, [acmeId]);
    const c = await aq.call('POST', '/api/claims', { caseId: k.id, summary: 'Debris again', items: [{ arch: 'upper', step: 1, defectCode: 'DEBRIS' }] });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const d = await klAdmin.call('POST', `/api/claims/${c.json.claim.id}/decision`, { decision: 'accepted', resolution: 'remake' });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    const child = (await klAdmin.call('GET', `/api/console/cases/${d.json.claim.reworkCaseId}`)).json;
    expect(child.case).toMatchObject({ status: 'submitted', priority: 'rush', kind: 'rework', siteCode: null });
    const tab = await klAdmin.call('GET', '/api/intake?tab=review');
    expect(tab.json.items.map((x: any) => x.id)).toContain(d.json.claim.reworkCaseId);
    await runDueJobs();
    const notes = await q(`SELECT title, body FROM notifications WHERE org_id = $1 AND kind = 'case_submitted'`, [klineId]);
    expect(notes.some((n) => n.body === `Case ${child.case.ref}`)).toBe(true);
    // not in the factory feed until routed
    expect((await svc('GET', '/api/mes/v1/intake')).json.cases.map((x: any) => x.ref)).not.toContain(child.case.ref);
    const routed = await klAdmin.call('POST', `/api/cases/${d.json.claim.reworkCaseId}/route`, { siteCode: 'PT-CHV' });
    expect(routed.status, JSON.stringify(routed.json)).toBe(200);
    expect((await svc('GET', '/api/mes/v1/intake')).json.cases.map((x: any) => x.ref)).toContain(child.case.ref);
    await q(`UPDATE organizations SET settings = settings || '{"manual_review": false}'::jsonb WHERE id = $1`, [acmeId]);
    await klAdmin.call('POST', `/api/claims/${c.json.claim.id}/close`, {});
  });

  it('rejects with a reason the partner can read and resolves a credit without a new case', async () => {
    const a = await aq.call('POST', '/api/claims', { caseId: k.id, summary: 'Cloudy film', items: [{ arch: 'lower', step: 1, defectCode: 'TRANSPARENCY' }] });
    const rejected = await klAdmin.call('POST', `/api/claims/${a.json.claim.id}/decision`, { decision: 'rejected', note: 'The film was within tolerance.' });
    expect(rejected.status, JSON.stringify(rejected.json)).toBe(200);
    expect(rejected.json.claim).toMatchObject({ status: 'rejected', resolution: null, reworkCaseId: null, decisionNote: 'The film was within tolerance.' });
    const seen = await aq.call('GET', `/api/claims/${a.json.claim.id}`);
    expect(seen.json.messages.map((m: any) => m.body)).toEqual(['Claim opened.', 'Claim rejected.', 'The film was within tolerance.']);
    expect((await klAdmin.call('POST', `/api/claims/${a.json.claim.id}/close`, {})).status).toBe(200);

    const b = await aq.call('POST', '/api/claims', { caseId: k.id, summary: 'Late delivery damage', items: [{ arch: 'upper', step: 1, defectCode: 'PACKAGING' }] });
    const before = (await q(`SELECT count(*)::int AS n FROM cases`))[0].n;
    const credit = await klAdmin.call('POST', `/api/claims/${b.json.claim.id}/decision`, { decision: 'accepted', resolution: 'credit' });
    expect(credit.json.claim).toMatchObject({ status: 'accepted', resolution: 'credit', reworkCaseId: null });
    expect((await q(`SELECT count(*)::int AS n FROM cases`))[0].n).toBe(before);
    expect(credit.json.messages.map((m: any) => m.body)).toContain('Claim accepted. Resolution: credit.');
    expect((await klAdmin.call('POST', `/api/claims/${b.json.claim.id}/close`, {})).status).toBe(200);
  });

  it('counts open claims on the console overview', async () => {
    const before = (await klAdmin.call('GET', '/api/console/overview')).json.openClaims;
    const c = await aq.call('POST', '/api/claims', { caseId: k.id, summary: 'Open one', items: [{ arch: 'upper', step: 1, defectCode: 'OTHER' }] });
    expect((await klAdmin.call('GET', '/api/console/overview')).json.openClaims).toBe(before + 1);
    await klAdmin.call('POST', `/api/claims/${c.json.claim.id}/status`, { status: 'awaiting_partner' });
    expect((await klAdmin.call('GET', '/api/console/overview')).json.openClaims).toBe(before + 1);
    await klAdmin.call('POST', `/api/claims/${c.json.claim.id}/decision`, { decision: 'rejected', note: 'Not a defect.' });
    expect((await klAdmin.call('GET', '/api/console/overview')).json.openClaims).toBe(before);
  });

  it('remakes a direct manufacturing case as a standard rework case for the factory', async () => {
    const d = await readyCase();
    await ship(d.id);
    await q(`UPDATE cases SET manufacturing_mode = 'direct', patient_first_enc = 'x', patient_last_enc = 'y' WHERE id = $1`, [d.id]);
    const c = await aq.call('POST', '/api/claims', { caseId: d.id, summary: 'Direct case problem', items: [{ arch: 'lower', step: 1, defectCode: 'TRIM_LINE' }] });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const r = await klAdmin.call('POST', `/api/claims/${c.json.claim.id}/decision`, { decision: 'accepted', resolution: 'remake' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const child = (await up.call('GET', `/api/cases/${r.json.claim.reworkCaseId}`)).json.case;
    expect(child).toMatchObject({ kind: 'rework', manufacturingMode: 'standard', status: 'ready', parentRef: d.ref });
    await klAdmin.call('POST', `/api/claims/${c.json.claim.id}/close`, {});
    await q(`UPDATE cases SET manufacturing_mode = 'standard', patient_first_enc = NULL, patient_last_enc = NULL WHERE id = $1`, [d.id]);
  });

  it('keeps patient data out of notifications, jobs, audit entries and hook payloads', async () => {
    const dump = JSON.stringify({
      notifications: await q(`SELECT title, body, data FROM notifications`),
      jobs: await q(`SELECT kind, payload FROM jobs`),
      audit: await q(`SELECT action, details FROM audit_log WHERE action LIKE 'claim.%' OR action LIKE 'spec.%' OR action LIKE 'material.%' OR action LIKE 'case.rework%' OR action LIKE 'case.replacement%'`),
      hooks,
    });
    expect(dump).not.toMatch(/Marc|Alonso/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('replacement orders', () => {
  let k: Ready;

  it('creates a child case for the chosen aligners and only requires their files', async () => {
    k = await readyCase();
    const early = await up.call('POST', `/api/cases/${k.id}/replacement`, { items: [{ arch: 'upper', step: 1 }] });
    expect(early.status).toBe(409);
    expect(early.json.code).toBe('case_not_replaceable');
    await ship(k.id);

    expect((await up.call('POST', `/api/cases/${k.id}/replacement`, { items: [] })).status).toBe(400);
    expect((await up.call('POST', `/api/cases/${k.id}/replacement`, { items: [{ arch: 'upper', step: 7 }] })).json.code).toBe('unknown_aligner');
    expect((await up.call('POST', `/api/cases/${k.id}/replacement`, { items: [{ arch: 'upper', step: 1, template: true }] })).json.code).toBe('unknown_aligner');
    expect((await up.call('POST', `/api/cases/${k.id}/replacement`, { items: [{ arch: 'sideways', step: 1 }] })).status).toBe(400);
    expect((await contoso.call('POST', `/api/cases/${k.id}/replacement`, { items: [{ arch: 'upper', step: 1 }] })).status).toBe(404);
    expect((await av.call('POST', `/api/cases/${k.id}/replacement`, { items: [{ arch: 'upper', step: 1 }] })).status).toBe(403);
    expect((await klAdmin.call('POST', `/api/cases/${k.id}/replacement`, { items: [{ arch: 'upper', step: 1 }] })).status).toBe(403);

    const r = await up.call('POST', `/api/cases/${k.id}/replacement`, { items: [{ arch: 'upper', step: 1 }, { arch: 'upper', step: 1 }, { arch: 'lower', step: 1 }], reason: 'Lost by the patient' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const child = r.json.case;
    expect(child).toMatchObject({
      kind: 'replacement', priority: 'normal', status: 'ready', parentRef: k.ref, parentId: k.id, claimId: null, specVersion: 4, counts: { upper: 1, lower: 1, templates: 0 }, fileCount: 4,
    });
    expect(child.requestedItems).toEqual([{ arch: 'upper', step: 1, template: false }, { arch: 'lower', step: 1, template: false }]);
    const detail = await up.call('GET', `/api/cases/${child.id}`);
    expect(detail.json.instructions).toBe('Replacement order. Reason: Lost by the patient\n\nLeave the attachments as designed.');
    expect((await up.call('GET', `/api/cases/${k.id}`)).json.events.map((e: any) => e.type)).toContain('replacement_ordered');

    const mes = await svc('GET', '/api/mes/v1/intake?site=PT-CHV');
    const item = mes.json.cases.find((x: any) => x.ref === child.ref);
    expect(item).toMatchObject({ kind: 'replacement', parent_ref: k.ref, priority: 'normal', aligner_counts: { upper: 1, lower: 1, templates: 0 } });
    expect(item.items.map((i: any) => i.aligner)).toEqual(['U01', 'L01']);
    expect(item.items[0].defect_code).toBeNull();
    const req = Object.fromEntries(item.files.map((f: any) => [f.name, f.requested]));
    expect(req).toEqual({ 'upper/U01.stl': true, 'upper/U01.pts': true, 'upper/U02.stl': false, 'lower/L01.stl': true });
    expect(item.bags.map((b: any) => b.aligner)).toEqual(['U01', 'L01']);
    // a new case lists nothing as items and everything as requested
    const fresh = mes.json.cases.find((x: any) => x.kind === 'new');
    expect(fresh.items).toEqual([]);
    expect(fresh.files.every((f: any) => f.requested === true)).toBe(true);
    // the replacement can be replaced again, and it ships and consumes like any case
    const list = await up.call('GET', '/api/cases?status=production');
    expect(list.json.items.find((x: any) => x.id === child.id)).toMatchObject({ kind: 'replacement', parentRef: k.ref });
  });

  it('refuses when the organisation is not approved and for direct manufacturing cases', async () => {
    const k2 = await readyCase();
    await ship(k2.id);
    await q(`UPDATE organizations SET status = 'onboarding' WHERE id = $1`, [acmeId]);
    const r = await up.call('POST', `/api/cases/${k2.id}/replacement`, { items: [{ arch: 'upper', step: 1 }] });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('org_not_approved');
    await q(`UPDATE organizations SET status = 'active' WHERE id = $1`, [acmeId]);
    await q(`UPDATE cases SET manufacturing_mode = 'direct', patient_first_enc = 'x', patient_last_enc = 'y' WHERE id = $1`, [k2.id]);
    const d = await up.call('POST', `/api/cases/${k2.id}/replacement`, { items: [{ arch: 'upper', step: 1 }] });
    expect(d.status).toBe(409);
    expect(d.json.code).toBe('direct_case');
    await q(`UPDATE cases SET manufacturing_mode = 'standard', patient_first_enc = NULL, patient_last_enc = NULL WHERE id = $1`, [k2.id]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('partner supplied materials', () => {
  let box: string;
  let bag: string;
  let ela: string;
  let s1: string;
  let s2: string;
  const stockOf = async (c: Client, id: string, site: string) => {
    const m = (await c.call('GET', '/api/materials')).json.items.find((x: any) => x.id === id);
    return m.stock.find((s: any) => s.siteCode === site);
  };

  it('lets a partner administrator manage items with usage rules', async () => {
    const mk = (body: Record<string, unknown>) => admin.call('POST', '/api/materials', body);
    expect((await up.call('POST', '/api/materials', { sku: 'X', name: 'X', category: 'box' })).status).toBe(403); // material.manage
    expect((await klAdmin.call('POST', '/api/materials', { sku: 'X', name: 'X', category: 'box' })).status).toBe(403); // not a supplier
    expect((await mk({ sku: 'BOX-1', name: 'Case box', category: 'crate' })).status).toBe(400);
    expect((await mk({ sku: 'BOX-1', name: 'Case box', category: 'box', perCase: -1 })).status).toBe(400);
    expect((await mk({ sku: '', name: 'Case box', category: 'box' })).status).toBe(400);
    const b = await mk({ sku: 'BOX-1', name: 'Case box', category: 'box', unit: 'boxes', perCase: 1, perAligner: 0, minStock: 10 });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    box = b.json.material.id;
    expect(b.json.material).toMatchObject({ sku: 'BOX-1', category: 'box', unit: 'boxes', perCase: 1, perAligner: 0, minStock: 10, active: true, stock: [] });
    expect((await mk({ sku: 'box-1', name: 'Duplicate', category: 'box' })).json.code).toBe('sku_exists');
    bag = (await mk({ sku: 'BAG-1', name: 'Aligner bag', category: 'bag', perCase: 0, perAligner: 1, minStock: 0 })).json.material.id;
    ela = (await mk({ sku: 'ELA-1', name: 'Elastics', category: 'elastic', perCase: 0, perAligner: 0, minStock: 0 })).json.material.id;
    const p = await admin.call('PATCH', `/api/materials/${ela}`, { name: 'Elastics 3 mm', minStock: 5 });
    expect(p.json.material).toMatchObject({ name: 'Elastics 3 mm', minStock: 5 });
    expect((await admin.call('PATCH', `/api/materials/${ela}`, { perCase: -2 })).status).toBe(400);
    expect((await admin.call('PATCH', `/api/materials/${ela}`, { sku: 'BOX-1' })).json.code).toBe('sku_exists');
    expect((await up.call('PATCH', `/api/materials/${ela}`, { name: 'Nope' })).status).toBe(403);
    expect((await contoso.call('PATCH', `/api/materials/${ela}`, { name: 'Nope' })).status).toBe(404);
    // visibility
    expect((await af.call('GET', '/api/materials')).json.items).toHaveLength(3);
    expect((await contoso.call('GET', '/api/materials')).json.items).toEqual([]);
    const all = await klAdmin.call('GET', '/api/console/materials');
    expect(all.json.items.map((x: any) => x.sku).sort()).toEqual(['BAG-1', 'BOX-1', 'ELA-1']);
    expect(all.json.items[0].orgName).toBe('Acme Aligners');
    expect((await klAdmin.call('GET', `/api/console/materials?orgId=${contosoId}`)).json.items).toEqual([]);
    expect((await af.call('GET', '/api/console/materials')).status).toBe(403);
    expect((await withKey(['materials:read'], 'GET', '/api/materials')).status).toBe(200);
    expect((await withKey(['cases:read'], 'GET', '/api/materials')).status).toBe(403);
  });

  it('declares shipments to an allowed site, with numbers and documents', async () => {
    const line = (materialId: string, quantity: number) => ({ materialId, quantity });
    const ok = { siteCode: 'PT-CHV', carrier: 'DHL', tracking: 'JD0123', expectedDate: '2026-10-05' };
    expect((await aq.call('POST', '/api/material-shipments', { ...ok, lines: [line(box, 5)] })).status).toBe(403); // material.declare
    expect((await av.call('POST', '/api/material-shipments', { ...ok, lines: [line(box, 5)] })).status).toBe(403);
    expect((await up.call('POST', '/api/material-shipments', { ...ok, siteCode: 'US-WPB', lines: [line(box, 5)] })).json.code).toBe('invalid_site');
    expect((await up.call('POST', '/api/material-shipments', { ...ok, lines: [] })).status).toBe(400);
    expect((await up.call('POST', '/api/material-shipments', { ...ok, lines: [line(box, 0)] })).status).toBe(400);
    expect((await up.call('POST', '/api/material-shipments', { ...ok, lines: [line(box, 1.5)] })).status).toBe(400);
    expect((await up.call('POST', '/api/material-shipments', { ...ok, lines: [line(box, 1), line(box, 2)] })).json.code).toBe('duplicate_line');
    expect((await up.call('POST', '/api/material-shipments', { ...ok, lines: [line(ZERO, 1)] })).json.code).toBe('invalid_material');
    expect((await up.call('POST', '/api/material-shipments', { ...ok, expectedDate: 'tomorrow', lines: [line(box, 1)] })).status).toBe(400);
    expect((await klAdmin.call('POST', '/api/material-shipments', { ...ok, lines: [line(box, 1)] })).status).toBe(403);
    // organisation gate
    await q(`UPDATE organizations SET status = 'onboarding' WHERE id = $1`, [acmeId]);
    const gated = await up.call('POST', '/api/material-shipments', { ...ok, lines: [line(box, 5)] });
    expect(gated.status).toBe(403);
    expect(gated.json.code).toBe('org_not_approved');
    await q(`UPDATE organizations SET status = 'active' WHERE id = $1`, [acmeId]);

    const a = await up.call('POST', '/api/material-shipments', { ...ok, lines: [line(box, 20), line(bag, 50), line(ela, 5)] });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    s1 = a.json.shipment.id;
    expect(a.json.shipment).toMatchObject({ status: 'in_transit', siteCode: 'PT-CHV', carrier: 'DHL', tracking: 'JD0123', expectedDate: '2026-10-05' });
    expect(a.json.shipment.number).toMatch(/^SHP-\d{4}-\d{5}$/);
    expect(a.json.shipment.lines.map((l: any) => [l.sku, l.quantity, l.receivedQuantity])).toEqual([['BAG-1', 50, null], ['BOX-1', 20, null], ['ELA-1', 5, null]]);
    const b = await up.call('POST', '/api/material-shipments', { siteCode: 'EG-CFZ', lines: [line(box, 5)] });
    s2 = b.json.shipment.id;
    // stock shows what is on its way
    expect(await stockOf(af, box, 'PT-CHV')).toMatchObject({ onHand: 0, inTransit: 20, used28d: 0, daysOfCover: null, lowStock: true });
    expect(await stockOf(af, box, 'EG-CFZ')).toMatchObject({ onHand: 0, inTransit: 5 });

    // documents
    const doc = await uploadFor(up, 'shipment', s1, 'delivery note.pdf', minimalPdf());
    expect(doc.file).toMatchObject({ state: 'ready', kind: 'pdf', shipmentId: s1, claimId: null });
    expect((await uploadFor(up, 'shipment', s1, 'photo.png', PNG_BYTES)).file.state).toBe('ready');
    expect((await up.call('POST', '/api/uploads', { purpose: 'shipment', shipmentId: s1, name: 'clip.mp4', size: 10 })).status).toBe(415);
    expect((await up.call('POST', '/api/uploads', { purpose: 'shipment', shipmentId: s1, name: 'big.pdf', size: 25 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await aq.call('POST', '/api/uploads', { purpose: 'shipment', shipmentId: s1, name: 'a.pdf', size: 10 })).status).toBe(403);
    expect((await klAdmin.call('POST', '/api/uploads', { purpose: 'shipment', shipmentId: s1, name: 'a.pdf', size: 10 })).status).toBe(403);
    expect((await contoso.call('POST', '/api/uploads', { purpose: 'shipment', shipmentId: s1, name: 'a.pdf', size: 10 })).status).toBe(404);
    const d = await klAdmin.call('GET', `/api/console/material-shipments/${s1}`);
    expect(d.json.documents.map((f: any) => f.name).sort()).toEqual(['delivery note.pdf', 'photo.png']);
    const dl = await klAdmin.call('GET', `/api/files/${doc.fileId}/download`);
    expect(dl.status).toBe(200);
    expect(dl.res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const log = await admin.call('GET', '/api/audit?action=file.download');
    expect(log.json.entries.find((e: any) => e.targetId === doc.fileId).details.shipmentId).toBe(s1);
    // remove a document again
    const rm = await up.call('DELETE', `/api/files/${(await uploadFor(up, 'shipment', s1, 'wrong.pdf', minimalPdf())).fileId}`);
    expect(rm.json).toEqual({ ok: true });
    expect((await aq.call('DELETE', `/api/files/${doc.fileId}`)).status).toBe(403);

    // partners list their own shipments only
    expect((await up.call('GET', '/api/material-shipments')).json.total).toBe(2);
    expect((await contoso.call('GET', '/api/material-shipments')).json.total).toBe(0);
    expect((await contoso.call('GET', `/api/material-shipments/${s1}`)).status).toBe(404);
    expect((await contoso.call('POST', `/api/material-shipments/${s1}/cancel`, {})).status).toBe(404);
    expect((await up.call('GET', '/api/material-shipments?status=received')).json.total).toBe(0);

    // cancel a spare one
    const spare = await up.call('POST', '/api/material-shipments', { siteCode: 'PT-CHV', lines: [line(bag, 5)] });
    const c = await up.call('POST', `/api/material-shipments/${spare.json.shipment.id}/cancel`, {});
    expect(c.json.shipment.status).toBe('cancelled');
    expect((await up.call('POST', `/api/material-shipments/${spare.json.shipment.id}/cancel`, {})).json.code).toBe('shipment_not_in_transit');
    expect((await klAdmin.call('POST', `/api/console/material-shipments/${spare.json.shipment.id}/receive`, { lines: [{ lineId: ZERO, receivedQuantity: 1 }] })).json.code).toBe('shipment_not_in_transit');
    expect(await stockOf(af, bag, 'PT-CHV')).toMatchObject({ inTransit: 50 });
  });

  it('receives at the site with a discrepancy', async () => {
    expect((await up.call('POST', `/api/console/material-shipments/${s1}/receive`, { lines: [{ lineId: ZERO, receivedQuantity: 1 }] })).status).toBe(403);
    expect((await klAdmin.call('GET', `/api/console/material-shipments?status=in_transit`)).json.total).toBe(2);
    expect((await klAdmin.call('GET', `/api/console/material-shipments?siteCode=EG-CFZ`)).json.items.map((s: any) => s.id)).toEqual([s2]);
    const other = await klAdmin.call('GET', `/api/console/material-shipments/${s2}`);

    const detail = (await klAdmin.call('GET', `/api/console/material-shipments/${s1}`)).json.shipment;
    const byName = (n: string) => detail.lines.find((l: any) => l.sku === n);
    // every line must be answered
    expect((await klAdmin.call('POST', `/api/console/material-shipments/${s1}/receive`, { lines: [{ lineId: byName('BOX-1').id, receivedQuantity: 20 }] })).json.code).toBe('lines_mismatch');
    expect((await klAdmin.call('POST', `/api/console/material-shipments/${s1}/receive`, { lines: [{ lineId: byName('BOX-1').id, receivedQuantity: -1 }, { lineId: byName('BAG-1').id, receivedQuantity: 1 }, { lineId: byName('ELA-1').id, receivedQuantity: 1 }] })).status).toBe(400);
    const r = await klAdmin.call('POST', `/api/console/material-shipments/${s1}/receive`, {
      lines: [{ lineId: byName('BOX-1').id, receivedQuantity: 18 }, { lineId: byName('BAG-1').id, receivedQuantity: 50 }, { lineId: byName('ELA-1').id, receivedQuantity: 5 }],
      note: 'Two boxes were crushed.',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.shipment).toMatchObject({ status: 'discrepancy', receiveNote: 'Two boxes were crushed.' });
    expect(r.json.shipment.lines.find((l: any) => l.sku === 'BOX-1')).toMatchObject({ quantity: 20, receivedQuantity: 18, difference: -2 });
    expect(r.json.shipment.receivedAt).toBeTruthy();
    expect((await klAdmin.call('POST', `/api/console/material-shipments/${s1}/receive`, { lines: r.json.shipment.lines.map((l: any) => ({ lineId: l.id, receivedQuantity: l.quantity })) })).json.code).toBe('shipment_not_in_transit');
    // exact receipt at the other site
    const ok = await klAdmin.call('POST', `/api/console/material-shipments/${s2}/receive`, { lines: other.json.shipment.lines.map((l: any) => ({ lineId: l.id, receivedQuantity: l.quantity })) });
    expect(ok.json.shipment.status).toBe('received');

    const moves = await q(`SELECT kind, quantity::float AS quantity FROM material_movements WHERE shipment_id = $1 ORDER BY quantity`, [s1]);
    expect(moves).toEqual([{ kind: 'receipt', quantity: 5 }, { kind: 'receipt', quantity: 18 }, { kind: 'receipt', quantity: 50 }]);
    expect(await stockOf(af, box, 'PT-CHV')).toMatchObject({ onHand: 18, inTransit: 0, lowStock: false });
    expect(await stockOf(af, box, 'EG-CFZ')).toMatchObject({ onHand: 5, inTransit: 0, lowStock: true });
    // the partner is told, and the receipt is in its access log
    const n = await q(`SELECT title, body FROM notifications WHERE org_id = $1 AND kind = 'material_received' ORDER BY created_at`, [acmeId]);
    expect(n.map((x) => x.title)).toEqual(['Materials received with differences', 'Materials received']);
    const log = await admin.call('GET', '/api/audit?action=material.');
    expect(log.json.entries.map((e: any) => e.action)).toEqual(expect.arrayContaining(['material.shipment_declared', 'material.shipment_received', 'material.created']));
    // no more documents once received
    const late = await up.call('POST', '/api/uploads', { purpose: 'shipment', shipmentId: s1, name: 'late.pdf', size: 10 });
    expect(late.json.code).toBe('shipment_not_open');
    expect((await up.call('GET', '/api/material-shipments?status=discrepancy')).json.total).toBe(1);
  });

  it('books consumption once when a case ships and works out days of cover', async () => {
    const k = await readyCase();
    await ship(k.id, 3);
    const rows = await q(`SELECT m.sku, mv.quantity::float AS quantity, s.code FROM material_movements mv JOIN materials m ON m.id = mv.material_id JOIN sites s ON s.id = mv.site_id WHERE mv.case_id = $1 ORDER BY m.sku`, [k.id]);
    expect(rows).toEqual([{ sku: 'BAG-1', quantity: -3, code: 'PT-CHV' }, { sku: 'BOX-1', quantity: -1, code: 'PT-CHV' }]);
    // idempotent per case
    await tx(SYSTEM, async (c) => {
      const row = (await c.query('SELECT id, org_id, ref, site_id FROM cases WHERE id = $1', [k.id])).rows[0];
      await bookConsumption(c, row, 3);
      await bookConsumption(c, row, 5);
    });
    expect((await q(`SELECT count(*)::int AS n FROM material_movements WHERE case_id = $1`, [k.id]))[0].n).toBe(2);
    // delivering later books nothing more
    const del = await klAdmin.call('POST', `/api/cases/${k.id}/stage`, { stage: 'delivered' });
    expect(del.status).toBe(200);
    expect((await q(`SELECT count(*)::int AS n FROM material_movements WHERE case_id = $1`, [k.id]))[0].n).toBe(2);
    const b = await stockOf(af, box, 'PT-CHV');
    expect(b).toMatchObject({ onHand: 17, used28d: 1, lowStock: false });
    expect(b.daysOfCover).toBe(476); // 17 on hand, 1 used in 28 days
    expect(await stockOf(af, bag, 'PT-CHV')).toMatchObject({ onHand: 47, used28d: 3, daysOfCover: 438.7 });
    // the elastics have no usage rule
    expect(await stockOf(af, ela, 'PT-CHV')).toMatchObject({ onHand: 5, used28d: 0, daysOfCover: null });
    // a case without a rule for any material books nothing
    expect((await q(`SELECT count(*)::int AS n FROM material_movements WHERE kind = 'consumption'`))[0].n).toBe(2);
    expect((await q(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'material_low_stock'`))[0].n).toBe(0);
  });

  it('adjusts stock with an audited reason and warns about low stock at most once a day', async () => {
    const adjust = (c: Client, body: Record<string, unknown>) => c.call('POST', '/api/console/materials/adjust', { orgId: acmeId, materialId: box, siteCode: 'PT-CHV', quantity: -1, reason: 'Damaged in storage', ...body });
    expect((await admin.call('POST', '/api/console/materials/adjust', { orgId: acmeId, materialId: box, siteCode: 'PT-CHV', quantity: -1, reason: 'Damaged' })).status).toBe(403);
    expect((await adjust(klAdmin, { quantity: 0 })).status).toBe(400);
    expect((await adjust(klAdmin, { quantity: 1.5 })).status).toBe(400);
    expect((await adjust(klAdmin, { reason: 'x' })).json.code).toBe('reason_required');
    expect((await adjust(klAdmin, { siteCode: 'NO-SUCH' })).status).toBe(400);
    expect((await adjust(klAdmin, { materialId: ZERO })).status).toBe(404);
    expect((await adjust(klAdmin, { orgId: contosoId })).status).toBe(404); // the material belongs to Acme
    expect((await q(`SELECT count(*)::int AS n FROM material_movements WHERE kind = 'adjustment'`))[0].n).toBe(0);

    hooks.length = 0;
    // 17 - 10 = 7 is below the minimum of 10
    const a = await adjust(klAdmin, { quantity: -10, reason: 'Water damage' });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.material.stock.find((s: any) => s.siteCode === 'PT-CHV')).toMatchObject({ onHand: 7, lowStock: true });
    const notices = () => q(`SELECT * FROM notifications WHERE org_id = $1 AND kind = 'material_low_stock' ORDER BY created_at`, [acmeId]);
    expect(await notices()).toHaveLength(1);
    expect((await notices())[0]).toMatchObject({ title: 'Materials running low', body: 'Case box at Chaves: 7 left', user_id: null });
    expect(hooks.filter((h) => h.event === 'materials.low_stock')).toHaveLength(1);
    expect(hooks.find((h) => h.event === 'materials.low_stock')!.data).toMatchObject({ sku: 'BOX-1', siteCode: 'PT-CHV', onHand: 7, minStock: 10 });

    // the audit entry names the reason and is visible to the partner
    const log = await admin.call('GET', '/api/audit?action=material.adjusted');
    expect(log.json.entries[0]).toMatchObject({ action: 'material.adjusted', details: { sku: 'BOX-1', site: 'PT-CHV', quantity: -10, reason: 'Water damage' } });
    expect(log.json.entries[0].actorLabel).toBe('K Line staff'); // the K Line person is named only in K Line's own view
    // more shipments and more adjustments within the day do not warn again
    const k = await readyCase();
    await ship(k.id, 2);
    expect(await stockOf(af, box, 'PT-CHV')).toMatchObject({ onHand: 6 });
    expect((await adjust(klAdmin, { quantity: -1 })).status).toBe(200);
    expect(await notices()).toHaveLength(1);
    // after 24 hours the warning may come again
    await q(`UPDATE material_alerts SET notified_at = now() - interval '25 hours'`);
    expect((await adjust(klAdmin, { quantity: -1 })).status).toBe(200);
    expect(await notices()).toHaveLength(2);
    expect((await notices())[1].body).toBe('Case box at Chaves: 4 left');
    // an increase above the minimum does not warn
    expect((await adjust(klAdmin, { quantity: 50, reason: 'Found a pallet' })).status).toBe(200);
    expect(await notices()).toHaveLength(2);
    expect(hooks.filter((h) => h.event === 'materials.low_stock')).toHaveLength(2);
    // other sites and other materials are tracked on their own
    expect((await adjust(klAdmin, { siteCode: 'EG-CFZ', quantity: -1, reason: 'Sample used' })).status).toBe(200);
    expect(await notices()).toHaveLength(3);
    expect((await notices())[2].body).toBe('Case box at Cairo: 4 left');
  });

  it('emails partner administrators with fixed text and no personal data', async () => {
    await runDueJobs();
    // One email per site and material inside 15 minutes, sent to the one administrator who can manage materials.
    // The second Chaves notice came inside the window and is held back. Jobs run side by side, so the order is not fixed.
    const box = async () => q(`SELECT * FROM dev_mailbox WHERE subject = 'Materials running low at K Line' ORDER BY body`);
    expect(await box()).toHaveLength(2);
    expect((await box()).every((m) => m.to_addr === 'admin@acme.demo')).toBe(true);
    expect((await box()).some((m) => m.body.includes('K Line site EG-CFZ'))).toBe(true);
    expect((await box()).some((m) => m.body.includes('K Line site PT-CHV'))).toBe(true);
    for (const m of await box()) {
      // fixed text: no material name or SKU (people typed those), no claim numbers, no names
      expect(m.body).not.toMatch(/Marc|Alonso|CLM-|Case box|BOX-1/);
      expect(m.body).not.toMatch(/ [-–—] /);
    }
    // the held back notice goes out when its window ends
    await q(`UPDATE email_notice_log SET sent_at = now() - interval '20 minutes'`);
    await q(`UPDATE jobs SET run_at = now() WHERE kind = 'notice.flush' AND status = 'queued'`);
    await runDueJobs();
    expect(await box()).toHaveLength(3);
  });

  it('keeps stock and shipments of one partner away from another, in the database as well', async () => {
    const counts = async (orgId: string, bypass: boolean) =>
      tx({ orgId, bypass }, async (c) => {
        const out: Record<string, number> = {};
        for (const t of ['claims', 'claim_items', 'claim_messages', 'specs', 'materials', 'material_shipments', 'material_shipment_lines', 'material_movements', 'material_alerts']) {
          out[t] = (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
        }
        return out;
      });
    const asContoso = await counts(contosoId, false);
    expect(Object.values(asContoso).every((n) => n === 0)).toBe(true);
    const asAcme = await counts(acmeId, false);
    for (const t of Object.keys(asAcme)) expect(asAcme[t], t).toBeGreaterThan(0);
    // inserting into another organisation is refused by row level security
    await expect(tx({ orgId: contosoId, bypass: false }, (c) => c.query(`INSERT INTO materials (org_id, sku, name, category) VALUES ($1, 'EVIL', 'Evil', 'box')`, [acmeId]))).rejects.toThrow();
    // K Line sees everything
    // K Line also sees the draft specs of the two seeded registrations (Contoso Smile, Fabrikam Dental Lab)
    expect(await counts(klineId, true)).toEqual({ ...asAcme, specs: asAcme.specs + 2 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('permission matrix for the new routes', () => {
  const who = () => ({ admin, up, aq, af, av, klAdmin }) as Record<string, Client>;
  const ALL = ['admin', 'up', 'aq', 'af', 'av', 'klAdmin'];
  const PARTNER = ['admin', 'up', 'aq', 'af', 'av'];
  const KLINE = ['klAdmin'];

  const rows: [string, string, unknown, string[]][] = [
    ['GET', '/api/claims', undefined, ALL],
    ['GET', `/api/claims/${ZERO}`, undefined, ALL],
    ['POST', '/api/claims', { caseId: ZERO, summary: 'Test', items: [{ arch: 'upper', step: 1, defectCode: 'CRACK' }] }, ['admin', 'aq']],
    ['POST', `/api/claims/${ZERO}/messages`, { body: 'Hello' }, ['admin', 'aq', 'klAdmin']],
    ['POST', `/api/claims/${ZERO}/status`, { status: 'in_review' }, ['klAdmin']],
    ['POST', `/api/claims/${ZERO}/decision`, { decision: 'rejected', note: 'No' }, ['klAdmin']],
    ['POST', `/api/claims/${ZERO}/close`, {}, ['klAdmin']],
    ['GET', '/api/console/claims', undefined, KLINE],
    ['GET', `/api/console/claims/${ZERO}`, undefined, KLINE],
    ['GET', `/api/specs?orgId=${ZERO}`, undefined, ALL],
    ['GET', '/api/specs/active', undefined, ALL],
    ['GET', '/api/specs/default', undefined, ALL],
    ['GET', `/api/specs/${ZERO}`, undefined, ALL],
    ['GET', `/api/specs/${ZERO}/diff/${ZERO}`, undefined, ALL],
    ['POST', '/api/specs', { orgId: ZERO }, ['admin', 'aq', 'klAdmin']],
    ['PUT', `/api/specs/${ZERO}`, { content: {} }, ['admin', 'aq', 'klAdmin']],
    ['DELETE', `/api/specs/${ZERO}`, undefined, ['admin', 'aq', 'klAdmin']],
    ['POST', `/api/specs/${ZERO}/propose`, {}, ['admin', 'aq', 'klAdmin']],
    ['POST', `/api/specs/${ZERO}/sign`, {}, ['admin', 'aq', 'klAdmin']],
    ['POST', `/api/specs/${ZERO}/reject`, { note: 'No' }, ['admin', 'aq', 'klAdmin']],
    ['GET', '/api/console/specs/partners', undefined, KLINE],
    ['POST', '/api/console/specs', { orgId: ZERO }, ['klAdmin']],
    ['GET', '/api/materials', undefined, ALL],
    ['POST', '/api/materials', { sku: '' }, ['admin', 'klAdmin']],
    ['PATCH', `/api/materials/${ZERO}`, {}, ['admin']],
    ['GET', '/api/material-shipments', undefined, ALL],
    ['GET', `/api/material-shipments/${ZERO}`, undefined, ALL],
    ['POST', '/api/material-shipments', { siteCode: 'PT-CHV', lines: [] }, ['admin', 'up', 'klAdmin']],
    ['POST', `/api/material-shipments/${ZERO}/cancel`, {}, ['admin', 'up']],
    ['GET', '/api/console/materials', undefined, KLINE],
    ['GET', '/api/console/material-shipments', undefined, KLINE],
    ['GET', `/api/console/material-shipments/${ZERO}`, undefined, KLINE],
    ['POST', `/api/console/material-shipments/${ZERO}/receive`, { lines: [{ lineId: ZERO, receivedQuantity: 1 }] }, ['klAdmin']],
    ['POST', '/api/console/materials/adjust', { orgId: ZERO, materialId: ZERO, siteCode: 'PT-CHV', quantity: 1, reason: 'Test' }, ['klAdmin']],
    ['POST', '/api/uploads', { purpose: 'claim', claimId: ZERO, name: 'a.png', size: 10 }, ['admin', 'aq']],
    ['POST', '/api/uploads', { purpose: 'shipment', shipmentId: ZERO, name: 'a.pdf', size: 10 }, ['admin', 'up']],
    ['POST', `/api/cases/${ZERO}/replacement`, { items: [{ arch: 'upper', step: 1 }] }, ['admin', 'up']],
  ];

  it.each(rows)('%s %s', async (method, url, body, allowed) => {
    await freshStepUp();
    const clients = who();
    for (const name of ALL) {
      const r = await clients[name]!.call(method, url, body);
      if (allowed.includes(name)) expect(r.status, `${name} should be allowed: ${JSON.stringify(r.json)}`).not.toBe(403);
      else expect(r.status, `${name} should be refused`).toBe(403);
      if (allowed.includes(name)) expect(r.json?.code, name).not.toBe('step_up_required');
    }
    void PARTNER;
  });

  it('answers 401 without a session', async () => {
    for (const [method, url, body] of rows) {
      const r = await app.inject({ method: method as any, url, payload: body as any, remoteAddress: '10.9.3.1' });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('needs a fresh authenticator code for propose, sign and reject', async () => {
    await freshStepUp();
    await expireStepUp('quality@acme.demo');
    await expireStepUp('admin@kline.demo');
    for (const url of [`/api/specs/${ZERO}/propose`, `/api/specs/${ZERO}/sign`, `/api/specs/${ZERO}/reject`]) {
      for (const c of [aq, klAdmin]) {
        const r = await c.call('POST', url, { note: 'No' });
        expect(r.status, url).toBe(403);
        expect(r.json.code, url).toBe('step_up_required');
      }
    }
    await freshStepUp();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('retention keeps shared files safe', () => {
  it('purges claim evidence with its case, keeps the bytes a child case still needs, and removes them last', async () => {
    const parent = (await q(`SELECT c.id FROM cases c JOIN claims cl ON cl.case_id = c.id WHERE cl.status = 'closed' AND cl.rework_case_id IS NOT NULL ORDER BY (SELECT count(*) FROM cases ch WHERE ch.parent_id = c.id) DESC LIMIT 1`))[0];
    const kids = await q<{ id: string }>(`SELECT id FROM cases WHERE parent_id = $1 ORDER BY created_at`, [parent.id]);
    expect(kids.length).toBeGreaterThanOrEqual(2);
    const u2 = (await q(`SELECT id, storage_prefix FROM files WHERE case_id = $1 AND arch = 'upper' AND step = 2 AND kind = 'stl'`, [parent.id]))[0];
    const evidence = await q(`SELECT id, storage_prefix FROM files WHERE claim_id IS NOT NULL AND state = 'ready'`);
    expect(evidence.length).toBeGreaterThan(0);
    const st = await storage();
    expect(await st.exists(chunkKey(u2.storage_prefix, 0))).toBe(true);

    // purge the parent only
    await q(`UPDATE cases SET purge_after = now() - interval '1 day' WHERE id = $1`, [parent.id]);
    const first = await runRetention();
    expect(first.casesPurged).toBe(1);
    const gone = await q(`SELECT state, wrapped_key, name_enc FROM files WHERE case_id = $1 OR claim_id IN (SELECT id FROM claims WHERE case_id = $1)`, [parent.id]);
    expect(gone.length).toBeGreaterThan(4);
    expect(gone.every((f) => f.state === 'purged' && f.wrapped_key === null && f.name_enc === null)).toBe(true);
    for (const e of evidence) expect(await st.exists(chunkKey(e.storage_prefix, 0))).toBe(false);
    // the children still read the same bytes
    expect(await st.exists(chunkKey(u2.storage_prefix, 0))).toBe(true);
    const child = (await up.call('GET', `/api/cases/${kids[0]!.id}`)).json;
    const f = child.files.find((x: any) => x.name === 'U02.stl');
    const dl = await up.call('GET', `/api/files/${f.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.res.rawPayload.length).toBeGreaterThan(84);
    expect((await runRetention()).orphanObjectsRemoved).toBeGreaterThanOrEqual(0);
    expect(await st.exists(chunkKey(u2.storage_prefix, 0))).toBe(true);
    // purging the children one by one removes the objects only after the last user is gone
    await q(`UPDATE cases SET purge_after = now() - interval '1 day' WHERE id = $1`, [kids[0]!.id]);
    await runRetention();
    if (kids.length > 1) expect(await st.exists(chunkKey(u2.storage_prefix, 0))).toBe(true);
    for (const kid of kids.slice(1)) await q(`UPDATE cases SET purge_after = now() - interval '1 day' WHERE id = $1`, [kid.id]);
    await runRetention();
    expect(await st.exists(chunkKey(u2.storage_prefix, 0))).toBe(false);
    // the production record of the parent remains
    expect((await q(`SELECT ref FROM cases WHERE id = $1`, [parent.id]))[0].ref).toMatch(/^ACME-/);
    expect((await q(`SELECT count(*)::int AS n FROM claims WHERE case_id = $1`, [parent.id]))[0].n).toBeGreaterThan(0);
  });
});
