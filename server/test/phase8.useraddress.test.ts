import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createApiKey } from '../src/auth/apikeys';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { runDueJobs } from '../src/worker';
import { FakePortalClient, setPortalClientFactory, toPortalShipping } from '../src/services/portal';
import { pickCaseAddress, resolveCaseAddress } from '../src/services/userCaseAddress';
import { CASE_ADDRESS_REQUIRED_MESSAGE, type CaseAddress } from '../../shared/caseAddress';
import { Client, createDemoUser, cubeStl, laserCsv, minimalPdf, orgIdOf, trimLine } from './helpers';

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);
const fake = new FakePortalClient();

const ACME_ADDRESS: CaseAddress = {
  company: 'Acme Aligners Ltd', fullName: 'Alex Acme', street: '1 Rua Direita', city: 'Chaves', postalCode: '5400-001', stateProvince: 'Vila Real', country: 'PT', phone: '+351276000000', email: 'goods@acme.demo',
};
const UMA_ADDRESS: CaseAddress = {
  company: 'Acme Aligners Lab', fullName: 'Uma Upload', street: '77 Quarry Lane', city: 'Braga', postalCode: '4700-123', stateProvince: 'Braga', country: 'PT', phone: '+351253111222', email: 'uma.parcels@acme.demo',
};
const QUINN_ADDRESS: CaseAddress = {
  company: 'Acme Quality Office', fullName: 'Quinn Quality', street: '3 Harbour Road', city: 'Porto', postalCode: '4000-010', stateProvince: 'Porto', country: 'PT', phone: '+351220333444', email: 'quinn.parcels@acme.demo',
};

const setCompany = (orgId: string, a: CaseAddress | null) =>
  q(`UPDATE organizations SET settings = CASE WHEN $2::jsonb IS NULL THEN settings - 'case_address' ELSE jsonb_set(settings, '{case_address}', $2::jsonb, true) END WHERE id = $1`, [orgId, a ? JSON.stringify(a) : null]);
const setOwn = (email: string, a: unknown) => q(`UPDATE users SET case_address = $2::jsonb WHERE email = $1`, [email, a === null ? null : JSON.stringify(a)]);
const ownOf = async (email: string) => (await q(`SELECT case_address FROM users WHERE email = $1`, [email]))[0].case_address;
const userId = async (email: string) => (await q<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]))[0]!.id;

let app: FastifyInstance;
let acmeId: string;
let admin: Client;
let uma: Client; // uploader
let quinn: Client; // quality
let finn: Client; // finance
let viewer: Client;
let contoso: Client;
let klAdmin: Client;

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  await createDemoUser(acmeId, 'viewer@acme.demo', 'Vic Viewer', ['viewer']);
  admin = await new Client(app).full('admin@acme.demo');
  uma = await new Client(app).full('upload@acme.demo');
  quinn = await new Client(app).full('quality@acme.demo');
  finn = await new Client(app).full('finance@acme.demo');
  viewer = await new Client(app).full('viewer@acme.demo');
  contoso = await new Client(app).full('owner@contoso.demo');
  klAdmin = await new Client(app).full('admin@kline.demo');
  setPortalClientFactory(() => fake);
});

afterAll(async () => {
  setPortalClientFactory(undefined);
  await app.close();
  await closePools();
});

// ---------------------------------------------------------------------------
describe('own case address: read', () => {
  it('shows every partner role the company address as the one in use, and no own address', async () => {
    for (const [who, c] of [['admin', admin], ['uploader', uma], ['quality', quinn], ['finance', finn], ['viewer', viewer]] as const) {
      const r = await c.call('GET', '/api/account/case-address');
      expect(r.status, who).toBe(200);
      expect(r.json, who).toEqual({ own: null, ownComplete: false, company: ACME_ADDRESS, companyComplete: true, effective: 'company' });
    }
  });

  it('answers none when neither address is complete, and company when the company one is the only one', async () => {
    await setCompany(acmeId, null);
    try {
      expect((await viewer.call('GET', '/api/account/case-address')).json).toMatchObject({ company: null, companyComplete: false, effective: 'none' });
      await setCompany(acmeId, { ...ACME_ADDRESS, phone: '' });
      const r = await viewer.call('GET', '/api/account/case-address');
      expect(r.json).toMatchObject({ companyComplete: false, effective: 'none' });
      expect(r.json.company.phone).toBe('');
    } finally {
      await setCompany(acmeId, ACME_ADDRESS);
    }
  });

  it('is for signed in partner users: K Line staff, API keys and visitors are refused', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const kl = await klAdmin.call(method, '/api/account/case-address', method === 'PUT' ? UMA_ADDRESS : undefined);
      expect(kl.status, `kline ${method}`).toBe(403);
      expect((await new Client(app).call(method, '/api/account/case-address', method === 'PUT' ? UMA_ADDRESS : undefined)).status, `anonymous ${method}`).toBe(401);
    }
    const key = await tx(SYSTEM, (c) => createApiKey(c, { orgId: acmeId, orgKind: 'partner', name: 'user address key', scopes: ['cases:read', 'cases:write'], expiresInDays: 30 }));
    const res = await app.inject({ method: 'GET', url: '/api/account/case-address', headers: { authorization: `Bearer ${key.key}` }, remoteAddress: '10.9.8.7' });
    expect(res.statusCode).toBe(403);
    expect((await q(`SELECT count(*)::int AS n FROM users WHERE case_address IS NOT NULL`))[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('own case address: write', () => {
  it('lets every partner role save, read and remove its own address, and nobody else sees it', async () => {
    const roles: [string, Client, string, CaseAddress][] = [
      ['uploader', uma, 'upload@acme.demo', UMA_ADDRESS],
      ['quality', quinn, 'quality@acme.demo', QUINN_ADDRESS],
      ['finance', finn, 'finance@acme.demo', { ...UMA_ADDRESS, fullName: 'Finn Finance', street: '5 Ledger Street' }],
      ['viewer', viewer, 'viewer@acme.demo', { ...QUINN_ADDRESS, fullName: 'Vic Viewer', street: '9 Quiet Close' }],
      ['admin', admin, 'admin@acme.demo', { ...ACME_ADDRESS, fullName: 'Alex Own', street: '12 Admin Avenue' }],
    ];
    for (const [who, c, email, addr] of roles) {
      const put = await c.call('PUT', '/api/account/case-address', addr);
      expect(put.status, `${who} ${JSON.stringify(put.json)}`).toBe(200);
      expect(put.json).toEqual({ own: addr, ownComplete: true, company: ACME_ADDRESS, companyComplete: true, effective: 'own' });
      expect(await ownOf(email), who).toEqual(addr);
    }
    // everybody sees only their own, never the others
    for (const [who, c, , addr] of roles) {
      const r = await c.call('GET', '/api/account/case-address');
      expect(r.json.own, who).toEqual(addr);
      const text = JSON.stringify(r.json);
      for (const [, , , other] of roles) if (other !== addr && other.street !== ACME_ADDRESS.street) expect(text, who).not.toContain(other.street);
    }
    // the company address was not touched by any of it
    expect((await q(`SELECT settings->'case_address' AS a FROM organizations WHERE id = $1`, [acmeId]))[0].a).toEqual(ACME_ADDRESS);
    expect((await admin.call('GET', '/api/org/profile')).json.caseAddress).toEqual(ACME_ADDRESS);
    // removing falls back to the company address
    for (const [who, c, email] of roles) {
      const del = await c.call('DELETE', '/api/account/case-address');
      expect(del.status, who).toBe(200);
      expect(del.json).toEqual({ own: null, ownComplete: false, company: ACME_ADDRESS, companyComplete: true, effective: 'company' });
      expect(await ownOf(email), who).toBeNull();
    }
  });

  it('keeps users apart inside one company and across companies', async () => {
    expect((await uma.call('PUT', '/api/account/case-address', UMA_ADDRESS)).status).toBe(200);
    expect((await quinn.call('GET', '/api/account/case-address')).json.own).toBeNull();
    expect((await contoso.call('GET', '/api/account/case-address')).json).toMatchObject({ own: null, effective: 'company' });
    expect(JSON.stringify((await contoso.call('GET', '/api/account/case-address')).json)).not.toContain('Quarry Lane');
    // no route takes a user id: the body cannot aim at another person
    expect((await quinn.call('PUT', '/api/account/case-address', { ...QUINN_ADDRESS, userId: await userId('upload@acme.demo') })).status).toBe(200);
    expect(await ownOf('upload@acme.demo')).toEqual(UMA_ADDRESS);
    // a user id from another company never resolves to an own address of that company
    const contosoUser = await userId('owner@contoso.demo');
    await setOwn('owner@contoso.demo', UMA_ADDRESS);
    const resolved = await tx(SYSTEM, (c) => resolveCaseAddress(c, acmeId, contosoUser));
    expect(resolved).toMatchObject({ source: 'company', address: ACME_ADDRESS });
    await setOwn('owner@contoso.demo', null);
    await uma.call('DELETE', '/api/account/case-address');
    await quinn.call('DELETE', '/api/account/case-address');
  });

  it('is isolated by row level security: a partner session cannot read another company user row', async () => {
    await setOwn('owner@contoso.demo', UMA_ADDRESS);
    try {
      const rows = await tx({ orgId: acmeId, bypass: false }, async (c) => (await c.query(`SELECT email, case_address FROM users WHERE case_address IS NOT NULL`)).rows);
      expect(rows).toEqual([]);
    } finally {
      await setOwn('owner@contoso.demo', null);
    }
  });

  it('needs all nine fields and refuses wrong values with field messages, storing nothing', async () => {
    const bad = await uma.call('PUT', '/api/account/case-address', { street: '1 Only Street' });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('invalid_request');
    expect(bad.json.fields.map((f: any) => f.path).sort()).toEqual(['city', 'company', 'country', 'email', 'fullName', 'phone', 'postalCode', 'stateProvince']);
    expect(bad.json.fields.every((f: any) => typeof f.message === 'string' && f.message.length > 5 && !/ [-–—] /.test(f.message))).toBe(true);
    for (const patch of [{ phone: '12' }, { phone: '+351 276 000 000 999' }, { country: 'XX' }, { email: 'not-an-email' }, { postalCode: '5400-001-123456' }, { company: '<b>x</b>' }, { stateProvince: '' }]) {
      const r = await uma.call('PUT', '/api/account/case-address', { ...UMA_ADDRESS, ...patch });
      expect(r.status, JSON.stringify(patch)).toBe(400);
    }
    expect((await uma.call('PUT', '/api/account/case-address', null)).status).toBe(400);
    expect(await ownOf('upload@acme.demo')).toBeNull();
  });

  it('accepts N/A for the state, cleans the country and stores only the nine fields', async () => {
    const r = await uma.call('PUT', '/api/account/case-address', { ...UMA_ADDRESS, stateProvince: 'N/A', country: ' pt ', extra: 'ignored' });
    expect(r.status).toBe(200);
    expect(await ownOf('upload@acme.demo')).toEqual({ ...UMA_ADDRESS, stateProvince: 'N/A', country: 'PT' });
    await uma.call('DELETE', '/api/account/case-address');
  });

  it('audits the change with field names only, never values', async () => {
    await uma.call('PUT', '/api/account/case-address', UMA_ADDRESS);
    await uma.call('PUT', '/api/account/case-address', { ...UMA_ADDRESS, city: 'Guimaraes', phone: '+351253999888' });
    await uma.call('DELETE', '/api/account/case-address');
    const rows = await q(`SELECT actor_id, org_id, target_type, target_id, details FROM audit_log WHERE action = 'account.case_address_changed' ORDER BY seq`);
    const mine = rows.filter((r) => r.actor_id === rows[rows.length - 1].actor_id).slice(-3);
    expect(mine).toHaveLength(3);
    expect(mine[0].details.changed.sort()).toEqual(['city', 'company', 'country', 'email', 'fullName', 'phone', 'postalCode', 'stateProvince', 'street']);
    expect(mine[1].details).toEqual({ changed: ['city', 'phone'], removed: false });
    expect(mine[2].details).toEqual({ changed: [], removed: true });
    expect(mine[0]).toMatchObject({ org_id: acmeId, target_type: 'user' });
    const dump = JSON.stringify(await q(`SELECT details, actor_id, target_id FROM audit_log`));
    expect(dump).not.toMatch(/Quarry Lane|Guimaraes|253999888|uma\.parcels|Braga/);
    // the audit log shown to the company holds no values either
    expect(JSON.stringify((await admin.call('GET', '/api/audit?limit=200')).json)).not.toMatch(/Quarry Lane|Guimaraes|253999888|uma\.parcels/);
  });

  it('leaves the getting started list and the profile on the company address', async () => {
    await setCompany(acmeId, null);
    try {
      await uma.call('PUT', '/api/account/case-address', UMA_ADDRESS);
      const item = (await admin.call('GET', '/api/org/onboarding')).json.items.find((i: any) => i.id === 'case_address');
      expect(item.done).toBe(false);
      const prof = (await admin.call('GET', '/api/org/profile')).json;
      expect(prof.caseAddress).toBeNull();
      expect(prof.caseAddressComplete).toBe(false);
    } finally {
      await uma.call('DELETE', '/api/account/case-address');
      await setCompany(acmeId, ACME_ADDRESS);
    }
  });
});

// ---------------------------------------------------------------------------
describe('which address a direct manufacturing case is sent with', () => {
  const portalOf = async (c: Client, id: string) => (await c.call('GET', `/api/cases/${id}`)).json.case.portal;
  const pushOf = async (id: string) => (await q(`SELECT portal_push FROM cases WHERE id = $1`, [id]))[0].portal_push;

  async function directCase(c: Client, pid: string, first: string, last: string, files = true) {
    const b = await c.call('POST', '/api/bulk/batches', { cases: [{ key: pid, patientId: pid, firstName: first, lastName: last }] });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    const id = b.json.cases[0].id as string;
    if (files) {
      await c.uploadFile(id, `${pid}_U01.stl`, cubeStl(50));
      await c.uploadFile(id, `${pid}_U01.pts`, trimLine());
      await c.uploadFile(id, `${pid}_U01.csv`, laserCsv());
      await c.uploadFile(id, 'report.pdf', minimalPdf());
    }
    return id;
  }
  const submit = (c: Client, id: string) => c.call('POST', `/api/cases/${id}/submit`, {});
  const sent = () => [...fake.cases.values()].at(-1)!.shippingAddress;

  it('uses the sender own address when it is complete and records only the source', async () => {
    fake.reset();
    await uma.call('PUT', '/api/account/case-address', UMA_ADDRESS);
    const id = await directCase(uma, '92001', 'Olga', 'Own');
    expect((await submit(uma, id)).status).toBe(200);
    await runDueJobs();
    expect(fake.calls.map((c) => c.op).slice(0, 2)).toEqual(['createCase', 'setShippingAddress']);
    expect(sent()).toEqual(toPortalShipping(UMA_ADDRESS));
    expect(sent()).toMatchObject({ shipping_full_name: 'Uma Upload', shipping_street_address: '77 Quarry Lane', shipping_email_address: 'uma.parcels@acme.demo' });
    expect(await portalOf(uma, id)).toMatchObject({ status: 'pushed' });
    const push = await pushOf(id);
    expect(push.uploads.address).toBe(true);
    expect(push.addressSource).toBe('own');
    expect(JSON.stringify(push)).not.toMatch(/Quarry|Braga|uma\.parcels|Rua Direita/);
    // no address values in events, jobs, audit entries, the case JSON or the lists
    const dump = JSON.stringify([
      await q('SELECT data FROM case_events WHERE case_id = $1', [id]), await q('SELECT payload, last_error FROM jobs'),
      await q(`SELECT details FROM audit_log WHERE action LIKE 'case.%'`), (await admin.call('GET', '/api/audit?limit=200')).json,
    ]);
    expect(dump).not.toMatch(/Quarry Lane|Braga|uma\.parcels|253111222/);
    const caseJson = JSON.stringify([(await uma.call('GET', `/api/cases/${id}`)).json, (await uma.call('GET', '/api/cases?mode=direct')).json]);
    expect(caseJson).not.toMatch(/Quarry Lane|shipping|addressSource/i);
  });

  it('gives a colleague without an own address the company address, in the same company and at the same time', async () => {
    fake.reset();
    await uma.call('PUT', '/api/account/case-address', UMA_ADDRESS);
    const a = await directCase(uma, '92002', 'Una', 'First');
    const b = await directCase(admin, '92003', 'Adam', 'Second');
    const c3 = await directCase(admin, '92004', 'Quincy', 'Third');
    // Alex saves an own address after creating the case but before the push: the address is resolved when the address step runs
    await admin.call('PUT', '/api/account/case-address', QUINN_ADDRESS);
    const d = await directCase(admin, '92005', 'Quentin', 'Fourth');
    for (const [c, id] of [[uma, a], [admin, b], [admin, c3], [admin, d]] as const) {
      const r = await submit(c as Client, id as string);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }
    await runDueJobs();
    const byCase = async (id: string) => {
      const uuid = (await q(`SELECT portal_case_uuid FROM cases WHERE id = $1`, [id]))[0].portal_case_uuid;
      return fake.cases.get(uuid)!.shippingAddress;
    };
    expect(await byCase(a)).toEqual(toPortalShipping(UMA_ADDRESS));
    expect(await byCase(b)).toEqual(toPortalShipping(QUINN_ADDRESS)); // b was created by Alex too: only one address for Alex at push time
    expect(await byCase(c3)).toEqual(toPortalShipping(QUINN_ADDRESS));
    expect(await byCase(d)).toEqual(toPortalShipping(QUINN_ADDRESS));
    expect((await pushOf(a)).addressSource).toBe('own');
    expect((await pushOf(b)).addressSource).toBe('own');
    expect((await pushOf(d)).addressSource).toBe('own');
    await uma.call('DELETE', '/api/account/case-address');
    await admin.call('DELETE', '/api/account/case-address');
  });

  it('uses the address of the person who created the case, not of the person who submits it or of the worker', async () => {
    fake.reset();
    await uma.call('PUT', '/api/account/case-address', UMA_ADDRESS);
    const id = await directCase(uma, '92006', 'Cleo', 'Creator');
    // Alex (no own address) submits Uma's case
    const r = await submit(admin, id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await runDueJobs();
    expect(sent()).toEqual(toPortalShipping(UMA_ADDRESS));
    expect((await pushOf(id)).addressSource).toBe('own');
    // and the other way round: Alex creates, Uma submits, Uma's own address is not used
    fake.reset();
    const id2 = await directCase(admin, '92007', 'Cato', 'Creator');
    expect((await submit(uma, id2)).status).toBe(200);
    await runDueJobs();
    expect(sent()).toEqual(toPortalShipping(ACME_ADDRESS));
    expect((await pushOf(id2)).addressSource).toBe('company');
    await uma.call('DELETE', '/api/account/case-address');
  });

  it('does not repeat the address on a retry, and keeps what was sent when the own address changes later', async () => {
    fake.reset();
    await uma.call('PUT', '/api/account/case-address', UMA_ADDRESS);
    const id = await directCase(uma, '92008', 'Rex', 'Retry');
    fake.failNext('uploadFile', 'server', 1, 503, 0);
    await submit(uma, id);
    await runDueJobs();
    expect(await portalOf(uma, id)).toMatchObject({ status: 'pending' });
    expect((await pushOf(id)).addressSource).toBe('own');
    // the person changes or removes the own address before the retry: nothing is sent again
    await uma.call('PUT', '/api/account/case-address', { ...UMA_ADDRESS, street: '1 New Street' });
    await uma.call('DELETE', '/api/account/case-address');
    await q(`UPDATE jobs SET run_at = now() WHERE kind = 'bulk.push' AND status = 'queued'`);
    await runDueJobs();
    expect(await portalOf(uma, id)).toMatchObject({ status: 'pushed' });
    expect(fake.calls.filter((c) => c.op === 'createCase')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.op === 'setShippingAddress')).toHaveLength(1);
    expect(sent()).toEqual(toPortalShipping(UMA_ADDRESS));
    expect((await pushOf(id)).addressSource).toBe('own');
    // a later change never touches the pushed case
    await uma.call('PUT', '/api/account/case-address', { ...UMA_ADDRESS, city: 'Lisbon' });
    await runDueJobs();
    expect(sent()).toEqual(toPortalShipping(UMA_ADDRESS));
    expect(fake.calls.filter((c) => c.op === 'setShippingAddress')).toHaveLength(1);
    await uma.call('DELETE', '/api/account/case-address');
  });

  it('answers the early gate from the sender: only an own address, only a company address, or neither', async () => {
    fake.reset();
    const batch = (c: Client, pid: string) => c.call('POST', '/api/bulk/batches', { cases: [{ key: 'k', patientId: pid, firstName: 'Gate', lastName: 'Test' }] });
    // a draft made while the company address still exists
    const draftOwn = await directCase(uma, '92010', 'Dina', 'Draft');
    const draftNone = await directCase(admin, '92011', 'Dan', 'Draft');
    await setCompany(acmeId, null);
    try {
      // only an own address: Uma may send, Alex (none) may not
      await uma.call('PUT', '/api/account/case-address', UMA_ADDRESS);
      const okUma = await batch(uma, '92012');
      expect(okUma.status, JSON.stringify(okUma.json)).toBe(201);
      const noQuinn = await batch(admin, '92013');
      expect(noQuinn.status).toBe(409);
      expect(noQuinn.json).toEqual({ code: 'case_address_required', message: CASE_ADDRESS_REQUIRED_MESSAGE });
      expect(await q(`SELECT 1 FROM cases WHERE partner_case_id = '92013'`)).toHaveLength(0);
      // submits: the creator decides
      expect((await submit(admin, draftNone)).json.code).toBe('case_address_required');
      expect((await q(`SELECT status FROM cases WHERE id = $1`, [draftNone]))[0].status).toBe('draft');
      expect(await q(`SELECT 1 FROM jobs WHERE kind = 'bulk.push' AND payload->>'caseId' = $1`, [draftNone])).toHaveLength(0);
      expect((await submit(admin, draftOwn)).status).toBe(200); // created by Uma, submitted by the admin
      // an incomplete own address does not count, and does not hide the missing company one
      await setOwn('upload@acme.demo', { ...UMA_ADDRESS, phone: '' });
      expect((await batch(uma, '92014')).json.code).toBe('case_address_required');
    } finally {
      await setCompany(acmeId, ACME_ADDRESS);
    }
    // only a company address: an incomplete own address falls back to it
    expect(await ownOf('upload@acme.demo')).toMatchObject({ phone: '' });
    const fallback = await batch(uma, '92015');
    expect(fallback.status, JSON.stringify(fallback.json)).toBe(201);
    expect(await resolveCaseAddress_('upload@acme.demo')).toMatchObject({ source: 'company' });
    await setOwn('upload@acme.demo', null);
    expect((await batch(admin, '92016')).status).toBe(201);
    await runDueJobs();
  });

  it('refuses permanently when the sender address and the company address are both gone at push time, and works after the person adds one', async () => {
    fake.reset();
    const id = await directCase(uma, '92020', 'Ola', 'Late');
    await submit(uma, id);
    await setCompany(acmeId, null);
    try {
      await runDueJobs();
      const p = await portalOf(uma, id);
      expect(p).toMatchObject({ status: 'failed', lastError: CASE_ADDRESS_REQUIRED_MESSAGE });
      expect(fake.calls).toEqual([]);
      const events = (await uma.call('GET', `/api/cases/${id}`)).json.events.filter((e: any) => e.type === 'portal_push_failed');
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({ code: 'case_address_required' });
      expect((await q(`SELECT status FROM jobs WHERE kind = 'bulk.push' AND payload->>'caseId' = $1`, [id])).every((j) => j.status !== 'queued')).toBe(true);
      // Try again before fixing it fails the same way, then the person adds an own address
      expect((await uma.call('POST', `/api/cases/${id}/portal/retry`, {})).status).toBe(200);
      await runDueJobs();
      expect(await portalOf(uma, id)).toMatchObject({ status: 'failed', lastError: CASE_ADDRESS_REQUIRED_MESSAGE });
      expect((await uma.call('PUT', '/api/account/case-address', UMA_ADDRESS)).status).toBe(200);
      expect((await uma.call('POST', `/api/cases/${id}/portal/retry`, {})).status).toBe(200);
      await runDueJobs();
      expect(await portalOf(uma, id)).toMatchObject({ status: 'pushed' });
      expect(sent()).toEqual(toPortalShipping(UMA_ADDRESS));
      expect((await pushOf(id)).addressSource).toBe('own');
    } finally {
      await setCompany(acmeId, ACME_ADDRESS);
      await uma.call('DELETE', '/api/account/case-address');
    }
  });

  it('uses the company address for partner API keys, which have no person', async () => {
    fake.reset();
    await uma.call('PUT', '/api/account/case-address', UMA_ADDRESS);
    const key = await tx(SYSTEM, (c) => createApiKey(c, { orgId: acmeId, orgKind: 'partner', name: 'user address key 2', scopes: ['cases:read', 'cases:write'], expiresInDays: 30 }));
    const post = (patientId: string) =>
      app.inject({
        method: 'POST', url: '/api/bulk/batches', headers: { authorization: `Bearer ${key.key}` }, remoteAddress: '10.9.9.8',
        payload: { cases: [{ key: 'k', patientId, firstName: 'Key', lastName: 'User' }] },
      });
    await setCompany(acmeId, null);
    try {
      // somebody in the company having an own address does not help a key
      const blocked = await post('92030');
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().code).toBe('case_address_required');
    } finally {
      await setCompany(acmeId, ACME_ADDRESS);
    }
    const ok = await post('92030');
    expect(ok.statusCode).toBe(201);
    const id = ok.json().cases[0].id as string;
    expect((await q(`SELECT created_by FROM cases WHERE id = $1`, [id]))[0].created_by).toBeNull();
    await uma.uploadFile(id, '92030_U01.stl', cubeStl(50));
    await uma.uploadFile(id, '92030_U01.pts', trimLine());
    await uma.uploadFile(id, '92030_U01.csv', laserCsv());
    const sub = await uma.call('POST', `/api/cases/${id}/submit`, {});
    expect(sub.status, JSON.stringify(sub.json)).toBe(200);
    await runDueJobs();
    expect(sent()).toEqual(toPortalShipping(ACME_ADDRESS));
    expect((await pushOf(id)).addressSource).toBe('company');
    await uma.call('DELETE', '/api/account/case-address');
  });

  it('keeps the other company on its own addresses', async () => {
    await uma.call('PUT', '/api/account/case-address', UMA_ADDRESS);
    // Contoso is not approved for uploads in the seed, so look at the gate and the resolution instead of a full push
    const contosoId = await orgIdOf('CONT');
    const contosoUser = await userId('owner@contoso.demo');
    expect(await tx(SYSTEM, (c) => resolveCaseAddress(c, contosoId, contosoUser))).toMatchObject({ source: 'company' });
    expect(await tx(SYSTEM, (c) => resolveCaseAddress(c, contosoId, null))).toMatchObject({ source: 'company' });
    const r = await contoso.call('POST', '/api/bulk/batches', { cases: [{ key: 'k', patientId: '93001', firstName: 'Con', lastName: 'Toso' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const original = (await q(`SELECT settings->'case_address' AS a FROM organizations WHERE id = $1`, [contosoId]))[0].a as CaseAddress;
    await setCompany(contosoId, null);
    try {
      // Acme's own addresses never make Contoso's gate pass
      expect((await contoso.call('POST', '/api/bulk/batches', { cases: [{ key: 'k', patientId: '93002', firstName: 'Con', lastName: 'Toso' }] })).json.code).toBe('case_address_required');
    } finally {
      await setCompany(contosoId, original);
    }
    await uma.call('DELETE', '/api/account/case-address');
  });
});

const resolveCaseAddress_ = async (email: string) => {
  const u = (await q(`SELECT id, org_id FROM users WHERE email = $1`, [email]))[0];
  return tx(SYSTEM, (c) => resolveCaseAddress(c, u.org_id, u.id));
};

// ---------------------------------------------------------------------------
describe('pickCaseAddress', () => {
  it('prefers a complete own address, then a complete company address, else nothing', () => {
    expect(pickCaseAddress(UMA_ADDRESS, ACME_ADDRESS)).toEqual({ address: UMA_ADDRESS, source: 'own' });
    expect(pickCaseAddress(null, ACME_ADDRESS)).toEqual({ address: ACME_ADDRESS, source: 'company' });
    expect(pickCaseAddress({ ...UMA_ADDRESS, city: '' }, ACME_ADDRESS)).toEqual({ address: ACME_ADDRESS, source: 'company' });
    expect(pickCaseAddress(undefined, { ...ACME_ADDRESS, country: 'ZZ' })).toBeNull();
    expect(pickCaseAddress({}, null)).toBeNull();
  });
});
