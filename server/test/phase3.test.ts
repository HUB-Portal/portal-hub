import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { config } from '../src/config';
import { seedDemo } from '../src/demo/seed';
import { createApiKey } from '../src/auth/apikeys';
import { runDueJobs, scheduleDailyJobs } from '../src/worker';
import { runRetention } from '../src/services/retention';
import { Client, cubeStl, createDemoUser, giveOrgLogo, orgIdOf, trimLine } from './helpers';

let app: FastifyInstance;
let acmeId: string;
let up: Client; // Acme uploader
let admin: Client; // Acme admin
let klAdmin: Client; // K Line administrator
let svcKey: string;
let partnerKey: string;

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let ipCounter = 1;

/** A fresh sign in counts as a recent authenticator code, so tests that need "no step up" age it first. */
const expireStepUp = (email: string) => q(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL`, [email]);

/** Calls the factory API with a bearer key (no session). */
async function svc(method: string, url: string, body?: unknown, key: string = svcKey) {
  const res = await app.inject({ method: method as any, url, payload: body as any, headers: { authorization: `Bearer ${key}` }, remoteAddress: `10.9.0.${ipCounter++ % 250}` });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* binary */
  }
  return { status: res.statusCode, json, res };
}

const NAME = 'Marc Alonso'; // synthetic patient name that must never reach the factory API

async function newCase(c: Client, body: Record<string, unknown> = {}) {
  const r = await c.call('POST', '/api/cases', { caseId: `P3-${Math.random().toString(36).slice(2, 8)}`, ...body });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.case as any;
}

/** A case with two upper and one lower aligner, submitted and routed. */
async function readyCase(opts: { instructions?: string } = {}) {
  const c = await newCase(up, { patientName: NAME, instructions: opts.instructions ?? 'Leave the attachments as designed.' });
  const stl1 = cubeStl(50, 'model one');
  const stl2 = cubeStl(45, 'model two');
  const low = cubeStl(40, 'model low');
  const f1 = await up.uploadFile(c.id, 'U01.stl', stl1);
  await up.uploadFile(c.id, 'U01.pts', trimLine());
  const f2 = await up.uploadFile(c.id, 'U02.stl', stl2);
  const f3 = await up.uploadFile(c.id, 'L01.stl', low);
  const sub = await up.call('POST', `/api/cases/${c.id}/submit`, { acknowledgeWarnings: true });
  expect(sub.status, JSON.stringify(sub.json)).toBe(200);
  expect(sub.json.case.status).toBe('ready');
  return { id: c.id as string, ref: c.ref as string, files: { u1: { id: f1.fileId, data: stl1 }, u2: { id: f2.fileId, data: stl2 }, l1: { id: f3.fileId, data: low } } };
}

const ev = (id: string, ref: string, code: string, extra: Record<string, unknown> = {}) => ({ event_id: id, case_ref: ref, stage_code: code, occurred_at: new Date().toISOString(), ...extra });
const caseRow = async (id: string) => (await q('SELECT * FROM cases WHERE id = $1', [id]))[0];

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  up = await new Client(app).full('upload@acme.demo');
  admin = await new Client(app).full('admin@acme.demo');
  klAdmin = await new Client(app).full('admin@kline.demo');
  const k = await klAdmin.call('POST', '/api/service-keys', { name: 'Test factory system', scopes: ['mes:intake', 'mes:files', 'mes:events'], expiresInDays: 30 });
  expect(k.status, JSON.stringify(k.json)).toBe(201);
  svcKey = k.json.key;
  const pk = await tx({ orgId: acmeId, bypass: false }, (c) => createApiKey(c, { orgId: acmeId, orgKind: 'partner', name: 'partner test', scopes: ['cases:read', 'cases:write', 'patients:read'], expiresInDays: 30 }));
  partnerKey = pk.key;
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('migration and seed', () => {
  it('seeds the default stage map and keeps the phase 1 tenant rules', async () => {
    const rows = await q('SELECT mes_code, target FROM mes_stage_map ORDER BY mes_code');
    expect(rows.length).toBe(15);
    expect(rows.find((r) => r.mes_code === 'SHIP')!.target).toBe('shipped');
    // the app role cannot read the stage map without the K Line bypass
    const asPartner = await tx({ orgId: acmeId, bypass: false }, async (c) => (await c.query('SELECT count(*)::int AS n FROM mes_stage_map')).rows[0].n);
    expect(asPartner).toBe(0);
  });
});

describe('the full factory flow', () => {
  let k: Awaited<ReturnType<typeof readyCase>>;

  it('lists a routed standard case for the factory without patient names, with hashes that match', async () => {
    k = await readyCase();
    // a direct manufacturing case is never listed
    await q(`UPDATE cases SET manufacturing_mode = 'standard' WHERE id = $1`, [k.id]);
    const r = await svc('GET', '/api/mes/v1/intake?site=PT-CHV');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const item = r.json.cases.find((x: any) => x.ref === k.ref);
    expect(item).toBeTruthy();
    expect(item).toMatchObject({
      partner: { code: 'ACME', name: 'Acme Aligners' },
      kind: 'new',
      priority: 'normal',
      site: 'PT-CHV',
      spec_version: null,
      notes: 'Leave the attachments as designed.',
      aligner_counts: { upper: 2, lower: 1, templates: 0 },
      items: [],
    });
    expect(item.acknowledged_warnings).toEqual(expect.any(Array));
    expect(item.expected_ship_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(item.bags.map((b: any) => b.aligner)).toEqual(['U01', 'U02', 'L01']);
    expect(item.bags[0].barcode).toBe(`${k.ref} U01`);
    // no patient name anywhere in what the factory sees, and no original file names
    expect(JSON.stringify(r.json)).not.toMatch(/Marc|Alonso/);
    const u1 = item.files.find((f: any) => f.id === k.files.u1.id);
    expect(u1).toMatchObject({ name: 'upper/U01.stl', kind: 'stl', arch: 'upper', step: 1, template: false, bytes: k.files.u1.data.length, sha256: sha(k.files.u1.data) });
    expect(u1.download_url).toBe(`${config.publicUrl}/api/mes/v1/files/${k.files.u1.id}`);
    // another site sees nothing of it
    const other = await svc('GET', '/api/mes/v1/intake?site=EG-CFZ');
    expect(other.json.cases.find((x: any) => x.ref === k.ref)).toBeUndefined();
    // One audit entry per intake call, in K Line's own log: how many cases and the first references, no entry per case
    const log = await klAdmin.call('GET', '/api/audit?limit=200&action=mes.');
    const entries = log.json.entries.filter((e: any) => e.action === 'mes.intake_read');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e: any) => e.targetId === null && Array.isArray(e.details.refs) && typeof e.details.cases === 'number')).toBe(true);
    expect(entries.some((e: any) => e.actorLabel === 'K Line service' && e.details.refs.includes(k.ref))).toBe(true);
    // The partner's own access log does not get a row per poll, but still shows every file the factory system downloads (see the next tests)
    const mine = await admin.call('GET', '/api/audit?limit=200&action=mes.');
    expect(mine.json.entries.some((e: any) => e.action === 'mes.intake_read')).toBe(false);
  });

  it('serves byte identical files, checks them against the stored hash, and audits each download to the partner', async () => {
    for (const f of Object.values(k.files)) {
      const r = await svc('GET', `/api/mes/v1/files/${f.id}`);
      expect(r.status).toBe(200);
      expect(r.res.headers['content-disposition']).toMatch(/^attachment/);
      expect(r.res.headers['x-content-type-options']).toBe('nosniff');
      // the download name is canonical, never the partner's own file name
      expect(String(r.res.headers['content-disposition'])).toMatch(/[UL]0[12]\.stl/);
      expect(Buffer.compare(r.res.rawPayload, f.data)).toBe(0);
      const stored = (await q('SELECT meta FROM files WHERE id = $1', [f.id]))[0].meta.sha256;
      expect(sha(r.res.rawPayload)).toBe(stored);
    }
    const log = await admin.call('GET', '/api/audit?limit=200&action=file.download');
    const mine = log.json.entries.filter((e: any) => e.actorLabel === 'K Line service' && e.details.caseId === k.id);
    expect(mine.length).toBe(3);
    expect(JSON.stringify(log.json)).not.toMatch(/Marc|Alonso/);
    // unknown files and files of cases that are not routed are not served
    expect((await svc('GET', `/api/mes/v1/files/${'0'.repeat(8)}-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it('acknowledges a case once and stores the factory case number', async () => {
    const a = await svc('POST', `/api/mes/v1/cases/${k.ref}/ack`, { mes_case_id: 'MES-1001' });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const row = await caseRow(k.id);
    expect(row).toMatchObject({ status: 'received', stage: 'received', mes_case_id: 'MES-1001' });
    expect(row.received_at).toBeTruthy();
    // again: harmless; with another number: refused
    const again = await svc('POST', `/api/mes/v1/cases/${k.ref}/ack`, { mes_case_id: 'MES-1001' });
    expect(again.status).toBe(200);
    expect(again.json.already).toBe(true);
    expect((await svc('POST', `/api/mes/v1/cases/${k.ref}/ack`, { mes_case_id: 'MES-9' })).status).toBe(409);
    expect((await svc('POST', `/api/mes/v1/cases/ACME-999999/ack`, { mes_case_id: 'MES-2' })).status).toBe(404);
    // it left the intake list
    const list = await svc('GET', '/api/mes/v1/intake');
    expect(list.json.cases.find((x: any) => x.ref === k.ref)).toBeUndefined();
  });

  it('applies events once, reports duplicates, unknown codes and out of order events, and books the shipment', async () => {
    const t0 = Date.now();
    const events = [
      ev('e-1', k.ref, 'PRINT'),
      ev('e-1', k.ref, 'PRINT'), // duplicate in the same call
      ev('e-2', k.ref, 'MYSTERY'), // unknown code
      ev('e-3', k.ref, 'RECEIVED'), // older stage
      ev('e-4', k.ref, 'THERMO'),
      ev('e-5', k.ref, 'SHIP'), // shipped without details
      { event_id: 'e-6', mes_case_id: 'MES-1001', stage_code: 'trim', occurred_at: new Date().toISOString() }, // lower case code, looked up by the factory number
      ev('e-7', 'ACME-999999', 'PRINT'), // no such case
      { event_id: 'e-8', stage_code: 'PRINT' }, // invalid
    ];
    const r = await svc('POST', '/api/mes/v1/events', { events });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const out = r.json.results as any[];
    expect(out.map((x) => x.outcome)).toEqual(['applied', 'duplicate', 'error', 'ignored', 'applied', 'error', 'applied', 'error', 'error']);
    expect(out[2].message).toMatch(/stage map/);
    expect(out[5].message).toMatch(/carrier/i);
    expect(JSON.stringify(out)).not.toMatch(/Marc|Alonso/);
    let row = await caseRow(k.id);
    expect(row).toMatchObject({ status: 'in_production', stage: 'trimming' });
    expect(row.started_at).toBeTruthy();

    // the same call again changes nothing: applied and ignored events are duplicates now, errors are tried again
    const again = await svc('POST', '/api/mes/v1/events', { events: [events[0], events[3], events[4]] });
    expect(again.json.results.map((x: any) => x.outcome)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    // an event that failed before can be corrected and sent with the same ID
    const shipEv = ev('e-5', k.ref, 'SHIP', { carrier: 'DHL Express', tracking_number: 'JD014600003', aligners_shipped: 24 });
    const ship = await svc('POST', '/api/mes/v1/events', { events: [ev('e-9', k.ref, 'PACK'), shipEv] });
    expect(ship.json.results.map((x: any) => x.outcome)).toEqual(['applied', 'applied']);
    row = await caseRow(k.id);
    expect(row).toMatchObject({ status: 'shipped', stage: 'shipped', carrier: 'DHL Express', tracking: 'JD014600003', aligners_shipped: 24 });
    expect(row.shipped_at).toBeTruthy();
    expect(row.finished_at).toBeTruthy();
    // purge_after = shipped_at + retention (24 months by default)
    const months = (new Date(row.purge_after).getTime() - new Date(row.shipped_at).getTime()) / (30.44 * 86_400_000);
    expect(months).toBeGreaterThan(23.5);
    expect(months).toBeLessThan(24.5);
    expect(new Date(row.shipped_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(row.shipped_at).getTime()).toBeGreaterThan(t0 - 1000);

    const del = await svc('POST', '/api/mes/v1/events', { events: [ev('e-10', k.ref, 'DELIVERED')] });
    expect(del.json.results[0].outcome).toBe('applied');
    row = await caseRow(k.id);
    expect(row).toMatchObject({ status: 'delivered', stage: 'delivered' });
    expect(row.delivered_at).toBeTruthy();
    // a late event for an earlier stage is ignored, never a step back
    expect((await svc('POST', '/api/mes/v1/events', { events: [ev('e-11', k.ref, 'QC')] })).json.results[0].outcome).toBe('ignored');
    expect((await caseRow(k.id)).status).toBe('delivered');

    // too many events in one call
    const many = await svc('POST', '/api/mes/v1/events', { events: Array.from({ length: 501 }, (_, i) => ev(`bulk-${i}`, k.ref, 'PRINT')) });
    expect(many.status).toBe(400);
    expect(many.json.code).toBe('too_many_events');
  });

  it('logs every outcome without patient data, and the partner sees the stepper, source labels and notifications', async () => {
    const logs = await q('SELECT external_id, outcome, payload, message FROM mes_events');
    expect(new Set(logs.map((l) => l.outcome))).toEqual(new Set(['applied', 'duplicate', 'ignored', 'error']));
    expect(JSON.stringify(logs)).not.toMatch(/Marc|Alonso/);
    // applied and ignored events keep their event ID; errors and duplicates do not reserve it
    expect(logs.filter((l) => l.external_id === 'e-1').length).toBe(1);

    const d = await up.call('GET', `/api/cases/${k.id}`);
    expect(d.status).toBe(200);
    expect(d.json.case).toMatchObject({ status: 'delivered', stage: 'delivered', stageLabel: 'Delivered', carrier: 'DHL Express', trackingNumber: 'JD014600003' });
    expect(d.json.case.stepper.map((s: any) => s.id)).toEqual(['draft', 'submitted', 'production', 'shipped']);
    expect(d.json.case.stepper.map((s: any) => s.state)).toEqual(['done', 'done', 'done', 'current']);
    expect(d.json.case.simpleStatus).toBe('shipped');
    const staged = d.json.events.filter((e: any) => e.type === 'stage_reported');
    expect(staged.length).toBeGreaterThanOrEqual(5);
    expect(staged.every((e: any) => e.sourceLabel === 'Factory system')).toBe(true);
    expect(d.json.events.find((e: any) => e.type === 'submitted').sourceLabel).toBe('Partner');
    expect(d.json.case.expectedShipDate).toBe(d.json.case.dueDate);

    const n = await up.call('GET', '/api/notifications');
    expect(n.status).toBe(200);
    expect(n.json.unread).toBeGreaterThanOrEqual(5);
    expect(n.json.items.length).toBeLessThanOrEqual(50);
    const shipped = n.json.items.find((x: any) => x.kind === 'case_shipped');
    expect(shipped.title).toBe('Shipped');
    expect(shipped.body).toBe(`Case ${k.ref}`);
    expect(JSON.stringify(n.json)).not.toMatch(/Marc|Alonso/);
    // every active partner user is told, and only in their own organisation
    const both = await admin.call('GET', '/api/notifications');
    expect(both.json.unread).toBeGreaterThanOrEqual(5);
    expect((await klAdmin.call('GET', '/api/notifications')).json.items.find((x: any) => x.data?.ref === k.ref && x.kind === 'case_shipped')).toBeUndefined();
    const first = n.json.items[0].id;
    const marked = await up.call('POST', '/api/notifications/read', { ids: [first] });
    expect(marked.json.marked).toBe(1);
    expect((await up.call('GET', '/api/notifications')).json.unread).toBe(n.json.unread - 1);
    const all = await up.call('POST', '/api/notifications/read', { all: true });
    expect(all.status).toBe(200);
    expect((await up.call('GET', '/api/notifications')).json.unread).toBe(0);
    // reading someone else's notification changes nothing
    const adminNotes = (await admin.call('GET', '/api/notifications')).json.items;
    expect((await up.call('POST', '/api/notifications/read', { ids: [adminNotes[0].id] })).json.marked).toBe(0);
  });
});

describe('factory case numbers', () => {
  it('reports a clash of factory case numbers as an error and leaves the case alone', async () => {
    const a = await readyCase();
    const b = await readyCase();
    expect((await svc('POST', `/api/mes/v1/cases/${a.ref}/ack`, { mes_case_id: 'MES-CLASH-1' })).status).toBe(200);
    // another case may not take the same number, by ack or by event
    expect((await svc('POST', `/api/mes/v1/cases/${b.ref}/ack`, { mes_case_id: 'MES-CLASH-1' })).status).toBe(409);
    const r = await svc('POST', '/api/mes/v1/events', { events: [ev('clash-1', b.ref, 'PRINT', { mes_case_id: 'MES-CLASH-1' })] });
    expect(r.json.results[0]).toMatchObject({ outcome: 'error', message: 'The event could not be processed.' });
    expect(await caseRow(b.id)).toMatchObject({ status: 'ready', stage: null, mes_case_id: null });
    // the event ID stays free, so a corrected event can be sent with it
    const fixed = await svc('POST', '/api/mes/v1/events', { events: [ev('clash-1', b.ref, 'PRINT', { mes_case_id: 'MES-CLASH-2' })] });
    expect(fixed.json.results[0].outcome).toBe('applied');
    expect(await caseRow(b.id)).toMatchObject({ status: 'in_production', mes_case_id: 'MES-CLASH-2' });
    // a later event may name the case by its factory number
    const byNumber = await svc('POST', '/api/mes/v1/events', { events: [{ event_id: 'clash-2', mes_case_id: 'MES-CLASH-2', stage_code: 'THERMO', occurred_at: new Date().toISOString() }] });
    expect(byNumber.json.results[0].outcome).toBe('applied');
    // and by the partner code with the partner's own case ID
    const pc = (await caseRow(b.id)).partner_case_id as string;
    const byPartner = await svc('POST', '/api/mes/v1/events', { events: [{ event_id: 'clash-3', partner_code: 'acme', partner_case_id: pc.toLowerCase(), stage_code: 'TRIM', occurred_at: new Date().toISOString() }] });
    expect(byPartner.json.results[0].outcome).toBe('applied');
    expect((await caseRow(b.id)).stage).toBe('trimming');
  });
});

describe('hold and cancel from the factory', () => {
  it('puts a case on hold with a reason the partner can read, and takes it back after a resubmit', async () => {
    const k = await readyCase();
    const h = await svc('POST', '/api/mes/v1/events', { events: [ev('h-1', k.ref, 'HOLD', { hold_reason: 'The lower model has a hole near the molar.' })] });
    expect(h.json.results[0].outcome).toBe('applied');
    const d = await up.call('GET', `/api/cases/${k.id}`);
    expect(d.json.case).toMatchObject({ status: 'on_hold', holdReason: 'The lower model has a hole near the molar.' });
    expect(d.json.events.map((e: any) => e.type)).toContain('on_hold');
    // the partner fixes the file and submits again
    const del = await up.call('DELETE', `/api/files/${k.files.l1.id}`);
    expect(del.status).toBe(200);
    await up.uploadFile(k.id, 'L01.stl', cubeStl(41, 'fixed model'));
    const re = await up.call('POST', `/api/cases/${k.id}/submit`, { acknowledgeWarnings: true });
    expect(re.status, JSON.stringify(re.json)).toBe(200);
    // Back to K Line for a review, never straight to ready: a held case cannot be pushed back into production by the partner.
    expect(re.json.case).toMatchObject({ status: 'submitted', holdReason: null, stage: null });
    expect((await up.call('GET', `/api/cases/${k.id}`)).json.events.map((e: any) => e.type)).toContain('resubmitted');
    const again = await klAdmin.call('POST', `/api/cases/${k.id}/route`, { siteCode: 'PT-CHV' });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.case.status).toBe('ready');
    // a hold without a reason still gets a default reason
    const h2 = await svc('POST', '/api/mes/v1/events', { events: [ev('h-2', k.ref, 'HOLD')] });
    expect(h2.json.results[0].outcome).toBe('applied');
    expect((await caseRow(k.id)).hold_reason).toMatch(/on hold/);
    // a second hold is ignored
    expect((await svc('POST', '/api/mes/v1/events', { events: [ev('h-3', k.ref, 'HOLD')] })).json.results[0].outcome).toBe('ignored');
  });

  it('cancels a case and sets the purge date 30 days ahead', async () => {
    const k = await readyCase();
    const r = await svc('POST', '/api/mes/v1/events', { events: [ev('c-1', k.ref, 'CANCEL')] });
    expect(r.json.results[0].outcome).toBe('applied');
    const row = await caseRow(k.id);
    expect(row.status).toBe('cancelled');
    const days = (new Date(row.purge_after).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    // a shipped case cannot be cancelled by an event
    const s = await readyCase();
    await svc('POST', '/api/mes/v1/events', { events: [ev('c-2', s.ref, 'SHIP', { carrier: 'UPS', tracking_number: '1Z999', aligners_shipped: 3 })] });
    expect((await svc('POST', '/api/mes/v1/events', { events: [ev('c-3', s.ref, 'CANCEL')] })).json.results[0].outcome).toBe('ignored');
    expect((await caseRow(s.id)).status).toBe('shipped');
  });
});

describe('CSV import', () => {
  it('imports events with per row results and is safe to repeat', async () => {
    const k = await readyCase();
    // times shortly before now: the case was created a moment ago and an event cannot be older than the case by more than a day
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const csv = [
      'event_id,case_ref,partner_code,partner_case_id,mes_case_id,stage_code,occurred_at,carrier,tracking_number,aligners_shipped,hold_reason',
      `csv-1,${k.ref},,,,PRINT,${at(4)},,,,`,
      `csv-2,${k.ref},,,,BOGUS,${at(3)},,,,`,
      `,${k.ref},,,,TRIM,${at(2)},,,,`,
      `csv-4,${k.ref},,,,SHIP,${at(1)},"DHL, Express",JD5,12,`,
    ].join('\r\n');
    const r = await klAdmin.call('POST', '/api/mes/events/import', { csv });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.results.map((x: any) => [x.row, x.outcome])).toEqual([[2, 'applied'], [3, 'error'], [4, 'applied'], [5, 'applied']]);
    expect(r.json.summary).toEqual({ total: 4, applied: 3, ignored: 0, error: 1, duplicate: 0 });
    const row = await caseRow(k.id);
    expect(row).toMatchObject({ status: 'shipped', carrier: 'DHL, Express', tracking: 'JD5', aligners_shipped: 12 });
    const ev1 = (await up.call('GET', `/api/cases/${k.id}`)).json.events.filter((e: any) => e.type === 'stage_reported');
    expect(ev1.every((e: any) => e.sourceLabel === 'Factory system')).toBe(true);
    // the same file again: rows with an event ID and the row with the derived ID are duplicates
    const twice = await klAdmin.call('POST', '/api/mes/events/import', { csv });
    expect(twice.json.results.map((x: any) => x.outcome)).toEqual(['duplicate', 'error', 'duplicate', 'duplicate']);
    // also accepted as raw text/csv
    const raw = await app.inject({
      method: 'POST', url: '/api/mes/events/import', payload: csv, remoteAddress: klAdmin.ip,
      headers: { 'content-type': 'text/csv', cookie: klAdmin.cookie, 'x-csrf-token': klAdmin.csrf },
    });
    expect(raw.statusCode).toBe(200);
    // a file without the needed columns, and the event log
    expect((await klAdmin.call('POST', '/api/mes/events/import', { csv: 'a,b\n1,2' })).json.code).toBe('missing_column');
    const log = await klAdmin.call('GET', '/api/mes/events?outcome=error');
    expect(log.status).toBe(200);
    expect(log.json.items.length).toBeGreaterThan(0);
    expect(log.json.items.every((i: any) => i.outcome === 'error')).toBe(true);
    const all = await klAdmin.call('GET', '/api/mes/events?page=1&pageSize=5');
    expect(all.json.items.length).toBe(5);
    expect(all.json.total).toBeGreaterThan(10);
    expect(all.json.items[0]).toEqual(expect.objectContaining({ source: expect.any(String), outcome: expect.any(String), receivedAt: expect.any(String) }));
    expect((await klAdmin.call('GET', '/api/mes/events?outcome=weird')).status).toBe(400);
  });
});

describe('stage map', () => {
  it('can be read and edited, and edits take effect', async () => {
    const before = await klAdmin.call('GET', '/api/mes/stage-map');
    expect(before.status).toBe(200);
    expect(before.json.items.find((i: any) => i.code === 'PRINT')).toMatchObject({ target: 'printing' });
    const svcMap = await svc('GET', '/api/mes/v1/stage-map');
    expect(svcMap.json.stage_map.length).toBe(before.json.items.length);
    const put = await klAdmin.call('PUT', '/api/mes/stage-map', { items: [...before.json.items, { code: 'x-ray', target: 'quality_check', note: 'Scan' }, { code: 'NOISE', target: 'ignore', note: '' }] });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json.items.find((i: any) => i.code === 'X-RAY')).toMatchObject({ target: 'quality_check' });
    const k = await readyCase();
    const r = await svc('POST', '/api/mes/v1/events', { events: [ev('m-1', k.ref, 'X-RAY'), ev('m-2', k.ref, 'NOISE')] });
    expect(r.json.results.map((x: any) => x.outcome)).toEqual(['applied', 'ignored']);
    expect((await caseRow(k.id)).stage).toBe('quality_check');
    expect((await klAdmin.call('PUT', '/api/mes/stage-map', { items: [{ code: 'X', target: 'moon' }] })).status).toBe(400);
    expect((await klAdmin.call('PUT', '/api/mes/stage-map', { items: [] })).status).toBe(400);
    // put the map back
    expect((await klAdmin.call('PUT', '/api/mes/stage-map', { items: before.json.items })).status).toBe(200);
    expect((await klAdmin.call('GET', '/api/mes/stage-map')).json.items.length).toBe(before.json.items.length);
  });
});

describe('manual stage update', () => {
  it('moves forward with an actor, books the shipment and refuses steps back', async () => {
    const k = await readyCase();
    const s1 = await klAdmin.call('POST', `/api/cases/${k.id}/stage`, { stage: 'printing', note: 'Started early' });
    expect(s1.status, JSON.stringify(s1.json)).toBe(200);
    expect(s1.json.case).toMatchObject({ status: 'in_production', stage: 'printing' });
    const back = await klAdmin.call('POST', `/api/cases/${k.id}/stage`, { stage: 'received' });
    expect(back.status).toBe(409);
    expect(back.json.code).toBe('stage_not_allowed');
    const noShip = await klAdmin.call('POST', `/api/cases/${k.id}/stage`, { stage: 'shipped' });
    expect(noShip.status).toBe(400);
    expect(noShip.json.code).toBe('shipping_details_required');
    const ship = await klAdmin.call('POST', `/api/cases/${k.id}/stage`, { stage: 'shipped', carrier: 'FedEx', trackingNumber: 'FX123', alignersShipped: 24 });
    expect(ship.status).toBe(200);
    expect(ship.json.case).toMatchObject({ status: 'shipped', carrier: 'FedEx', trackingNumber: 'FX123' });
    expect((await caseRow(k.id)).purge_after).toBeTruthy();
    const d = await up.call('GET', `/api/cases/${k.id}`);
    const e = d.json.events.filter((x: any) => x.type === 'stage');
    expect(e.length).toBe(2);
    expect(e.every((x: any) => x.sourceLabel === 'K Line')).toBe(true);
    expect(e[0].data.note).toBe('Started early');
    // a draft or submitted case cannot be moved
    const draft = await newCase(up);
    expect((await klAdmin.call('POST', `/api/cases/${draft.id}/stage`, { stage: 'printing' })).status).toBe(409);
    expect((await klAdmin.call('POST', `/api/cases/${k.id}/stage`, { stage: 'teleport' })).status).toBe(400);
    // the audit trail names the case organisation
    const log = await admin.call('GET', '/api/audit?limit=100&action=case.stage');
    expect(log.json.entries.some((x: any) => x.targetId === k.id)).toBe(true);
  });
});

describe('intake: route, hold and release', () => {
  async function submittedCase() {
    await q(`UPDATE organizations SET settings = settings || '{"manual_review": true}'::jsonb WHERE id = $1`, [acmeId]);
    try {
      const c = await newCase(up, { patientName: NAME });
      await up.uploadFile(c.id, 'U01.stl', cubeStl(50));
      const sub = await up.call('POST', `/api/cases/${c.id}/submit`, {});
      expect(sub.status, JSON.stringify(sub.json)).toBe(200);
      expect(sub.json.case.status).toBe('submitted');
      return c as any;
    } finally {
      await q(`UPDATE organizations SET settings = settings || '{"manual_review": false}'::jsonb WHERE id = $1`, [acmeId]);
    }
  }

  it('lists the three tabs, routes a case and sets the due date', async () => {
    const c = await submittedCase();
    const review = await klAdmin.call('GET', '/api/intake?tab=review');
    expect(review.status).toBe(200);
    const item = review.json.items.find((x: any) => x.id === c.id);
    expect(item.orgName).toBe('Acme Aligners');
    expect(item.sites.map((s: any) => s.code)).toEqual(['EG-CFZ', 'PT-CHV']);
    expect(item.sites.every((s: any) => s.allowed === (s.code === 'PT-CHV'))).toBe(true); // Egypt needs SCCs for a partner in Portugal
    expect(JSON.stringify(review.json)).not.toMatch(/Alonso/);
    const routed = await klAdmin.call('POST', `/api/cases/${c.id}/route`, { siteCode: 'PT-CHV' });
    expect(routed.status, JSON.stringify(routed.json)).toBe(200);
    expect(routed.json.case).toMatchObject({ status: 'ready', siteCode: 'PT-CHV' });
    expect(routed.json.case.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dow = new Date(routed.json.case.dueDate + 'T00:00:00Z').getUTCDay();
    expect([0, 6]).not.toContain(dow); // business days
    expect((await klAdmin.call('GET', '/api/intake?tab=ready')).json.items.some((x: any) => x.id === c.id)).toBe(true);
    expect((await klAdmin.call('GET', '/api/intake?tab=review')).json.items.some((x: any) => x.id === c.id)).toBe(false);
    expect((await up.call('GET', `/api/cases/${c.id}`)).json.events.map((e: any) => e.type)).toContain('routed');
    // the partner is told
    expect((await up.call('GET', '/api/notifications')).json.items.some((n: any) => n.kind === 'case_routed' && n.data.ref === c.ref)).toBe(true);
    // routing again from ready re-routes without changing the dates; a bad tab is refused
    expect((await klAdmin.call('POST', `/api/cases/${c.id}/route`, { siteCode: 'PT-CHV' })).status).toBe(200);
    expect((await klAdmin.call('GET', '/api/intake?tab=nope')).status).toBe(400);
  });

  it('refuses routing outside the EEA without SCCs, and to sites the partner does not have', async () => {
    const c = await submittedCase();
    const blocked = await klAdmin.call('POST', `/api/cases/${c.id}/route`, { siteCode: 'EG-CFZ' });
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe('transfer_blocked');
    expect((await caseRow(c.id)).status).toBe('submitted');
    const notTheirs = await klAdmin.call('POST', `/api/cases/${c.id}/route`, { siteCode: 'MX-TIJ' });
    expect(notTheirs.status).toBe(400);
    expect(notTheirs.json.code).toBe('invalid_site');
    await q(`INSERT INTO agreements (org_id, type, signed_at, signed_by) VALUES ($1, 'scc', current_date, 'Test')`, [acmeId]);
    try {
      const ok = await klAdmin.call('POST', `/api/cases/${c.id}/route`, { siteCode: 'EG-CFZ' });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(ok.json.case.siteCode).toBe('EG-CFZ');
    } finally {
      await q(`DELETE FROM agreements WHERE org_id = $1 AND type = 'scc'`, [acmeId]);
    }
    // an inactive site cannot be chosen
    const c2 = await submittedCase();
    await q(`UPDATE sites SET active = false WHERE code = 'PT-CHV'`);
    try {
      expect((await klAdmin.call('POST', `/api/cases/${c2.id}/route`, { siteCode: 'PT-CHV' })).json.code).toBe('invalid_site');
    } finally {
      await q(`UPDATE sites SET active = true WHERE code = 'PT-CHV'`);
    }
  });

  it('holds a case with a reason, the partner resubmits, and a release sends it back to review', async () => {
    const c = await submittedCase();
    expect((await klAdmin.call('POST', `/api/cases/${c.id}/hold`, { reason: 'no' })).status).toBe(400);
    const h = await klAdmin.call('POST', `/api/cases/${c.id}/hold`, { reason: 'Trim line for the upper step 1 is open.' });
    expect(h.status, JSON.stringify(h.json)).toBe(200);
    expect(h.json.case).toMatchObject({ status: 'on_hold', holdReason: 'Trim line for the upper step 1 is open.' });
    expect((await klAdmin.call('GET', '/api/intake?tab=hold')).json.items.some((x: any) => x.id === c.id)).toBe(true);
    const d = await up.call('GET', `/api/cases/${c.id}`);
    expect(d.json.case.holdReason).toBe('Trim line for the upper step 1 is open.');
    expect(d.json.events.find((e: any) => e.type === 'on_hold').sourceLabel).toBe('K Line');
    expect((await up.call('GET', '/api/notifications')).json.items.some((n: any) => n.kind === 'case_on_hold' && n.data.ref === c.ref)).toBe(true);
    // the partner resubmits (manual review is on again for this step)
    await q(`UPDATE organizations SET settings = settings || '{"manual_review": true}'::jsonb WHERE id = $1`, [acmeId]);
    try {
      await up.uploadFile(c.id, 'U01_T.stl', cubeStl(50));
      const re = await up.call('POST', `/api/cases/${c.id}/submit`, { acknowledgeWarnings: true });
      expect(re.status, JSON.stringify(re.json)).toBe(200);
      expect(re.json.case).toMatchObject({ status: 'submitted', holdReason: null });
      expect((await up.call('GET', `/api/cases/${c.id}`)).json.events.map((e: any) => e.type)).toContain('resubmitted');
    } finally {
      await q(`UPDATE organizations SET settings = settings || '{"manual_review": false}'::jsonb WHERE id = $1`, [acmeId]);
    }
    // hold again, then release
    expect((await klAdmin.call('POST', `/api/cases/${c.id}/release`, {})).json.code).toBe('not_on_hold');
    expect((await klAdmin.call('POST', `/api/cases/${c.id}/hold`, { reason: 'Waiting for a call back.' })).status).toBe(200);
    const rel = await klAdmin.call('POST', `/api/cases/${c.id}/release`, {});
    expect(rel.status, JSON.stringify(rel.json)).toBe(200);
    expect(rel.json.case).toMatchObject({ status: 'submitted', holdReason: null, siteCode: null });
    const types = (await up.call('GET', `/api/cases/${c.id}`)).json.events.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(['on_hold', 'released', 'resubmitted']));
  });

  it('holds a case that is already at the factory, and the factory number stays', async () => {
    const k = await readyCase();
    await svc('POST', `/api/mes/v1/cases/${k.ref}/ack`, { mes_case_id: 'MES-HOLD-1' });
    const h = await klAdmin.call('POST', `/api/cases/${k.id}/hold`, { reason: 'Partner asked us to wait.' });
    expect(h.status, JSON.stringify(h.json)).toBe(200);
    expect((await caseRow(k.id)).mes_case_id).toBe('MES-HOLD-1');
    // events for a case on hold are errors (the factory should not be working on it)
    const r = await svc('POST', '/api/mes/v1/events', { events: [ev('hh-1', k.ref, 'PRINT')] });
    expect(r.json.results[0]).toMatchObject({ outcome: 'error' });
  });
});

describe('service keys and partner keys stay apart', () => {
  it('keeps service keys off partner routes and partner keys off the factory API', async () => {
    const k = await readyCase();
    // service key on partner routes
    for (const [m, u] of [['GET', '/api/cases'], ['GET', `/api/cases/${k.id}`], ['GET', `/api/files/${k.files.u1.id}/download`], ['GET', '/api/org'], ['POST', '/api/cases'], ['POST', '/api/uploads'], ['GET', '/api/notifications'], ['GET', '/api/console/overview']] as const) {
      const r = await svc(m, u, m === 'POST' ? {} : undefined);
      expect([401, 403], `${m} ${u} -> ${r.status}`).toContain(r.status);
    }
    // partner key on the factory API
    for (const [m, u] of [['GET', '/api/mes/v1/intake'], ['GET', `/api/mes/v1/files/${k.files.u1.id}`], ['GET', '/api/mes/v1/stage-map']] as const) {
      const r = await svc(m, u, undefined, partnerKey);
      expect(r.status, `${m} ${u}`).toBe(403);
    }
    expect((await svc('POST', '/api/mes/v1/events', { events: [] }, partnerKey)).status).toBe(403);
    expect((await svc('POST', `/api/mes/v1/cases/${k.ref}/ack`, { mes_case_id: 'X-1' }, partnerKey)).status).toBe(403);
    // the partner key still works where it should
    const list = await svc('GET', '/api/cases', undefined, partnerKey);
    expect(list.status).toBe(200);
    // no key at all, a bad key, and a signed in person (session) are all refused
    expect((await app.inject({ method: 'GET', url: '/api/mes/v1/intake' })).statusCode).toBe(401);
    expect((await svc('GET', '/api/mes/v1/intake', undefined, 'kph_000000000000_' + 'A'.repeat(43))).status).toBe(401);
    expect((await klAdmin.call('GET', '/api/mes/v1/intake')).status).toBe(403);
    expect((await klAdmin.call('POST', '/api/mes/v1/events', { events: [] })).status).toBe(403);
    // a key with a single scope only does that
    await klAdmin.stepUp('admin@kline.demo');
    const only = await klAdmin.call('POST', '/api/service-keys', { name: 'Events only', scopes: ['mes:events'], expiresInDays: 10 });
    expect(only.status).toBe(201);
    expect((await svc('GET', '/api/mes/v1/intake', undefined, only.json.key)).status).toBe(403);
    expect((await svc('GET', `/api/mes/v1/files/${k.files.u1.id}`, undefined, only.json.key)).status).toBe(403);
    expect((await svc('GET', '/api/mes/v1/stage-map', undefined, only.json.key)).status).toBe(200);
    // revoking a key stops it at once
    const del = await klAdmin.call('DELETE', `/api/service-keys/${only.json.id}`);
    expect(del.status).toBe(200);
    expect((await svc('GET', '/api/mes/v1/stage-map', undefined, only.json.key)).status).toBe(401);
  });

  it('shows keys without secrets, needs step up to write, and allowed networks are enforced', async () => {
    const list = await klAdmin.call('GET', '/api/service-keys');
    expect(list.status).toBe(200);
    expect(list.json.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(list.json)).not.toContain(svcKey);
    expect(JSON.stringify(list.json)).not.toMatch(/secret_hash|secretHash/);
    expect(list.json.items.find((i: any) => svcKey.startsWith(i.prefix))).toMatchObject({ status: 'active', scopes: ['mes:intake', 'mes:files', 'mes:events'] });
    // no fresh authenticator code: refused
    const fresh = await new Client(app).full('admin@kline.demo');
    await expireStepUp('admin@kline.demo');
    const noStep = await fresh.call('POST', '/api/service-keys', { name: 'No step up', scopes: ['mes:intake'], expiresInDays: 10 });
    expect(noStep.status).toBe(403);
    expect(noStep.json.code).toBe('step_up_required');
    expect((await fresh.call('DELETE', `/api/service-keys/${list.json.items[0].id}`)).json.code).toBe('step_up_required');
    await fresh.stepUp('admin@kline.demo');
    expect((await fresh.call('POST', '/api/service-keys', { name: 'Bad', scopes: ['cases:read'], expiresInDays: 10 })).status).toBe(400);
    expect((await fresh.call('POST', '/api/service-keys', { name: 'Bad', scopes: ['mes:intake'], expiresInDays: 731 })).status).toBe(400);
    expect((await fresh.call('POST', '/api/service-keys', { name: 'Bad net', scopes: ['mes:intake'], expiresInDays: 10, cidrs: ['nope'] })).json.code).toBe('invalid_cidr');
    const net = await fresh.call('POST', '/api/service-keys', { name: 'Office only', scopes: ['mes:events'], expiresInDays: 10, cidrs: ['192.0.2.0/24'] });
    expect(net.status).toBe(201);
    const inside = await app.inject({ method: 'GET', url: '/api/mes/v1/stage-map', headers: { authorization: `Bearer ${net.json.key}` }, remoteAddress: '192.0.2.44' });
    expect(inside.statusCode).toBe(200);
    const outside = await app.inject({ method: 'GET', url: '/api/mes/v1/stage-map', headers: { authorization: `Bearer ${net.json.key}` }, remoteAddress: '198.51.100.9' });
    expect(outside.statusCode).toBe(401);
    // audit entries for creation and revocation carry no key material
    const log = (await fresh.call('GET', '/api/audit?limit=100&action=service_key.')).json.entries;
    expect(log.some((e: any) => e.action === 'service_key.created')).toBe(true);
    expect(JSON.stringify(log)).not.toContain(net.json.key);
  });
});

describe('permissions are checked on every route', () => {
  it('lets K Line administrators and each partner role do only what their permissions allow', async () => {
    const someCase = (await q<{ id: string }>(`SELECT id FROM cases WHERE status = 'ready' LIMIT 1`))[0]!.id;
    const partnerId = acmeId;
    type Row = [string, string, unknown, Record<string, number>];
    // [method, url, body, expected status per client name]; 403 means refused by permission
    const table: Row[] = [
      ['GET', '/api/console/overview', undefined, { klAdmin: 200, admin: 403, up: 403 }],
      ['GET', '/api/console/cases', undefined, { klAdmin: 200, admin: 403, up: 403 }],
      ['GET', '/api/intake', undefined, { klAdmin: 200, admin: 403, up: 403 }],
      ['GET', '/api/service-keys', undefined, { klAdmin: 200, admin: 403, up: 403 }],
      ['GET', '/api/staff', undefined, { klAdmin: 200, admin: 403, up: 403 }],
      ['GET', '/api/sites', undefined, { klAdmin: 200, admin: 403, up: 403 }],
      ['GET', '/api/partners', undefined, { klAdmin: 200, admin: 403, up: 403 }],
      ['GET', `/api/partners/${partnerId}`, undefined, { klAdmin: 200, admin: 403, up: 403 }],
      ['GET', '/api/mes/stage-map', undefined, { klAdmin: 200, admin: 403, up: 403 }],
      ['GET', '/api/mes/events', undefined, { klAdmin: 200, admin: 403, up: 403 }],
      ['POST', '/api/mes/events/import', { csv: 'stage_code,occurred_at\nPRINT,2026-01-01' }, { admin: 403, up: 403 }],
      ['GET', '/api/audit/verify', undefined, { klAdmin: 200, admin: 403, up: 403 }],
      ['POST', `/api/cases/${someCase}/stage`, { stage: 'nonsense' }, { klAdmin: 400, admin: 403, up: 403 }],
      ['GET', `/api/cases/${someCase}/bags.csv`, undefined, { klAdmin: 200, admin: 403, up: 403 }],
      ['GET', '/api/notifications', undefined, { klAdmin: 200, admin: 200, up: 200 }],
    ];
    const clients: Record<string, Client> = { klAdmin, admin, up };
    for (const [m, u, body, expected] of table) {
      for (const [name, code] of Object.entries(expected)) {
        const r = await clients[name]!.call(m, u, body);
        expect(r.status, `${name} ${m} ${u}`).toBe(code);
      }
    }
    // partner admins can neither write staff nor sites
    expect((await admin.call('POST', '/api/staff/invite', { email: 'x@kline.demo', name: 'X', roles: ['kl_admin'] })).status).toBe(403);
    expect((await admin.call('POST', '/api/sites', { code: 'DE-BER', name: 'Berlin', country: 'DE' })).status).toBe(403);
  });

  it('does not let a partner user see K Line staff or other people through the staff routes', async () => {
    const r = await admin.call('GET', '/api/team');
    expect(r.status).toBe(200);
    expect(r.json.users.every((u: any) => /@acme\.demo$/.test(u.email))).toBe(true);
    const staffUser = (await q<{ id: string }>(`SELECT id FROM users WHERE email = 'admin@kline.demo'`))[0]!.id;
    await admin.stepUp('admin@acme.demo');
    expect((await admin.call('POST', `/api/team/${staffUser}/disable`, {})).status).toBe(404);
    expect((await admin.call('POST', `/api/team/${staffUser}/roles`, { roles: ['admin'] })).status).toBe(404);
  });
});

describe('audit entries for K Line access are visible to the partner', () => {
  it('records downloads, name reveals, case views and name searches against the partner organisation', async () => {
    const k = await readyCase();
    const dl = await klAdmin.call('GET', `/api/files/${k.files.u1.id}/download`);
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.res.rawPayload, k.files.u1.data)).toBe(0);
    expect((await klAdmin.call('POST', `/api/cases/${k.id}/reveal-name`, {})).json.patientName).toBe(NAME);
    expect((await klAdmin.call('GET', `/api/console/cases/${k.id}`)).status).toBe(200);
    expect((await klAdmin.call('GET', `/api/console/cases?search=${encodeURIComponent(NAME)}`)).json.items.some((x: any) => x.id === k.id)).toBe(true);
    const pkg = await klAdmin.call('GET', `/api/cases/${k.id}/package.zip`);
    expect(pkg.status).toBe(200);

    const log = (await admin.call('GET', '/api/audit?limit=200')).json.entries as any[];
    const mine = log.filter((e) => e.targetId === k.id || e.details?.caseId === k.id);
    const labels = (action: string) => mine.filter((e) => e.action === action).map((e) => e.actorLabel);
    expect(labels('file.download').length).toBeGreaterThan(0);
    expect(labels('case.name_revealed').length).toBeGreaterThan(0);
    expect(labels('case.viewed').length).toBe(1); // views are logged at most once per person and case within ten minutes
    expect(labels('case.name_searched').length).toBeGreaterThan(0);
    expect(labels('case.package_downloaded').length).toBeGreaterThan(0);
    // the partner sees K Line staff as a role, not by name
    expect(log.filter((e) => e.action === 'file.download' && e.details?.caseId === k.id).every((e) => e.actorLabel === 'K Line staff')).toBe(true);
    expect(JSON.stringify(log)).not.toMatch(/Alonso/);
    // and a repeat view within ten minutes adds nothing
    await klAdmin.call('GET', `/api/console/cases/${k.id}`);
    const again = (await admin.call('GET', '/api/audit?limit=200&action=case.viewed')).json.entries.filter((e: any) => e.targetId === k.id);
    expect(again.length).toBe(1);
    // partner staff opening their own case are not logged as K Line access
    await admin.call('GET', `/api/cases/${k.id}`);
    expect((await admin.call('GET', '/api/audit?limit=200&action=case.viewed')).json.entries.filter((e: any) => e.targetId === k.id).length).toBe(1);
  });
});

describe('bag labels', () => {
  it('manages the layout, keeps personal data out by default and out of the factory feed', async () => {
    const def = await admin.call('GET', '/api/org/bag-layout');
    expect(def.status).toBe(200);
    expect(def.json.layout).toMatchObject({ widthMm: 76, heightMm: 127, marginMm: 4, wearDays: 14, showPatientName: false });
    expect(def.json.printsPersonalData).toBe(false);
    expect(def.json.tokens).toContain('patient_initials');
    expect(def.json.preview.length).toBe(6);
    expect((await up.call('GET', '/api/org/bag-layout')).status).toBe(403); // org.edit is needed

    const bad = await admin.call('PUT', '/api/org/bag-layout', { ...def.json.layout, lines: ['{nonsense}'] });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('invalid_bag_layout');
    expect((await admin.call('PUT', '/api/org/bag-layout', { ...def.json.layout, lines: Array(9).fill('x') })).status).toBe(400);
    expect((await admin.call('PUT', '/api/org/bag-layout', { ...def.json.layout, lines: ['x'.repeat(61)] })).status).toBe(400);
    expect((await admin.call('PUT', '/api/org/bag-layout', { ...def.json.layout, marginMm: 99 })).status).toBe(400);

    const k = await readyCase();
    // default layout: the CSV holds one row per bag and no personal data
    const csv = await klAdmin.call('GET', `/api/cases/${k.id}/bags.csv`);
    expect(csv.status).toBe(200);
    expect(csv.res.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.res.headers['content-disposition']).toContain(`${k.ref}-bags.csv`);
    const rows = csv.res.body.trim().split('\r\n');
    expect(rows.length).toBe(4); // header and three bags
    expect(rows[0]).toMatch(/^aligner,arch,step,barcode,line_1/);
    expect(rows[1]).toMatch(new RegExp(`^U01,upper,1,${k.ref} U01,`));
    expect(csv.res.body).not.toMatch(/Marc|Alonso/);

    // a layout that prints the patient name needs a fresh authenticator code
    const withName = { ...def.json.layout, lines: ['{brand}', '{patient_name}', '{aligner}'], showPatientName: true };
    const fresh = await new Client(app).full('admin@acme.demo');
    await expireStepUp('admin@acme.demo');
    const refused = await fresh.call('PUT', '/api/org/bag-layout', withName);
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('step_up_required');
    await fresh.stepUp('admin@acme.demo');
    const saved = await fresh.call('PUT', '/api/org/bag-layout', withName);
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.printsPersonalData).toBe(true);
    try {
      // the bag file for staff has the name (audited as a name reveal) ...
      const named = await klAdmin.call('GET', `/api/cases/${k.id}/bags.csv`);
      expect(named.res.body).toContain(NAME);
      const log = (await admin.call('GET', '/api/audit?limit=200')).json.entries as any[];
      expect(log.some((e) => e.action === 'case.bags_csv' && e.details.personalData === true && e.details.ref === k.ref)).toBe(true);
      expect(log.some((e) => e.action === 'case.name_revealed' && e.details.via === 'bags_csv')).toBe(true);
      // ... but the factory feed never carries it
      const feed = await svc('GET', '/api/mes/v1/intake?site=PT-CHV');
      const item = feed.json.cases.find((x: any) => x.ref === k.ref);
      expect(item.bag_personal_data).toBe(true);
      expect(item.bags[0].lines).toEqual(['', '', 'U01']);
      expect(JSON.stringify(feed.json)).not.toMatch(/Marc|Alonso/);
    } finally {
      await fresh.stepUp('admin@acme.demo');
      const back = await fresh.call('PUT', '/api/org/bag-layout', def.json.layout);
      expect(back.status).toBe(200);
    }
    // a direct manufacturing case ordering more lines and a wear time change is stored per organisation
    const custom = await admin.call('PUT', '/api/org/bag-layout', { ...def.json.layout, wearDays: 7, lines: ['{ref}', '{aligner} {step_padded}/{total_steps}'] });
    expect(custom.json.layout.wearDays).toBe(7);
    expect((await admin.call('GET', '/api/org/bag-layout')).json.layout.lines).toEqual(['{ref}', '{aligner} {step_padded}/{total_steps}']);
    await admin.call('PUT', '/api/org/bag-layout', def.json.layout);
  });
});

describe('sites, staff and partners', () => {
  it('manages sites with the code pattern', async () => {
    const bad = await klAdmin.call('POST', '/api/sites', { code: 'berlin', name: 'Berlin', country: 'DE' });
    expect(bad.status).toBe(400);
    const made = await klAdmin.call('POST', '/api/sites', { code: 'de-ber', name: 'Berlin', country: 'de', city: 'Berlin' });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect(made.json.site).toMatchObject({ code: 'DE-BER', country: 'DE', inEea: true, hasAdequacy: false, active: true });
    expect((await klAdmin.call('POST', '/api/sites', { code: 'DE-BER', name: 'Again', country: 'DE' })).status).toBe(409);
    const patched = await klAdmin.call('PATCH', `/api/sites/${made.json.site.id}`, { name: 'Berlin Mitte', in_eea: false, has_adequacy: true, active: false });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
    expect(patched.json.site).toMatchObject({ name: 'Berlin Mitte', inEea: false, hasAdequacy: true, active: false });
    const list = await klAdmin.call('GET', '/api/sites');
    expect(list.json.items.map((s: any) => s.code)).toEqual(expect.arrayContaining(['PT-CHV', 'DE-BER']));
    expect((await klAdmin.call('PATCH', `/api/sites/${made.json.site.id}`, { code: 'PT-CHV' })).status).toBe(409);
    expect((await klAdmin.call('PATCH', `/api/sites/${made.json.site.id}`, { code: 'x' })).status).toBe(400);
  });

  it('invites and manages staff with step up', async () => {
    const fresh = await new Client(app).full('admin@kline.demo');
    await expireStepUp('admin@kline.demo');
    const noStep = await fresh.call('POST', '/api/staff/invite', { email: 'new.staff@kline.demo', name: 'Nina New', roles: ['kl_admin'] });
    expect(noStep.json.code).toBe('step_up_required');
    await fresh.stepUp('admin@kline.demo');
    const inv = await fresh.call('POST', '/api/staff/invite', { email: 'new.staff@kline.demo', name: 'Nina New', roles: ['kl_admin'] });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    expect((await fresh.call('POST', '/api/staff/invite', { email: 'new.staff@kline.demo', name: 'Again', roles: ['kl_admin'] })).status).toBe(409);
    expect((await fresh.call('POST', '/api/staff/invite', { email: 'partner.role@kline.demo', name: 'Wrong', roles: ['admin'] })).status).toBe(400);
    // the old K Line staff roles no longer exist: an administrator is the only K Line role
    expect((await fresh.call('POST', '/api/staff/invite', { email: 'old.role@kline.demo', name: 'Wrong', roles: ['kl_intake'] })).status).toBe(400);
    expect((await fresh.call('POST', '/api/staff/invite', { email: 'bad.site@kline.demo', name: 'Wrong', roles: ['kl_admin'], siteIds: ['00000000-0000-4000-8000-000000000000'] })).json.code).toBe('invalid_site');
    const staff = await fresh.call('GET', '/api/staff');
    const nina = staff.json.users.find((u: any) => u.email === 'new.staff@kline.demo');
    expect(nina).toMatchObject({ status: 'invited', roles: ['kl_admin'], siteCodes: [] });
    expect(staff.json.users.every((u: any) => /@kline\.demo$/.test(u.email))).toBe(true);
    expect(staff.json.users.find((u: any) => u.email === 'admin@kline.demo').isYou).toBe(true);
    const mail = await q(`SELECT payload FROM jobs WHERE kind = 'email.send' AND payload->>'to' = 'new.staff@kline.demo'`);
    expect(mail.length).toBe(1);

    expect((await fresh.call('POST', `/api/staff/${nina.id}/roles`, { roles: ['kl_intake'] })).status).toBe(400);
    expect((await fresh.call('POST', `/api/staff/${nina.id}/roles`, { roles: ['kl_admin'], siteIds: [] })).status).toBe(200);
    expect((await q(`SELECT roles, site_ids FROM users WHERE id = $1`, [nina.id]))[0]).toMatchObject({ roles: ['kl_admin'], site_ids: [] });
    expect((await fresh.call('POST', `/api/staff/${nina.id}/disable`, {})).status).toBe(200);
    expect((await fresh.call('POST', `/api/staff/${nina.id}/enable`, {})).status).toBe(200);
    expect((await fresh.call('POST', `/api/staff/${nina.id}/reset-mfa`, {})).status).toBe(200);
    expect((await fresh.call('POST', `/api/staff/${nina.id}/resend-invite`, {})).status).toBe(200);
    // not oneself, not the last administrator, not people of other organisations
    const me = staff.json.users.find((u: any) => u.isYou).id;
    expect((await fresh.call('POST', `/api/staff/${me}/disable`, {})).json.code).toBe('self_change');
    const other = await q<{ id: string }>(`SELECT id FROM users WHERE email = 'upload@acme.demo'`);
    expect((await fresh.call('POST', `/api/staff/${other[0]!.id}/disable`, {})).status).toBe(404);
    const otherAdmin = await createDemoUser(await orgIdOf('KLINE'), 'second.admin@kline.demo', 'Second Admin', ['kl_admin']);
    expect((await fresh.call('POST', `/api/staff/${otherAdmin}/roles`, { roles: ['kl_finance'] })).status).toBe(400);
    expect((await q('SELECT roles FROM users WHERE id = $1', [otherAdmin]))[0].roles).toEqual(['kl_admin']);
  });

  it('gives K Line a minimal partner console with gates, agreements, sites and activation', async () => {
    const fab = await tx(SYSTEM, async (c) => (await c.query(`INSERT INTO organizations (kind, name, code, country, status) VALUES ('partner', 'Fabrikam Dental Lab', 'FABRIK', 'DE', 'onboarding') RETURNING id`)).rows[0].id as string);
    const list = await klAdmin.call('GET', '/api/partners');
    expect(list.status).toBe(200);
    const row = list.json.items.find((p: any) => p.id === fab);
    expect(row).toMatchObject({ name: 'Fabrikam Dental Lab', status: 'onboarding', dpaOnFile: false, sccOnFile: false, usersCount: 0 });
    expect(list.json.items.find((p: any) => p.code === 'ACME')).toMatchObject({ status: 'active', dpaOnFile: true, siteCodes: ['EG-CFZ', 'PT-CHV'] });

    // cannot be activated without a DPA and a site
    expect((await klAdmin.call('POST', `/api/partners/${fab}/activate`, {})).json.code).toBe('dpa_required');
    await klAdmin.stepUp('admin@kline.demo');
    const noDate = await klAdmin.call('POST', `/api/partners/${fab}/agreements`, { kind: 'dpa', signedAt: 'yesterday' });
    expect(noDate.status).toBe(400);
    const dpa = await klAdmin.call('POST', `/api/partners/${fab}/agreements`, { kind: 'dpa', signedAt: '2026-09-01', reference: 'DPA-77', notes: 'Signed copy in the contract folder' });
    expect(dpa.status, JSON.stringify(dpa.json)).toBe(201);
    expect((await klAdmin.call('POST', `/api/partners/${fab}/agreements`, { kind: 'scc', signedAt: '2026-09-01', expiresAt: '2026-08-01' })).status).toBe(400);
    expect((await klAdmin.call('POST', `/api/partners/${fab}/activate`, {})).json.code).toBe('site_required');
    const sitesPut = await klAdmin.call('PUT', `/api/partners/${fab}/sites`, { siteCodes: ['PT-CHV', 'EG-CFZ'], defaultSiteCode: 'PT-CHV' });
    expect(sitesPut.status, JSON.stringify(sitesPut.json)).toBe(200);
    expect(sitesPut.json.defaultSiteCode).toBe('PT-CHV');
    expect(sitesPut.json.sites.find((s: any) => s.code === 'EG-CFZ')).toMatchObject({ allowed: false }); // German partner, Egypt, no SCC
    expect((await klAdmin.call('PUT', `/api/partners/${fab}/sites`, { siteCodes: ['PT-CHV'], defaultSiteCode: 'EG-CFZ' })).status).toBe(400);
    expect((await klAdmin.call('PUT', `/api/partners/${fab}/sites`, { siteCodes: ['ZZ-NOP'] })).status).toBe(400);
    const settings = await klAdmin.call('PATCH', `/api/partners/${fab}/settings`, { retentionMonths: 12, slaDays: 5, requirePts: true, manualReview: true, defaultSiteCode: 'PT-CHV' });
    expect(settings.status, JSON.stringify(settings.json)).toBe(200);
    expect(settings.json).toMatchObject({ retentionMonths: 12, settings: { slaDays: 5, requirePts: true, manualReview: true }, defaultSiteCode: 'PT-CHV' });
    for (const bad of [{ retentionMonths: 0 }, { retentionMonths: 181 }, { slaDays: 0 }, { defaultSiteCode: 'MX-TIJ' }]) {
      expect((await klAdmin.call('PATCH', `/api/partners/${fab}/settings`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    // the company logo is mandatory: without one the gate stays closed
    const noLogo = await klAdmin.call('GET', `/api/partners/${fab}`);
    expect(noLogo.json.gates).toMatchObject({ hasLogo: false, canActivate: false, blockers: [{ code: 'logo_required', message: 'Company logo is required.' }] });
    expect((await klAdmin.call('POST', `/api/partners/${fab}/activate`, {})).json.code).toBe('logo_required');
    await giveOrgLogo(fab);
    const detail = await klAdmin.call('GET', `/api/partners/${fab}`);
    expect(detail.json).toMatchObject({ name: 'Fabrikam Dental Lab', status: 'onboarding', retentionMonths: 12, defaultSiteCode: 'PT-CHV', hasLogo: true, gates: { dpaOnFile: true, sccOnFile: false, hasSite: true, hasLogo: true, canActivate: true } });
    expect(detail.json.agreements[0]).toMatchObject({ kind: 'dpa', reference: 'DPA-77', signedAt: '2026-09-01', revoked: false });
    const act = await klAdmin.call('POST', `/api/partners/${fab}/activate`, {});
    expect(act.status).toBe(200);
    expect((await q('SELECT status FROM organizations WHERE id = $1', [fab]))[0].status).toBe('active');
    // agreements can be withdrawn (step up), which closes the gate again
    const rm = await klAdmin.call('DELETE', `/api/partners/${fab}/agreements/${dpa.json.id}`);
    expect(rm.status).toBe(200);
    expect((await klAdmin.call('GET', `/api/partners/${fab}`)).json.gates.dpaOnFile).toBe(false);
    expect((await klAdmin.call('DELETE', `/api/partners/${fab}/agreements/${dpa.json.id}`)).status).toBe(200); // harmless twice
    expect((await klAdmin.call('DELETE', `/api/partners/${fab}/agreements/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    // suspend
    const sus = await klAdmin.call('POST', `/api/partners/${fab}/suspend`, {});
    expect(sus.json.status).toBe('suspended');
    expect((await klAdmin.call('GET', `/api/partners/${'00000000-0000-4000-8000-000000000000'}`)).status).toBe(404);
    // a fresh authenticator code is needed to record or withdraw an agreement
    const noStep = await new Client(app).full('admin@kline.demo');
    await expireStepUp('admin@kline.demo');
    expect((await noStep.call('POST', `/api/partners/${fab}/agreements`, { kind: 'dpa', signedAt: '2026-09-01' })).json.code).toBe('step_up_required');
    // the partner sees what K Line changed in their audit log
    const acmeLog = await klAdmin.call('GET', `/api/audit?orgId=${fab}&limit=50`);
    expect(acmeLog.json.entries.map((e: any) => e.action)).toEqual(expect.arrayContaining(['partner.activated', 'partner.suspended', 'partner.agreement_added']));
  });
});

describe('audit verification', () => {
  it('lets a K Line administrator verify the chain through the API', async () => {
    const r = await klAdmin.call('GET', '/api/audit/verify');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ ok: true, firstBadSeq: null });
    expect(r.json.checked).toBeGreaterThan(50);
    expect((await admin.call('GET', '/api/audit/verify')).status).toBe(403);
    // the app role still cannot call the owner only functions
    await expect(tx(SYSTEM, (c) => c.query('SELECT * FROM kph_audit_verify()'))).rejects.toMatchObject({ code: '42501' });
    await expect(tx(SYSTEM, (c) => c.query('SELECT kph_audit_trim(now())'))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('overview', () => {
  it('reports the tiles the console needs', async () => {
    const o = await klAdmin.call('GET', '/api/console/overview');
    expect(o.status).toBe(200);
    expect(o.json).toEqual(expect.objectContaining({
      intakeWaiting: expect.any(Number), inProduction: expect.any(Number), shippedLast7Days: expect.any(Number), openClaims: 0, lateCases: expect.any(Number), newSignups: 1, // Contoso Smile registered, confirmed and waits for review (seed)
    }));
    expect(o.json.readyForMes).toEqual({ count: expect.any(Number), waitingOver4h: expect.any(Number) });
    expect(o.json.mesHealth.events24h).toBeGreaterThan(10);
    expect(o.json.mesHealth.errors24h).toBeGreaterThan(0);
    expect(o.json.mesHealth.lastEventAt).toMatch(/^\d{4}-/);
    expect(o.json.security).toEqual({ failedSignIns24h: expect.any(Number), malwareFiles24h: expect.any(Number) });
    expect(o.json.siteLoad.find((s: any) => s.siteCode === 'PT-CHV')).toMatchObject({ ready: expect.any(Number), inProduction: expect.any(Number) });
    const acme = o.json.partners.find((p: any) => p.code === 'ACME');
    expect(acme).toMatchObject({ status: 'active', dpaOnFile: true, sccOnFile: false, siteCodes: ['EG-CFZ', 'PT-CHV'] });
    // late: a routed case past its due date counts
    const before = o.json.lateCases;
    const k = await readyCase();
    await q(`UPDATE cases SET due_date = current_date - 2 WHERE id = $1`, [k.id]);
    expect((await klAdmin.call('GET', '/api/console/overview')).json.lateCases).toBe(before + 1);
    await q(`UPDATE cases SET ready_at = now() - interval '5 hours' WHERE id = $1`, [k.id]);
    expect((await klAdmin.call('GET', '/api/console/overview')).json.readyForMes.waitingOver4h).toBeGreaterThanOrEqual(1);
    // the console case list filters
    const c = await klAdmin.call('GET', `/api/console/cases?status=ready&orgId=${acmeId}&siteCode=PT-CHV&mode=standard&search=${k.ref}`);
    expect(c.json.items.map((x: any) => x.id)).toEqual([k.id]);
    expect(c.json.items[0]).toMatchObject({ orgName: 'Acme Aligners', orgCode: 'ACME' });
    const d = await klAdmin.call('GET', `/api/console/cases/${k.id}`);
    expect(d.json.routing).toMatchObject({ siteCode: 'PT-CHV', canRoute: true, partnerCountry: 'PT' });
    expect(d.json.routing.sites.length).toBe(2);
    expect(d.json.case.id).toBe(k.id);
  });
});

describe('retention', () => {
  it('purges files and names at purge_after, keeps the production record, and cleans old records', async () => {
    const k = await readyCase({ instructions: 'Please mind the gap.' });
    const prefixes = (await q<{ storage_prefix: string }>('SELECT storage_prefix FROM files WHERE case_id = $1', [k.id])).map((r) => r.storage_prefix);
    expect(prefixes.length).toBe(4);
    for (const p of prefixes) expect(existsSync(path.join(config.storageDir, ...p.split('/')))).toBe(true);
    await svc('POST', '/api/mes/v1/events', { events: [ev('r-1', k.ref, 'SHIP', { carrier: 'DHL', tracking_number: 'JD1', aligners_shipped: 5 })] });
    const before = await caseRow(k.id);
    expect(before.purge_after).toBeTruthy();
    // not yet due: nothing happens
    const first = await runRetention();
    expect((await caseRow(k.id)).purged_at).toBeNull();
    expect(first.casesPurged).toBe(0);

    await q(`UPDATE cases SET purge_after = now() - interval '1 hour' WHERE id = $1`, [k.id]);
    const report = await runRetention();
    expect(report.casesPurged).toBe(1);
    const row = await caseRow(k.id);
    expect(row.purged_at).toBeTruthy();
    expect(row).toMatchObject({ patient_enc: null, patient_bidx: null, notes_enc: null, patient_first_enc: null, patient_last_enc: null, status: 'shipped', carrier: 'DHL', tracking: 'JD1' });
    expect(row.patient_bidxs).toEqual([]);
    expect(row.ref).toBe(k.ref);
    expect(row.partner_case_id).toBeTruthy();
    expect(row.aligners_upper).toBe(2);
    const files = await q('SELECT * FROM files WHERE case_id = $1', [k.id]);
    expect(files.length).toBe(4);
    for (const f of files) {
      expect(f).toMatchObject({ state: 'purged', name_enc: null, wrapped_key: null, nonce_prefix: null, storage_prefix: null });
      expect(f.purged_at).toBeTruthy();
    }
    for (const p of prefixes) expect(existsSync(path.join(config.storageDir, ...p.split('/')))).toBe(false);
    expect((await q('SELECT count(*)::int AS n FROM file_chunks WHERE file_id = ANY($1::uuid[])', [files.map((f) => f.id)]))[0].n).toBe(0);
    // the partner still sees the case, without names, files or download
    const d = await up.call('GET', `/api/cases/${k.id}`);
    expect(d.status).toBe(200);
    expect(d.json.case).toMatchObject({ hasPatientName: false, hasInstructions: false, fileCount: 0, status: 'shipped' });
    expect(d.json.files).toEqual([]);
    expect(d.json.events.map((e: any) => e.type)).toContain('purged');
    expect((await up.call('GET', `/api/files/${k.files.u1.id}/download`)).status).toBe(409);
    expect((await svc('GET', `/api/mes/v1/files/${k.files.u1.id}`)).status).toBe(404);
    const log = (await admin.call('GET', '/api/audit?limit=100&action=case.purged')).json.entries;
    expect(log.some((e: any) => e.targetId === k.id && e.actorLabel === 'System')).toBe(true);
    // running it again does nothing more
    expect((await runRetention()).casesPurged).toBe(0);
  });

  it('removes cancelled cases after 30 days, old drafts, abandoned uploads and old records', async () => {
    // a cancelled case (by the partner) 31 days ago
    const c1 = await newCase(up, { patientName: 'Old Cancelled' });
    const f1 = await up.uploadFile(c1.id, 'U01.stl', cubeStl(50));
    expect((await up.call('POST', `/api/cases/${c1.id}/cancel`, {})).status).toBe(200);
    await q(`UPDATE cases SET cancelled_at = now() - interval '31 days', purge_after = NULL WHERE id = $1`, [c1.id]);
    // a draft untouched for 31 days, and a fresh one
    const oldDraft = await newCase(up);
    const fresh = await newCase(up);
    await q(`UPDATE cases SET updated_at = now() - interval '31 days' WHERE id = $1`, [oldDraft.id]);
    // an upload that never finished
    const c3 = await newCase(up);
    const init = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: c3.id, name: 'U01.stl', size: 1000 });
    await q(`UPDATE files SET created_at = now() - interval '3 days' WHERE id = $1`, [init.json.fileId]);
    const fresh2 = await up.call('POST', '/api/uploads', { purpose: 'case', caseId: c3.id, name: 'L01.stl', size: 1000 });
    // old records
    await q(`INSERT INTO dev_mailbox (to_addr, subject, body, created_at) VALUES ('a@b.demo', 's', 'b', now() - interval '15 days'), ('a@b.demo', 's', 'b', now())`);
    await q(`INSERT INTO mes_events (external_id, outcome, received_at) VALUES ('old-evt', 'applied', now() - interval '181 days'), ('new-evt', 'applied', now())`);
    await q(`INSERT INTO notifications (org_id, kind, title, created_at) VALUES ($1, 'x', 'old', now() - interval '181 days'), ($1, 'x', 'new', now())`, [acmeId]);
    await q(`INSERT INTO jobs (kind, status, finished_at) VALUES ('x', 'done', now() - interval '15 days'), ('x', 'failed', now() - interval '1 day')`);
    const u = (await q<{ id: string }>(`SELECT id FROM users WHERE email = 'finance@acme.demo'`))[0]!.id;
    await q(`INSERT INTO sessions (org_id, user_id, token_hash, stage, expires_at) VALUES ($1, $2, 'old-session', 'full', now() - interval '8 days'), ($1, $2, 'recent-session', 'full', now() - interval '1 day')`, [acmeId, u]);
    await q(`INSERT INTO user_tokens (org_id, user_id, kind, token_hash, expires_at) VALUES ($1, $2, 'reset', 'old-token', now() - interval '31 days'), ($1, $2, 'reset', 'recent-token', now() - interval '2 days')`, [acmeId, u]);
    await q(`INSERT INTO oidc_flows (state, nonce, code_verifier, expires_at) VALUES ('old-flow', 'n', 'v', now() - interval '2 days'), ('new-flow', 'n', 'v', now() - interval '1 hour')`);
    const prefixOld = (await q<{ storage_prefix: string }>('SELECT storage_prefix FROM files WHERE id = $1', [f1.fileId]))[0]!.storage_prefix;

    const rep = await runRetention();
    expect(rep.casesPurged).toBeGreaterThanOrEqual(1);
    expect((await caseRow(c1.id)).purged_at).toBeTruthy();
    expect((await caseRow(c1.id)).patient_enc).toBeNull();
    expect(existsSync(path.join(config.storageDir, ...prefixOld.split('/')))).toBe(false);
    expect(rep.draftsDeleted).toBe(1);
    expect((await q('SELECT 1 FROM cases WHERE id = $1', [oldDraft.id])).length).toBe(0);
    expect((await q('SELECT 1 FROM cases WHERE id = $1', [fresh.id])).length).toBe(1);
    expect(rep.abandonedUploads).toBe(1);
    expect((await q('SELECT 1 FROM files WHERE id = $1', [init.json.fileId])).length).toBe(0);
    expect((await q('SELECT 1 FROM files WHERE id = $1', [fresh2.json.fileId])).length).toBe(1);
    expect(rep).toMatchObject({ devMailbox: 1, mesEvents: 1, notifications: 1, oidcFlows: 1 });
    expect(rep.sessions).toBeGreaterThanOrEqual(1);
    expect(rep.userTokens).toBeGreaterThanOrEqual(1);
    expect(rep.jobs).toBeGreaterThanOrEqual(1);
    expect((await q(`SELECT 1 FROM sessions WHERE token_hash = 'recent-session'`)).length).toBe(1);
    expect((await q(`SELECT 1 FROM user_tokens WHERE token_hash = 'recent-token'`)).length).toBe(1);
    expect((await q(`SELECT 1 FROM oidc_flows WHERE state = 'new-flow'`)).length).toBe(1);
    // the audit log is never touched: the chain still verifies
    expect((await klAdmin.call('GET', '/api/audit/verify')).json.ok).toBe(true);
    // bookkeeping
    const runs = await q(`SELECT last_status, last_detail FROM job_runs WHERE name = 'retention'`);
    expect(runs[0].last_status).toBe('ok');
  });

  it('is scheduled once a day and runs as a worker job', async () => {
    await q(`DELETE FROM job_runs WHERE name = 'retention'`);
    expect(await scheduleDailyJobs()).toBe(true);
    expect(await scheduleDailyJobs()).toBe(false); // already claimed within 24 hours
    const queued = await q(`SELECT kind, payload FROM jobs WHERE kind = 'retention' AND status = 'queued'`);
    expect(queued.length).toBe(1);
    expect(queued[0].payload).toEqual({});
    await runDueJobs();
    expect((await q(`SELECT status FROM jobs WHERE kind = 'retention' ORDER BY id DESC LIMIT 1`))[0].status).toBe('done');
    // after a day the slot opens again
    await q(`UPDATE job_runs SET last_run_at = now() - interval '25 hours' WHERE name = 'retention'`);
    expect(await scheduleDailyJobs()).toBe(true);
    await runDueJobs();
  });
});

describe('logs and job payloads stay free of patient data', () => {
  it('holds no patient names in jobs, events, notifications or the event log', async () => {
    const dump = JSON.stringify({
      jobs: await q('SELECT kind, payload, last_error FROM jobs'),
      events: await q('SELECT data FROM case_events'),
      notes: await q('SELECT title, body, data FROM notifications'),
      mes: await q('SELECT payload, message FROM mes_events'),
      audit: await q('SELECT details FROM audit_log'),
    });
    expect(dump).not.toMatch(/Marc|Alonso/);
  });
});
