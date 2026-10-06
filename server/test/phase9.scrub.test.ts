import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { insertCase } from '../src/services/cases';
import { runRetention } from '../src/services/retention';
import { REMOVED, scrubCase } from '../src/services/scrub';
import { Client, orgIdOf } from './helpers';
import { q } from './helpers9';

/** Every place that used to survive a purge gets this marker. After a purge or an erasure it must be nowhere. */
const MARK = 'ZZMARKERZZ';

let app: FastifyInstance;
let acmeId: string;
let klineId: string;
let adminId: string;
let admin: Client;
let webhookId: string;

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  klineId = await orgIdOf('KLINE');
  adminId = (await q(`SELECT id FROM users WHERE email = 'admin@acme.demo'`))[0].id;
  admin = await new Client(app).full('admin@acme.demo');
  webhookId = (await q(`INSERT INTO webhooks (org_id, url, events, secret_enc) VALUES ($1, 'http://localhost:9/hook', ARRAY['case.cancelled'], 'x') RETURNING id`, [acmeId]))[0].id;
});
afterAll(async () => {
  await app.close();
  await closePools();
});

interface Seeded {
  id: string;
  ref: string;
  pid: string;
  claimId: string;
  deliveryId: string;
}

/**
 * A case with a recognisable marker in every place a purge used to leave behind: the case ID (the patient ID of a direct case), the hold reason,
 * hold and stage event text, the instructions event, a claim with all its free text, claim messages from both sides, a webhook delivery payload
 * and a notification that quotes the case ID.
 */
async function seedMarked(mode: 'standard' | 'direct', status: 'delivered' | 'ready' | 'on_hold'): Promise<Seeded> {
  const pid = `PID-${MARK}-${Math.random().toString(36).slice(2, 7)}`;
  return tx(SYSTEM, async (c) => {
    const r = await insertCase(c, {
      orgId: acmeId,
      actor: { actorType: 'user', actorId: adminId },
      mode,
      caseId: pid,
      ...(mode === 'direct' ? { firstName: 'Mark', lastName: 'Er' } : { patientName: 'Mark Er' }),
      instructions: `Instructions ${MARK}`,
    });
    await c.query(
      `UPDATE cases SET status = $2, submitted_at = now() - interval '40 days', ready_at = now() - interval '39 days', shipped_at = now() - interval '30 days',
              hold_reason = $3, aligners_upper = 7, aligners_lower = 6, carrier = 'DHL', tracking = 'TRACK123',
              purge_after = CASE WHEN $2 = 'delivered' THEN now() - interval '1 day' ELSE NULL END
        WHERE id = $1`,
      [r.id, status, status === 'on_hold' ? `Hold ${MARK}` : null],
    );
    const ev = (type: string, data: Record<string, unknown>) =>
      c.query(`INSERT INTO case_events (org_id, case_id, type, actor_type, data) VALUES ($1, $2, $3, 'user', $4::jsonb)`, [acmeId, r.id, type, JSON.stringify(data)]);
    await ev('on_hold', { source: 'kline', from: 'ready', reason: `Hold reason ${MARK}`, sourceLabel: 'K Line' });
    await ev('stage', { source: 'kline', stage: 'packing', status: 'in_production', note: `Stage note ${MARK}`, sourceLabel: 'K Line' });
    await ev('instructions_updated', {});
    await ev('submitted', { status: 'ready', warnings: 0, acknowledged: false });

    const claim = (await c.query(
      `INSERT INTO claims (org_id, number, case_id, status, resolution, summary, description, root_cause, corrective_action, decision_note, opened_by)
       VALUES ($1, $2, $3, 'accepted', 'remake', $4, $5, $6, $7, $8, $9) RETURNING id`,
      [acmeId, `CLM-2026-9${Math.floor(Math.random() * 90000 + 10000)}`, r.id, `Summary ${MARK}`, `Description ${MARK}`, `Root cause ${MARK}`, `Corrective action ${MARK}`, `Decision ${MARK}`, adminId],
    )).rows[0].id as string;
    await c.query(`INSERT INTO claim_items (org_id, claim_id, arch, step, defect_code, note, pos) VALUES ($1, $2, 'upper', 3, 'DEBRIS', $3, 0)`, [acmeId, claim, `Item note ${MARK}`]);
    await c.query(`INSERT INTO claim_messages (org_id, claim_id, side, body, author_id) VALUES ($1, $2, 'system', 'Claim opened.', NULL), ($1, $2, 'partner', $3, $4), ($1, $2, 'kline', $5, NULL)`, [acmeId, claim, `Partner message ${MARK}`, adminId, `Kline message ${MARK}`]);

    const deliveryId = randomUUID();
    await c.query(
      `INSERT INTO webhook_deliveries (id, org_id, webhook_id, event, payload, status) VALUES ($1, $2, $3, 'case.cancelled', $4::jsonb, 'delivered')`,
      [deliveryId, acmeId, webhookId, JSON.stringify({ id: deliveryId, type: 'case.cancelled', created_at: new Date().toISOString(), org_code: 'ACME', data: { ref: r.ref, case_id: pid, partner_case_id: pid, status: 'cancelled', stage: null } })],
    );
    await c.query(
      `INSERT INTO notifications (org_id, kind, title, body, data) VALUES ($1, 'case_stage', $2, $3, $4::jsonb)`,
      [acmeId, `Update for ${pid}`, `Case ${pid} moved on`, JSON.stringify({ caseId: r.id, ref: r.ref })],
    );
    return { id: r.id, ref: r.ref, pid, claimId: claim, deliveryId };
  });
}

/** Every row that could hold a marker, as text, for one case. */
async function leftovers(s: Seeded): Promise<string[]> {
  const out: string[] = [];
  const check = async (label: string, sql: string, params: unknown[]) => {
    for (const r of await q(sql, params)) if (JSON.stringify(r).includes(MARK)) out.push(label);
  };
  await check('cases', 'SELECT * FROM cases WHERE id = $1', [s.id]);
  await check('case_events', 'SELECT * FROM case_events WHERE case_id = $1', [s.id]);
  await check('claims', 'SELECT * FROM claims WHERE case_id = $1', [s.id]);
  await check('claim_items', 'SELECT * FROM claim_items WHERE claim_id = $1', [s.claimId]);
  await check('claim_messages', 'SELECT * FROM claim_messages WHERE claim_id = $1', [s.claimId]);
  await check('webhook_deliveries', 'SELECT * FROM webhook_deliveries WHERE id = $1', [s.deliveryId]);
  await check('notifications', `SELECT * FROM notifications WHERE data->>'caseId' = $1`, [s.id]);
  await check('audit_log', `SELECT * FROM audit_log WHERE target_id = $1`, [s.id]);
  return out;
}

/** What must stay: references, dates, counts and status. */
async function expectRecordKept(s: Seeded, status: string) {
  const c = (await q('SELECT * FROM cases WHERE id = $1', [s.id]))[0];
  expect(c.ref).toBe(s.ref);
  expect(c.status).toBe(status);
  expect(c.aligners_upper).toBe(7);
  expect(c.aligners_lower).toBe(6);
  expect(c.carrier).toBe('DHL');
  expect(c.tracking).toBe('TRACK123');
  expect(c.shipped_at).not.toBeNull();
  expect(c.submitted_at).not.toBeNull();
  expect(c.purged_at).not.toBeNull();
  expect(c.scrubbed_at).not.toBeNull();
  const events = await q('SELECT type, data FROM case_events WHERE case_id = $1', [s.id]);
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['created', 'on_hold', 'stage', 'instructions_updated', 'submitted']));
  const hold = events.find((e) => e.type === 'on_hold')!;
  expect(hold.data).toMatchObject({ source: 'kline', from: 'ready', reason: REMOVED, sourceLabel: 'K Line' });
  const stage = events.find((e) => e.type === 'stage')!;
  expect(stage.data).toMatchObject({ stage: 'packing', status: 'in_production', note: REMOVED });
  expect(events.find((e) => e.type === 'submitted')!.data).toMatchObject({ status: 'ready', warnings: 0 });
  const claim = (await q('SELECT * FROM claims WHERE id = $1', [s.claimId]))[0];
  expect(claim).toMatchObject({ status: 'accepted', resolution: 'remake', summary: REMOVED, description: REMOVED, root_cause: REMOVED, corrective_action: REMOVED, decision_note: REMOVED });
  expect(claim.number).toMatch(/^CLM-2026-/);
  const item = (await q('SELECT * FROM claim_items WHERE claim_id = $1', [s.claimId]))[0];
  expect(item).toMatchObject({ arch: 'upper', step: 3, defect_code: 'DEBRIS', note: REMOVED });
  const msgs = await q('SELECT side, body FROM claim_messages WHERE claim_id = $1 ORDER BY side', [s.claimId]);
  expect(msgs.length).toBe(3);
  expect(msgs.find((m) => m.side === 'system')!.body).toBe('Claim opened.');
  expect(msgs.find((m) => m.side === 'partner')!.body).toBe(REMOVED);
  expect(msgs.find((m) => m.side === 'kline')!.body).toBe(REMOVED);
  const d = (await q('SELECT payload FROM webhook_deliveries WHERE id = $1', [s.deliveryId]))[0];
  expect(d.payload.data).toEqual({ ref: s.ref, status: 'cancelled', stage: null }); // the reference stays, the case ID is gone
  expect(d.payload).toMatchObject({ id: s.deliveryId, type: 'case.cancelled', org_code: 'ACME' });
  const n = (await q(`SELECT title, body FROM notifications WHERE data->>'caseId' = $1`, [s.id]))[0];
  expect(n.title).toBe(`Update for ${s.ref}`);
  expect(n.body).toBe(`Case ${s.ref} moved on`);
}

describe('scrubCase on a retention purge', () => {
  it('removes the patient ID of a direct case, hold and event text, claim text and webhook ids, and keeps the production record', async () => {
    const s = await seedMarked('direct', 'delivered');
    expect(await leftovers(s)).not.toEqual([]); // the seed really put markers everywhere
    const report = await runRetention();
    expect(report.casesPurged).toBeGreaterThanOrEqual(1);
    expect(await leftovers(s)).toEqual([]);
    const c = (await q('SELECT partner_case_id, patient_enc, patient_first_enc, notes_enc FROM cases WHERE id = $1', [s.id]))[0];
    expect(c).toEqual({ partner_case_id: null, patient_enc: null, patient_first_enc: null, notes_enc: null });
    await expectRecordKept(s, 'delivered');
    // the purge itself is still recorded, without free text
    const ev = (await q(`SELECT data FROM case_events WHERE case_id = $1 AND type = 'purged'`, [s.id]))[0];
    expect(ev.data).toEqual({ reason: 'retention', files: 0 });
  });

  it('keeps the partner case ID of a standard case (the partner\'s own reference) but scrubs everything else', async () => {
    const s = await seedMarked('standard', 'delivered');
    await runRetention();
    const c = (await q('SELECT partner_case_id FROM cases WHERE id = $1', [s.id]))[0];
    expect(c.partner_case_id).toBe(s.pid);
    // the markers that remain are only the case ID itself (it carries the marker text in this test) and the notification that quotes it
    expect((await leftovers(s)).sort()).toEqual(['cases', 'notifications']);
    // the webhook payload loses the case ID whatever the case type
    expect((await q('SELECT payload FROM webhook_deliveries WHERE id = $1', [s.deliveryId]))[0].payload.data.case_id).toBeUndefined();
  });

  it('scrubs a case that was purged before the scrub existed (the daily job marks it with scrubbed_at)', async () => {
    const s = await seedMarked('direct', 'delivered');
    // purged the old way: files and names gone, nothing else
    await q(`UPDATE cases SET purged_at = now(), patient_enc = NULL, patient_first_enc = NULL, patient_last_enc = NULL, notes_enc = NULL, patient_bidx = NULL, patient_bidxs = '{}', purge_after = NULL WHERE id = $1`, [s.id]);
    expect((await q('SELECT scrubbed_at FROM cases WHERE id = $1', [s.id]))[0].scrubbed_at).toBeNull();
    const report = await runRetention();
    expect(report.casesScrubbed).toBeGreaterThanOrEqual(1);
    expect(await leftovers(s)).toEqual([]);
    await expectRecordKept(s, 'delivered');
    // a second run has nothing left to do
    expect((await runRetention()).casesScrubbed).toBe(0);
  });
});

describe('scrubCase on an erasure', () => {
  it('removes the case ID of a standard case as well, and everything else that carries the marker', async () => {
    const s = await seedMarked('standard', 'ready');
    const r = await admin.call('POST', `/api/cases/${s.id}/erase`, { confirmRef: s.ref });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await leftovers(s)).toEqual([]);
    expect((await q('SELECT partner_case_id FROM cases WHERE id = $1', [s.id]))[0].partner_case_id).toBeNull();
    await expectRecordKept(s, 'ready');
    // the erased event stays and carries no free text
    const erased = (await q(`SELECT data FROM case_events WHERE case_id = $1 AND type = 'erased'`, [s.id]))[0];
    expect(erased.data).toEqual({ files: 0, byKline: false });
  });

  it('does the same for a direct manufacturing case', async () => {
    const s = await seedMarked('direct', 'ready');
    const r = await admin.call('POST', `/api/cases/${s.id}/erase`, { confirmRef: s.ref });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await leftovers(s)).toEqual([]);
    await expectRecordKept(s, 'ready');
  });

  it('removes the hold reason of a case that is on hold', async () => {
    const s = await seedMarked('standard', 'on_hold');
    expect((await admin.call('POST', `/api/cases/${s.id}/erase`, { confirmRef: s.ref })).status).toBe(200);
    const c = (await q('SELECT hold_reason, status FROM cases WHERE id = $1', [s.id]))[0];
    expect(c).toEqual({ hold_reason: REMOVED, status: 'on_hold' });
    expect(await leftovers(s)).toEqual([]);
  });
});

describe('scrubCase itself', () => {
  it('refuses a case that is not purged and is safe to run twice', async () => {
    const s = await seedMarked('standard', 'delivered');
    await expect(tx(SYSTEM, (c) => scrubCase(c, s.id))).rejects.toThrow(/purged or erased/);
    await q(`UPDATE cases SET purged_at = now() WHERE id = $1`, [s.id]);
    const first = await tx(SYSTEM, (c) => scrubCase(c, s.id, { partnerCaseId: 'always' }));
    expect(first).toMatchObject({ partnerCaseId: true, claims: 1, claimItems: 1, claimMessages: 2, webhookDeliveries: 1 });
    const second = await tx(SYSTEM, (c) => scrubCase(c, s.id, { partnerCaseId: 'always' }));
    expect(second.partnerCaseId).toBe(false);
    expect(second.claimMessages).toBe(0);
    expect(second.claimItems).toBe(0);
    expect(klineId).not.toBe(acmeId);
  });
});
