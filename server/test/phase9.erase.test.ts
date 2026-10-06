import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { createApiKey } from '../src/auth/apikeys';
import { setHookObserver, type HookCall } from '../src/services/webhooks';
import { insertCase } from '../src/services/cases';
import { PORTAL_COPY_NOTICE } from '../src/services/erasure';
import { chunkKey, storage } from '../src/storage';
import { runDueJobs } from '../src/worker';
import { Client, orgIdOf } from './helpers';
import { expireStepUp, q, readyStandardCase, svcCall } from './helpers9';

const NAME = 'Erin Erasable'; // synthetic patient name that must never appear in events, audit entries or notifications
const INSTRUCTION_MARK = 'ERASE-INSTRUCTIONS-MARKER';

let app: FastifyInstance;
let acmeId: string;
let contosoId: string;
let admin: Client; // Acme administrator (case.erase)
let uploader: Client; // Acme uploader (no case.erase)
let quality: Client;
let finance: Client;
let contoso: Client; // another partner's administrator
let klAdmin: Client;
let klIntake: Client;
let svcKey: string;
let partnerKey: string;

const hooks: HookCall[] = [];

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  contosoId = await orgIdOf('CONT');
  admin = await new Client(app).full('admin@acme.demo');
  uploader = await new Client(app).full('upload@acme.demo');
  quality = await new Client(app).full('quality@acme.demo');
  finance = await new Client(app).full('finance@acme.demo');
  contoso = await new Client(app).full('owner@contoso.demo');
  klAdmin = await new Client(app).full('admin@kline.demo');
  klIntake = await new Client(app).full('intake@kline.demo');
  const k = await klAdmin.call('POST', '/api/service-keys', { name: 'Erasure test factory', scopes: ['mes:intake', 'mes:files', 'mes:events'], expiresInDays: 30 });
  svcKey = k.json.key;
  partnerKey = (await tx({ orgId: acmeId, bypass: false }, (c) => createApiKey(c, { orgId: acmeId, orgKind: 'partner', name: 'erase test', scopes: ['cases:read', 'cases:write'], expiresInDays: 30 }))).key;
  setHookObserver((h) => hooks.push(h));
});
afterAll(async () => {
  setHookObserver(null);
  await app.close();
  await closePools();
});

const erase = (c: Client, id: string, confirmRef: string) => c.call('POST', `/api/cases/${id}/erase`, { confirmRef });
const caseRow = async (id: string) => (await q('SELECT * FROM cases WHERE id = $1', [id]))[0];

describe('who may erase', () => {
  it('needs the case.erase permission: uploaders, quality, finance and K Line intake are refused, and so are API keys and anonymous calls', async () => {
    const k = await readyStandardCase(uploader, { patientName: NAME, instructions: INSTRUCTION_MARK });
    for (const who of [uploader, quality, finance, klIntake]) {
      const r = await erase(who, k.id, k.ref);
      expect(r.status, JSON.stringify(r.json)).toBe(403);
    }
    const key = await app.inject({ method: 'POST', url: `/api/cases/${k.id}/erase`, payload: { confirmRef: k.ref }, headers: { authorization: `Bearer ${partnerKey}` }, remoteAddress: '10.9.8.1' });
    expect(key.statusCode).toBe(403);
    const anon = await app.inject({ method: 'POST', url: `/api/cases/${k.id}/erase`, payload: { confirmRef: k.ref }, remoteAddress: '10.9.8.2' });
    expect(anon.statusCode).toBe(401);
    // nothing happened
    expect((await caseRow(k.id)).purged_at).toBeNull();
    expect((await q(`SELECT count(*)::int AS n FROM files WHERE case_id = $1 AND state = 'ready'`, [k.id]))[0].n).toBe(2);
  });

  it('needs a recent authenticator code (step up)', async () => {
    const k = await readyStandardCase(uploader);
    await expireStepUp('admin@acme.demo');
    const r = await erase(admin, k.id, k.ref);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('step_up_required');
    expect((await caseRow(k.id)).purged_at).toBeNull();
    await admin.stepUp('admin@acme.demo');
    expect((await erase(admin, k.id, k.ref)).status).toBe(200);
  });

  it('asks for the case reference and refuses a wrong one', async () => {
    const k = await readyStandardCase(uploader);
    const wrong = await erase(admin, k.id, 'ACME-999999');
    expect(wrong.status).toBe(400);
    expect(wrong.json.code).toBe('confirmation_mismatch');
    expect((await caseRow(k.id)).purged_at).toBeNull();
    const noBody = await admin.call('POST', `/api/cases/${k.id}/erase`, {});
    expect(noBody.status).toBe(400);
    // the reference is not case sensitive
    expect((await erase(admin, k.id, k.ref.toLowerCase())).status).toBe(200);
  });

  it("answers 404 for another organisation's case, for partners, and does not touch it", async () => {
    const k = await readyStandardCase(uploader);
    const r = await erase(contoso, k.id, k.ref);
    expect(r.status).toBe(404);
    expect((await caseRow(k.id)).purged_at).toBeNull();
    expect(contosoId).not.toBe(acmeId);
  });

  it('refuses drafts (delete them instead) and a case that is already erased', async () => {
    const draft = await uploader.call('POST', '/api/cases', { caseId: `P9-DRAFT-${Math.random().toString(36).slice(2, 7)}` });
    const d = await erase(admin, draft.json.case.id, draft.json.case.ref);
    expect(d.status).toBe(409);
    expect(d.json.code).toBe('use_delete_for_drafts');
    expect((await caseRow(draft.json.case.id)).id).toBeTruthy();

    const k = await readyStandardCase(uploader);
    expect((await erase(admin, k.id, k.ref)).status).toBe(200);
    const again = await erase(admin, k.id, k.ref);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('already_erased');
  });
});

describe('what an erasure does', () => {
  it('removes files, key material, names and instructions now, keeps the production record, and leaves no patient data in the event, audit entry or notices', async () => {
    const k = await readyStandardCase(uploader, { patientName: NAME, instructions: INSTRUCTION_MARK });
    const before = await q(`SELECT id, storage_prefix FROM files WHERE case_id = $1`, [k.id]);
    const st = await storage();
    for (const f of before) expect(await st.exists(chunkKey(f.storage_prefix, 0))).toBe(true);
    const dueBefore = (await caseRow(k.id)).due_date;
    hooks.length = 0;

    const r = await erase(admin, k.id, k.ref);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ ok: true, ref: k.ref, filesRemoved: 2, portalCopyRemains: false });
    expect(r.json.message).not.toContain(PORTAL_COPY_NOTICE);
    expect(hooks.some((h) => h.kind === 'case' && h.event === 'case.erased' && h.id === k.id)).toBe(true);

    // the case: names, instructions, blind index and case ID are gone; the production record stays
    const row = await caseRow(k.id);
    expect(row.purged_at).not.toBeNull();
    expect(row.scrubbed_at).not.toBeNull();
    expect(row.patient_enc).toBeNull();
    expect(row.patient_bidx).toBeNull();
    expect(row.patient_bidxs).toEqual([]);
    expect(row.notes_enc).toBeNull();
    expect(row.partner_case_id).toBeNull();
    expect(row.ref).toBe(k.ref);
    expect(row.status).toBe('ready');
    expect(row.due_date).toBe(dueBefore);
    expect(row.org_id).toBe(acmeId);
    expect(row.aligners_upper).toBe(1);

    // files: purged, no key material, no chunk rows, the stored objects are gone
    const files = await q(`SELECT * FROM files WHERE case_id = $1`, [k.id]);
    expect(files.length).toBe(2);
    for (const f of files) {
      expect(f.state).toBe('purged');
      expect(f.wrapped_key).toBeNull();
      expect(f.nonce_prefix).toBeNull();
      expect(f.key_id).toBeNull();
      expect(f.name_enc).toBeNull();
    }
    expect((await q(`SELECT count(*)::int AS n FROM file_chunks WHERE file_id = ANY($1::uuid[])`, [k.fileIds]))[0].n).toBe(0);
    for (const f of before) expect(await st.exists(chunkKey(f.storage_prefix, 0))).toBe(false);

    // downloads fail afterwards, for the partner and for the factory
    for (const id of k.fileIds) {
      const dl = await admin.call('GET', `/api/files/${id}/download`);
      expect(dl.status).toBeGreaterThanOrEqual(400);
      const mes = await svcCall(app, svcKey, 'GET', `/api/mes/v1/files/${id}`);
      expect(mes.status).toBeGreaterThanOrEqual(400);
    }
    const feed = await svcCall(app, svcKey, 'GET', '/api/mes/v1/intake');
    expect(feed.status).toBe(200);
    expect(feed.json.cases.some((x: any) => x.ref === k.ref)).toBe(false);

    // the case page still opens, shows the erased event and no files
    const detail = await admin.call('GET', `/api/cases/${k.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.files).toEqual([]);
    expect(detail.json.case.purgedAt).toBeTruthy();
    expect(detail.json.instructions).toBeNull();
    const erased = detail.json.events.find((e: any) => e.type === 'erased');
    expect(erased).toBeTruthy();
    expect(erased.data).toMatchObject({ files: 2, byKline: false });
    expect(erased.data.portalCopyRemains).toBeUndefined(); // standard case

    // the event, the audit entry and the notices name the reference only
    const events = await q(`SELECT type, actor_type, actor_id, data FROM case_events WHERE case_id = $1`, [k.id]);
    const ev = events.find((e) => e.type === 'erased');
    expect(ev.actor_type).toBe('user');
    expect(ev.actor_id).toBeTruthy();
    expect(events.some((e) => e.type === 'purged')).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(new RegExp(`${NAME}|Erin|Erasable|${INSTRUCTION_MARK}|${k.caseId}`));

    // the partner reads the audit entry in their own access log
    const log = await admin.call('GET', '/api/audit?action=case.erased&limit=50');
    expect(log.status).toBe(200);
    const entry = log.json.entries.find((e: any) => e.targetId === k.id);
    expect(entry).toBeTruthy();
    expect(entry.details).toMatchObject({ ref: k.ref, mode: 'standard', files: 2, byKline: false, portalCopyRemains: false });
    expect(entry.actorLabel).toBe('Alex Acme');
    expect(JSON.stringify(log.json)).not.toMatch(new RegExp(`${NAME}|Erasable|${INSTRUCTION_MARK}|${k.caseId}`));

    // the organisation's administrators were told, by reference only
    const adminNotes = await q(`SELECT n.title, n.body, n.data FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'case_erased' AND n.data->>'caseId' = $1 AND u.email = 'admin@acme.demo'`, [k.id]);
    expect(adminNotes.length).toBe(1);
    expect(adminNotes[0].body).toBe(`Case ${k.ref}`);
    // the case was ready at a factory site, so K Line intake is told too (by a job)
    await runDueJobs();
    const klNotes = await q(`SELECT n.title, n.body FROM notifications n JOIN organizations o ON o.id = n.org_id WHERE o.kind = 'kline' AND n.kind = 'case_erased' AND n.data->>'caseId' = $1`, [k.id]);
    expect(klNotes.length).toBe(1);
    expect(klNotes[0].body).toBe(`Case ${k.ref}`);
    expect(JSON.stringify([adminNotes, klNotes])).not.toMatch(new RegExp(`${NAME}|Erasable|${k.caseId}`));
    // the other partner users did not get the notice
    expect((await q(`SELECT count(*)::int AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'case_erased' AND n.data->>'caseId' = $1 AND u.email = 'upload@acme.demo'`, [k.id]))[0].n).toBe(0);
  });

  it('cannot be changed afterwards: no new files, no resubmission, no details', async () => {
    const k = await readyStandardCase(uploader);
    await q(`UPDATE cases SET status = 'on_hold', hold_reason = 'check the scan' WHERE id = $1`, [k.id]);
    expect((await erase(admin, k.id, k.ref)).status).toBe(200);
    const sub = await uploader.call('POST', `/api/cases/${k.id}/submit`, { acknowledgeWarnings: true });
    expect(sub.status).toBe(409);
    expect(sub.json.code).toBe('case_erased');
    const patch = await uploader.call('PATCH', `/api/cases/${k.id}`, { priority: 'rush' });
    expect(patch.status).toBe(409);
    const up = await uploader.call('POST', '/api/uploads', { purpose: 'case', caseId: k.id, name: 'U02.stl', size: 10 });
    expect(up.status).toBe(409);
  });

  it("keeps the stored bytes that a replacement case still uses, and removes them with the last live file", async () => {
    const k = await readyStandardCase(uploader);
    await q(`UPDATE cases SET status = 'shipped', shipped_at = now(), stage = 'shipped' WHERE id = $1`, [k.id]);
    const rep = await admin.call('POST', `/api/cases/${k.id}/replacement`, { items: [{ arch: 'upper', step: 1 }], reason: 'Lost in the post' });
    expect(rep.status, JSON.stringify(rep.json)).toBe(201);
    const childId = (rep.json.case?.id ?? rep.json.id) as string;
    const childFiles = await q(`SELECT id, storage_prefix, kind FROM files WHERE case_id = $1 AND state = 'ready' ORDER BY kind`, [childId]);
    expect(childFiles.length).toBeGreaterThan(0);
    const stlChild = childFiles.find((f) => f.kind === 'stl')!;
    const parentPrefixes = (await q(`SELECT storage_prefix FROM files WHERE case_id = $1`, [k.id])).map((r) => r.storage_prefix);
    expect(parentPrefixes).toContain(stlChild.storage_prefix);

    const r = await erase(admin, k.id, k.ref);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const st = await storage();
    // the parent's files are purged, but the child still reads the same stored bytes
    expect((await q(`SELECT count(*)::int AS n FROM files WHERE case_id = $1 AND state <> 'purged'`, [k.id]))[0].n).toBe(0);
    expect(await st.exists(chunkKey(stlChild.storage_prefix, 0))).toBe(true);
    const dl = await uploader.call('GET', `/api/files/${stlChild.id}/download`);
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.res.rawPayload, k.stl)).toBe(0);
    const parentDl = await uploader.call('GET', `/api/files/${k.fileIds[0]}/download`);
    expect(parentDl.status).toBeGreaterThanOrEqual(400);
    // the child keeps its own data; the erase dialog says so
    expect((await caseRow(childId)).purged_at).toBeNull();

    // erasing the child removes the last user of the bytes
    const child = await caseRow(childId);
    expect((await erase(admin, childId, child.ref)).status).toBe(200);
    await runDueJobs();
    expect(await st.exists(chunkKey(stlChild.storage_prefix, 0))).toBe(false);
  });

  it('lets a K Line administrator erase any partner case, records who did it in the partner access log and tells the partner administrators', async () => {
    const k = await readyStandardCase(uploader, { patientName: NAME });
    const r = await erase(klAdmin, k.id, k.ref);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await caseRow(k.id)).purged_at).not.toBeNull();
    const entry = (await q(`SELECT org_id, actor_type, details FROM audit_log WHERE action = 'case.erased' AND target_id = $1`, [k.id]))[0];
    expect(entry.org_id).toBe(acmeId);
    expect(entry.details).toMatchObject({ ref: k.ref, byKline: true });
    // the partner sees it
    const log = await admin.call('GET', '/api/audit?action=case.erased&limit=50');
    const mine = log.json.entries.find((e: any) => e.targetId === k.id);
    expect(mine).toBeTruthy();
    expect(mine.actorLabel).toBe('K Line staff'); // the partner sees K Line staff, not a name
    expect(mine.ip).toBeNull(); // the partner does not see K Line's address
    expect((await q(`SELECT count(*)::int AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'case_erased' AND n.data->>'caseId' = $1 AND u.email = 'admin@acme.demo'`, [k.id]))[0].n).toBe(1);
    // K Line intake and production staff cannot, only administrators
    const other = await readyStandardCase(uploader);
    expect((await erase(klIntake, other.id, other.ref)).status).toBe(403);
  });
});

describe('direct manufacturing cases', () => {
  it('says that the K Line portal keeps its own copy, in the answer and in the event and audit data, and drops the patient ID', async () => {
    const PID = 'PID-ERASE-12345';
    const id = await tx(SYSTEM, async (c) => {
      const r = await insertCase(c, { orgId: acmeId, actor: { actorType: 'user', actorId: null }, mode: 'direct', caseId: PID, firstName: 'Direct', lastName: 'Patient' });
      await c.query(
        `UPDATE cases SET status = 'ready', submitted_at = now(), ready_at = now(), portal_case_uuid = $2, portal_push = jsonb_build_object('status', 'pushed', 'attempts', 1) WHERE id = $1`,
        [r.id, randomUUID()],
      );
      return r;
    });
    const r = await erase(admin, id.id, id.ref);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.portalCopyRemains).toBe(true);
    expect(r.json.message).toContain('The K Line portal keeps its own copy. Ask K Line to remove it there.');
    expect(r.json.message).toContain(PORTAL_COPY_NOTICE);
    const row = await caseRow(id.id);
    expect(row.partner_case_id).toBeNull();
    expect(row.patient_first_enc).toBeNull();
    expect(row.patient_last_enc).toBeNull();
    expect(row.portal_case_uuid).toBeTruthy(); // a reference to the portal's own case, not patient data
    const ev = (await q(`SELECT data FROM case_events WHERE case_id = $1 AND type = 'erased'`, [id.id]))[0];
    expect(ev.data).toMatchObject({ portalCopyRemains: true });
    const au = (await q(`SELECT details FROM audit_log WHERE action = 'case.erased' AND target_id = $1`, [id.id]))[0];
    expect(au.details).toMatchObject({ mode: 'direct', portalCopyRemains: true });
    expect(JSON.stringify([ev, au])).not.toMatch(new RegExp(`${PID}|Direct|Patient`));
  });

  it('records portalCopyRemains false for a direct case that never reached the portal', async () => {
    const r0 = await tx(SYSTEM, async (c) => {
      const r = await insertCase(c, { orgId: acmeId, actor: { actorType: 'user', actorId: null }, mode: 'direct', caseId: 'PID-NOT-PUSHED', firstName: 'Not', lastName: 'Pushed' });
      await c.query(`UPDATE cases SET status = 'submitted', submitted_at = now(), portal_push = jsonb_build_object('status', 'pending', 'attempts', 0) WHERE id = $1`, [r.id]);
      return r;
    });
    const r = await erase(admin, r0.id, r0.ref);
    expect(r.status).toBe(200);
    expect(r.json.portalCopyRemains).toBe(false);
    expect(r.json.message).not.toContain('K Line portal keeps');
  });
});
