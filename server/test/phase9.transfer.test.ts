import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { insertCase } from '../src/services/cases';
import { runRetention } from '../src/services/retention';
import { sccOnFile } from '../src/services/transferCheck';
import { TRANSFER_HOLD_REASON, recheckTransfers } from '../src/services/transferGate';
import { canReceive } from '../../shared/geo';
import { Client, cubeStl, orgIdOf } from './helpers';
import { q, readyStandardCase, svcCall, type MadeCase } from './helpers9';

const NAME = 'Gabi Gated';
const FIXED = 'Transfer to this site is no longer covered. K Line will contact you.';

let app: FastifyInstance;
let acmeId: string;
let adminId: string;
let cairoId: string;
let chavesId: string;
let admin: Client;
let uploader: Client;
let klAdmin: Client;
let svcKey: string;

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  adminId = (await q(`SELECT id FROM users WHERE email = 'admin@acme.demo'`))[0].id;
  cairoId = (await q(`SELECT id FROM sites WHERE code = 'EG-CFZ'`))[0].id;
  chavesId = (await q(`SELECT id FROM sites WHERE code = 'PT-CHV'`))[0].id;
  admin = await new Client(app).full('admin@acme.demo');
  uploader = await new Client(app).full('upload@acme.demo');
  klAdmin = await new Client(app).full('admin@kline.demo');
  const k = await klAdmin.call('POST', '/api/service-keys', { name: 'Transfer test factory', scopes: ['mes:intake', 'mes:files', 'mes:events'], expiresInDays: 30 });
  svcKey = k.json.key;
});
afterAll(async () => {
  await app.close();
  await closePools();
});

const setDefaultSite = (siteId: string) => q('UPDATE organizations SET default_site_id = $2 WHERE id = $1', [acmeId, siteId]);
const clearScc = () => q(`DELETE FROM agreements WHERE org_id = $1 AND type = 'scc'`, [acmeId]);
const addScc = (validUntilSql: string | null = null) =>
  q(`INSERT INTO agreements (org_id, type, version, signed_at, signed_by, valid_until) VALUES ($1, 'scc', '1.0', current_date - 30, 'Test', ${validUntilSql ?? 'NULL'})`, [acmeId]);
const caseRow = async (id: string) => (await q('SELECT * FROM cases WHERE id = $1', [id]))[0];
const siteCodeOf = async (id: string) => (await q('SELECT s.code FROM cases c JOIN sites s ON s.id = c.site_id WHERE c.id = $1', [id]))[0]?.code ?? null;

/** A ready case at Cairo (an SCC is on file when it is submitted). */
async function cairoCase(): Promise<MadeCase> {
  await clearScc();
  await addScc();
  await setDefaultSite(cairoId);
  const k = await readyStandardCase(uploader, { patientName: NAME });
  expect(await siteCodeOf(k.id)).toBe('EG-CFZ');
  expect((await caseRow(k.id)).status).toBe('ready');
  return k;
}

async function expectHeldByGate(k: MadeCase, trigger: string) {
  const row = await caseRow(k.id);
  expect(row.status).toBe('on_hold');
  expect(row.hold_reason).toBe(FIXED);
  expect(FIXED).toBe(TRANSFER_HOLD_REASON);
  // case event: type on_hold, fixed reason, shown as the system
  const events = await q(`SELECT type, actor_type, data FROM case_events WHERE case_id = $1 AND type = 'on_hold'`, [k.id]);
  expect(events.length).toBe(1);
  expect(events[0].actor_type).toBe('system');
  expect(events[0].data).toMatchObject({ reason: FIXED, source: 'system', gate: 'transfer', site: 'EG-CFZ', from: 'ready' });
  // audit entry for the gate decision, visible to the partner
  const au = await q(`SELECT org_id, details FROM audit_log WHERE action = 'case.transfer_blocked' AND target_id = $1`, [k.id]);
  expect(au.length).toBe(1);
  expect(au[0].org_id).toBe(acmeId);
  expect(au[0].details).toMatchObject({ ref: k.ref, site: 'EG-CFZ', trigger });
  // K Line intake is told by reference only
  const kl = await q(`SELECT title, body, data FROM notifications n JOIN organizations o ON o.id = n.org_id WHERE o.kind = 'kline' AND n.kind = 'transfer_blocked' AND n.data->>'caseId' = $1`, [k.id]);
  expect(kl.length).toBe(1);
  expect(kl[0].body).toBe(`Case ${k.ref}`);
  // the partner is told as for any hold
  expect((await q(`SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND kind = 'case_on_hold' AND data->>'caseId' = $2`, [acmeId, k.id]))[0].n).toBeGreaterThan(0);
  // no patient data anywhere in what the gate wrote
  const all = JSON.stringify([events, au, kl, await q(`SELECT * FROM notifications WHERE data->>'caseId' = $1`, [k.id])]);
  expect(all).not.toMatch(new RegExp(`${NAME}|Gabi|Gated|${k.caseId}`));
  // the partner sees the fixed reason on the case page
  const detail = await admin.call('GET', `/api/cases/${k.id}`);
  expect(detail.json.case.holdReason).toBe(FIXED);
}

describe('the factory pull re-checks the gate', () => {
  it('lists a case at a non EEA site while an SCC is on file', async () => {
    const k = await cairoCase();
    const feed = await svcCall(app, svcKey, 'GET', '/api/mes/v1/intake?site=EG-CFZ');
    expect(feed.status).toBe(200);
    expect(feed.json.cases.some((x: any) => x.ref === k.ref)).toBe(true);
    expect((await caseRow(k.id)).status).toBe('ready');
  });

  it('does not list a case when the SCC was withdrawn: the case goes on hold with the fixed reason', async () => {
    const k = await cairoCase();
    await q(`UPDATE agreements SET revoked_at = now() WHERE org_id = $1 AND type = 'scc'`, [acmeId]);
    const feed = await svcCall(app, svcKey, 'GET', '/api/mes/v1/intake?site=EG-CFZ');
    expect(feed.status).toBe(200);
    expect(feed.json.cases.some((x: any) => x.ref === k.ref)).toBe(false);
    expect(JSON.stringify(feed.json)).not.toMatch(new RegExp(`${NAME}|Gabi|Gated`));
    await expectHeldByGate(k, 'mes_intake');
    // a second pull does not repeat anything
    await svcCall(app, svcKey, 'GET', '/api/mes/v1/intake?site=EG-CFZ');
    expect((await q(`SELECT count(*)::int AS n FROM case_events WHERE case_id = $1 AND type = 'on_hold'`, [k.id]))[0].n).toBe(1);
  });

  it('does not list a case when the SCC has expired (valid_until is in the past)', async () => {
    const k = await cairoCase();
    await q(`UPDATE agreements SET valid_until = current_date - 1 WHERE org_id = $1 AND type = 'scc'`, [acmeId]);
    const feed = await svcCall(app, svcKey, 'GET', '/api/mes/v1/intake');
    expect(feed.status).toBe(200);
    expect(feed.json.cases.some((x: any) => x.ref === k.ref)).toBe(false);
    await expectHeldByGate(k, 'mes_intake');
  });

  it('keeps listing cases at EEA sites without any SCC, and ignores direct manufacturing cases', async () => {
    await clearScc();
    await setDefaultSite(chavesId);
    const k = await readyStandardCase(uploader, { patientName: NAME });
    expect(await siteCodeOf(k.id)).toBe('PT-CHV');
    const feed = await svcCall(app, svcKey, 'GET', '/api/mes/v1/intake?site=PT-CHV');
    expect(feed.json.cases.some((x: any) => x.ref === k.ref)).toBe(true);
    expect((await caseRow(k.id)).status).toBe('ready');
    expect((await q(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'case.transfer_blocked' AND target_id = $1`, [k.id]))[0].n).toBe(0);
  });
});

describe('the factory file download re-checks the gate', () => {
  it('serves the file while the transfer is covered', async () => {
    const k = await cairoCase();
    const r = await svcCall(app, svcKey, 'GET', `/api/mes/v1/files/${k.fileIds[0]}`);
    expect(r.status).toBe(200);
    expect(Buffer.compare(r.res.rawPayload, k.stl)).toBe(0);
  });

  it('refuses with 403 transfer_blocked when the SCC expired, and puts a ready case on hold', async () => {
    const k = await cairoCase();
    await q(`UPDATE agreements SET valid_until = current_date - 1 WHERE org_id = $1 AND type = 'scc'`, [acmeId]);
    const r = await svcCall(app, svcKey, 'GET', `/api/mes/v1/files/${k.fileIds[0]}`);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('transfer_blocked');
    expect(r.res.rawPayload.includes(k.stl.subarray(0, 40))).toBe(false); // no file bytes
    await expectHeldByGate(k, 'mes_file');
    // the hold is committed: a later download answers 404 (the case is no longer at the factory)
    const again = await svcCall(app, svcKey, 'GET', `/api/mes/v1/files/${k.fileIds[0]}`);
    expect(again.status).toBe(404);
  });

  it('refuses the download for a case already in production, with an audit entry, without changing its status', async () => {
    const k = await cairoCase();
    await q(`UPDATE cases SET status = 'in_production', stage = 'printing' WHERE id = $1`, [k.id]);
    await q(`UPDATE agreements SET revoked_at = now() WHERE org_id = $1 AND type = 'scc'`, [acmeId]);
    const r = await svcCall(app, svcKey, 'GET', `/api/mes/v1/files/${k.fileIds[0]}`);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('transfer_blocked');
    expect((await caseRow(k.id)).status).toBe('in_production');
    const au = await q(`SELECT actor_type, details FROM audit_log WHERE action = 'case.transfer_blocked' AND target_id = $1`, [k.id]);
    expect(au.length).toBe(1);
    expect(au[0].actor_type).toBe('service');
    expect(au[0].details).toMatchObject({ ref: k.ref, trigger: 'mes_file', from: 'in_production' });
  });

  it('serves files at EEA sites without an SCC', async () => {
    await clearScc();
    await setDefaultSite(chavesId);
    const k = await readyStandardCase(uploader, { patientName: NAME });
    const r = await svcCall(app, svcKey, 'GET', `/api/mes/v1/files/${k.fileIds[0]}`);
    expect(r.status).toBe(200);
  });
});

describe('the daily check', () => {
  it('puts ready and received cases at a non EEA site on hold when the SCC is gone, and leaves everything else alone', async () => {
    const ready = await cairoCase();
    const received = await cairoCase();
    await q(`UPDATE cases SET status = 'received', stage = 'received', received_at = now() WHERE id = $1`, [received.id]);
    const inProduction = await cairoCase();
    await q(`UPDATE cases SET status = 'in_production', stage = 'printing' WHERE id = $1`, [inProduction.id]);
    // an EEA case of the same partner
    await setDefaultSite(chavesId);
    const eea = await readyStandardCase(uploader, { patientName: NAME });
    expect(await siteCodeOf(eea.id)).toBe('PT-CHV');
    // a case already on hold is not touched again
    await setDefaultSite(cairoId);

    await q(`UPDATE agreements SET valid_until = current_date - 1 WHERE org_id = $1 AND type = 'scc'`, [acmeId]);
    const report = await runRetention();
    expect(report.transfersHeld).toBeGreaterThanOrEqual(2);
    for (const k of [ready, received]) {
      const row = await caseRow(k.id);
      expect(row.status).toBe('on_hold');
      expect(row.hold_reason).toBe(FIXED);
      expect((await q(`SELECT data FROM case_events WHERE case_id = $1 AND type = 'on_hold'`, [k.id]))[0].data).toMatchObject({ reason: FIXED, gate: 'transfer', source: 'system' });
      expect((await q(`SELECT details FROM audit_log WHERE action = 'case.transfer_blocked' AND target_id = $1`, [k.id]))[0].details).toMatchObject({ trigger: 'daily_check' });
    }
    expect((await caseRow(received.id)).status).toBe('on_hold');
    expect((await q(`SELECT data FROM case_events WHERE case_id = $1 AND type = 'on_hold'`, [received.id]))[0].data.from).toBe('received');
    expect((await caseRow(inProduction.id)).status).toBe('in_production');
    expect((await caseRow(eea.id)).status).toBe('ready');
    // nothing more to do on the next run
    expect(await recheckTransfers()).toBe(0);
    expect(JSON.stringify(await q(`SELECT data FROM case_events WHERE case_id = ANY($1::uuid[])`, [[ready.id, received.id]]))).not.toMatch(new RegExp(`${NAME}|Gabi|${ready.caseId}`));
  });

  it('puts a case on hold when the site flags change (adequacy withdrawn)', async () => {
    // Memphis is a US site: it needs an SCC unless an administrator set the adequacy flag
    const memphis = (await q(`SELECT id FROM sites WHERE code = 'US-MEM'`))[0].id;
    await q('INSERT INTO org_sites (org_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [acmeId, memphis]);
    await clearScc();
    await q(`UPDATE sites SET adequacy = true WHERE id = $1`, [memphis]);
    await setDefaultSite(memphis);
    const k = await readyStandardCase(uploader, { patientName: NAME });
    expect(await siteCodeOf(k.id)).toBe('US-MEM');
    expect((await recheckTransfers())).toBe(0);
    await q(`UPDATE sites SET adequacy = false WHERE id = $1`, [memphis]);
    expect(await recheckTransfers()).toBeGreaterThanOrEqual(1);
    expect((await caseRow(k.id)).status).toBe('on_hold');
    expect((await caseRow(k.id)).hold_reason).toBe(FIXED);
    await q('DELETE FROM org_sites WHERE org_id = $1 AND site_id = $2', [acmeId, memphis]);
  });
});

describe('direct manufacturing cases', () => {
  it('skip the gate at submit and everywhere else: they have no site', async () => {
    // the partner can only use Cairo and has no SCC: a standard case is refused, a direct case is not
    await clearScc();
    await q('DELETE FROM org_sites WHERE org_id = $1 AND site_id = $2', [acmeId, chavesId]);
    await setDefaultSite(cairoId);
    const std = await uploader.call('POST', '/api/cases', { caseId: `P9-STD-${Math.random().toString(36).slice(2, 7)}` });
    await uploader.uploadFile(std.json.case.id, 'U01.stl', cubeStl(50, 'std'));
    const refused = await uploader.call('POST', `/api/cases/${std.json.case.id}/submit`, { acknowledgeWarnings: true });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('transfer_blocked');

    const d = await tx(SYSTEM, (c) => insertCase(c, { orgId: acmeId, actor: { actorType: 'user', actorId: adminId }, mode: 'direct', caseId: `PID-${Math.random().toString(36).slice(2, 8)}`, firstName: 'Dora', lastName: 'Direct' }));
    await uploader.uploadFile(d.id, 'U01.stl', cubeStl(50, 'direct'));
    const sub = await uploader.call('POST', `/api/cases/${d.id}/submit`, { acknowledgeWarnings: true });
    expect(sub.status, JSON.stringify(sub.json)).toBe(200);
    expect(sub.json.case.status).toBe('ready');
    expect(sub.json.case.siteCode).toBeNull();
    // a direct case without any site at all is fine too
    await q('DELETE FROM org_sites WHERE org_id = $1', [acmeId]);
    const d2 = await tx(SYSTEM, (c) => insertCase(c, { orgId: acmeId, actor: { actorType: 'user', actorId: adminId }, mode: 'direct', caseId: `PID-${Math.random().toString(36).slice(2, 8)}`, firstName: 'Dina', lastName: 'Direct' }));
    await uploader.uploadFile(d2.id, 'U01.stl', cubeStl(50, 'direct2'));
    expect((await uploader.call('POST', `/api/cases/${d2.id}/submit`, { acknowledgeWarnings: true })).status).toBe(200);

    // never listed for the factory, never held by the daily check
    const feed = await svcCall(app, svcKey, 'GET', '/api/mes/v1/intake');
    expect(feed.json.cases.some((x: any) => x.ref === d.ref || x.ref === d2.ref)).toBe(false);
    await runRetention();
    expect((await caseRow(d.id)).status).toBe('ready');
    expect((await caseRow(d2.id)).status).toBe('ready');
    expect((await q(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'case.transfer_blocked' AND target_id = ANY($1::text[])`, [[d.id, d2.id]]))[0].n).toBe(0);
    // give the partner its sites back for the other tests
    await q('INSERT INTO org_sites (org_id, site_id) VALUES ($1, $2), ($1, $3)', [acmeId, chavesId, cairoId]);
    await setDefaultSite(chavesId);
  });
});

describe('what counts as an SCC on file', () => {
  it('is withdrawn, unsigned or expired agreements that do not count; the last day of validity still does', async () => {
    const run = (fn: (c: any) => Promise<boolean>) => tx(SYSTEM, fn);
    await clearScc();
    expect(await run((c) => sccOnFile(c, acmeId))).toBe(false);
    await q(`INSERT INTO agreements (org_id, type, version, signed_at, valid_until) VALUES ($1, 'scc', '1', NULL, NULL)`, [acmeId]); // not signed
    expect(await run((c) => sccOnFile(c, acmeId))).toBe(false);
    await clearScc();
    await q(`INSERT INTO agreements (org_id, type, version, signed_at, valid_until) VALUES ($1, 'scc', '1', current_date - 400, current_date - 1)`, [acmeId]); // expired yesterday
    expect(await run((c) => sccOnFile(c, acmeId))).toBe(false);
    await clearScc();
    await q(`INSERT INTO agreements (org_id, type, version, signed_at, valid_until, revoked_at) VALUES ($1, 'scc', '1', current_date - 4, NULL, now())`, [acmeId]); // withdrawn
    expect(await run((c) => sccOnFile(c, acmeId))).toBe(false);
    await clearScc();
    await q(`INSERT INTO agreements (org_id, type, version, signed_at, valid_until) VALUES ($1, 'scc', '1', current_date - 4, current_date)`, [acmeId]); // last day
    expect(await run((c) => sccOnFile(c, acmeId))).toBe(true);
    await clearScc();
    await q(`INSERT INTO agreements (org_id, type, version, signed_at, valid_until) VALUES ($1, 'scc', '1', current_date - 4, NULL)`, [acmeId]); // no expiry
    expect(await run((c) => sccOnFile(c, acmeId))).toBe(true);
    await clearScc();
  });

  it('is combined with the per site flags by canReceive: the flag grants, an SCC covers the rest, the static list is the default', () => {
    const us = { country: 'US', eea: false, adequacy: false };
    expect(canReceive('PT', us, false)).toBe(false);
    expect(canReceive('PT', us, true)).toBe(true);
    expect(canReceive('PT', { ...us, adequacy: true }, false)).toBe(true); // a Data Privacy Framework decision recorded by Legal, as a site flag
    expect(canReceive('PT', { country: 'JP', eea: false, adequacy: false }, false)).toBe(true); // static default
    expect(canReceive('PT', { country: 'MX', eea: false }, false)).toBe(false);
  });
});
