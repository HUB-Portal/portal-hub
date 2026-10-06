import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { hashSpec } from '../../shared/spec';
import { Client } from './helpers';

let app: FastifyInstance;
const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);

beforeAll(async () => {
  await seedDemo({ force: true, withCases: true, writeKeys: false });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closePools();
});

describe('phase 4 demo data', () => {
  it('seeds an active spec v1, a proposed v2, two materials and two shipments for Acme', async () => {
    const aq = await new Client(app).full('quality@acme.demo');
    const list = await aq.call('GET', '/api/specs');
    expect(list.json.items.map((s: any) => [s.version, s.status])).toEqual([[2, 'proposed'], [1, 'active']]);
    const active = await aq.call('GET', '/api/specs/active');
    expect(active.json.spec.version).toBe(1);
    expect(active.json.spec.contentHash).toBe(await hashSpec(active.json.spec.content));
    expect(active.json.spec.partnerSignature.name).toBe('Quinn Quality');
    expect(active.json.spec.klineSignature.name).toBe('Quentin Quality');
    const org = await q(`SELECT settings->'bag' AS bag FROM organizations WHERE code = 'ACME'`);
    expect(org[0].bag).toEqual(active.json.spec.content.bag);

    const materials = await aq.call('GET', '/api/materials');
    expect(materials.json.items.map((m: any) => m.sku).sort()).toEqual(['ACME-BAG', 'ACME-BOX']);
    const box = materials.json.items.find((m: any) => m.sku === 'ACME-BOX');
    expect(box.stock).toEqual([expect.objectContaining({ siteCode: 'PT-CHV', onHand: 120, inTransit: 200, lowStock: false })]);
    const shipments = await aq.call('GET', '/api/material-shipments');
    expect(shipments.json.items.map((s: any) => s.status).sort()).toEqual(['in_transit', 'received']);
  });

  it('can sign the proposed version 2 and switch over', async () => {
    const aq = await new Client(app).full('quality@acme.demo');
    const kq = await new Client(app).full('quality@kline.demo');
    const v2 = (await aq.call('GET', '/api/specs')).json.items.find((s: any) => s.version === 2);
    expect(v2.actions.sign).toBe(true);
    const diff = await aq.call('GET', `/api/specs/${v2.id}/diff/${(await aq.call('GET', '/api/specs/active')).json.spec.id}`);
    expect(diff.json.changeCount).toBe(2);
    expect((await kq.call('POST', `/api/specs/${v2.id}/sign`, {})).json.spec.status).toBe('proposed');
    const done = await aq.call('POST', `/api/specs/${v2.id}/sign`, {});
    expect(done.json.spec.status).toBe('active');
    expect((await aq.call('GET', '/api/specs')).json.items.map((s: any) => s.status)).toEqual(['active', 'superseded']);
  });

  it('shows the seeded shipment to K Line receiving', async () => {
    const chaves = await new Client(app).full('chaves@kline.demo');
    const r = await chaves.call('GET', '/api/console/material-shipments?status=in_transit');
    expect(r.json.total).toBe(1);
    expect(r.json.items[0]).toMatchObject({ siteCode: 'PT-CHV', orgName: 'Acme Aligners', status: 'in_transit' });
    const ov = await (await new Client(app).full('admin@kline.demo')).call('GET', '/api/console/overview');
    expect(ov.json.openClaims).toBe(1); // the seeded claim that is in review
  });
});
