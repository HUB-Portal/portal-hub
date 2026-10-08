import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { unzipSync } from 'fflate';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { runDueJobs } from '../src/worker';
import { FakePortalClient, setPortalClientFactory } from '../src/services/portal';
import { Client, PNG_BYTES, createDemoUser, cubeStl, laserCsv, minimalPdf, orgIdOf, trimLine } from './helpers';

let app: FastifyInstance;
let acmeId: string;
let up: Client;
let admin: Client;
let contoso: Client;
const fake = new FakePortalClient();

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  const contosoId = await tx(SYSTEM, async (c) => (await c.query(`INSERT INTO organizations (kind, name, code, country, status) VALUES ('partner', 'Contoso Smile', 'CONTOSO', 'PT', 'active') RETURNING id`)).rows[0].id);
  await createDemoUser(contosoId, 'admin@contoso.demo', 'Cora Contoso', ['admin']);
  up = await new Client(app).full('upload@acme.demo');
  admin = await new Client(app).full('admin@acme.demo');
  contoso = await new Client(app).full('admin@contoso.demo');
  setPortalClientFactory(() => fake);
});

afterAll(async () => {
  setPortalClientFactory(undefined);
  await app.close();
  await closePools();
});

const portalOf = async (id: string) => (await up.call('GET', `/api/cases/${id}`)).json.case.portal;
/** The error text is K Line's business: a partner never gets it (usability review of 8 Oct 2026, R3), so tests read it from the database. */
const lastErrorOf = async (id: string) => (await q<{ e: string | null }>(`SELECT portal_push->>'lastError' AS e FROM cases WHERE id = $1`, [id]))[0]!.e ?? undefined;

/** Creates a direct case through the bulk route and uploads a realistic set of files. */
async function directCase(pid: string, first: string, last: string, instructions?: string) {
  const b = await up.call('POST', '/api/bulk/batches', { cases: [{ key: pid, patientId: pid, firstName: first, lastName: last, instructions }] });
  expect(b.status, JSON.stringify(b.json)).toBe(201);
  const id = b.json.cases[0].id as string;
  await up.uploadFile(id, `${pid}_U01.stl`, cubeStl(50));
  await up.uploadFile(id, `${pid}_U01.pts`, trimLine());
  await up.uploadFile(id, `${pid}_U01.csv`, laserCsv());
  await up.uploadFile(id, `${pid}_L01_T.stl`, cubeStl(50));
  await up.uploadFile(id, 'report.pdf', minimalPdf());
  await up.uploadFile(id, 'photo.png', PNG_BYTES);
  return { id, batchId: b.json.batchId as string };
}

describe('direct manufacturing bulk intake', () => {
  let batchId: string;
  let ids: Record<string, string> = {};

  it('creates a batch, refuses a name that is too long and a bad patient ID', async () => {
    const r = await up.call('POST', '/api/bulk/batches', {
      cases: [
        { key: 'a', patientId: '55813', firstName: 'Marc', lastName: 'Alonso', instructions: 'Handle with care' },
        { key: 'b', patientId: '90001', firstName: 'Jan', lastName: 'Kowalski' },
        { key: 'f', patientId: '70003', firstName: 'x'.repeat(51), lastName: 'Long' },
        { key: 'h', patientId: 'bad<id>', firstName: 'Bad', lastName: 'Id' },
      ],
      priority: 'rush',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    batchId = r.json.batchId;
    const byKey = Object.fromEntries((r.json.cases as any[]).map((c) => [c.key, c]));
    expect(byKey.a.ref).toMatch(/^ACME-\d{6}$/);
    expect(byKey.a.caseId).toBe('55813');
    expect(byKey.b.id).toBeTruthy();
    expect(byKey.f.error).toBe('name_too_long');
    expect(byKey.h.error).toBe('invalid_patient_id');
    ids = { a: byKey.a.id, b: byKey.b.id };

    // names never travel in clear
    expect(JSON.stringify(r.json)).not.toMatch(/Alonso|Kowalski/);
    const row = (await q('SELECT patient_enc, patient_first_enc, patient_last_enc, patient_bidxs, partner_case_id, manufacturing_mode, priority FROM cases WHERE id = $1', [ids.a]))[0];
    expect(row.patient_first_enc).toMatch(/^f1\./);
    expect(row.patient_last_enc).toMatch(/^f1\./);
    expect(row.patient_enc).toMatch(/^f1\./);
    expect(row.patient_bidxs).toHaveLength(2);
    expect(JSON.stringify(row)).not.toMatch(/Marc|Alonso/);
    expect(row).toMatchObject({ partner_case_id: '55813', manufacturing_mode: 'direct', priority: 'rush' });

    // the patient ID and the names are optional: a case with neither is created, reads back as "no name" and goes to the portal under its reference
    const bare = await up.call('POST', '/api/bulk/batches', { cases: [{ key: 'bare', firstName: '', lastName: '' }, { key: 'half', firstName: 'Solo', lastName: '' }] });
    expect(bare.status, JSON.stringify(bare.json)).toBe(201);
    const [bareCase, halfCase] = bare.json.cases as { id?: string; error?: string }[];
    expect(bareCase!.error).toBeUndefined();
    expect(halfCase!.error).toBeUndefined();
    const shown = await up.call('GET', `/api/cases/${bareCase!.id}`);
    expect(shown.json.case).toMatchObject({ hasPatientName: false, patientName: null, caseId: null });
    // a name can be added and cleared again while the case is a draft
    const named = await up.call('PATCH', `/api/cases/${bareCase!.id}`, { firstName: 'Late', lastName: 'Name' });
    expect(named.status, JSON.stringify(named.json)).toBe(200);
    expect(named.json.case.patientName).toBe('Late Name');
    const cleared = await up.call('PATCH', `/api/cases/${bareCase!.id}`, { firstName: '', lastName: '' });
    expect(cleared.status, JSON.stringify(cleared.json)).toBe(200);
    expect(cleared.json.case).toMatchObject({ hasPatientName: false, patientName: null });
    for (const c of [bareCase, halfCase]) expect((await up.call('DELETE', `/api/cases/${c!.id}`)).status).toBe(200);

    // a second batch may reuse the patient ID of a direct case; standard cases keep their unique case ID
    const again = await up.call('POST', '/api/bulk/batches', { cases: [{ key: 'z', patientId: '55813', firstName: 'Other', lastName: 'Person' }] });
    expect(again.status, JSON.stringify(again.json)).toBe(201);
    expect(again.json.cases[0].id).toBeTruthy();
    // no patient ID at all: the case is created without a case ID
    const noId = await up.call('POST', '/api/bulk/batches', { cases: [{ key: 'n', firstName: 'No', lastName: 'Number' }] });
    expect(noId.status, JSON.stringify(noId.json)).toBe(201);
    expect(noId.json.cases[0].id).toBeTruthy();
    expect((await q('SELECT partner_case_id FROM cases WHERE id = $1', [noId.json.cases[0].id]))[0].partner_case_id).toBeNull();
    const std = await up.call('POST', '/api/cases', { caseId: 'STD-DUP' });
    expect(std.status).toBe(201);
    const dupStd = await up.call('POST', '/api/cases', { caseId: 'STD-DUP' });
    expect(dupStd.json.code).toBe('case_id_exists');
  });

  it('shows the batch, the names, the portal block, and finds cases by name in either order', async () => {
    const r = await up.call('GET', `/api/bulk/batches/${batchId}`);
    expect(r.status).toBe(200);
    expect(r.json.batch).toMatchObject({ id: batchId, status: 'open', caseCount: 2, priority: 'rush' });
    const a = r.json.cases.find((c: any) => c.id === ids.a);
    expect(a).toMatchObject({ manufacturingMode: 'direct', caseId: '55813', status: 'draft', patientMasked: 'M*** A*****', hasPatientName: true, bulkBatchId: batchId });
    expect(a.portal).toEqual({ status: 'pending', attempts: 0, demo: false });
    // the company that uploaded the name sees it in full (usability review of 8 Oct 2026, A1); the masked form is still there, and K Line staff get no clear name
    expect(a.patientName).toBe('Marc Alonso');
    const staff = await (await new Client(app).full('admin@kline.demo')).call('GET', `/api/console/cases/${ids.a}`);
    expect(JSON.stringify(staff.json)).not.toMatch(/Marc|Alonso/);
    for (const term of ['Marc Alonso', 'alonso marc', 'ALONSO, Marc']) {
      const s = await up.call('GET', `/api/cases?search=${encodeURIComponent(term)}`);
      // "ALONSO, Marc" normalises to the same letters as "Alonso Marc"
      expect(s.json.items.map((c: any) => c.id), term).toEqual([ids.a]);
    }
    expect((await up.call('GET', '/api/cases?mode=direct')).json.total).toBe(4); // two from the first batch, then the repeated and the missing patient ID
    const reveal = await up.call('POST', `/api/cases/${ids.a}/reveal-name`, {});
    expect(reveal.json).toEqual({ patientName: 'Marc Alonso', firstName: 'Marc', lastName: 'Alonso' });
    // patient ID and names of direct cases can be corrected while in draft
    const fix = await up.call('PATCH', `/api/cases/${ids.b}`, { firstName: 'Jan', lastName: 'Kowalski' });
    expect(fix.status).toBe(200);
    expect((await up.call('PATCH', `/api/cases/${ids.b}`, { patientName: 'x' })).status).toBe(400);
    expect((await up.call('PATCH', `/api/cases/${ids.b}`, { firstName: 'y'.repeat(51) })).json.code).toBe('name_too_long');
  });

  it('is isolated between organisations and needs write access', async () => {
    expect((await contoso.call('GET', `/api/bulk/batches/${batchId}`)).status).toBe(404);
    expect((await contoso.call('POST', `/api/cases/${ids.a}/portal/retry`, {})).status).toBe(404);
    const fin = await new Client(app).full('finance@acme.demo');
    const denied = await fin.call('POST', '/api/bulk/batches', { cases: [{ key: 'k', patientId: '9', firstName: 'A', lastName: 'B' }] });
    expect(denied.status).toBe(403);
    expect((await contoso.call('GET', '/api/cases?search=Marc%20Alonso')).json.total).toBe(0);
  });
});

describe('pushing to the K Line portal', () => {
  it('creates the case, uploads other documents and one bundle zip, submits, and shows it as pushed', async () => {
    fake.reset();
    const { id, batchId } = await directCase('90002', 'Greta', 'Kask', 'Please match the shade for Greta.');
    const before = await up.call('GET', `/api/cases/${id}`);
    expect(before.json.case.checks.errors).toEqual([]);
    const sub = await up.call('POST', `/api/cases/${id}/submit`, {});
    expect(sub.status, JSON.stringify(sub.json)).toBe(200);
    expect(sub.json.case).toMatchObject({ status: 'ready', manufacturingMode: 'direct' });
    expect(sub.json.case.portal).toMatchObject({ status: 'pending', attempts: 0 });
    // submitting queued the push, and its payload holds a reference only
    const jobs = await q(`SELECT payload, org_id, max_attempts FROM jobs WHERE kind = 'bulk.push' AND status = 'queued'`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ caseId: id });
    expect(jobs[0].org_id).toBe(acmeId);
    expect(jobs[0].max_attempts).toBe(5);

    await runDueJobs();

    const ops = fake.calls.map((c) => c.op);
    // the last call reads the portal status right after the push, so the case shows the portal's status at once
    expect(ops).toEqual(['createCase', 'setShippingAddress', 'uploadFile', 'uploadFile', 'uploadFile', 'submitCase', 'getCase']);
    const pc = [...fake.cases.values()][0]!;
    expect(pc.input).toEqual({ firstName: 'Greta', lastName: 'Kask', gender: 2, productType: 0, doctorInstructions: 'Please match the shade for Greta.' });
    expect(pc.submitted).toBe(true);
    expect(pc.uploads.map((u) => u.field)).toEqual(['field_case_other_docs', 'field_case_other_docs', 'field_case_other_docs']);
    const docs = pc.uploads.filter((u) => !u.name.endsWith('.zip')).map((u) => u.name).sort();
    expect(docs).toEqual(['photo.png', 'report.pdf']);
    const zip = pc.uploads.find((u) => u.name.endsWith('.zip'))!;
    expect(zip.name).toMatch(/^ACME-\d{6}-files\.zip$/);
    const entries = unzipSync(new Uint8Array(zip.data));
    expect(Object.keys(entries).sort()).toEqual(['lower/L01_T.stl', 'manifest.csv', 'upper/U01.csv', 'upper/U01.pts', 'upper/U01.stl']);
    expect(Buffer.from(entries['upper/U01.csv']!).equals(laserCsv())).toBe(true);
    expect(Buffer.from(entries['upper/U01.pts']!).equals(trimLine())).toBe(true);
    expect(Buffer.from(entries['manifest.csv']!).toString()).toMatch(/upper\/U01\.pts,pts,upper,1,no,\d+,[0-9a-f]{64}/);
    expect(pc.uploads.find((u) => u.name === 'photo.png')!.data.equals(PNG_BYTES)).toBe(true);

    const after = await up.call('GET', `/api/cases/${id}`);
    expect(after.json.case.portal).toMatchObject({ status: 'pushed', caseUuid: pc.uuid, attempts: 1 });
    expect(after.json.case.portal.lastError).toBeUndefined();
    expect(after.json.events.map((e: any) => e.type)).toContain('portal_pushed');
    expect((await up.call('GET', `/api/bulk/batches/${batchId}`)).json.batch.status).toBe('completed');

    // nothing patient related in jobs, events or audit
    const dump = JSON.stringify([await q('SELECT payload, last_error FROM jobs'), await q('SELECT data FROM case_events WHERE case_id = $1', [id]), (await admin.call('GET', '/api/audit?limit=200')).json]);
    expect(dump).not.toMatch(/Greta|Kask\b|shade/);
    // no temporary zip is left behind
    const { readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('kph-push-'))).toEqual([]);

    // running the job again changes nothing
    await q(`INSERT INTO jobs (kind, payload, org_id) VALUES ('bulk.push', $1::jsonb, $2)`, [JSON.stringify({ caseId: id }), acmeId]);
    await runDueJobs();
    expect(fake.calls).toHaveLength(7);
  });

  it('marks a permanent failure as failed without patient data, and retries by hand', async () => {
    fake.reset();
    const { id } = await directCase('80001', 'Petra', 'Novak', 'Note for Petra');
    fake.failNext('createCase', 'validation', 1, 422);
    expect((await up.call('POST', `/api/cases/${id}/submit`, {})).status).toBe(200);
    await runDueJobs();
    let p = await portalOf(id);
    expect(p).toMatchObject({ status: 'failed', attempts: 1 });
    expect(p.lastError).toBeUndefined(); // the partner is not told
    expect(await lastErrorOf(id)).toBe('The K Line portal rejected the request. (HTTP 422)');
    expect(await lastErrorOf(id)).not.toMatch(/Petra|Novak/);
    expect(p.caseUuid).toBeUndefined();
    const d = await up.call('GET', `/api/cases/${id}`);
    expect(d.json.events.some((e: any) => e.type === 'portal_push_failed')).toBe(false);
    const ev = (await q(`SELECT data FROM case_events WHERE case_id = $1 AND type = 'portal_push_failed'`, [id]))[0];
    expect(ev.data).toMatchObject({ code: 'validation', status: 422 });
    // K Line is told once, and the push is tried again by itself later
    await runDueJobs();
    expect((await q(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'portal_push_failed' AND data->>'caseId' = $1`, [id]))[0].n).toBe(1);
    expect((await q(`SELECT run_at > now() AS later FROM jobs WHERE kind = 'bulk.push' AND status = 'queued' AND payload->>'caseId' = $1`, [id]))[0].later).toBe(true);
    expect(JSON.stringify(await q('SELECT payload, last_error, status FROM jobs ORDER BY id DESC LIMIT 3'))).not.toMatch(/Petra|Novak/);
    // it is not under the partner's attention: there is nothing the partner can do about it
    expect((await up.call('GET', '/api/cases?status=attention')).json.items.map((c: any) => c.id)).not.toContain(id);

    const retry = await up.call('POST', `/api/cases/${id}/portal/retry`, {});
    expect(retry.status).toBe(200);
    expect(retry.json.portal.status).toBe('pending');
    expect((await up.call('POST', `/api/cases/${id}/portal/retry`, {})).json.code).toBe('not_failed');
    await runDueJobs();
    p = await portalOf(id);
    expect(p).toMatchObject({ status: 'pushed', attempts: 2 });
    expect(p.lastError).toBeUndefined();
    expect(fake.calls.filter((c) => c.op === 'createCase')).toHaveLength(2);
    // standard cases have nothing to retry
    const std = await up.call('POST', '/api/cases', { caseId: 'STD-1' });
    expect((await up.call('POST', `/api/cases/${std.json.case.id}/portal/retry`, {})).json.code).toBe('not_direct');
    expect(std.json.case.portal).toEqual({ status: 'not_applicable', attempts: 0 });
  });

  it('resumes after a temporary failure without repeating finished steps', async () => {
    fake.reset();
    const { id } = await directCase('80002', 'Rita', 'Silva');
    // the first upload works, the second fails with a 503
    fake.failNext('uploadFile', 'server', 1, 503, 1);
    await up.call('POST', `/api/cases/${id}/submit`, {});
    await runDueJobs();
    let p = await portalOf(id);
    expect(p.status).toBe('pending');
    expect(await lastErrorOf(id)).toBe('The K Line portal had a problem on its side. (HTTP 503)');
    const stored = (await q('SELECT portal_case_uuid, portal_push FROM cases WHERE id = $1', [id]))[0];
    expect(stored.portal_case_uuid).toBeTruthy();
    expect(Object.keys(stored.portal_push.uploads.docs)).toHaveLength(1);
    const job = (await q(`SELECT status, attempts, run_at > now() AS later, last_error FROM jobs WHERE kind = 'bulk.push' ORDER BY id DESC LIMIT 1`))[0];
    expect(job).toMatchObject({ status: 'queued', attempts: 1, later: true });
    expect(job.last_error).not.toMatch(/Rita|Silva/);

    await q(`UPDATE jobs SET run_at = now() WHERE kind = 'bulk.push' AND status = 'queued'`);
    await runDueJobs();
    p = await portalOf(id);
    expect(p).toMatchObject({ status: 'pushed', attempts: 2 });
    expect(fake.calls.filter((c) => c.op === 'createCase')).toHaveLength(1);
    const uploaded = [...fake.cases.values()][0]!.uploads.map((u) => u.name).sort();
    expect(uploaded).toHaveLength(3); // report.pdf, photo.png and the bundle exactly once each
    expect(new Set(uploaded).size).toBe(3);
    expect([...fake.cases.values()][0]!.submitted).toBe(true);
  });

  it('gives up after the attempt cap and can be retried later', async () => {
    fake.reset();
    const { id } = await directCase('80003', 'Sam', 'Stone');
    await up.call('POST', `/api/cases/${id}/submit`, {});
    fake.failNext('createCase', 'network', 99);
    for (let i = 0; i < 5; i++) {
      await q(`UPDATE jobs SET run_at = now() WHERE kind = 'bulk.push' AND status = 'queued'`);
      await runDueJobs();
    }
    const p = await portalOf(id);
    expect(p).toMatchObject({ status: 'failed', attempts: 5 });
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'bulk.push' AND status = 'failed' AND payload->>'caseId' = $1`, [id]))[0].n).toBe(1);
    expect((await q(`SELECT count(*)::int AS n FROM case_events WHERE case_id = $1 AND type = 'portal_push_failed'`, [id]))[0].n).toBe(1);
    // the Hub keeps trying by itself, later
    expect((await q(`SELECT run_at > now() AS later FROM jobs WHERE kind = 'bulk.push' AND status = 'queued' AND payload->>'caseId' = $1`, [id]))[0].later).toBe(true);
    fake.clearFailures();
    expect((await up.call('POST', `/api/cases/${id}/portal/retry`, {})).status).toBe(200);
    await runDueJobs();
    expect((await portalOf(id)).status).toBe('pushed');
  });

  const FIXED_NOT_SET_UP = 'The K Line portal is not set up for this company. Add the address, key and user ID in the portal settings.';

  it('fails with a clear message when no portal is set up, even in demo mode, unless PORTAL_FAKE is on', async () => {
    setPortalClientFactory(undefined);
    const { config } = await import('../src/config');
    const was = config.portalFake;
    try {
      (config as any).portalFake = false;
      expect(config.demoMode).toBe(true); // demo mode alone no longer pretends
      const { id } = await directCase('80004', 'Nora', 'Field');
      await up.call('POST', `/api/cases/${id}/submit`, {});
      await runDueJobs();
      const p = await portalOf(id);
      expect(p.status).toBe('failed');
      expect(await lastErrorOf(id)).toBe(FIXED_NOT_SET_UP);
      expect(p.lastError).toBeUndefined();
      expect(p.demo).toBe(false);
      expect(p.caseUuid).toBeUndefined();
      const detail = (await up.call('GET', `/api/cases/${id}`)).json;
      expect(detail.events.some((e: any) => e.type === 'portal_pushed')).toBe(false);
      expect(JSON.stringify(detail.events)).not.toMatch(/Nora|Field/);
    } finally {
      (config as any).portalFake = was;
      setPortalClientFactory(() => fake);
    }
  });

  it('with PORTAL_FAKE on and no credentials, uses the in memory portal and marks the case as demo only', async () => {
    setPortalClientFactory(undefined);
    const { config } = await import('../src/config');
    const { devFakePortal } = await import('../src/services/portal');
    expect(config.portalFake).toBe(true);
    const before = devFakePortal.cases.size;
    const { id } = await directCase('80105', 'Demi', 'Only');
    await up.call('POST', `/api/cases/${id}/submit`, {});
    await runDueJobs();
    const detail = (await up.call('GET', `/api/cases/${id}`)).json;
    expect(detail.case.portal).toMatchObject({ status: 'pushed', demo: true });
    expect(devFakePortal.cases.size).toBe(before + 1);
    expect(detail.events.find((e: any) => e.type === 'portal_pushed').data.demo).toBe(true);
    expect((await q(`SELECT portal_push->>'demo' AS d FROM cases WHERE id = $1`, [id]))[0].d).toBe('true');
    // A case pushed to a (test) real client is not marked demo, and the sync leaves demo cases alone.
    setPortalClientFactory(() => fake);
    const real = await directCase('80106', 'Rea', 'Lone');
    await up.call('POST', `/api/cases/${real.id}/submit`, {});
    await runDueJobs();
    expect((await portalOf(real.id)).demo).toBe(false);
    const calls = fake.calls.length;
    const refresh = await up.call('POST', `/api/cases/${id}/portal/refresh`, {});
    expect(refresh.status).toBe(200);
    expect(refresh.json.case.portal.demo).toBe(true);
    expect(fake.calls.length).toBe(calls);
  });
});

describe('portal credentials', () => {
  it('are managed with the integration permission and step up, and the key is never returned', async () => {
    const view = await admin.call('GET', '/api/org/portal-api');
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({ configured: false, baseUrl: null, userUuid: null });
    expect((await up.call('GET', '/api/org/portal-api')).status).toBe(403);
    expect((await up.call('PUT', '/api/org/portal-api', {})).status).toBe(403);

    await q(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE revoked_at IS NULL`);
    const body = { baseUrl: 'https://portal.example.com/', apiKey: 'unit-test-api-key-value-1234567890', userUuid: '123e4567-e89b-12d3-a456-426614174000', doctorId: 'doc-7' };
    const noStep = await admin.call('PUT', '/api/org/portal-api', body);
    expect(noStep.status).toBe(403);
    expect(noStep.json.code).toBe('step_up_required');
    await admin.stepUp('admin@acme.demo');

    for (const bad of ['http://portal.example.com', 'https://10.0.0.1', 'https://intranet', 'javascript:alert(1)']) {
      const r = await admin.call('PUT', '/api/org/portal-api', { ...body, baseUrl: bad });
      expect(r.status, bad).toBe(400);
      expect(r.json.code).toBe('invalid_portal_url');
    }
    expect((await admin.call('PUT', '/api/org/portal-api', { ...body, userUuid: 'nope' })).status).toBe(400);
    expect((await admin.call('PUT', '/api/org/portal-api', { ...body, apiKey: undefined })).json.code).toBe('api_key_required');

    const put = await admin.call('PUT', '/api/org/portal-api', body);
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json).toEqual({ configured: true, baseUrl: 'https://portal.example.com', userUuid: body.userUuid, doctorId: 'doc-7', defaultGender: 2 });
    expect(JSON.stringify(put.json)).not.toContain(body.apiKey);
    const stored = (await q('SELECT settings FROM organizations WHERE id = $1', [acmeId]))[0].settings;
    expect(stored.portal_api.apiKeyEnc).toMatch(/^f1\./);
    expect(JSON.stringify(stored)).not.toContain(body.apiKey);
    expect(stored.manual_review).toBe(false); // other settings are untouched
    const get = await admin.call('GET', '/api/org/portal-api');
    expect(JSON.stringify(get.json)).not.toContain(body.apiKey);
    expect(get.json.configured).toBe(true);
    // the key can stay as it was when only other details change
    const keep = await admin.call('PUT', '/api/org/portal-api', { baseUrl: body.baseUrl, userUuid: body.userUuid, defaultGender: 1 });
    expect(keep.json.defaultGender).toBe(1);
    expect((await q('SELECT settings FROM organizations WHERE id = $1', [acmeId]))[0].settings.portal_api.apiKeyEnc).toBe(stored.portal_api.apiKeyEnc);
    const log = await admin.call('GET', '/api/audit?action=org.portal_api');
    expect(log.json.entries.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(log.json)).not.toContain(body.apiKey);

    // connection test
    fake.reset();
    const ok = await admin.call('POST', '/api/org/portal-api/test', {});
    expect(ok.json).toEqual({ ok: true });
    fake.failNext('ping', 'auth', 1, 401);
    const bad = await admin.call('POST', '/api/org/portal-api/test', {});
    expect(bad.json).toMatchObject({ ok: false, code: 'auth' });
    expect((await up.call('POST', '/api/org/portal-api/test', {})).status).toBe(403);
  });

  it('uses the configured gender when creating portal cases', async () => {
    fake.reset();
    const { id } = await directCase('80005', 'Gina', 'Green');
    await up.call('POST', `/api/cases/${id}/submit`, {});
    await runDueJobs();
    expect([...fake.cases.values()][0]!.input.gender).toBe(1);
  });
});
