import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { unzipSync } from 'fflate';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { config } from '../src/config';
import { seedDemo } from '../src/demo/seed';
import { runDueJobs } from '../src/worker';
import { setScanner, type Scanner } from '../src/services/scanner';
import { Client, PNG_BYTES, binaryStl, createDemoUser, cubeStl, minimalPdf, orgIdOf, trimLine } from './helpers';

let app: FastifyInstance;
let acmeId: string;
let contosoId: string;
let up: Client; // Acme uploader
let admin: Client; // Acme admin
let intake: Client; // K Line intake
let contoso: Client;

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);

async function newCase(c: Client, body: Record<string, unknown> = {}) {
  const r = await c.call('POST', '/api/cases', { caseId: `T-${Math.random().toString(36).slice(2, 8)}`, ...body });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.case as any;
}

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  // A second partner without a data processing agreement yet.
  contosoId = await tx(SYSTEM, async (c) => (await c.query(`INSERT INTO organizations (kind, name, code, country, status) VALUES ('partner', 'Contoso Smile', 'CONTOSO', 'PT', 'active') RETURNING id`)).rows[0].id);
  await createDemoUser(contosoId, 'admin@contoso.demo', 'Cora Contoso', ['admin']);
  up = await new Client(app).full('upload@acme.demo');
  admin = await new Client(app).full('admin@acme.demo');
  intake = await new Client(app).full('intake@kline.demo');
  contoso = await new Client(app).full('admin@contoso.demo');
});

afterAll(async () => {
  setScanner(undefined);
  await app.close();
  await closePools();
});

describe('uploads are locked until the organisation is approved', () => {
  it('refuses uploads and submission without a data processing agreement, then allows them', async () => {
    const c = await newCase(contoso, { caseId: 'C-100' });
    const blocked = await contoso.call('POST', '/api/uploads', { purpose: 'case', caseId: c.id, name: 'U01.stl', size: 100 });
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe('org_not_approved');
    const submit = await contoso.call('POST', `/api/cases/${c.id}/submit`, {});
    expect(submit.status).toBe(403);
    expect(submit.json.code).toBe('org_not_approved');

    await tx(SYSTEM, (x) => x.query(`INSERT INTO agreements (org_id, type, signed_at, signed_by) VALUES ($1, 'dpa', current_date, 'Cora Contoso')`, [contosoId]));
    const ok = await contoso.call('POST', '/api/uploads', { purpose: 'case', caseId: c.id, name: 'U01.stl', size: 100 });
    expect(ok.status).toBe(200);
    await contoso.call('DELETE', `/api/files/${ok.json.fileId}`);
    // an organisation that is not active stays locked even with an agreement
    await q(`UPDATE organizations SET status = 'onboarding' WHERE id = $1`, [contosoId]);
    const locked = await contoso.call('POST', '/api/uploads', { purpose: 'case', caseId: c.id, name: 'U01.stl', size: 100 });
    expect(locked.json.code).toBe('org_not_approved');
    await q(`UPDATE organizations SET status = 'active' WHERE id = $1`, [contosoId]);
  });
});

describe('case IDs and details', () => {
  it('creates cases and enforces the case ID rules', async () => {
    expect((await up.call('POST', '/api/cases', {})).json.code).toBe('identifier_required');
    for (const bad of ['bad<id>', 'x'.repeat(65), 'tab\tid', 'semi;colon']) {
      const r = await up.call('POST', '/api/cases', { caseId: bad });
      expect(r.status, bad).toBe(400);
      expect(r.json.code).toBe('invalid_case_id');
    }
    const a = await up.call('POST', '/api/cases', { caseId: 'AB 12_3.4/5#6-7' });
    expect(a.status).toBe(201);
    expect(a.json.case.ref).toMatch(/^ACME-\d{6}$/);
    const dup = await up.call('POST', '/api/cases', { caseId: 'ab 12_3.4/5#6-7' });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe('case_id_exists');
    // a cancelled case frees its ID
    expect((await up.call('POST', `/api/cases/${a.json.case.id}/cancel`, {})).status).toBe(200);
    expect((await up.call('POST', '/api/cases', { caseId: 'AB 12_3.4/5#6-7' })).status).toBe(201);
    // a patient name alone is enough, references count up
    const b = await up.call('POST', '/api/cases', { patientName: 'Only Name' });
    expect(b.status).toBe(201);
    expect(b.json.case.caseId).toBeNull();
    const refs = [a.json.case.ref, b.json.case.ref].map((r: string) => Number(r.split('-')[1]));
    expect(refs[1]).toBeGreaterThan(refs[0]!);
    // finance cannot write
    const fin = await new Client(app).full('finance@acme.demo');
    expect((await fin.call('POST', '/api/cases', { caseId: 'F-1' })).status).toBe(403);
  });
});

let caseA: any;
let stl1: string;
let stl2: string;
let pts1: string;
const STL_HEADER_SECRET = 'SECRET-HEADER-TEXT';

describe('upload, checks and submit', () => {
  it('creates a case with encrypted patient data and instructions', async () => {
    const r = await up.call('POST', '/api/cases', { caseId: '55813', patientName: 'Marc Alonso', instructions: 'Please leave attachments in place for Marc.' });
    expect(r.status).toBe(201);
    caseA = r.json.case;
    expect(caseA.patientMasked).toBe('M*** A*****');
    expect(caseA.hasPatientName).toBe(true);
    expect(caseA.status).toBe('draft');
    expect(JSON.stringify(r.json)).not.toContain('Alonso');
    const row = (await q('SELECT patient_enc, notes_enc, patient_bidx FROM cases WHERE id = $1', [caseA.id]))[0];
    expect(row.patient_enc).toMatch(/^f1\./);
    expect(row.notes_enc).toMatch(/^f1\./);
    expect(JSON.stringify(row)).not.toMatch(/Marc|Alonso|attachments/);
  });

  it('rejects damaged chunks, incomplete uploads, executables and unknown types', async () => {
    const data = cubeStl(50, STL_HEADER_SECRET);
    const init = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: caseA.id, name: '55813_U01.stl', size: data.length });
    expect(init.status).toBe(200);
    expect(init.json).toMatchObject({ chunkSize: 8388608, chunkCount: 1, received: [] });
    const bad = await up.putChunk(init.json.fileId, 0, data, 'a'.repeat(64));
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe('checksum_mismatch');
    const noHeader = await up.call('PUT', `/api/uploads/${init.json.fileId}/chunks/0`, data, { headers: { 'content-type': 'application/octet-stream' } });
    expect(noHeader.status).toBe(400);
    const early = await up.call('POST', `/api/uploads/${init.json.fileId}/complete`, {});
    expect(early.status).toBe(409);
    expect(early.json.code).toBe('upload_incomplete');
    const wrongSize = await up.putChunk(init.json.fileId, 0, data.subarray(0, 100));
    expect(wrongSize.status).toBe(422);
    const outOfRange = await up.putChunk(init.json.fileId, 5, data);
    expect(outOfRange.status).toBe(400);
    // resume returns what arrived
    const again = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: caseA.id, name: '55813_U01.stl', size: data.length });
    expect(again.json.fileId).toBe(init.json.fileId);
    expect(again.json.received).toEqual([]);
    await up.call('DELETE', `/api/files/${init.json.fileId}`);

    const exe = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: caseA.id, name: 'setup.exe', size: 100 });
    expect(exe.status).toBe(415);
    expect(exe.json.code).toBe('file_type_not_allowed');
    const zip = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: caseA.id, name: 'archive.zip', size: 100 });
    expect(zip.status).toBe(415);
    const huge = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: caseA.id, name: 'big.stl', size: 600 * 1024 * 1024 });
    expect(huge.status).toBe(413);
    expect(huge.json.code).toBe('file_too_large');

    // executable content hidden behind an allowed extension is caught by its magic bytes
    const mz = Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), Buffer.alloc(200)]);
    const disguised = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: caseA.id, name: 'model.stl', size: mz.length });
    const put = await up.putChunk(disguised.json.fileId, 0, mz);
    expect(put.status).toBe(415);
    expect((await up.call('GET', `/api/files/${disguised.json.fileId}`)).status).toBe(404);
  });

  it('uploads models and a trim line, checks them and stores only ciphertext', async () => {
    const a = await up.uploadFile(caseA.id, '55813_U01.stl', cubeStl(50, STL_HEADER_SECRET));
    stl1 = a.fileId;
    expect(a.file).toMatchObject({ kind: 'stl', arch: 'upper', step: 1, template: false, state: 'ready', name: '55813_U01.stl', scan: 'skipped' });
    expect(a.file.validation.meta).toMatchObject({ triangles: 12, openEdges: 0 });
    expect(a.file.validation.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    // a 5 mm cube warns about units
    const b = await up.uploadFile(caseA.id, '55813_U02.stl', cubeStl(5));
    stl2 = b.fileId;
    expect(b.file.state).toBe('ready');
    expect(b.file.validation.warnings.map((w: any) => w.code)).toContain('stl_units');
    const p = await up.uploadFile(caseA.id, '55813_U01.pts', trimLine());
    pts1 = p.fileId;
    expect(p.file).toMatchObject({ kind: 'pts', arch: 'upper', step: 1, state: 'ready' });
    expect(p.file.validation.meta).toMatchObject({ closed: true });

    const detail = await up.call('GET', `/api/cases/${caseA.id}`);
    expect(detail.json.case.counts).toMatchObject({ upper: 2, lower: 0 });
    expect(detail.json.case.checks.errors).toEqual([]);
    expect(detail.json.case.checks.warnings.map((w: any) => w.code)).toContain('stl_units');
    expect(detail.json.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['created', 'files_checked']));
    expect(detail.json.instructions).toContain('attachments');

    // at rest: names and content are encrypted and disk names are random
    const rows = await q('SELECT name_enc, storage_prefix, chunk_count FROM files WHERE id = $1', [stl1]);
    expect(rows[0].name_enc).toMatch(/^f1\./);
    expect(rows[0].name_enc).not.toContain('55813');
    const onDisk = path.join(config.storageDir, ...rows[0].storage_prefix.split('/'), '0.bin');
    const raw = readFileSync(onDisk);
    expect(raw.includes(Buffer.from(STL_HEADER_SECRET))).toBe(false);
    expect(raw.length).toBe(84 + 12 * 50 + 16);
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? [n, ...walk(path.join(d, n))] : [n]));
    for (const name of walk(config.storageDir)) expect(name).toMatch(/^(f|[0-9a-f]{32}|\d+\.bin)$/);
  });

  it('flags an error for two files in one slot and clears it after fixing the mapping', async () => {
    const dupe = await up.uploadFile(caseA.id, 'copy_of_model_U01.stl', cubeStl(60));
    let d = await up.call('GET', `/api/cases/${caseA.id}`);
    expect(d.json.case.checks.errors.map((e: any) => e.code)).toContain('duplicate_file');
    // the same model as a template for step 1 is its own slot
    const fixed = await up.call('PATCH', `/api/files/${dupe.fileId}`, { arch: 'upper', step: 1, template: true });
    expect(fixed.status).toBe(200);
    expect(fixed.json.template).toBe(true);
    d = await up.call('GET', `/api/cases/${caseA.id}`);
    expect(d.json.case.checks.errors).toEqual([]);
    expect(d.json.case.counts.templates).toBe(1);
    // a file without arch and step blocks
    const loose = await up.uploadFile(caseA.id, 'scan.stl', cubeStl(50), { arch: null, step: null });
    d = await up.call('GET', `/api/cases/${caseA.id}`);
    expect(d.json.case.checks.errors.map((e: any) => e.code)).toContain('missing_mapping');
    expect((await up.call('DELETE', `/api/files/${loose.fileId}`)).status).toBe(200);
    expect((await up.call('GET', `/api/files/${loose.fileId}`)).status).toBe(404);
    expect((await up.call('GET', `/api/cases/${caseA.id}`)).json.case.checks.errors).toEqual([]);
  });

  it('uploads a multi chunk file and resumes where it stopped', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 'note line\n');
    const init = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: caseA.id, name: 'notes.txt', size: big.length });
    expect(init.json.chunkCount).toBe(2);
    expect((await up.putChunk(init.json.fileId, 0, big.subarray(0, 8 * 1024 * 1024))).json.received).toBe(1);
    const resume = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: caseA.id, name: 'notes.txt', size: big.length });
    expect(resume.json.fileId).toBe(init.json.fileId);
    expect(resume.json.received).toEqual([0]);
    const f = await up.uploadFile(caseA.id, 'notes.txt', big);
    expect(f.fileId).toBe(init.json.fileId);
    expect(f.file.state).toBe('ready');
    expect(f.file.size).toBe(big.length);
    expect(f.file.validation.meta.sha256).toBe(createHash('sha256').update(big).digest('hex'));
    // it downloads back byte for byte
    const dl = await up.call('GET', `/api/files/${f.fileId}/download`);
    expect(dl.status).toBe(200);
    expect(createHash('sha256').update(dl.res.rawPayload).digest('hex')).toBe(createHash('sha256').update(big).digest('hex'));
    await up.call('DELETE', `/api/files/${f.fileId}`);
  });

  it('rejects an infected file through the scanner', async () => {
    const scanner: Scanner = {
      driver: 'clamav',
      ping: async () => true,
      async scan(chunks) {
        const parts: Buffer[] = [];
        for await (const c of chunks) parts.push(c);
        return Buffer.concat(parts).includes('EICAR-TEST-MARKER') ? { status: 'infected', signature: 'Test.Signature' } : { status: 'clean' };
      },
    };
    setScanner(scanner);
    try {
      const clean = await up.uploadFile(caseA.id, 'clean.pdf', minimalPdf());
      expect(clean.file).toMatchObject({ state: 'ready', scan: 'clean' });
      const bad = await up.uploadFile(caseA.id, 'evil.pdf', minimalPdf('/Note (EICAR-TEST-MARKER)'));
      expect(bad.file.state).toBe('rejected');
      expect(bad.file.scan).toBe('infected');
      expect(bad.file.validation.errors[0].code).toBe('infected');
      expect((await up.call('GET', `/api/files/${bad.fileId}/download`)).status).toBe(409);
      const d = await up.call('GET', `/api/cases/${caseA.id}`);
      expect(d.json.case.checks.errors.map((e: any) => e.code)).toContain('file_rejected');
      // a PDF with JavaScript is rejected by the content checks
      const js = await up.uploadFile(caseA.id, 'active.pdf', minimalPdf('/OpenAction << /S /JavaScript /JS (app.alert(1)) >>'));
      expect(js.file.state).toBe('rejected');
      expect(js.file.validation.errors[0].code).toBe('pdf_javascript');
      for (const id of [bad.fileId, js.fileId, clean.fileId]) await up.call('DELETE', `/api/files/${id}`);
    } finally {
      setScanner(undefined);
    }
    expect((await up.call('GET', `/api/cases/${caseA.id}`)).json.case.checks.errors).toEqual([]);
  });

  it('holds the case at 600 files', async () => {
    const c = await newCase(up);
    await q(`INSERT INTO files (org_id, purpose, case_id, kind, state) SELECT $1, 'case', $2, 'other', 'ready' FROM generate_series(1, 600)`, [acmeId, c.id]);
    const r = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: c.id, name: 'one_more.txt', size: 10 });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('too_many_files');
    await up.call('DELETE', `/api/cases/${c.id}`);
  });

  it('does not let errors or warnings stop a submission', async () => {
    const c = await newCase(up);
    // an empty case has the error no_stl
    expect((await up.call('GET', `/api/cases/${c.id}`)).json.case.checks.errors.map((e: any) => e.code)).toContain('no_stl');
    const sub = await up.call('POST', `/api/cases/${c.id}/submit`, {});
    expect(sub.status, JSON.stringify(sub.json)).toBe(200);
    expect(sub.json.case.status).toMatch(/^(ready|submitted)$/);
  });

  it('submits a case with warnings without asking, stores the acknowledgement, routes to the default site and sets the due date', async () => {
    expect((await up.call('GET', `/api/cases/${caseA.id}`)).json.case.checks.warnings.map((w: any) => w.code)).toContain('stl_units');
    const ok = await up.call('POST', `/api/cases/${caseA.id}/submit`, { acknowledgeWarnings: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.case).toMatchObject({ status: 'ready', siteCode: 'PT-CHV', warningsAcknowledged: true });
    expect(ok.json.case.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const row = (await q('SELECT warnings_acknowledged, warnings_acknowledged_at, ready_at FROM cases WHERE id = $1', [caseA.id]))[0];
    expect(row.warnings_acknowledged).toBe(true);
    expect(row.warnings_acknowledged_at).not.toBeNull();
    expect((await up.call('GET', `/api/cases/${caseA.id}`)).json.events.map((e: any) => e.type)).toContain('submitted');
    // files are closed once the case is submitted
    expect((await up.call('POST', '/api/uploads', { purpose: 'case', caseId: caseA.id, name: 'late.stl', size: 100 })).json.code).toBe('case_not_open');
    expect((await up.call('PATCH', `/api/files/${stl1}`, { step: 5 })).json.code).toBe('case_not_open');
    expect((await up.call('DELETE', `/api/files/${stl1}`)).json.code).toBe('case_not_open');
    expect((await up.call('PATCH', `/api/cases/${caseA.id}`, { priority: 'rush' })).json.code).toBe('case_not_open');
    expect((await up.call('DELETE', `/api/cases/${caseA.id}`)).json.code).toBe('case_not_draft');
    expect((await up.call('POST', `/api/cases/${caseA.id}/submit`, {})).json.code).toBe('case_not_open');
  });
});

describe('instructions', () => {
  it('are editable until production starts, then locked, and K Line is told by reference only', async () => {
    const before = await q('SELECT count(*)::int AS n FROM notifications');
    const secret = 'Use the softer material for Marc please';
    const r = await up.call('PATCH', `/api/cases/${caseA.id}`, { instructions: secret });
    expect(r.status).toBe(200);
    const d = await up.call('GET', `/api/cases/${caseA.id}`);
    expect(d.json.instructions).toBe(secret);
    expect(d.json.events.map((e: any) => e.type)).toContain('instructions_updated');
    const stored = (await q('SELECT notes_enc FROM cases WHERE id = $1', [caseA.id]))[0].notes_enc;
    expect(stored).not.toContain('softer');
    await runDueJobs();
    const notes = await q(`SELECT title, body, data FROM notifications WHERE kind = 'instructions_updated' ORDER BY created_at DESC LIMIT 1`);
    expect(notes[0].body).toBe(`Case ${caseA.ref}`);
    expect(JSON.stringify(notes[0])).not.toMatch(/softer|Marc/);
    expect((await q('SELECT count(*)::int AS n FROM notifications'))[0].n).toBe(before[0].n + 1);
    const jobs = await q(`SELECT payload FROM jobs WHERE kind = 'notify.kline'`);
    expect(JSON.stringify(jobs)).not.toMatch(/softer|Marc/);

    expect((await up.call('PATCH', `/api/cases/${caseA.id}`, { instructions: 'x'.repeat(8001) })).json.code).toBe('instructions_too_long');
    await q(`UPDATE cases SET status = 'in_production' WHERE id = $1`, [caseA.id]);
    const locked = await up.call('PATCH', `/api/cases/${caseA.id}`, { instructions: 'too late' });
    expect(locked.status).toBe(409);
    expect(locked.json.code).toBe('instructions_locked');
    await q(`UPDATE cases SET status = 'ready' WHERE id = $1`, [caseA.id]);
  });
});

describe('patient names, downloads and the access log', () => {
  it('logs every name reveal and file download and shows K Line access to the partner', async () => {
    const list = await up.call('GET', '/api/cases');
    expect(JSON.stringify(list.json)).not.toMatch(/Marc|Alonso/);

    const reveal = await up.call('POST', `/api/cases/${caseA.id}/reveal-name`, {});
    expect(reveal.status).toBe(200);
    expect(reveal.json.patientName).toBe('Marc Alonso');
    const klReveal = await intake.call('POST', `/api/cases/${caseA.id}/reveal-name`, {});
    expect(klReveal.json.patientName).toBe('Marc Alonso');

    const dl = await up.call('GET', `/api/files/${stl1}/download`);
    expect(dl.status).toBe(200);
    expect(dl.res.headers['content-type']).toBe('application/octet-stream');
    expect(String(dl.res.headers['content-disposition'])).toContain('attachment; filename="55813_U01.stl"');
    expect(dl.res.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.res.headers['cache-control']).toBe('no-store');
    expect(dl.res.rawPayload.equals(cubeStl(50, STL_HEADER_SECRET))).toBe(true);
    const view = await up.call('GET', `/api/files/${pts1}/content`);
    expect(view.status).toBe(200);
    const klDl = await intake.call('GET', `/api/files/${stl2}/download`);
    expect(klDl.status).toBe(200);

    const log = await admin.call('GET', '/api/audit?limit=200');
    expect(log.status).toBe(200);
    const acts = log.json.entries as any[];
    const by = (action: string) => acts.filter((e) => e.action === action);
    expect(by('case.name_revealed').length).toBe(2);
    expect(by('case.name_revealed').map((e) => e.actorLabel)).toEqual(expect.arrayContaining(['K Line staff', 'Uma Upload']));
    expect(by('file.download').map((e) => e.actorLabel)).toEqual(expect.arrayContaining(['K Line staff', 'Uma Upload']));
    expect(by('file.view').length).toBe(1);
    expect(by('file.download').find((e) => e.actorLabel === 'K Line staff').targetId).toBe(stl2);
    expect(JSON.stringify(acts)).not.toMatch(/Alonso|Marc/);
    // partners of other organisations see none of it
    const other = await contoso.call('GET', '/api/audit?limit=200');
    expect(other.json.entries.filter((e: any) => /^(case\.name_revealed|file\.(download|view))/.test(e.action))).toEqual([]);
  });

  it('streams a package with canonical names, a manifest with SHA-256 and the instructions', async () => {
    const r = await up.call('GET', `/api/cases/${caseA.id}/package.zip`);
    expect(r.status).toBe(200);
    expect(r.res.headers['content-type']).toBe('application/zip');
    expect(String(r.res.headers['content-disposition'])).toContain(`${caseA.ref}.zip`);
    const files = unzipSync(new Uint8Array(r.res.rawPayload));
    expect(Object.keys(files).sort()).toEqual(['instructions.txt', 'manifest.csv', 'upper/U01.pts', 'upper/U01.stl', 'upper/U01_T.stl', 'upper/U02.stl']);
    expect(Buffer.from(files['upper/U01.stl']!).equals(cubeStl(50, STL_HEADER_SECRET))).toBe(true);
    const manifest = Buffer.from(files['manifest.csv']!).toString();
    const sha = createHash('sha256').update(Buffer.from(files['upper/U01.stl']!)).digest('hex');
    expect(manifest).toContain(`upper/U01.stl,stl,upper,1,no,${cubeStl(50, STL_HEADER_SECRET).length},${sha}`);
    expect(Buffer.from(files['instructions.txt']!).toString()).toContain('softer material');
    const log = await admin.call('GET', '/api/audit?action=case.package');
    expect(log.json.entries.length).toBe(1);
  });
});

describe('tenant isolation at the API', () => {
  it('hides cases, files and names of one partner from another', async () => {
    const list = await contoso.call('GET', '/api/cases');
    expect(list.json.items.every((c: any) => c.orgId === contosoId)).toBe(true);
    expect(list.json.items.find((c: any) => c.id === caseA.id)).toBeUndefined();
    expect((await contoso.call('GET', `/api/cases/${caseA.id}`)).status).toBe(404);
    expect((await contoso.call('GET', `/api/files/${stl1}`)).status).toBe(404);
    expect((await contoso.call('GET', `/api/files/${stl1}/download`)).status).toBe(404);
    expect((await contoso.call('GET', `/api/files/${stl1}/content`)).status).toBe(404);
    expect((await contoso.call('POST', `/api/cases/${caseA.id}/reveal-name`, {})).status).toBe(404);
    expect((await contoso.call('GET', `/api/cases/${caseA.id}/package.zip`)).status).toBe(404);
    expect((await contoso.call('PATCH', `/api/cases/${caseA.id}`, { priority: 'rush' })).status).toBe(404);
    expect((await contoso.call('POST', `/api/cases/${caseA.id}/cancel`, {})).status).toBe(404);
    expect((await contoso.call('POST', `/api/cases/${caseA.id}/submit`, {})).status).toBe(404);
    expect((await contoso.call('DELETE', `/api/cases/${caseA.id}`)).status).toBe(404);
    expect((await contoso.call('POST', '/api/uploads', { purpose: 'case', caseId: caseA.id, name: 'x.stl', size: 10 })).status).toBe(404);
    expect((await contoso.call('DELETE', `/api/files/${stl1}`)).status).toBe(404);
    // and searching for the name finds nothing
    expect((await contoso.call('GET', '/api/cases?search=Marc%20Alonso')).json.total).toBe(0);
    // K Line sees all
    const kl = await intake.call('GET', '/api/cases?pageSize=100');
    expect(kl.json.items.find((c: any) => c.id === caseA.id)).toBeDefined();
  });
});

describe('listing and search', () => {
  it('searches by case ID, reference and exact patient name, filters and pages', async () => {
    const s1 = await up.call('GET', '/api/cases?search=55813');
    expect(s1.json.items.map((c: any) => c.id)).toEqual([caseA.id]);
    const s2 = await up.call('GET', `/api/cases?search=${caseA.ref.toLowerCase()}`);
    expect(s2.json.items.map((c: any) => c.id)).toEqual([caseA.id]);
    for (const name of ['Marc Alonso', 'marc  ALONSO', 'Márc Alonsó']) {
      const s3 = await up.call('GET', `/api/cases?search=${encodeURIComponent(name)}`);
      expect(s3.json.items.map((c: any) => c.id), name).toEqual([caseA.id]);
    }
    expect((await up.call('GET', '/api/cases?search=Marc')).json.total).toBe(0); // exact name only
    expect((await up.call('GET', '/api/cases?search=%25')).json.total).toBe(0); // wildcards are literal
    expect((await up.call('GET', '/api/cases?status=production')).json.items.map((c: any) => c.id)).toContain(caseA.id);
    expect((await up.call('GET', '/api/cases?status=draft')).json.items.map((c: any) => c.id)).not.toContain(caseA.id);
    const p1 = await up.call('GET', '/api/cases?pageSize=2&page=1');
    const p2 = await up.call('GET', '/api/cases?pageSize=2&page=2');
    expect(p1.json.items).toHaveLength(2);
    expect(p1.json.total).toBeGreaterThan(2);
    expect(p2.json.items.map((c: any) => c.id)).not.toEqual(p1.json.items.map((c: any) => c.id));
    expect((await up.call('GET', '/api/cases?pageSize=500')).status).toBe(400);
  });
});

describe('transfer gate and routing', () => {
  it('refuses routing to a non EEA site without SCCs and allows it once they are on file', async () => {
    // Acme (Portugal) only has the Cairo site.
    const ids = await q<{ id: string; code: string }>(`SELECT id, code FROM sites WHERE code IN ('PT-CHV', 'EG-CFZ')`);
    const chaves = ids.find((s) => s.code === 'PT-CHV')!.id;
    await q('DELETE FROM org_sites WHERE org_id = $1 AND site_id = $2', [acmeId, chaves]);
    await q(`UPDATE organizations SET default_site_id = (SELECT id FROM sites WHERE code = 'EG-CFZ') WHERE id = $1`, [acmeId]);
    try {
      const c = await newCase(up);
      await up.uploadFile(c.id, 'U01.stl', cubeStl(50));
      const blocked = await up.call('POST', `/api/cases/${c.id}/submit`, {});
      expect(blocked.status).toBe(403);
      expect(blocked.json.code).toBe('transfer_blocked');
      expect((await q('SELECT status FROM cases WHERE id = $1', [c.id]))[0].status).toBe('draft');
      await q(`INSERT INTO agreements (org_id, type, signed_at, signed_by) VALUES ($1, 'scc', current_date, 'Test')`, [acmeId]);
      const ok = await up.call('POST', `/api/cases/${c.id}/submit`, {});
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(ok.json.case).toMatchObject({ status: 'ready', siteCode: 'EG-CFZ' });
      await q(`DELETE FROM agreements WHERE org_id = $1 AND type = 'scc'`, [acmeId]);
    } finally {
      await q('INSERT INTO org_sites (org_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [acmeId, chaves]);
      await q(`UPDATE organizations SET default_site_id = $2 WHERE id = $1`, [acmeId, chaves]);
    }
  });

  it('keeps a case as submitted when manual review is on, and tells K Line', async () => {
    await q(`UPDATE organizations SET settings = settings || '{"manual_review": true}'::jsonb WHERE id = $1`, [acmeId]);
    try {
      const c = await newCase(up);
      await up.uploadFile(c.id, 'U01.stl', cubeStl(50));
      const ok = await up.call('POST', `/api/cases/${c.id}/submit`, {});
      expect(ok.json.case).toMatchObject({ status: 'submitted', siteCode: null, dueDate: null });
      await runDueJobs();
      const n = await q(`SELECT body FROM notifications WHERE kind = 'case_submitted' ORDER BY created_at DESC LIMIT 1`);
      expect(n[0].body).toBe(`Case ${ok.json.case.ref}`);
    } finally {
      await q(`UPDATE organizations SET settings = settings || '{"manual_review": false}'::jsonb WHERE id = $1`, [acmeId]);
    }
  });

  it('asks for a trim line per aligner when the organisation requires PTS', async () => {
    await q(`UPDATE organizations SET settings = settings || '{"require_pts": true}'::jsonb WHERE id = $1`, [acmeId]);
    try {
      const c = await newCase(up);
      await up.uploadFile(c.id, 'U01.stl', cubeStl(50));
      const d = await up.call('GET', `/api/cases/${c.id}`);
      expect(d.json.case.checks.warnings.map((w: any) => w.code)).toContain('missing_pts');
      await up.uploadFile(c.id, 'U01.pts', trimLine());
      const d2 = await up.call('GET', `/api/cases/${c.id}`);
      expect(d2.json.case.checks.warnings).toEqual([]);
      // a template U01_T does not clash with U01 and needs no trim line
      await up.uploadFile(c.id, 'U01_T.stl', cubeStl(50));
      const d3 = await up.call('GET', `/api/cases/${c.id}`);
      expect(d3.json.case.checks.errors).toEqual([]);
      expect(d3.json.case.checks.warnings).toEqual([]);
      expect(d3.json.files.find((f: any) => f.name === 'U01_T.stl')).toMatchObject({ arch: 'upper', step: 1, template: true });
    } finally {
      await q(`UPDATE organizations SET settings = settings || '{"require_pts": false}'::jsonb WHERE id = $1`, [acmeId]);
    }
  });
});

describe('deleting', () => {
  it('removes a draft with its stored chunks', async () => {
    const c = await newCase(up);
    const f = await up.uploadFile(c.id, 'U01.stl', cubeStl(50));
    const prefix = (await q('SELECT storage_prefix FROM files WHERE id = $1', [f.fileId]))[0].storage_prefix as string;
    const dir = path.join(config.storageDir, ...prefix.split('/'));
    expect(readdirSync(dir).length).toBe(1);
    expect((await up.call('DELETE', `/api/cases/${c.id}`)).status).toBe(200);
    expect((await up.call('GET', `/api/cases/${c.id}`)).status).toBe(404);
    expect((await q('SELECT count(*)::int AS n FROM files WHERE id = $1', [f.fileId]))[0].n).toBe(0);
    expect(() => readdirSync(dir)).toThrow();
  });

  it('tampered stored chunks fail to download instead of leaking garbage', async () => {
    const c = await newCase(up);
    const f = await up.uploadFile(c.id, 'U01.stl', cubeStl(50));
    const prefix = (await q('SELECT storage_prefix FROM files WHERE id = $1', [f.fileId]))[0].storage_prefix as string;
    const file = path.join(config.storageDir, ...prefix.split('/'), '0.bin');
    const bytes = readFileSync(file);
    bytes[10] ^= 0xff;
    (await import('node:fs')).writeFileSync(file, bytes);
    const r = await up.call('GET', `/api/files/${f.fileId}/download`);
    expect(r.status).toBe(500);
    expect(r.json.code).toBe('file_unreadable');
    expect(r.res.rawPayload.includes(Buffer.from('synthetic'))).toBe(false);
    await up.call('DELETE', `/api/cases/${c.id}`);
  });
});

describe('big STL through the whole pipeline', () => {
  it('processes an STL of about 20 MB in a few seconds', async () => {
    // 420 thousand triangles: a fan of thin sliver triangles is enough for the size, the checks run on all of them.
    const n = 420_000;
    const b = Buffer.alloc(84 + n * 50);
    b.writeUInt32LE(n, 80);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      const x = (i % 700) * 0.1;
      const y = Math.floor(i / 700) * 0.1;
      [x, y, 0, x + 0.09, y, 0, x, y + 0.09, 1].forEach((v, k) => b.writeFloatLE(v, o + k * 4));
    }
    const c = await newCase(up);
    const t = Date.now();
    const f = await up.uploadFile(c.id, 'U01.stl', b);
    expect(Date.now() - t).toBeLessThan(20_000);
    expect(f.file.state).toBe('ready');
    expect(f.file.validation.meta.triangles).toBe(n);
    await up.call('DELETE', `/api/cases/${c.id}`);
  });
});

void binaryStl;
void PNG_BYTES;
