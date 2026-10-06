import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { registeredJobKinds } from '../src/jobs';
import { runDueJobs, schedulePortalSync } from '../src/worker';
import { insertCase } from '../src/services/cases';
import { PORTAL_SYNC_CAP, portalDate, runPortalSync, splitTracking } from '../src/services/portalSync';
import { FakePortalClient, setPortalClientFactory } from '../src/services/portal';
import { setHookObserver, type HookCall } from '../src/services/webhooks';
import { Client, createDemoUser, orgIdOf } from './helpers';

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);

let app: FastifyInstance;
let acmeId: string;
let contosoId: string;
let up: Client;
let contoso: Client;
let kline: Client;
const fakes: Record<string, FakePortalClient> = {};
const hooks: HookCall[] = [];
let n = 0;

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  contosoId = await tx(SYSTEM, async (c) => (await c.query(`INSERT INTO organizations (kind, name, code, country, status) VALUES ('partner', 'Contoso Smile', 'CONTOSO', 'PT', 'active') RETURNING id`)).rows[0].id);
  await createDemoUser(contosoId, 'admin@contoso.demo', 'Cora Contoso', ['admin']);
  fakes[acmeId] = new FakePortalClient();
  fakes[contosoId] = new FakePortalClient();
  setPortalClientFactory((org) => fakes[org.id] ?? null);
  setHookObserver((h) => hooks.push(h));
  up = await new Client(app).full('upload@acme.demo');
  contoso = await new Client(app).full('admin@contoso.demo');
  kline = await new Client(app).full('admin@kline.demo');
});

afterAll(async () => {
  setPortalClientFactory(undefined);
  setHookObserver(null);
  await app.close();
  await closePools();
});

/** A submitted direct case that the portal already has (as after a successful push). Patient names are distinctive so leaks show. */
async function pushedCase(orgId: string, opts: { status?: string; portal?: Record<string, unknown> } = {}) {
  n++;
  const pid = `9${String(n).padStart(5, '0')}`;
  const fake = fakes[orgId]!;
  const { uuid } = await fake.createCase({ firstName: 'Zelda', lastName: 'Quimby', gender: 2, productType: 0 });
  const id = await tx(SYSTEM, async (c) => {
    const r = await insertCase(c, { orgId, actor: { actorType: 'user', actorId: null }, mode: 'direct', caseId: pid, firstName: 'Zelda', lastName: 'Quimby' });
    await c.query(
      `UPDATE cases SET status = $2, submitted_at = now(), portal_case_uuid = $3, portal_push = $4::jsonb WHERE id = $1`,
      [r.id, opts.status ?? 'submitted', uuid, JSON.stringify({ status: 'pushed', attempts: 1, ...(opts.portal ?? {}) })],
    );
    return r.id;
  });
  return { id, uuid, fake };
}

const row = async (id: string) => (await q('SELECT * FROM cases WHERE id = $1', [id]))[0];
const portalEvents = async (id: string) => q(`SELECT data FROM case_events WHERE case_id = $1 AND type = 'stage' AND data->>'source' = 'portal' ORDER BY created_at, id`, [id]);
const notifCount = async (kind: string) => (await q(`SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND kind = $2`, [acmeId, kind]))[0].n as number;
/** Takes every other open direct case out of the sync, so a test sees only its own cases. */
const quiesce = () => q(`UPDATE cases SET status = 'cancelled' WHERE manufacturing_mode = 'direct' AND status NOT IN ('shipped', 'delivered', 'cancelled')`);
const hooksFor = (id: string) => hooks.filter((h) => h.id === id).map((h) => h.event);

describe('helpers', () => {
  it('splits courier and tracking number', () => {
    expect(splitTracking('DHL 1234567890')).toEqual({ carrier: 'DHL', tracking: '1234567890' });
    expect(splitTracking('DHL Express JD014600003')).toEqual({ carrier: 'DHL Express', tracking: 'JD014600003' });
    expect(splitTracking('1Z999AA10123456784')).toEqual({ carrier: null, tracking: '1Z999AA10123456784' });
    expect(splitTracking('1234 5678 9012')).toEqual({ carrier: null, tracking: '1234 5678 9012' });
    expect(splitTracking('  UPS   1Z999  ')).toEqual({ carrier: 'UPS', tracking: '1Z999' });
    expect(splitTracking('TRACKINGONLY')).toEqual({ carrier: null, tracking: 'TRACKINGONLY' });
    expect(splitTracking('')).toEqual({ carrier: null, tracking: null });
    expect(splitTracking(null)).toEqual({ carrier: null, tracking: null });
  });
  it('reads the date from an ISO datetime', () => {
    expect(portalDate('2026-10-05T00:00:00+00:00')).toBe('2026-10-05');
    expect(portalDate('2026-13-45')).toBeNull();
    expect(portalDate('soon')).toBeNull();
    expect(portalDate(null)).toBeNull();
  });
  it('registers the job kind', () => {
    expect(registeredJobKinds()).toContain('portal.sync');
  });
});

describe('portal status sync', () => {
  it('leaves New and InPlanning as Submitted, with one event for a real change only', async () => {
    const { id, uuid, fake } = await pushedCase(acmeId);
    await runPortalSync({ caseId: id });
    let r = await row(id);
    expect(r.status).toBe('submitted');
    expect(r.portal_push.portalStatus).toBe('New');
    expect(await portalEvents(id)).toHaveLength(0);

    fake.setPortalState(uuid, { status: 'InPlanning' });
    await runPortalSync({ caseId: id });
    await runPortalSync({ caseId: id });
    r = await row(id);
    expect(r.status).toBe('submitted');
    const ev = await portalEvents(id);
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ source: 'portal', portalStatus: 'InPlanning', message: 'Status from the K Line portal: In planning', status: 'submitted' });
    const detail = (await up.call('GET', `/api/cases/${id}`)).json;
    expect(detail.case).toMatchObject({ status: 'submitted', simpleStatus: 'submitted' });
    expect(detail.case.portal).toMatchObject({ portalStatus: 'InPlanning', portalStatusLabel: 'In planning', demo: false });
    expect(detail.case.stepper.find((s: any) => s.state === 'current')).toMatchObject({ id: 'submitted', detail: 'In planning' });
    expect(detail.events.filter((e: any) => e.data?.source === 'portal').every((e: any) => e.sourceLabel === 'K Line portal')).toBe(true);
    expect(hooksFor(id)).toEqual([]);

    for (const status of ['PendingPlanReview', 'PlanRejected']) {
      fake.setPortalState(uuid, { status });
      await runPortalSync({ caseId: id });
      expect((await row(id)).status).toBe('submitted');
    }
    expect((await portalEvents(id)).length).toBe(3);
  });

  it('moves a case to in_production once, with a notification and a webhook, and does nothing the second time', async () => {
    const { id, uuid, fake } = await pushedCase(acmeId);
    fake.setPortalState(uuid, { status: 'InProduction', expectedShippingDate: '2026-10-12T00:00:00+00:00' });
    const before = await notifCount('case_stage');
    const users = (await q(`SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND status = 'active'`, [acmeId]))[0].n as number;
    const first = await runPortalSync();
    expect(first.changed).toBeGreaterThanOrEqual(1);
    const r = await row(id);
    expect(r).toMatchObject({ status: 'in_production', stage: null, due_date: '2026-10-12' });
    expect(r.started_at).toBeTruthy();
    expect(r.shipped_at).toBeNull();
    expect(await portalEvents(id)).toHaveLength(1);
    expect((await portalEvents(id))[0].data).toMatchObject({ portalStatus: 'InProduction', status: 'in_production', from: 'submitted', message: 'Status from the K Line portal: In production' });
    expect(await notifCount('case_stage')).toBe(before + users);
    expect(hooksFor(id)).toEqual(['case.stage_changed']);

    const startedAt = r.started_at;
    const reads = () => fake.calls.filter((c) => c.op === 'getCase' && c.caseUuid === uuid).length;
    const calls = reads();
    await runPortalSync();
    await runPortalSync();
    expect(reads()).toBe(calls + 2); // still watched, but nothing new is written
    expect(await portalEvents(id)).toHaveLength(1);
    expect(await notifCount('case_stage')).toBe(before + users);
    expect(hooksFor(id)).toEqual(['case.stage_changed']);
    expect((await row(id)).started_at).toEqual(startedAt);

    const d = (await up.call('GET', `/api/cases/${id}`)).json.case;
    expect(d).toMatchObject({ status: 'in_production', simpleStatus: 'production' });
    expect(d.stepper.map((s: any) => s.state)).toEqual(['done', 'done', 'current', 'upcoming']);
    expect(d.expectedShipDate).toBe('2026-10-12');
  });

  it('ships a case: tracking split into carrier and number, no more checks afterwards', async () => {
    const { id, uuid, fake } = await pushedCase(acmeId);
    fake.setPortalState(uuid, { status: 'InProduction' });
    await runPortalSync({ caseId: id });
    fake.setPortalState(uuid, { status: 'Shipped', trackingNumber: 'DHL Express JD014600003', expectedShippingDate: '2026-10-20T00:00:00+00:00' });
    const before = await notifCount('case_shipped');
    await runPortalSync({ caseId: id });
    const r = await row(id);
    expect(r).toMatchObject({ status: 'shipped', stage: null, carrier: 'DHL Express', tracking: 'JD014600003', due_date: '2026-10-20' });
    expect(r.shipped_at).toBeTruthy();
    expect(r.started_at).toBeTruthy();
    expect((await portalEvents(id)).map((e) => e.data.portalStatus)).toEqual(['InProduction', 'Shipped']);
    expect((await portalEvents(id))[1].data).toMatchObject({ status: 'shipped', carrier: 'DHL Express', trackingNumber: 'JD014600003' });
    expect(await notifCount('case_shipped')).toBeGreaterThan(before);
    expect(hooksFor(id)).toEqual(['case.stage_changed', 'case.shipped']);

    const reads = () => fake.calls.filter((c) => c.op === 'getCase' && c.caseUuid === uuid).length;
    const calls = reads();
    await runPortalSync();
    expect(reads()).toBe(calls); // shipped cases are no longer watched
    expect(await portalEvents(id)).toHaveLength(2);
    const d = (await up.call('GET', `/api/cases/${id}`)).json.case;
    expect(d).toMatchObject({ status: 'shipped', simpleStatus: 'shipped', carrier: 'DHL Express', trackingNumber: 'JD014600003' });
    expect(d.stepper.map((s: any) => s.state)).toEqual(['done', 'done', 'done', 'current']);
  });

  it('stores a bare tracking number, and picks up a tracking number that arrives after Shipped', async () => {
    const a = await pushedCase(acmeId);
    a.fake.setPortalState(a.uuid, { status: 'Shipped', trackingNumber: '1Z999AA10123456784' });
    await runPortalSync({ caseId: a.id });
    expect(await row(a.id)).toMatchObject({ status: 'shipped', carrier: null, tracking: '1Z999AA10123456784' });

    const b = await pushedCase(acmeId);
    b.fake.setPortalState(b.uuid, { status: 'Shipped', trackingNumber: null });
    await runPortalSync({ caseId: b.id });
    expect(await row(b.id)).toMatchObject({ status: 'shipped', tracking: null });
    b.fake.setPortalState(b.uuid, { trackingNumber: 'UPS 1Z777' });
    await runPortalSync({ caseId: b.id });
    expect(await row(b.id)).toMatchObject({ status: 'shipped', carrier: 'UPS', tracking: '1Z777' });
    expect(await portalEvents(b.id)).toHaveLength(1);
    expect(hooksFor(b.id)).toEqual(['case.shipped']);
  });

  it('does not touch cancelled cases, cases not pushed yet, or the wrong organisation', async () => {
    const cancelled = await pushedCase(acmeId, { status: 'cancelled' });
    const notPushed = await pushedCase(acmeId, { portal: { status: 'pending' } });
    cancelled.fake.setPortalState(cancelled.uuid, { status: 'InProduction' });
    notPushed.fake.setPortalState(notPushed.uuid, { status: 'InProduction' });
    const mine = await pushedCase(acmeId);
    const theirs = await pushedCase(contosoId);
    mine.fake.setPortalState(mine.uuid, { status: 'InProduction' });
    theirs.fake.setPortalState(theirs.uuid, { status: 'Shipped', trackingNumber: 'DHL 555' });
    // Each organisation's cases are read through that organisation's own client only.
    await runPortalSync({ caseId: mine.id });
    expect((await row(mine.id)).status).toBe('in_production');
    expect((await row(theirs.id)).status).toBe('submitted');
    expect(fakes[contosoId]!.calls.filter((c) => c.op === 'getCase' && c.caseUuid === mine.uuid)).toHaveLength(0);
    expect(fakes[acmeId]!.calls.filter((c) => c.op === 'getCase' && c.caseUuid === theirs.uuid)).toHaveLength(0);
    expect((await row(cancelled.id)).status).toBe('cancelled');
    expect((await row(notPushed.id)).status).toBe('submitted');
    expect(fakes[acmeId]!.calls.filter((c) => c.op === 'getCase' && (c.caseUuid === cancelled.uuid || c.caseUuid === notPushed.uuid))).toHaveLength(0);
    await runPortalSync();
    expect((await row(theirs.id))).toMatchObject({ status: 'shipped', tracking: '555', carrier: 'DHL' });
    expect((await row(cancelled.id)).status).toBe('cancelled');
    expect((await row(notPushed.id)).status).toBe('submitted');
  });

  it('carries on after an error on one case and records only a fixed message', async () => {
    await quiesce();
    const a = await pushedCase(acmeId);
    const b = await pushedCase(acmeId);
    const c = await pushedCase(contosoId);
    for (const x of [a, b, c]) x.fake.setPortalState(x.uuid, { status: 'InProduction' });
    fakes[acmeId]!.failNext('getCase', 'server', 1, 503, 0);
    const summary = await runPortalSync();
    expect(summary.failed).toBe(1);
    const rows = await Promise.all([a, b, c].map((x) => row(x.id)));
    expect(rows.filter((r) => r.status === 'in_production')).toHaveLength(2);
    const failed = rows.find((r) => r.status === 'submitted')!;
    expect(failed.portal_push.syncError).toBe('The K Line portal had a problem on its side. (HTTP 503)');
    expect(failed.portal_push.status).toBe('pushed');
    expect(JSON.stringify(failed.portal_push)).not.toMatch(/Zelda|Quimby/);
    const shown = (await up.call('GET', `/api/cases/${failed.id}`)).json.case.portal;
    expect(shown.syncError).toContain('problem on its side');
    // The next run recovers and clears the error.
    await runPortalSync();
    const again = await row(failed.id);
    expect(again.status).toBe('in_production');
    expect(again.portal_push.syncError).toBeUndefined();
  });

  it('records a fixed message for every case of an organisation whose portal is not set up', async () => {
    const x = await pushedCase(acmeId);
    const { config } = await import('../src/config');
    const was = config.portalFake;
    setPortalClientFactory(() => null);
    (config as any).portalFake = false;
    try {
      const s = await runPortalSync({ caseId: x.id });
      expect(s.failed).toBe(1);
      expect((await row(x.id)).portal_push.syncError).toBe('The K Line portal is not set up for this company. Add the address, key and user ID in the portal settings.');
    } finally {
      (config as any).portalFake = was;
      setPortalClientFactory((org) => fakes[org.id] ?? null);
    }
  });

  it('keeps patient data out of events, jobs, notifications, hooks and errors', async () => {
    const x = await pushedCase(acmeId);
    x.fake.setPortalState(x.uuid, { status: 'Shipped', trackingNumber: 'DHL 999' });
    await runPortalSync({ caseId: x.id });
    await pushedCase(acmeId).then((y) => {
      y.fake.failNext('getCase', 'validation', 1, 422);
      return runPortalSync({ caseId: y.id });
    });
    const dump = JSON.stringify([
      await q('SELECT data FROM case_events'),
      await q('SELECT payload, last_error FROM jobs'),
      await q('SELECT title, body, data FROM notifications'),
      await q(`SELECT portal_push FROM cases WHERE portal_push ? 'portalStatus' OR portal_push ? 'syncError'`),
      await q(`SELECT details FROM audit_log WHERE action = 'case.portal_status'`),
      hooks,
    ]);
    expect(dump).not.toMatch(/Zelda|Quimby/);
  });
});

describe('refresh from the portal', () => {
  it('lets a partner refresh their own case and returns the updated case', async () => {
    const x = await pushedCase(acmeId);
    x.fake.setPortalState(x.uuid, { status: 'InProduction' });
    const r = await up.call('POST', `/api/cases/${x.id}/portal/refresh`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.case).toMatchObject({ id: x.id, status: 'in_production', simpleStatus: 'production' });
    expect(r.json.case.portal).toMatchObject({ status: 'pushed', portalStatus: 'InProduction' });
    expect(JSON.stringify(r.json)).not.toMatch(/Zelda|Quimby/);
  });

  it('is limited to the partner’s own organisation, but K Line staff may refresh any case', async () => {
    const x = await pushedCase(acmeId);
    x.fake.setPortalState(x.uuid, { status: 'InProduction' });
    const other = await contoso.call('POST', `/api/cases/${x.id}/portal/refresh`, {});
    expect(other.status).toBe(404);
    expect((await row(x.id)).status).toBe('submitted');
    expect(fakes[acmeId]!.calls.filter((c) => c.caseUuid === x.uuid && c.op === 'getCase').length).toBe(0);
    const staff = await kline.call('POST', `/api/cases/${x.id}/portal/refresh`, {});
    expect(staff.status, JSON.stringify(staff.json)).toBe(200);
    expect(staff.json.case.status).toBe('in_production');
  });

  it('refuses cases that are not direct, or not pushed yet, and needs a session', async () => {
    const std = await up.call('POST', '/api/cases', { caseId: 'STD-REFRESH-1' });
    expect(std.status).toBe(201);
    const a = await up.call('POST', `/api/cases/${std.json.case.id}/portal/refresh`, {});
    expect(a.status).toBe(409);
    expect(a.json.code).toBe('not_direct');
    const pending = await pushedCase(acmeId, { portal: { status: 'pending' } });
    const b = await up.call('POST', `/api/cases/${pending.id}/portal/refresh`, {});
    expect(b.status).toBe(409);
    expect(b.json.code).toBe('not_pushed');
    const anon = await new Client(app).call('POST', `/api/cases/${pending.id}/portal/refresh`, {});
    expect([401, 403]).toContain(anon.status);
  });

  it('shows a fixed error text when the portal cannot be reached', async () => {
    const x = await pushedCase(acmeId);
    fakes[acmeId]!.failNext('getCase', 'network', 1);
    const r = await up.call('POST', `/api/cases/${x.id}/portal/refresh`, {});
    expect(r.status).toBe(200);
    expect(r.json.case.portal.syncError).toBe('The K Line portal could not be reached.');
    expect(r.json.case.status).toBe('submitted');
  });
});

describe('lists by simple status', () => {
  it('groups the raw statuses like the progress bar, for partners and K Line staff', async () => {
    for (const [filter, simple] of [['simple_submitted', 'submitted'], ['simple_production', 'production'], ['simple_shipped', 'shipped']] as const) {
      const r = await up.call('GET', `/api/cases?status=${filter}&pageSize=100`);
      expect(r.status, filter).toBe(200);
      expect(r.json.total, filter).toBeGreaterThan(0);
      expect(r.json.items.every((c: any) => c.simpleStatus === simple), filter).toBe(true);
      const k = await kline.call('GET', `/api/console/cases?status=${filter}&pageSize=100`);
      expect(k.status, filter).toBe(200);
      expect(k.json.items.every((c: any) => c.simpleStatus === simple), filter).toBe(true);
    }
    // the older groups still work
    expect((await up.call('GET', '/api/cases?status=production')).status).toBe(200);
    expect((await up.call('GET', '/api/cases?status=done')).status).toBe(200);
  });
});

describe('schedule and cap', () => {
  it('queues one sync every 10 minutes and never while one is queued or running, and the job runs', async () => {
    await q(`DELETE FROM jobs WHERE kind = 'portal.sync'`);
    await q(`DELETE FROM job_runs WHERE name = 'portal.sync'`);
    await quiesce();
    expect(await schedulePortalSync()).toBe(true);
    expect(await schedulePortalSync()).toBe(false); // slot claimed
    await q(`UPDATE job_runs SET last_run_at = now() - interval '11 minutes' WHERE name = 'portal.sync'`);
    expect(await schedulePortalSync()).toBe(false); // one is still queued
    expect((await q(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'portal.sync'`))[0].n).toBe(1);
    const x = await pushedCase(acmeId);
    x.fake.setPortalState(x.uuid, { status: 'InProduction' });
    await runDueJobs();
    expect((await q(`SELECT status FROM jobs WHERE kind = 'portal.sync'`))[0].status).toBe('done');
    expect((await row(x.id)).status).toBe('in_production');
    expect((await q(`SELECT last_status FROM job_runs WHERE name = 'portal.sync'`))[0].last_status).toBe('ok');
    // The slot was claimed 11 minutes ago in this test, so the next one is due; claiming it again straight away is refused.
    expect(await schedulePortalSync()).toBe(true);
    await q(`UPDATE jobs SET status = 'done' WHERE kind = 'portal.sync'`);
    expect(await schedulePortalSync()).toBe(false); // ran a moment ago
    await q(`DELETE FROM jobs WHERE kind = 'portal.sync'`);
  });

  it('checks at most 200 cases a run and the ones checked longest ago go first', async () => {
    await quiesce();
    const ids: string[] = [];
    for (let i = 0; i < PORTAL_SYNC_CAP + 5; i++) ids.push((await pushedCase(acmeId)).id);
    const first = await runPortalSync();
    expect(first.checked).toBe(PORTAL_SYNC_CAP);
    const unchecked = await q(`SELECT id FROM cases WHERE id = ANY($1::uuid[]) AND portal_push->>'checkedAt' IS NULL`, [ids]);
    expect(unchecked).toHaveLength(5);
    const second = await runPortalSync();
    expect(second.checked).toBe(PORTAL_SYNC_CAP);
    expect((await q(`SELECT id FROM cases WHERE id = ANY($1::uuid[]) AND portal_push->>'checkedAt' IS NULL`, [ids]))).toHaveLength(0);
  }, 120_000);
});
