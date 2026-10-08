import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { runDueJobs } from '../src/worker';
import { FakePortalClient, setPortalClientFactory } from '../src/services/portal';
import { Client, PNG_BYTES, cubeStl, laserCsv, minimalPdf, trimLine } from './helpers';

// Server side of the usability review of 8 Oct 2026: what a partner sees (A1, R3), the counts (A3), the order of the list (A2) and documents
// added after a case was sent (R6).

let app: FastifyInstance;
let up: Client;
let kl: Client;
let intake: Client;
const fake = new FakePortalClient();

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  up = await new Client(app).full('upload@acme.demo');
  kl = await new Client(app).full('admin@kline.demo');
  intake = await new Client(app).full('intake@kline.demo');
  setPortalClientFactory(() => fake);
});

afterAll(async () => {
  setPortalClientFactory(undefined);
  await app.close();
  await closePools();
});

async function draft(key: string, first = 'Rita', last = 'Review') {
  const b = await up.call('POST', '/api/bulk/batches', { cases: [{ key, firstName: first, lastName: last }] });
  expect(b.status, JSON.stringify(b.json)).toBe(201);
  return b.json.cases[0].id as string;
}

async function withFiles(key: string) {
  const id = await draft(key);
  await up.uploadFile(id, `${key}_U01.stl`, cubeStl(50));
  await up.uploadFile(id, `${key}_U01.pts`, trimLine());
  await up.uploadFile(id, `${key}_U01.csv`, laserCsv());
  await up.uploadFile(id, `${key}_L01_T.stl`, cubeStl(50));
  return id;
}

describe('what a partner sees of a case', () => {
  it('shows the uploading company the full patient name, and K Line staff only the masked one', async () => {
    const id = await draft('A1', 'Greta', 'Gruber');
    const mine = await up.call('GET', `/api/cases/${id}`);
    expect(mine.json.case.patientName).toBe('Greta Gruber');
    const list = await up.call('GET', '/api/cases?search=Greta%20Gruber');
    expect(list.json.items[0].patientName).toBe('Greta Gruber');
    const theirs = await kl.call('GET', `/api/console/cases/${id}`);
    expect(theirs.status, JSON.stringify(theirs.json)).toBe(200);
    expect(theirs.json.case.patientName).toBeUndefined();
    expect(theirs.json.case.patientMasked).toMatch(/\*/);
  });

  it('never gives a partner the integration error, but tells K Line staff', async () => {
    const id = await draft('R3');
    await q(`UPDATE cases SET status = 'submitted', submitted_at = now(), portal_push = $2::jsonb WHERE id = $1`, [
      id, JSON.stringify({ status: 'failed', attempts: 3, lastError: 'Add the address, key and user ID in the portal settings.', syncError: 'secret internal detail' }),
    ]);
    const partner = (await up.call('GET', `/api/cases/${id}`)).json.case;
    expect(partner.portal.status).toBe('failed');
    expect(partner.portal.lastError).toBeUndefined();
    expect(partner.portal.syncError).toBeUndefined();
    expect(partner.portal.actionNeeded).toBeUndefined();
    expect(JSON.stringify(partner)).not.toMatch(/portal settings|secret internal/);
    const listed = (await up.call('GET', '/api/cases?pageSize=100')).json.items.find((c: any) => c.id === id);
    expect(listed.portal.lastError).toBeUndefined();
    const staff = (await kl.call('GET', `/api/console/cases/${id}`)).json.case;
    expect(staff.portal.lastError).toMatch(/portal settings/);
    // only an administrator reads the text: other K Line staff learn that the hand over failed, and not why
    const other = (await intake.call('GET', `/api/console/cases/${id}`)).json.case;
    expect(other.portal.status).toBe('failed');
    expect(other.portal.lastError).toBeUndefined();
    expect(other.portal.syncError).toBeUndefined();
  });

  it('lets a case with errors and warnings be submitted: nothing in the checks stops it', async () => {
    const id = await withFiles('NR1');
    await up.uploadFile(id, 'NR1_loose.stl', cubeStl(50), { arch: null, step: null }); // a model without arch and step used to be an error
    const before = (await up.call('GET', `/api/cases/${id}`)).json.case.checks;
    expect(before.errors.length).toBeGreaterThan(0);
    const sent = await up.call('POST', `/api/cases/${id}/submit`, {});
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(['submitted', 'ready']).toContain(sent.json.case.status);
    // a case with no file at all goes too
    const empty = await draft('NR2');
    expect((await up.call('POST', `/api/cases/${empty}/submit`, {})).status).toBe(200);
  });

  it('reports a missing case address as the one thing the partner can fix', async () => {
    const id = await draft('R3b');
    await q(`UPDATE cases SET status = 'submitted', submitted_at = now(), portal_push = $2::jsonb WHERE id = $1`, [
      id, JSON.stringify({ status: 'failed', attempts: 1, lastError: 'Add a case address, then try again.' }),
    ]);
    const partner = (await up.call('GET', `/api/cases/${id}`)).json.case;
    expect(partner.portal.actionNeeded).toBe('case_address');
    expect(partner.portal.lastError).toBeUndefined();
  });

  it('keeps a failed hand over out of the partner timeline', async () => {
    const id = await draft('R3c');
    await q(`INSERT INTO case_events (org_id, case_id, type, actor_type, data) SELECT org_id, id, 'portal_push_failed', 'system', '{"code":"internal"}'::jsonb FROM cases WHERE id = $1`, [id]);
    const partner = (await up.call('GET', `/api/cases/${id}`)).json;
    expect(partner.events.some((e: any) => e.type === 'portal_push_failed')).toBe(false);
    const staff = (await kl.call('GET', `/api/console/cases/${id}`)).json;
    expect(staff.events.some((e: any) => e.type === 'portal_push_failed')).toBe(true);
  });
});

describe('counts and order of the list', () => {
  it('counts what needs attention for a partner without the failures K Line has to fix', async () => {
    const before = (await up.call('GET', '/api/cases/counts')).json;
    expect(before).toMatchObject({ all: expect.any(Number), attention: expect.any(Number), drafts: expect.any(Number) });
    const id = await draft('A3');
    await q(`UPDATE cases SET checks = '{"errors":[{"code":"no_stl","message":"No models."}],"warnings":[]}'::jsonb WHERE id = $1`, [id]);
    const after = (await up.call('GET', '/api/cases/counts')).json;
    // a draft with check errors is nothing the partner has to deal with (the checks do not stop a submission)
    expect(after.attention).toBe(before.attention);
    expect(after.drafts).toBe(before.drafts + 1);
    // a failed hand over for another reason is not the partner's to fix
    const failed = await draft('A3b');
    await q(`UPDATE cases SET status = 'submitted', portal_push = '{"status":"failed","lastError":"internal"}'::jsonb WHERE id = $1`, [failed]);
    expect((await up.call('GET', '/api/cases/counts')).json.attention).toBe(after.attention);
    expect((await up.call('GET', '/api/cases?status=attention&pageSize=100')).json.items.some((c: any) => c.id === failed)).toBe(false);
  });

  it('lists cases created together in reference order, newest first', async () => {
    const b = await up.call('POST', '/api/bulk/batches', { cases: ['one', 'two', 'three', 'four', 'five'].map((k) => ({ key: k, firstName: k, lastName: 'Order' })) });
    expect(b.status).toBe(201);
    const refs = (b.json.cases as { ref: string }[]).map((c) => c.ref);
    const list = (await up.call('GET', '/api/cases?pageSize=5')).json.items.map((c: any) => c.ref);
    expect(list).toEqual([...refs].sort().reverse());
  });
});

describe('documents after a case was sent', () => {
  it('takes a document on a sent case, refuses a model, and stops once production starts', async () => {
    const id = await withFiles('R6');
    expect((await up.call('POST', `/api/cases/${id}/submit`, {})).status).toBe(200);
    await runDueJobs();
    const status = async () => (await up.call('GET', `/api/cases/${id}`)).json.case.status as string;
    expect(['submitted', 'ready']).toContain(await status());

    // a document is accepted and shows in the timeline
    const doc = await up.uploadFile(id, 'late-note.pdf', minimalPdf());
    expect(doc.file.state).toBe('ready');
    const detail = (await up.call('GET', `/api/cases/${id}`)).json;
    expect(detail.events.some((e: any) => e.type === 'documents_added')).toBe(true);
    // pictures too
    expect((await up.uploadFile(id, 'late-photo.png', PNG_BYTES)).file.state).toBe('ready');

    // a model or a trim line is not: it would change aligners that are being planned
    const model = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: id, name: 'late_U02.stl', size: 1000 });
    expect(model.status).toBe(409);
    expect(model.json.code).toBe('case_not_open');

    // once the case is in production nothing is accepted any more
    await q(`UPDATE cases SET status = 'in_production' WHERE id = $1`, [id]);
    const late = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: id, name: 'later.pdf', size: 1000 });
    expect(late.status).toBe(409);
    expect(late.json.code).toBe('case_not_open');
  });

  it('sends a document added after the case reached the K Line portal on to the portal', async () => {
    const id = await withFiles('R6b');
    expect((await up.call('POST', `/api/cases/${id}/submit`, {})).status).toBe(200);
    for (let i = 0; i < 6; i++) await runDueJobs();
    const pushed = (await up.call('GET', `/api/cases/${id}`)).json.case.portal;
    expect(pushed.status).toBe('pushed');
    const uploads = () => fake.calls.filter((c) => c.op === 'uploadFile').length;
    const uploadsBefore = uploads();
    await up.uploadFile(id, 'after-push.pdf', minimalPdf());
    for (let i = 0; i < 6; i++) await runDueJobs();
    expect(uploads()).toBeGreaterThan(uploadsBefore);
    // and it is sent once only
    const after = uploads();
    for (let i = 0; i < 3; i++) await runDueJobs();
    expect(uploads()).toBe(after);
  });
});
