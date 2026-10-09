import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { strFromU8, unzipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { archStl, docxInstructions, laserCsv, planPdf, rtfInstructions, sampleSvg, samplePng, sphereStl, trimLinePts } from '../src/demo/assets';
import { decryptField, fieldAad } from '../src/crypto/keys';
import { bufferSource, validateContent } from '../src/services/validate';
import { groupCases } from '../../shared/filenames';
import { Client } from './helpers';

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);
const check = (kind: string, ext: string, data: Buffer | string) => validateContent(kind, ext, bufferSource(Buffer.from(data)));

let app: FastifyInstance;
let ipN = 1;
const ip = () => `10.8.${Math.floor(ipN / 250)}.${ipN++ % 250}`;

beforeAll(async () => {
  await seedDemo({ force: true, withCases: true, writeKeys: false });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
});
afterAll(async () => {
  config.demoMode = true;
  await app.close();
  await closePools();
});

// ===========================================================================
describe('demo files', () => {
  it('makes closed, valid STL meshes of modest size', async () => {
    for (const buf of [archStl({ arch: 'upper', step: 1 }), archStl({ arch: 'lower', step: 7 }), archStl({ arch: 'upper', step: 0, template: true }), sphereStl()]) {
      expect(buf.length).toBeLessThan(400_000);
      const r = await check('stl', 'stl', buf);
      expect(r.errors).toEqual([]);
      expect(r.warnings, JSON.stringify(r.warnings)).toEqual([]);
      expect(r.meta).toMatchObject({ openEdges: 0, nonManifoldEdges: 0 });
    }
  });

  it('is deterministic', () => {
    expect(archStl({ arch: 'upper', step: 2 }).equals(archStl({ arch: 'upper', step: 2 }))).toBe(true);
    expect(archStl({ arch: 'upper', step: 2 }).equals(archStl({ arch: 'upper', step: 3 }))).toBe(false);
  });

  it('makes a closed trim line inside its model, and one with a gap', async () => {
    const closed = await check('pts', 'pts', trimLinePts({ arch: 'upper', step: 1 }));
    expect(closed.warnings).toEqual([]);
    expect(closed.meta).toMatchObject({ closed: true });
    const stl = await check('stl', 'stl', archStl({ arch: 'upper', step: 1 }));
    const box = stl.meta.bbox as { min: number[]; max: number[] };
    const tb = closed.meta.bbox as { min: number[]; max: number[] };
    for (let k = 0; k < 3; k++) {
      expect(tb.min[k]!).toBeGreaterThanOrEqual(box.min[k]!);
      expect(tb.max[k]!).toBeLessThanOrEqual(box.max[k]!);
    }
    const open = await check('pts', 'pts', trimLinePts({ arch: 'upper', step: 1, open: true }));
    expect(open.meta).toMatchObject({ closed: false });
    expect(open.warnings.map((w) => w.code)).toContain('pts_open');
  });

  it('makes a safe PDF, PNG, SVG, tab separated CSV, Word and RTF file', async () => {
    const pdf = planPdf('Plan', ['one', 'two (with brackets)']);
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(pdf.toString('latin1')).not.toMatch(/JavaScript|\/JS|\/Launch|OpenAction|EmbeddedFile/);
    const pdfResult = await check('pdf', 'pdf', pdf);
    expect(pdfResult.errors).toEqual([]);
    expect(pdfResult.warnings).toEqual([]);
    expect(samplePng().subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect((await check('image', 'png', samplePng())).errors).toEqual([]);
    const svg = await check('svg', 'svg', sampleSvg());
    expect(svg.errors).toEqual([]);
    expect(svg.warnings).toEqual([]);
    expect(sampleSvg()).not.toMatch(/<script|on\w+=|javascript:|foreignObject|href/i);
    const csv = laserCsv('55813', 'upper', 1);
    expect(csv.toString()).toContain('LaserPt1Start\t');
    expect(csv.toString()).toContain('text1\t55813_U01');
    const csvResult = await check('csv', 'csv', csv);
    expect(csvResult.errors).toEqual([]);
    expect(csvResult.warnings).toEqual([]);

    const docx = unzipSync(new Uint8Array(docxInstructions(['First line', 'Second & line'])));
    expect(Object.keys(docx).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    expect(strFromU8(docx['word/document.xml']!)).toContain('Second &amp; line');
    expect(rtfInstructions(['Hello']).toString('latin1')).toMatch(/^\{\\rtf1/);
  });
});

// ===========================================================================
describe('sample cases zip', () => {
  const download = (remoteAddress = ip()) => app.inject({ method: 'GET', url: '/api/demo/sample-cases.zip', remoteAddress });
  const entriesOf = (body: Buffer) => unzipSync(new Uint8Array(body));

  it('needs no sign in, and arrives as a zip download', async () => {
    const res = await download();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(entriesOf(res.rawPayload)).length).toBeGreaterThan(40);
  });

  it('splits into four cases with instructions, through the same grouping the Send files screen uses', async () => {
    const z = entriesOf((await download()).rawPayload);
    const files = Object.entries(z).filter(([p]) => !p.endsWith('/')).map(([p, d]) => ({ path: `sample-cases.zip/${p}`, size: d.length }));
    const groups = groupCases(files);
    expect(groups).toHaveLength(4);

    const by = (pred: (g: (typeof groups)[number]) => boolean) => groups.find(pred)!;
    const arch = by((g) => g.files.some((f) => f.path.includes('/Upper/') && f.kind === 'instructions' === false && g.files.some((x) => x.ext === 'docx')));
    const flat = by((g) => g.files.some((f) => f.name === 'instructions.txt') && g.files.some((f) => f.template));
    const patient = by((g) => g.files.some((f) => f.ext === 'rtf'));
    const openTrim = by((g) => g !== arch && g !== flat && g !== patient);

    // every case has an instructions file and every model has an arch and step
    for (const g of groups) {
      expect(g.files.some((f) => f.kind === 'instructions'), g.caseId).toBe(true);
      expect(g.problems, g.caseId).toEqual([]);
    }
    expect(arch.files.map((f) => f.ext).sort()).toEqual(expect.arrayContaining(['docx', 'pdf', 'pts', 'stl']));
    expect(arch.files.filter((f) => f.kind === 'stl' && f.arch === 'upper').map((f) => f.step)).toEqual([1, 2, 3]);
    expect(arch.files.filter((f) => f.kind === 'stl' && f.arch === 'lower').map((f) => f.step)).toEqual([1, 2, 3]);
    expect(flat.files.filter((f) => f.kind === 'stl' && !f.template)).toHaveLength(4);
    expect(flat.files.find((f) => f.template)).toMatchObject({ arch: 'upper', step: 1 });
    expect(patient.idFromFolderName).toBe(false);
    expect(patient.files.some((f) => f.ext === 'rtf')).toBe(true);
    expect(patient.files.filter((f) => f.kind === 'stl' && f.arch === 'upper')).toHaveLength(3); // Maxilla
    expect(patient.files.filter((f) => f.kind === 'stl' && f.arch === 'lower')).toHaveLength(3); // Mandible

    // the open trim line is on U03 only
    const open = await Promise.all(
      openTrim.files.filter((f) => f.kind === 'pts').map(async (f) => ({ step: f.step, closed: (await check('pts', 'pts', Buffer.from(z[f.path.replace('sample-cases.zip/', '')]!))).meta.closed })),
    );
    expect(open.sort((a, b) => a.step! - b.step!)).toEqual([{ step: 1, closed: true }, { step: 2, closed: true }, { step: 3, closed: false }]);
    // and the closed ones everywhere else
    for (const g of [arch, flat, patient]) {
      for (const f of g.files.filter((x) => x.kind === 'pts')) expect((await check('pts', 'pts', Buffer.from(z[f.path.replace('sample-cases.zip/', '')]!))).meta.closed, `${g.caseId} ${f.name}`).toBe(true);
    }
  });

  it('gives fresh case numbers on every download, and only fictional names', async () => {
    const ids = async () => {
      const z = entriesOf((await download()).rawPayload);
      return groupCases(Object.keys(z).filter((p) => !p.endsWith('/')).map((p) => ({ path: `sample-cases.zip/${p}`, size: 1 }))).map((g) => g.caseId).sort();
    };
    const a = await ids();
    const b = await ids();
    expect(a.filter((x) => /^\d{5}$/.test(x))).toHaveLength(4);
    const numbers = (x: string[]) => x.filter((i) => /^\d{5}$/.test(i));
    expect(numbers(a).some((n) => numbers(b).includes(n))).toBe(false);
    // the text inside the files mentions no real person
    const z = entriesOf((await download()).rawPayload);
    const text = Object.entries(z).filter(([p]) => /\.(txt|rtf)$/.test(p)).map(([, d]) => strFromU8(d)).join('\n');
    expect(text).toMatch(/fictional|demo/i);
  });

  it('every file in it would pass the intake checks, except the open trim line', async () => {
    const z = entriesOf((await download()).rawPayload);
    let warned = 0;
    for (const [p, d] of Object.entries(z)) {
      const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
      const kind = ({ stl: 'stl', pts: 'pts', pdf: 'pdf', csv: 'csv' } as Record<string, string>)[ext];
      if (!kind) continue;
      const r = await check(kind, ext, Buffer.from(d));
      expect(r.errors, p).toEqual([]);
      if (r.warnings.length) warned++;
    }
    expect(warned).toBe(1);
  });

  it('is only there in demo mode', async () => {
    config.demoMode = false;
    try {
      const res = await download();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('not_found');
    } finally {
      config.demoMode = true;
    }
  });

  it('is rate limited', async () => {
    const same = ip();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await download(same)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});

// ===========================================================================
describe('richer Acme demo data', () => {
  it('covers every status, in up to 18 cases', async () => {
    const rows = await q(`SELECT partner_case_id, kind, status, stage, priority, hold_reason, aligners_templates, parent_id FROM cases WHERE org_id = (SELECT id FROM organizations WHERE code = 'ACME') ORDER BY ref`);
    expect(rows).toHaveLength(18);
    const statuses = new Set(rows.map((r) => r.status));
    for (const s of ['draft', 'submitted', 'on_hold', 'ready', 'received', 'in_production', 'shipped', 'delivered', 'cancelled']) expect(statuses.has(s), s).toBe(true);
    expect(new Set(rows.filter((r) => r.status === 'in_production').map((r) => r.stage))).toEqual(new Set(['printing', 'thermoforming', 'trimming', 'finishing', 'quality_check', 'packing']));
    expect(rows.filter((r) => r.status === 'shipped').length).toBeGreaterThanOrEqual(3);
    expect(rows.filter((r) => r.status === 'shipped' && r.aligners_templates > 0)).toHaveLength(1);
    expect(rows.find((r) => r.stage === 'trimming')!.priority).toBe('rush');
    expect(rows.filter((r) => r.kind === 'replacement')).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'rework')).toHaveLength(1);
    expect(rows.find((r) => r.status === 'on_hold')!.hold_reason).toMatch(/U07/);
  });

  it('has a draft with a missing trim line, a prescription, changed instructions and an open U07 trim line', async () => {
    const draft = (await q(`SELECT checks FROM cases WHERE partner_case_id = 'AC-1001'`))[0];
    expect(JSON.stringify(draft.checks.warnings)).toMatch(/trim/i);
    const rx = (await q(`SELECT id, status, notes_enc FROM cases WHERE partner_case_id = 'AC-1002'`))[0];
    expect(rx.status).toBe('submitted');
    const text = decryptField(rx.notes_enc, fieldAad.caseNotes(rx.id));
    expect(text.length).toBeGreaterThan(800);
    expect(text).toMatch(/Attachments/);
    const lena = (await q(`SELECT id, status FROM cases WHERE partner_case_id = 'AC-1004'`))[0];
    expect(lena.status).toBe('ready');
    expect((await q(`SELECT type FROM case_events WHERE case_id = $1 ORDER BY created_at`, [lena.id])).map((e) => e.type)).toEqual(['created', 'submitted', 'routed', 'instructions_updated']);
    const hold = (await q(`SELECT id, checks FROM cases WHERE partner_case_id = 'AC-1003'`))[0];
    expect(JSON.stringify(hold.checks.warnings)).toMatch(/not closed|open/i);
  });

  it('has two claims: one closed with a rework case, one in review', async () => {
    const claims = await q(`SELECT cl.number, cl.status, cl.resolution, cl.rework_case_id, r.kind AS rework_kind, r.priority, r.claim_id FROM claims cl LEFT JOIN cases r ON r.id = cl.rework_case_id ORDER BY cl.number`);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ status: 'closed', resolution: 'remake', rework_kind: 'rework', priority: 'rush' });
    expect(claims[0].claim_id).toBeTruthy();
    expect(claims[1]).toMatchObject({ status: 'in_review', rework_case_id: null });
    const k = await new Client(app).full('admin@kline.demo');
    const ov = await (await new Client(app).full('admin@kline.demo')).call('GET', '/api/console/overview');
    expect(ov.json.openClaims).toBe(1);
    expect((await k.call('GET', '/api/claims')).status).toBe(200);
  });

  it('holds real encrypted files for received and shipped cases, which download byte for byte', async () => {
    const admin = await new Client(app).full('admin@acme.demo');
    const files = await q(
      `SELECT f.id, f.kind AS kind, f.size, f.state, f.meta, c.partner_case_id FROM files f JOIN cases c ON c.id = f.case_id WHERE c.partner_case_id IN ('AC-1005', 'AC-1012', 'AC-1013', 'AC-1014') ORDER BY f.id`,
    );
    expect(files.length).toBeGreaterThan(20);
    expect(files.every((f) => f.state === 'ready')).toBe(true);
    const stl = files.find((f) => f.kind === 'stl' && f.partner_case_id === 'AC-1012')!;
    const d = await admin.call('GET', `/api/files/${stl.id}/download`);
    expect(d.status).toBe(200);
    expect(d.res.rawPayload.length).toBe(Number(stl.size));
    expect(d.res.rawPayload.readUInt32LE(80)).toBeGreaterThan(1000);
    const sha = (await import('node:crypto')).createHash('sha256').update(d.res.rawPayload).digest('hex');
    expect(sha).toBe(stl.meta.sha256);
    // the replacement shares the bytes of its parent
    const shared = await q(`SELECT count(*)::int AS n FROM files WHERE cipher_file_id IS NOT NULL AND cipher_file_id <> id`);
    expect(shared[0].n).toBeGreaterThan(0);
    // the template case has template models and laser files
    const t = await q(`SELECT count(*) FILTER (WHERE f.is_template)::int AS templates, count(*) FILTER (WHERE f.kind = 'csv')::int AS csv FROM files f JOIN cases c ON c.id = f.case_id WHERE c.partner_case_id = 'AC-1012'`);
    expect(t[0]).toEqual({ templates: 2, csv: 4 });
  });

  it('logs factory events including an unmapped code, and K Line access that the partner can read', async () => {
    const bad = await q(`SELECT outcome, message, stage_code FROM mes_events WHERE stage_code = 'XRAY9'`);
    expect(bad).toEqual([{ outcome: 'error', message: 'The stage code XRAY9 is not in the stage map.', stage_code: 'XRAY9' }]);
    const applied = await q(`SELECT count(*)::int AS n FROM mes_events WHERE outcome = 'applied'`);
    expect(applied[0].n).toBeGreaterThan(20);
    const admin = await new Client(app).full('admin@acme.demo');
    const log = await admin.call('GET', '/api/audit?limit=200');
    expect(log.status, JSON.stringify(log.json)).toBe(200);
    const actions = (log.json.entries as any[]).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['file.download', 'case.name_revealed', 'claim.opened']));
    const access = (log.json.entries as any[]).find((e) => e.action === 'file.download' && e.actorLabel === 'K Line staff');
    expect(access).toBeTruthy();
    expect(access.ip).toBeNull(); // partners do not see the address of K Line staff
    const chain = await q(`SELECT ok FROM kph_audit_verify_chain()`);
    expect(chain[0].ok).toBe(true);
  });

  it('creates a partner API key with the partner scopes', async () => {
    const keys = await q(`SELECT name, scopes FROM api_keys WHERE org_id = (SELECT id FROM organizations WHERE code = 'ACME')`);
    expect(keys).toHaveLength(1);
    expect([...keys[0].scopes].sort()).toEqual(['cases:read', 'cases:write', 'claims:read', 'materials:read', 'patients:read']);
  });

  it('shows the cases to the partner and to K Line', async () => {
    const admin = await new Client(app).full('admin@acme.demo');
    const list = await admin.call('GET', '/api/cases?pageSize=100');
    expect(list.json.items).toHaveLength(18);
    const kl = await (await new Client(app).full('admin@kline.demo')).call('GET', '/api/console/cases?pageSize=100');
    expect(kl.status).toBe(200);
    expect(kl.json.total).toBeGreaterThanOrEqual(18);
  });
});
