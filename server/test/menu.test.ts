import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { ROLE_PERMISSIONS, permissionsFor } from '../../shared/roles';
import { MENU_KEYS } from '../../shared/menu';
import { Client, createDemoUser, orgIdOf } from './helpers';

// Menu visibility is VISIBILITY ONLY: it never changes a permission or a route guard.

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);

let app: FastifyInstance;
let acmeId: string;
let isoId: string;
let admin: Client;
let uploader: Client;
let quality: Client;
let finance: Client;
let viewer: Client;
let isoViewer: Client;
let isoAdmin: Client;
let klAdmin: Client;

const ALL_FALSE = { claims: false, spec: false, materials: false };
const ALL_TRUE = { claims: true, spec: true, materials: true };
const resetMenu = (orgId: string) => q(`UPDATE organizations SET settings = settings - 'menu' WHERE id = $1`, [orgId]);
const menuOf = async (c: Client) => (await c.call('GET', '/api/org')).json.menu;

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  isoId = await tx(SYSTEM, async (c) =>
    (await c.query(`INSERT INTO organizations (kind, name, code, country, status, settings) VALUES ('partner', 'Menu Isolated Dental', 'MENU9', 'GB', 'active', '{}'::jsonb) RETURNING id`)).rows[0].id,
  );
  await createDemoUser(isoId, 'admin@menu9.demo', 'Ida Menu', ['admin']);
  await createDemoUser(isoId, 'viewer@menu9.demo', 'Vic Menu', ['viewer']);
  await createDemoUser(acmeId, 'viewer-menu@acme.demo', 'Vera Viewer', ['viewer']);
  admin = await new Client(app).full('admin@acme.demo');
  uploader = await new Client(app).full('upload@acme.demo');
  quality = await new Client(app).full('quality@acme.demo');
  finance = await new Client(app).full('finance@acme.demo');
  viewer = await new Client(app).full('viewer-menu@acme.demo');
  isoAdmin = await new Client(app).full('admin@menu9.demo');
  isoViewer = await new Client(app).full('viewer@menu9.demo');
  klAdmin = await new Client(app).full('admin@kline.demo');
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('menu visibility: defaults', () => {
  it('hides the three optional items from non administrators of every company by default, including existing ones', async () => {
    await resetMenu(acmeId);
    for (const c of [uploader, quality, finance, viewer]) expect(await menuOf(c)).toEqual(ALL_FALSE);
    expect(await menuOf(isoViewer)).toEqual(ALL_FALSE);
  });

  it('shows everything to company administrators', async () => {
    expect(await menuOf(admin)).toEqual(ALL_TRUE);
    expect(await menuOf(isoAdmin)).toEqual(ALL_TRUE);
  });

  it('reads the raw setting as admins for every key while nothing is stored', async () => {
    const r = await admin.call('GET', '/api/org/menu');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ claims: 'admins', spec: 'admins', materials: 'admins' });
    // everybody in the company can read it (org.read), nothing else changes
    expect((await viewer.call('GET', '/api/org/menu')).json).toEqual({ claims: 'admins', spec: 'admins', materials: 'admins' });
  });

  it('treats unknown stored values as admins', async () => {
    await q(`UPDATE organizations SET settings = jsonb_set(settings, '{menu}', '{"claims":"all","spec":true,"materials":"everyone"}'::jsonb, true) WHERE id = $1`, [acmeId]);
    expect(await menuOf(viewer)).toEqual({ claims: false, spec: false, materials: true });
    await resetMenu(acmeId);
  });

  it('shows all three to K Line staff, whatever their role', async () => {
    expect(await menuOf(klAdmin)).toEqual(ALL_TRUE);
  });
});

describe('menu visibility: switching on', () => {
  it('lets an administrator switch one item on, and only that item becomes visible for the other roles', async () => {
    const r = await admin.call('PUT', '/api/org/menu', { claims: 'everyone' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ claims: 'everyone', spec: 'admins', materials: 'admins' });
    for (const c of [uploader, quality, finance, viewer]) expect(await menuOf(c)).toEqual({ claims: true, spec: false, materials: false });
    expect(await menuOf(admin)).toEqual(ALL_TRUE);
    expect((await admin.call('GET', '/api/org/menu')).json).toEqual({ claims: 'everyone', spec: 'admins', materials: 'admins' });
  });

  it('keeps earlier choices when a later partial update is saved, and can switch back', async () => {
    expect((await admin.call('PUT', '/api/org/menu', { spec: 'everyone', materials: 'everyone' })).json).toEqual({ claims: 'everyone', spec: 'everyone', materials: 'everyone' });
    for (const c of [uploader, quality, finance, viewer]) expect(await menuOf(c)).toEqual(ALL_TRUE);
    expect((await admin.call('PUT', '/api/org/menu', { claims: 'admins' })).json).toEqual({ claims: 'admins', spec: 'everyone', materials: 'everyone' });
    expect(await menuOf(viewer)).toEqual({ claims: false, spec: true, materials: true });
  });

  it('does not touch another company, and other settings of the company stay as they were', async () => {
    expect(await menuOf(isoViewer)).toEqual(ALL_FALSE);
    expect((await isoAdmin.call('GET', '/api/org/menu')).json).toEqual({ claims: 'admins', spec: 'admins', materials: 'admins' });
    const [{ settings }] = await q(`SELECT settings FROM organizations WHERE id = $1`, [acmeId]);
    expect(settings.case_address).toBeTruthy(); // the seeded case address survives
    expect(settings.menu).toEqual({ claims: 'admins', spec: 'everyone', materials: 'everyone' });
    // saving the company profile keeps the menu setting
    const org = (await admin.call('GET', '/api/org/profile')).json;
    expect((await admin.call('PUT', '/api/org/profile', { legalName: org.legalName || 'Acme Aligners Ltd' })).status).toBe(200);
    expect((await admin.call('GET', '/api/org/menu')).json).toEqual({ claims: 'admins', spec: 'everyone', materials: 'everyone' });
  });

  it('lets the switch work in the other company independently', async () => {
    expect((await isoAdmin.call('PUT', '/api/org/menu', { materials: 'everyone' })).status).toBe(200);
    expect(await menuOf(isoViewer)).toEqual({ claims: false, spec: false, materials: true });
    expect(await menuOf(viewer)).toEqual({ claims: false, spec: true, materials: true });
  });
});

describe('menu visibility: who may change it', () => {
  it('refuses every non administrator role with 403 and changes nothing', async () => {
    const before = (await admin.call('GET', '/api/org/menu')).json;
    for (const c of [uploader, quality, finance, viewer]) {
      const r = await c.call('PUT', '/api/org/menu', { claims: 'everyone' });
      expect(r.status).toBe(403);
    }
    expect((await admin.call('GET', '/api/org/menu')).json).toEqual(before);
  });

  it('refuses K Line staff, even administrators, with 403', async () => {
    expect((await klAdmin.call('PUT', '/api/org/menu', { claims: 'everyone' })).status).toBe(403);
    expect((await klAdmin.call('GET', '/api/org/menu')).status).toBe(403);
  });

  it('needs a session: an anonymous caller gets 401', async () => {
    expect((await new Client(app).call('PUT', '/api/org/menu', { claims: 'everyone' })).status).toBe(401);
    expect((await new Client(app).call('GET', '/api/org/menu')).status).toBe(401);
  });

  it('needs the CSRF token like every other write', async () => {
    const c = await new Client(app).full('admin@acme.demo');
    c.csrf = '';
    expect((await c.call('PUT', '/api/org/menu', { claims: 'everyone' })).status).toBe(403);
  });

  it('does not change any role permission (visibility only)', () => {
    expect([...permissionsFor(['viewer'])].sort()).toEqual([...ROLE_PERMISSIONS.viewer].sort());
    expect(ROLE_PERMISSIONS.admin).toContain('org.edit');
    for (const role of ['uploader', 'quality', 'finance', 'viewer'] as const) expect(ROLE_PERMISSIONS[role]).not.toContain('org.edit');
    // the company logo is open to every partner role except viewer, and to K Line staff through the single all permissions administrator role
    for (const role of ['admin', 'uploader', 'quality', 'finance'] as const) expect(ROLE_PERMISSIONS[role]).toContain('org.logo');
    expect(ROLE_PERMISSIONS.viewer).not.toContain('org.logo');
    expect(ROLE_PERMISSIONS.kl_admin).toEqual(expect.arrayContaining(['org.logo', 'org.edit']));
    expect(ROLE_PERMISSIONS.viewer).toEqual(expect.arrayContaining(['claim.read', 'spec.read', 'material.read']));
  });

  it('keeps the server routes open to a role that has the permission, whatever the menu says', async () => {
    await resetMenu(acmeId);
    // the viewer's menu hides everything, yet the API still answers by permission (claims, spec and materials read)
    expect(await menuOf(viewer)).toEqual(ALL_FALSE);
    for (const url of ['/api/claims', '/api/specs', '/api/materials']) {
      const r = await viewer.call('GET', url);
      expect(r.status, url).toBe(200);
    }
  });
});

describe('menu visibility: validation and audit', () => {
  it('rejects unknown keys, unknown values and empty bodies with 400 invalid_request', async () => {
    for (const body of [{}, { claims: 'yes' }, { claims: true }, { claims: null }, { reports: 'everyone' }, { claims: 'everyone', extra: 'x' }, { spec: 'EVERYONE' }, []]) {
      const r = await admin.call('PUT', '/api/org/menu', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.code).toBe('invalid_request');
    }
    expect((await admin.call('GET', '/api/org/menu')).json).toEqual({ claims: 'admins', spec: 'admins', materials: 'admins' });
  });

  it('audits org.menu_changed with the changed keys and values only', async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'org.menu_changed'`, [acmeId]))[0].n;
    const r = await admin.call('PUT', '/api/org/menu', { spec: 'everyone', materials: 'admins' });
    expect(r.status).toBe(200);
    const rows = await q(`SELECT actor_type, actor_id, target_type, target_id, details FROM audit_log WHERE org_id = $1 AND action = 'org.menu_changed' ORDER BY seq DESC`, [acmeId]);
    expect(rows.length).toBe(before + 1);
    expect(rows[0]).toMatchObject({ actor_type: 'user', target_type: 'organization', target_id: acmeId });
    expect(rows[0].details).toEqual({ changed: { spec: 'everyone', materials: 'admins' } });
    // the partner sees it in the access log
    const log = await admin.call('GET', '/api/audit?limit=20');
    expect(log.status).toBe(200);
    expect(JSON.stringify(log.json)).toContain('org.menu_changed');
  });

  it('writes no audit entry when a request is refused or invalid', async () => {
    const n = async () => (await q(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'org.menu_changed'`))[0].n;
    const before = await n();
    await viewer.call('PUT', '/api/org/menu', { claims: 'everyone' });
    await klAdmin.call('PUT', '/api/org/menu', { claims: 'everyone' });
    await admin.call('PUT', '/api/org/menu', { claims: 'nope' });
    expect(await n()).toBe(before);
  });

  it('knows exactly three keys', () => {
    expect([...MENU_KEYS]).toEqual(['claims', 'spec', 'materials']);
  });
});
