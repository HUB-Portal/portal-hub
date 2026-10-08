import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createApiKey } from '../src/auth/apikeys';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { runDueJobs } from '../src/worker';
import { FakePortalClient, setPortalClientFactory, toPortalShipping } from '../src/services/portal';
import { validateSvg } from '../src/services/validate/svg';
import { bufferSource } from '../src/services/validate';
import { CASE_ADDRESS_REQUIRED_MESSAGE, isCompleteCaseAddress, type CaseAddress } from '../../shared/caseAddress';
import { LOGO_MAX_BYTES } from '../../shared/logo';
import { PRIVACY_VERSION } from '../../shared/signup';
import { Client, LOGO_PNG, LOGO_SVG, PNG_BYTES, createDemoUser, cubeStl, jpegOfSize, laserCsv, minimalPdf, orgIdOf, pngOfSize, trimLine } from './helpers';

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);
const fake = new FakePortalClient();

let app: FastifyInstance;
let acmeId: string;
let isoId: string;
let admin: Client; // Acme admin
let up: Client; // Acme uploader (org.read only for profile writes)
let viewer: Client;
let contoso: Client;
let klAdmin: Client;
let iso: Client;

const ACME_ADDRESS: CaseAddress = {
  company: 'Acme Aligners Ltd', fullName: 'Alex Acme', street: '1 Rua Direita', city: 'Chaves', postalCode: '5400-001', stateProvince: 'Vila Real', country: 'PT', phone: '+351276000000', email: 'goods@acme.demo',
};
const ISO_ADDRESS: CaseAddress = {
  company: 'Isolated Dental', fullName: 'Ida Iso', street: '9 Isolated Street', city: 'Leeds', postalCode: 'LS1 1AA', stateProvince: 'West Yorkshire', country: 'GB', phone: '+441130000000', email: 'goods@iso8.demo',
};

const setAddress = (orgId: string, a: CaseAddress | null) =>
  q(`UPDATE organizations SET settings = CASE WHEN $2::jsonb IS NULL THEN settings - 'case_address' ELSE jsonb_set(settings, '{case_address}', $2::jsonb, true) END WHERE id = $1`, [orgId, a ? JSON.stringify(a) : null]);

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  isoId = await tx(SYSTEM, async (c) =>
    (await c.query(`INSERT INTO organizations (kind, name, code, country, status, settings) VALUES ('partner', 'Isolated Dental', 'ISO8', 'GB', 'active', $1::jsonb) RETURNING id`, [JSON.stringify({ manual_review: false, case_address: ISO_ADDRESS })])).rows[0].id,
  );
  await createDemoUser(isoId, 'admin@iso8.demo', 'Ida Iso', ['admin']);
  await createDemoUser(acmeId, 'viewer@acme.demo', 'Vic Viewer', ['viewer']);
  admin = await new Client(app).full('admin@acme.demo');
  up = await new Client(app).full('upload@acme.demo');
  viewer = await new Client(app).full('viewer@acme.demo');
  contoso = await new Client(app).full('owner@contoso.demo');
  klAdmin = await new Client(app).full('admin@kline.demo');
  iso = await new Client(app).full('admin@iso8.demo');
  setPortalClientFactory(() => fake);
});

afterAll(async () => {
  setPortalClientFactory(undefined);
  await app.close();
  await closePools();
});

// ---------------------------------------------------------------------------
describe('seed', () => {
  it('gives Acme, Contoso and Fabrikam a complete case address and a valid logo', async () => {
    const rows = await q(`SELECT o.code, o.settings->'case_address' AS addr, o.logo_file_id, f.state, f.content_type FROM organizations o LEFT JOIN files f ON f.id = o.logo_file_id WHERE o.code IN ('ACME', 'CONT', 'FDL') ORDER BY o.code`);
    expect(rows.map((r) => r.code)).toEqual(['ACME', 'CONT', 'FDL']);
    for (const r of rows) {
      expect(isCompleteCaseAddress(r.addr), r.code).toBe(true);
      expect(r.logo_file_id, r.code).toBeTruthy();
      expect(r).toMatchObject({ state: 'ready', content_type: 'image/svg+xml' });
    }
    expect(rows.find((r) => r.code === 'ACME')!.addr).toEqual(ACME_ADDRESS);
    // the logo is stored encrypted like any file and passes the SVG checks
    const res = await admin.call('GET', '/api/org/logo');
    expect(res.status).toBe(200);
    expect(res.res.rawPayload.toString()).toContain('<svg');
    expect((await validateSvg(bufferSource(res.res.rawPayload))).errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('registration with a case address', () => {
  const email = () => `p8.${Math.random().toString(36).slice(2, 8)}@zyxwv-dental.test`;
  const body = (over: Record<string, unknown> = {}) => ({
    companyName: 'Zyxwv Quartz Dental', country: 'DE', personName: 'Pascal Quirk', email: email(), website: 'https://zyxwv.example', volume: '1000_5000',
    acceptAuthority: true, acceptPrivacy: true, privacyVersion: PRIVACY_VERSION,
    caseAddress: { street: '5 Quarzweg', city: 'Hamburg', postalCode: '20095', stateProvince: 'Hamburg', country: 'DE', phone: '+4940123456' },
    ...over,
  });
  const orgOf = async (e: string) => (await q(`SELECT o.* FROM organizations o JOIN users u ON u.org_id = o.id WHERE lower(u.email) = $1`, [e.toLowerCase()]))[0];

  it('stores the address with recipient, company and email defaulted from the registrant', async () => {
    const b = body();
    const r = await new Client(app).call('POST', '/api/auth/register', b);
    expect(r.status).toBe(202);
    const org = await orgOf(b.email);
    expect(org.settings.case_address).toEqual({
      company: 'Zyxwv Quartz Dental', fullName: 'Pascal Quirk', email: b.email, street: '5 Quarzweg', city: 'Hamburg', postalCode: '20095', stateProvince: 'Hamburg', country: 'DE', phone: '+4940123456',
    });
    expect(org.settings.manual_review).toBe(true);
    // never part of the audit entry
    expect(JSON.stringify(await q(`SELECT details FROM audit_log WHERE org_id = $1`, [org.id]))).not.toMatch(/Quarzweg/);
  });

  it('accepts typed recipient, company and email', async () => {
    const b = body({ caseAddress: { ...body().caseAddress, fullName: 'Goods Inwards', company: 'Zyxwv Logistics', email: 'goods@zyxwv.example' } });
    expect((await new Client(app).call('POST', '/api/auth/register', b)).status).toBe(202);
    expect((await orgOf(b.email)).settings.case_address).toMatchObject({ fullName: 'Goods Inwards', company: 'Zyxwv Logistics', email: 'goods@zyxwv.example' });
  });

  it('answers 400 with field messages when the address is missing or not valid, and creates nothing', async () => {
    const none = body({ caseAddress: undefined });
    const r = await new Client(app).call('POST', '/api/auth/register', none);
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('invalid_request');
    expect(r.json.fields.map((f: any) => f.path).sort()).toEqual(['caseAddress.city', 'caseAddress.country', 'caseAddress.phone', 'caseAddress.postalCode', 'caseAddress.stateProvince', 'caseAddress.street']);
    expect(r.json.fields.every((f: any) => typeof f.message === 'string' && f.message.length > 5 && !/ [-–—] /.test(f.message))).toBe(true);
    expect(await orgOf(none.email)).toBeUndefined();

    const bad = body({ caseAddress: { street: 'x'.repeat(256), city: 'Hamburg', postalCode: '123456789012', stateProvince: '', country: 'ZZ', phone: '1234567890123456' } });
    const r2 = await new Client(app).call('POST', '/api/auth/register', bad);
    expect(r2.status).toBe(400);
    expect(r2.json.fields.map((f: any) => f.path).sort()).toEqual(['caseAddress.country', 'caseAddress.phone', 'caseAddress.postalCode', 'caseAddress.stateProvince', 'caseAddress.street']);
    expect(await orgOf(bad.email)).toBeUndefined();
  });

  it('keeps the same answer for a known address and never changes the stored organisation', async () => {
    const before = await q(`SELECT settings FROM organizations WHERE id = $1`, [acmeId]);
    const known = await new Client(app).call('POST', '/api/auth/register', body({ email: 'admin@acme.demo', caseAddress: { street: 'Evil 1', city: 'X', postalCode: '1', stateProvince: 'N/A', country: 'US', phone: '12345' } }));
    const fresh = await new Client(app).call('POST', '/api/auth/register', body());
    expect(known.status).toBe(202);
    expect(known.json).toEqual(fresh.json);
    expect((await q(`SELECT settings FROM organizations WHERE id = $1`, [acmeId]))[0]).toEqual(before[0]);
  });
});

// ---------------------------------------------------------------------------
describe('profile case address', () => {
  it('reads the address, the completeness flag and the logo facts', async () => {
    const r = await admin.call('GET', '/api/org/profile');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ caseAddress: ACME_ADDRESS, caseAddressComplete: true, logoRequired: true, hasLogo: true, logo: { hasLogo: true, version: expect.any(String) } });
    expect(r.json.logo.version).toBe((await q(`SELECT logo_file_id FROM organizations WHERE id = $1`, [acmeId]))[0].logo_file_id);
    // another company sees its own
    const c = await contoso.call('GET', '/api/org/profile');
    expect(c.json.caseAddress).toMatchObject({ company: 'Contoso Smile', country: 'ES' });
    expect(JSON.stringify(c.json)).not.toMatch(/Rua Direita|Acme/);
    // everyone with org.read may read it
    expect((await viewer.call('GET', '/api/org/profile')).json.caseAddress).toEqual(ACME_ADDRESS);
    // an organisation without an address
    await setAddress(isoId, null);
    const none = await iso.call('GET', '/api/org/profile');
    expect(none.json).toMatchObject({ caseAddress: null, caseAddressComplete: false });
    await setAddress(isoId, ISO_ADDRESS);
  });

  it('saves a partial update, merges it, audits the change without values and keeps the rest', async () => {
    const put = await admin.call('PUT', '/api/org/profile', { caseAddress: { city: 'Vila Real', phone: '+351276111222', fullName: 'Goods Inwards' } });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json.caseAddress).toEqual({ ...ACME_ADDRESS, city: 'Vila Real', phone: '+351276111222', fullName: 'Goods Inwards' });
    expect(put.json.caseAddressComplete).toBe(true);
    expect((await admin.call('GET', '/api/org/profile')).json.caseAddress).toEqual(put.json.caseAddress);
    const audit = await q(`SELECT details FROM audit_log WHERE org_id = $1 AND action = 'org.profile_updated' ORDER BY seq DESC LIMIT 1`, [acmeId]);
    expect(audit[0].details).toEqual({ changed: ['caseAddress'] });
    expect(JSON.stringify(audit)).not.toMatch(/Vila Real|Goods Inwards|276111222/);
    // values are cleaned
    const clean = await admin.call('PUT', '/api/org/profile', { caseAddress: { street: '  1   Rua   Direita ', country: 'pt' } });
    expect(clean.json.caseAddress).toMatchObject({ street: '1 Rua Direita', country: 'PT' });
    await admin.call('PUT', '/api/org/profile', { caseAddress: ACME_ADDRESS });
    expect((await admin.call('GET', '/api/org/profile')).json.caseAddress).toEqual(ACME_ADDRESS);
  });

  it('validates every field and stores nothing when one is wrong', async () => {
    const bad = await admin.call('PUT', '/api/org/profile', { caseAddress: { phone: 'abc', country: 'ZZ', postalCode: '12345678901', stateProvince: '', email: 'nope' } });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('invalid_request');
    expect(bad.json.fields.map((f: any) => f.path).sort()).toEqual(['caseAddress.country', 'caseAddress.email', 'caseAddress.phone', 'caseAddress.postalCode', 'caseAddress.stateProvince']);
    expect((await admin.call('GET', '/api/org/profile')).json.caseAddress).toEqual(ACME_ADDRESS);
    const long = await admin.call('PUT', '/api/org/profile', { caseAddress: { phone: '+351 276 000 000' } });
    expect(long.json.fields[0]).toMatchObject({ path: 'caseAddress.phone', message: expect.stringMatching(/at most 15 characters/) });
    // N/A is accepted as a state or province
    const na = await admin.call('PUT', '/api/org/profile', { caseAddress: { stateProvince: 'N/A' } });
    expect(na.json.caseAddress.stateProvince).toBe('N/A');
    await admin.call('PUT', '/api/org/profile', { caseAddress: { stateProvince: 'Vila Real' } });
  });

  it('can be saved partly, which leaves the address incomplete', async () => {
    await setAddress(isoId, null);
    const put = await iso.call('PUT', '/api/org/profile', { caseAddress: { street: '9 Isolated Street', city: 'Leeds' } });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ caseAddressComplete: false, caseAddress: { street: '9 Isolated Street', city: 'Leeds', phone: '' } });
    const done = await iso.call('PUT', '/api/org/profile', { caseAddress: ISO_ADDRESS });
    expect(done.json).toMatchObject({ caseAddressComplete: true, caseAddress: ISO_ADDRESS });
  });

  it('needs org.edit to write and is for partner companies', async () => {
    expect((await viewer.call('PUT', '/api/org/profile', { caseAddress: { city: 'Nowhere' } })).status).toBe(403);
    expect((await up.call('PUT', '/api/org/profile', { caseAddress: { city: 'Nowhere' } })).status).toBe(403);
    expect((await klAdmin.call('GET', '/api/org/profile')).status).toBe(403);
    expect((await klAdmin.call('PUT', '/api/org/profile', { caseAddress: { city: 'Nowhere' } })).status).toBe(403);
    expect((await new Client(app).call('GET', '/api/org/profile')).status).toBe(401);
    expect((await admin.call('GET', '/api/org/profile')).json.caseAddress.city).toBe('Chaves');
    // one company cannot change another's address
    await contoso.call('PUT', '/api/org/profile', { caseAddress: { city: 'Barcelona' } });
    expect((await admin.call('GET', '/api/org/profile')).json.caseAddress.city).toBe('Chaves');
    expect((await contoso.call('GET', '/api/org/profile')).json.caseAddress.city).toBe('Barcelona');
    await contoso.call('PUT', '/api/org/profile', { caseAddress: { city: 'Madrid' } });
  });

  it('shows the address and the logo facts to K Line on the partner page', async () => {
    const d = await klAdmin.call('GET', `/api/partners/${acmeId}`);
    expect(d.status).toBe(200);
    expect(d.json).toMatchObject({ hasLogo: true, caseAddressComplete: true, caseAddress: ACME_ADDRESS, gates: { hasLogo: true } });
    expect((await klAdmin.call('GET', `/api/partners/${isoId}`)).json.gates.blockers.map((b: any) => b.code)).toContain('logo_required');
  });
});

// ---------------------------------------------------------------------------
describe('getting started items', () => {
  const item = (json: any, id: string) => json.items.find((i: any) => i.id === id);

  it('lists the logo and the case address', async () => {
    const r = await admin.call('GET', '/api/org/onboarding');
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: any) => i.id)).toEqual(['account_secured', 'logo', 'case_address', 'spec', 'dpa', 'approval']);
    expect(item(r.json, 'logo')).toMatchObject({ label: 'Add your company logo', done: true });
    expect(item(r.json, 'case_address')).toMatchObject({ label: 'Add your shipping address', done: true });
    expect(r.json.items.every((i: any) => !/ [-–—] /.test(i.label))).toBe(true);
  });

  it('marks them open while the address is incomplete and the logo is missing', async () => {
    await setAddress(isoId, { ...ISO_ADDRESS, phone: '' });
    const r = await iso.call('GET', '/api/org/onboarding');
    expect(item(r.json, 'case_address').done).toBe(false);
    expect(item(r.json, 'logo').done).toBe(false);
    await setAddress(isoId, ISO_ADDRESS);
    expect(item((await iso.call('GET', '/api/org/onboarding')).json, 'case_address').done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
let uploadCounter = 0;
async function uploadLogo(c: Client, rawName: string, data: Buffer) {
  // a unique name: an upload with the same name and size would resume the earlier file
  const name = `${++uploadCounter}-${rawName}`;
  const init = await c.call('POST', '/api/uploads', { purpose: 'logo', name, size: data.length });
  expect(init.status, JSON.stringify(init.json)).toBe(200);
  const fileId = init.json.fileId as string;
  for (let i = 0; i < init.json.chunkCount; i++) {
    const put = await c.putChunk(fileId, i, data.subarray(i * init.json.chunkSize, (i + 1) * init.json.chunkSize));
    expect(put.status, JSON.stringify(put.json)).toBe(200);
  }
  expect((await c.call('POST', `/api/uploads/${fileId}/complete`, {})).status).toBe(200);
  await runDueJobs();
  return { fileId, state: (await q(`SELECT state FROM files WHERE id = $1`, [fileId]))[0].state as string };
}
const svgOf = (attrs: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="10" height="10" fill="#036"/></svg>`);

describe('company logo rules', () => {
  const refused: [string, string, Buffer, string][] = [
    ['png too narrow', 'a.png', pngOfSize(399, 120), 'logo_too_small'],
    ['png too short', 'a.png', pngOfSize(400, 119), 'logo_too_small'],
    ['png too wide in pixels', 'a.png', pngOfSize(4001, 1000), 'logo_too_large'],
    ['png too tall in pixels', 'a.png', pngOfSize(1000, 4001), 'logo_too_large'],
    ['png too long and thin', 'a.png', pngOfSize(1000, 150), 'logo_bad_ratio'],
    ['png taller than wide', 'a.png', pngOfSize(400, 500), 'logo_bad_ratio'],
    ['jpeg too small', 'a.jpg', jpegOfSize(300, 100), 'logo_too_small'],
    ['jpeg too large', 'a.jpeg', jpegOfSize(6000, 2000), 'logo_too_large'],
    ['jpeg too thin', 'a.jpg', jpegOfSize(2400, 200), 'logo_bad_ratio'],
    ['svg without size', 'a.svg', svgOf(''), 'logo_bad_ratio'],
    ['svg too thin', 'a.svg', svgOf('viewBox="0 0 1000 100"'), 'logo_bad_ratio'],
    ['svg taller than wide', 'a.svg', svgOf('viewBox="0 0 100 200"'), 'logo_bad_ratio'],
    ['svg in percent', 'a.svg', svgOf('width="100%" height="100%"'), 'logo_bad_ratio'],
    ['png over 2 MB', 'a.png', pngOfSize(800, 240, LOGO_MAX_BYTES), 'logo_too_large'],
  ];
  for (const [label, name, data, code] of refused) {
    it(`refuses ${label} with 422 ${code}, repeats the instruction and removes the file`, async () => {
      const up1 = await uploadLogo(admin, name, data);
      expect(up1.state).toBe('ready');
      const r = await admin.call('POST', '/api/org/logo', { fileId: up1.fileId });
      expect(r.status, JSON.stringify(r.json)).toBe(422);
      expect(r.json.code).toBe(code);
      expect(r.json.message).toMatch(/800 x 240/);
      expect(r.json.message).toMatch(/at least 400 x 120/);
      expect(r.json.message).toMatch(/2 MB/);
      expect(r.json.message).not.toMatch(/ [-–—] /);
      expect(await q(`SELECT 1 FROM files WHERE id = $1`, [up1.fileId])).toHaveLength(0);
      // the current logo is untouched
      expect((await admin.call('GET', '/api/org/profile')).json.hasLogo).toBe(true);
    });
  }

  const accepted: [string, string, Buffer, string][] = [
    ['png 800 x 240', 'a.png', LOGO_PNG, 'image/png'],
    ['png at the minimum', 'a.png', pngOfSize(400, 120), 'image/png'],
    ['png 4000 x 4000', 'a.png', pngOfSize(4000, 4000), 'image/png'],
    ['png at 6 to 1', 'a.png', pngOfSize(1200, 200), 'image/png'],
    ['png of exactly 2 MB', 'a.png', pngOfSize(800, 240, LOGO_MAX_BYTES - 33), 'image/png'],
    ['jpg', 'a.jpg', jpegOfSize(600, 200), 'image/jpeg'],
    ['svg with a viewBox', 'a.svg', LOGO_SVG, 'image/svg+xml'],
    ['svg with width and height', 'a.svg', svgOf('width="240" height="80"'), 'image/svg+xml'],
    ['small svg of the right ratio', 'a.svg', svgOf('viewBox="0 0 30 10"'), 'image/svg+xml'],
  ];
  for (const [label, name, data, type] of accepted) {
    it(`accepts ${label}`, async () => {
      const u = await uploadLogo(admin, name, data);
      expect(u.state).toBe('ready');
      const r = await admin.call('POST', '/api/org/logo', { fileId: u.fileId });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json).toEqual({ hasLogo: true, version: u.fileId });
      const g = await admin.call('GET', '/api/org/logo');
      expect(g.res.headers['content-type']).toBe(type);
      expect(g.res.rawPayload.equals(data)).toBe(true);
    });
  }

  it('does not apply the company rules to brand logos', async () => {
    const brand = await admin.call('POST', '/api/org/brands', { name: 'Tiny Brand' });
    const u = await uploadLogo(admin, 'tiny.png', PNG_BYTES);
    expect(u.state).toBe('ready');
    const r = await admin.call('POST', `/api/org/brands/${brand.json.brand.id}/logo`, { fileId: u.fileId });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // and an unsafe SVG is still refused by the content checks
    const bad = await uploadLogo(admin, 'evil.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 90"><script>alert(1)</script></svg>'));
    expect(bad.state).toBe('rejected');
    const use = await admin.call('POST', '/api/org/logo', { fileId: bad.fileId });
    expect(use.status).toBe(409);
    expect(use.json.code).toBe('file_not_ready');
    await admin.call('DELETE', `/api/org/brands/${brand.json.brand.id}`);
    await q(`DELETE FROM files WHERE id = $1`, [bad.fileId]);
  });

  it('keeps a file of another company out of reach', async () => {
    const mine = await uploadLogo(admin, 'mine.png', LOGO_PNG);
    expect((await contoso.call('POST', '/api/org/logo', { fileId: mine.fileId })).status).toBe(404);
    expect((await klAdmin.call('POST', '/api/org/logo', { fileId: mine.fileId })).status).toBe(403);
    const cBefore = (await contoso.call('GET', '/api/org')).json.logo.version;
    expect(cBefore).not.toBe(mine.fileId);
    expect((await admin.call('POST', '/api/org/logo', { fileId: mine.fileId })).status).toBe(200);
    expect((await contoso.call('GET', '/api/org')).json.logo.version).toBe(cBefore);
    expect((await admin.call('GET', '/api/org')).json.logo.version).toBe(mine.fileId);
  });
});

// ---------------------------------------------------------------------------
describe('showing the logo', () => {
  it('puts the logo facts in the organisation summary and changes the version with the logo', async () => {
    const a = await admin.call('GET', '/api/org');
    expect(a.status).toBe(200);
    expect(a.json.logo).toEqual({ hasLogo: true, version: expect.any(String) });
    const first = a.json.logo.version as string;
    const u = await uploadLogo(admin, 'second.svg', LOGO_SVG);
    expect((await admin.call('POST', '/api/org/logo', { fileId: u.fileId })).status).toBe(200);
    const b = await admin.call('GET', '/api/org');
    expect(b.json.logo.version).toBe(u.fileId);
    expect(b.json.logo.version).not.toBe(first);
    expect((await klAdmin.call('GET', '/api/org')).json.logo).toEqual({ hasLogo: false, version: null });
  });

  it('serves the logo as an image with the real type, a sandbox and hour long private caching', async () => {
    // SVG (the current logo)
    const svg = await admin.call('GET', '/api/org/logo?v=anything');
    expect(svg.status).toBe(200);
    expect(svg.res.headers['content-type']).toBe('image/svg+xml');
    expect(svg.res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(svg.res.headers['x-content-type-options']).toBe('nosniff');
    expect(svg.res.headers['cache-control']).toBe('private, max-age=3600');
    expect(svg.res.headers['content-disposition']).toBe('inline');
    expect(svg.res.rawPayload.equals(LOGO_SVG)).toBe(true);
    // PNG and JPEG
    for (const [name, data, type] of [['p.png', LOGO_PNG, 'image/png'], ['j.jpg', jpegOfSize(600, 200), 'image/jpeg']] as const) {
      const u = await uploadLogo(admin, name, data);
      expect((await admin.call('POST', '/api/org/logo', { fileId: u.fileId })).status).toBe(200);
      const g = await admin.call('GET', '/api/org/logo');
      expect(g.res.headers['content-type']).toBe(type);
      expect(g.res.headers['cache-control']).toBe('private, max-age=3600');
      expect(g.res.headers['x-content-type-options']).toBe('nosniff');
      expect(g.res.headers['content-security-policy']).toContain('sandbox');
      expect(g.res.rawPayload.equals(data)).toBe(true);
    }
    // other API answers stay uncached, and so do errors of the logo route
    expect((await admin.call('GET', '/api/org/profile')).res.headers['cache-control']).toBe('no-store');
    expect((await new Client(app).call('GET', '/api/org/logo')).res.headers['cache-control']).toBe('no-store');
    expect((await klAdmin.call('GET', '/api/org/logo')).status).toBe(403);
  });

  it('answers 404 without caching when there is no logo, and the profile and checklist say so', async () => {
    const keep = (await q(`SELECT logo_file_id FROM organizations WHERE id = $1`, [isoId]))[0].logo_file_id;
    expect(keep).toBeNull();
    const none = await iso.call('GET', '/api/org/logo');
    expect(none.status).toBe(404);
    expect(none.res.headers['cache-control']).toBe('no-store');
    expect(none.res.headers['content-type']).not.toMatch(/image/);
    expect((await iso.call('GET', '/api/org')).json.logo).toEqual({ hasLogo: false, version: null });
    expect((await iso.call('GET', '/api/org/profile')).json).toMatchObject({ logoRequired: true, hasLogo: false, logo: { hasLogo: false, version: null } });
    // adding and removing through the API
    const u = await uploadLogo(iso, 'iso.png', LOGO_PNG);
    expect((await iso.call('POST', '/api/org/logo', { fileId: u.fileId })).status).toBe(200);
    expect((await iso.call('GET', '/api/org')).json.logo.hasLogo).toBe(true);
    expect((await iso.call('DELETE', '/api/org/logo')).status).toBe(200);
    expect((await iso.call('GET', '/api/org')).json.logo).toEqual({ hasLogo: false, version: null });
    expect((await iso.call('GET', '/api/org/logo')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('sending the case address with direct manufacturing cases', () => {
  /** The portal block as the partner sees it, plus the error texts from the database: a partner is never given those (usability review of 8 Oct 2026, R3). */
  const portalOf = async (up_: Client, id: string) => {
    const p = (await up_.call('GET', `/api/cases/${id}`)).json.case.portal;
    expect(p.lastError).toBeUndefined();
    const db = (await q(`SELECT portal_push->>'lastError' AS e FROM cases WHERE id = $1`, [id]))[0];
    return db?.e ? { ...p, lastError: db.e as string } : p;
  };

  async function directCase(c: Client, pid: string, first: string, last: string, opts: { files?: boolean } = {}) {
    const b = await c.call('POST', '/api/bulk/batches', { cases: [{ key: pid, patientId: pid, firstName: first, lastName: last }] });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    const id = b.json.cases[0].id as string;
    if (opts.files !== false) {
      await c.uploadFile(id, `${pid}_U01.stl`, cubeStl(50));
      await c.uploadFile(id, `${pid}_U01.pts`, trimLine());
      await c.uploadFile(id, `${pid}_U01.csv`, laserCsv());
      await c.uploadFile(id, 'report.pdf', minimalPdf());
    }
    return id;
  }
  const submit = (c: Client, id: string) => c.call('POST', `/api/cases/${id}/submit`, {});

  it('creates the case, sets the address exactly as mapped, uploads, then submits', async () => {
    fake.reset();
    const id = await directCase(up, '91001', 'Maya', 'Order');
    expect((await submit(up, id)).status).toBe(200);
    await runDueJobs();
    expect(fake.calls.map((c) => c.op)).toEqual(['createCase', 'setShippingAddress', 'uploadFile', 'uploadFile', 'submitCase', 'getCase']);
    const pc = [...fake.cases.values()][0]!;
    expect(pc.shippingAddress).toEqual(toPortalShipping(ACME_ADDRESS));
    expect(pc.shippingAddress).toEqual({
      shipping_street_address: '1 Rua Direita', shipping_city: 'Chaves', shipping_country: 'PT', shipping_postal_code: '5400-001', shipping_state_province: 'Vila Real',
      shipping_full_name: 'Alex Acme', shipping_phone_number: '+351276000000', shipping_email_address: 'goods@acme.demo', shipping_company: 'Acme Aligners Ltd',
    });
    expect(pc.submitted).toBe(true);
    expect(await portalOf(up, id)).toMatchObject({ status: 'pushed' });
    expect((await q(`SELECT portal_push->'uploads'->>'address' AS a FROM cases WHERE id = $1`, [id]))[0].a).toBe('true');
    // nobody in the seed has an own address (per user addresses are tested in phase8.useraddress.test.ts), so the company address was used
    expect((await q(`SELECT portal_push->>'addressSource' AS s FROM cases WHERE id = $1`, [id]))[0].s).toBe('company');
    // the address is not in events, audit entries or job rows
    const dump = JSON.stringify([await q('SELECT data FROM case_events WHERE case_id = $1', [id]), await q('SELECT payload, last_error FROM jobs'), (await admin.call('GET', '/api/audit?limit=200')).json]);
    expect(dump).not.toMatch(/Rua Direita|Chaves|276000000|goods@acme/);
    // it is not on the case JSON either
    expect(JSON.stringify((await up.call('GET', `/api/cases/${id}`)).json)).not.toMatch(/Rua Direita|shipping/i);
    expect(JSON.stringify((await up.call('GET', '/api/cases?mode=direct')).json)).not.toMatch(/Rua Direita|shipping/i);
  });

  it('does not repeat the address, nor the case, when the push is retried', async () => {
    fake.reset();
    const id = await directCase(up, '91002', 'Rita', 'Retry');
    fake.failNext('uploadFile', 'server', 1, 503, 0);
    await submit(up, id);
    await runDueJobs();
    expect(await portalOf(up, id)).toMatchObject({ status: 'pending' });
    expect((await q(`SELECT portal_push->'uploads'->>'address' AS a FROM cases WHERE id = $1`, [id]))[0].a).toBe('true');
    await q(`UPDATE jobs SET run_at = now() WHERE kind = 'bulk.push' AND status = 'queued'`);
    await runDueJobs();
    expect(await portalOf(up, id)).toMatchObject({ status: 'pushed', attempts: 2 });
    expect(fake.calls.filter((c) => c.op === 'createCase')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.op === 'setShippingAddress')).toHaveLength(1);
    expect(fake.calls.map((c) => c.op).indexOf('setShippingAddress')).toBeLessThan(fake.calls.map((c) => c.op).indexOf('uploadFile'));
  });

  it('tries the address again when only that call failed, without a second case', async () => {
    fake.reset();
    const id = await directCase(up, '91003', 'Sam', 'Again');
    fake.failNext('setShippingAddress', 'server', 1, 503);
    await submit(up, id);
    await runDueJobs();
    const mid = await portalOf(up, id);
    expect(mid.status).toBe('pending');
    expect(mid.lastError).toBe('The K Line portal had a problem on its side. (HTTP 503)');
    expect([...fake.cases.values()][0]!.shippingAddress).toBeUndefined();
    await q(`UPDATE jobs SET run_at = now() WHERE kind = 'bulk.push' AND status = 'queued'`);
    await runDueJobs();
    expect(await portalOf(up, id)).toMatchObject({ status: 'pushed' });
    expect(fake.calls.filter((c) => c.op === 'createCase')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.op === 'setShippingAddress')).toHaveLength(2);
    expect([...fake.cases.values()][0]!.shippingAddress).toEqual(toPortalShipping(ACME_ADDRESS));
  });

  it('stops for good when the portal refuses the address, without uploading or submitting', async () => {
    fake.reset();
    const id = await directCase(up, '91004', 'Pia', 'Refused');
    fake.failNext('setShippingAddress', 'validation', 1, 400);
    await submit(up, id);
    await runDueJobs();
    const p = await portalOf(up, id);
    expect(p).toMatchObject({ status: 'failed', lastError: 'The K Line portal rejected the request. (HTTP 400)' });
    expect(fake.calls.map((c) => c.op)).toEqual(['createCase', 'setShippingAddress']);
    expect([...fake.cases.values()][0]!.submitted).toBe(false);
    // nothing runs again now: the one queued job is the Hub's own retry for later (the partner is not told, K Line is)
    expect((await q(`SELECT run_at > now() AS later FROM jobs WHERE kind = 'bulk.push' AND status = 'queued' AND payload->>'caseId' = $1`, [id])).every((j) => j.later)).toBe(true);
    // a retry by hand finishes the job (the address call is repeated, the case is not)
    expect((await up.call('POST', `/api/cases/${id}/portal/retry`, {})).status).toBe(200);
    await runDueJobs();
    expect(await portalOf(up, id)).toMatchObject({ status: 'pushed' });
    expect(fake.calls.filter((c) => c.op === 'createCase')).toHaveLength(1);
  });

  it('fails permanently with the fixed message when the address went missing before the push, then works after the fix', async () => {
    fake.reset();
    const id = await directCase(up, '91005', 'Gus', 'Missing');
    await submit(up, id);
    await setAddress(acmeId, { ...ACME_ADDRESS, phone: '' });
    await runDueJobs();
    const p = await portalOf(up, id);
    expect(p).toMatchObject({ status: 'failed', lastError: CASE_ADDRESS_REQUIRED_MESSAGE });
    expect(p.lastError).toBe('Add your case address in the company profile, then press Try again.');
    expect(fake.calls).toEqual([]); // nothing was created at the portal
    // no retries are queued
    expect((await q(`SELECT status, attempts FROM jobs WHERE kind = 'bulk.push' AND payload->>'caseId' = $1`, [id])).every((j) => j.status !== 'queued')).toBe(true);
    // the failure is in the record for K Line, and not in the partner's timeline
    expect((await up.call('GET', `/api/cases/${id}`)).json.events.some((e: any) => e.type === 'portal_push_failed')).toBe(false);
    const events = await q(`SELECT data FROM case_events WHERE case_id = $1 AND type = 'portal_push_failed'`, [id]);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ code: 'case_address_required' });
    expect(JSON.stringify(events)).not.toMatch(/Gus|Missing/);
    // the one thing the partner can fix is shown to them
    expect((await up.call('GET', `/api/cases/${id}`)).json.case.portal.actionNeeded).toBe('case_address');
    // the partner fixes the profile and presses Try again
    expect((await admin.call('PUT', '/api/org/profile', { caseAddress: { phone: '+351276000000' } })).status).toBe(200);
    expect((await up.call('POST', `/api/cases/${id}/portal/retry`, {})).status).toBe(200);
    await runDueJobs();
    expect(await portalOf(up, id)).toMatchObject({ status: 'pushed' });
    expect(fake.calls.map((c) => c.op).slice(0, 2)).toEqual(['createCase', 'setShippingAddress']);
  });

  it('does not change the address of a case that was already pushed when the profile changes later', async () => {
    fake.reset();
    const id = await directCase(up, '91006', 'Eli', 'Early');
    await submit(up, id);
    await runDueJobs();
    const pc = [...fake.cases.values()][0]!;
    const sent = { ...pc.shippingAddress };
    await admin.call('PUT', '/api/org/profile', { caseAddress: { city: 'Porto' } });
    await runDueJobs();
    expect(pc.shippingAddress).toEqual(sent);
    expect(fake.calls.filter((c) => c.op === 'setShippingAddress')).toHaveLength(1);
    await admin.call('PUT', '/api/org/profile', { caseAddress: { city: 'Chaves' } });
  });

  it('answers 409 case_address_required early, before any upload, for batches and for direct submits', async () => {
    fake.reset();
    // a draft that already exists when the address is removed
    const draft = await directCase(up, '91007', 'Dora', 'Draft');
    await setAddress(acmeId, null);
    try {
      const batch = await up.call('POST', '/api/bulk/batches', { cases: [{ key: 'k', patientId: '91008', firstName: 'No', lastName: 'Batch' }] });
      expect(batch.status).toBe(409);
      expect(batch.json).toEqual({ code: 'case_address_required', message: 'Add your case address in the company profile, then press Try again.' });
      expect(await q(`SELECT 1 FROM cases WHERE partner_case_id = '91008'`)).toHaveLength(0);
      const sub = await submit(up, draft);
      expect(sub.status).toBe(409);
      expect(sub.json.code).toBe('case_address_required');
      expect((await q(`SELECT status FROM cases WHERE id = $1`, [draft]))[0].status).toBe('draft');
      expect(await q(`SELECT 1 FROM jobs WHERE kind = 'bulk.push' AND payload->>'caseId' = $1`, [draft])).toHaveLength(0);
      // an incomplete address counts as missing
      await setAddress(acmeId, { ...ACME_ADDRESS, stateProvince: '' });
      expect((await up.call('POST', '/api/bulk/batches', { cases: [{ key: 'k', patientId: '91008', firstName: 'No', lastName: 'Batch' }] })).json.code).toBe('case_address_required');
      // standard cases are not affected
      const std = await up.call('POST', '/api/cases', { caseId: 'STD-P8' });
      expect(std.status).toBe(201);
      expect((await submit(up, std.json.case.id)).json.code).not.toBe('case_address_required');
      // another company with an address is not affected, whatever Acme did
      const other = await iso.call('POST', '/api/bulk/batches', { cases: [{ key: 'k', patientId: '77001', firstName: 'Iso', lastName: 'Patient' }] });
      expect(other.status, JSON.stringify(other.json)).toBe(201);
    } finally {
      await setAddress(acmeId, ACME_ADDRESS);
    }
    // once the address is back the draft goes through
    expect((await submit(up, draft)).status).toBe(200);
    await runDueJobs();
    expect(await portalOf(up, draft)).toMatchObject({ status: 'pushed' });
  });

  it('gives the same gate to a partner API key', async () => {
    const key = await tx(SYSTEM, (c) => createApiKey(c, { orgId: acmeId, orgKind: 'partner', name: 'Phase 8 test key', scopes: ['cases:read', 'cases:write'], expiresInDays: 30 }));
    const post = (patientId: string) =>
      app.inject({
        method: 'POST', url: '/api/bulk/batches', headers: { authorization: `Bearer ${key.key}` }, remoteAddress: '10.9.9.9',
        payload: { cases: [{ key: 'k', patientId, firstName: 'Key', lastName: 'User' }] },
      });
    await setAddress(acmeId, null);
    try {
      const blocked = await post('91010');
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().code).toBe('case_address_required');
    } finally {
      await setAddress(acmeId, ACME_ADDRESS);
    }
    expect((await post('91010')).statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Every team member except viewers can change the company logo (permission org.logo). Brand logos and the rest of the profile stay org.edit.
describe('who may change the company logo', () => {
  let quality: Client;
  let finance: Client;
  let intake: Client;
  const userId = async (email: string) => (await q(`SELECT id FROM users WHERE lower(email) = $1`, [email]))[0].id as string;
  const logoOf = async (orgId: string) => (await q(`SELECT logo_file_id FROM organizations WHERE id = $1`, [orgId]))[0].logo_file_id as string | null;
  const emailJobs = async () => (await q(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'email.send'`))[0].n as number;
  const logoNotes = async () => (await q(`SELECT count(*)::int AS n FROM notifications WHERE kind IN ('org_logo_changed', 'org_logo_removed')`))[0].n as number;
  const NO_FILE = '00000000-0000-4000-8000-000000000000';

  beforeAll(async () => {
    quality = await new Client(app).full('quality@acme.demo');
    finance = await new Client(app).full('finance@acme.demo');
    intake = await new Client(app).full('intake@kline.demo');
  });

  it('grants org.logo to admin, uploader, quality and finance only', async () => {
    const { ROLE_PERMISSIONS } = await import('../../shared/roles');
    for (const role of ['admin', 'uploader', 'quality', 'finance'] as const) expect(ROLE_PERMISSIONS[role], role).toContain('org.logo');
    expect(ROLE_PERMISSIONS.viewer).not.toContain('org.logo');
    for (const role of ['kl_intake', 'kl_production', 'kl_quality', 'kl_finance'] as const) expect(ROLE_PERMISSIONS[role], role).not.toContain('org.logo');
    // org.edit is still only for administrators
    for (const role of ['uploader', 'quality', 'finance', 'viewer'] as const) expect(ROLE_PERMISSIONS[role], role).not.toContain('org.edit');
  });

  it('lets admin, uploader, quality and finance upload and change the logo', async () => {
    for (const [role, c] of [['admin', admin], ['uploader', up], ['quality', quality], ['finance', finance]] as const) {
      const before = await logoOf(acmeId);
      const u = await uploadLogo(c, `${role}.png`, LOGO_PNG);
      expect(u.state, role).toBe('ready');
      const r = await c.call('POST', '/api/org/logo', { fileId: u.fileId });
      expect(r.status, `${role} ${JSON.stringify(r.json)}`).toBe(200);
      expect(r.json).toEqual({ hasLogo: true, version: u.fileId });
      expect(await logoOf(acmeId)).toBe(u.fileId);
      // the replaced logo file is gone, so no stale copy is kept
      expect(await q(`SELECT 1 FROM files WHERE id = $1`, [before])).toHaveLength(0);
      expect((await c.call('GET', '/api/org')).json.logo.version).toBe(u.fileId);
    }
  });

  it('refuses viewers, K Line staff, API keys and anonymous callers', async () => {
    const before = await logoOf(acmeId);
    const mine = await uploadLogo(admin, 'for-others.png', LOGO_PNG);
    // viewer: reads, never changes
    expect((await viewer.call('GET', '/api/org/logo')).status).toBe(200);
    expect((await viewer.call('POST', '/api/uploads', { purpose: 'logo', name: 'v.png', size: LOGO_PNG.length })).status).toBe(403);
    expect((await viewer.call('POST', '/api/org/logo', { fileId: mine.fileId })).status).toBe(403);
    expect((await viewer.call('DELETE', '/api/org/logo')).status).toBe(403);
    // K Line staff use the console, not these routes
    for (const c of [klAdmin, intake]) {
      expect((await c.call('POST', '/api/uploads', { purpose: 'logo', name: 'k.png', size: LOGO_PNG.length })).status).toBe(403);
      expect((await c.call('POST', '/api/org/logo', { fileId: mine.fileId })).status).toBe(403);
      expect((await c.call('DELETE', '/api/org/logo')).status).toBe(403);
    }
    // a partner API key has no scope for it
    const key = await tx(SYSTEM, (c) => createApiKey(c, { orgId: acmeId, orgKind: 'partner', name: 'Logo test key', scopes: ['cases:read', 'cases:write', 'claims:read', 'materials:read'], expiresInDays: 30 }));
    const bearer = { authorization: `Bearer ${key.key}` };
    expect([401, 403]).toContain((await app.inject({ method: 'POST', url: '/api/org/logo', headers: bearer, payload: { fileId: mine.fileId }, remoteAddress: '10.9.9.8' })).statusCode);
    expect([401, 403]).toContain((await app.inject({ method: 'DELETE', url: '/api/org/logo', headers: bearer, remoteAddress: '10.9.9.8' })).statusCode);
    expect((await app.inject({ method: 'POST', url: '/api/uploads', headers: bearer, payload: { purpose: 'logo', name: 'key.png', size: LOGO_PNG.length }, remoteAddress: '10.9.9.8' })).statusCode).toBe(403);
    // nobody signed in
    const anon = new Client(app);
    expect((await anon.call('POST', '/api/org/logo', { fileId: mine.fileId })).status).toBe(401);
    expect((await anon.call('DELETE', '/api/org/logo')).status).toBe(401);
    expect((await anon.call('POST', '/api/uploads', { purpose: 'logo', name: 'a.png', size: 10 })).status).toBe(401);
    // nothing changed
    expect(await logoOf(acmeId)).toBe(before);
    await q(`DELETE FROM files WHERE id = $1`, [mine.fileId]);
  });

  it('keeps brand logos, documents and the profile for administrators', async () => {
    const brand = await admin.call('POST', '/api/org/brands', { name: 'Admin Only Brand' });
    expect(brand.status).toBe(201);
    const id = brand.json.brand.id as string;
    for (const [role, c] of [['uploader', up], ['quality', quality], ['finance', finance], ['viewer', viewer]] as const) {
      expect((await c.call('POST', `/api/org/brands/${id}/logo`, { fileId: NO_FILE })).status, `${role} brand logo`).toBe(403);
      expect((await c.call('DELETE', `/api/org/brands/${id}/logo`)).status, `${role} brand logo delete`).toBe(403);
      expect((await c.call('POST', '/api/org/brands', { name: `B ${role}` })).status, `${role} new brand`).toBe(403);
      expect((await c.call('PUT', '/api/org/profile', {})).status, `${role} profile`).toBe(403);
      expect((await c.call('POST', '/api/uploads', { purpose: 'document', kind: 'other', name: 'x.pdf', size: 10 })).status, `${role} document`).toBe(403);
    }
    // an administrator still can, and a brand logo change is not a company logo change
    const notes = await logoNotes();
    const u = await uploadLogo(admin, 'brand.png', PNG_BYTES);
    expect((await admin.call('POST', `/api/org/brands/${id}/logo`, { fileId: u.fileId })).status).toBe(200);
    expect(await q(`SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'org.brand_logo_updated' AND target_id = $2`, [acmeId, id])).toHaveLength(1);
    expect(await logoNotes()).toBe(notes);
    expect((await admin.call('DELETE', `/api/org/brands/${id}`)).status).toBe(200);
  });

  it('writes the actor and only the file kind to the access log, and tells the administrators without sending email', async () => {
    const uma = await userId('upload@acme.demo');
    const alex = await userId('admin@acme.demo');
    const mailBefore = await emailJobs();
    const notesBefore = await logoNotes();

    const u = await uploadLogo(up, 'uma.svg', LOGO_SVG);
    expect((await up.call('POST', '/api/org/logo', { fileId: u.fileId })).status).toBe(200);

    const entry = (await q(`SELECT actor_type, actor_id, org_id, target_type, target_id, details FROM audit_log WHERE org_id = $1 AND action = 'org.logo_changed' ORDER BY seq DESC LIMIT 1`, [acmeId]))[0];
    expect(entry).toMatchObject({ actor_type: 'user', actor_id: uma, org_id: acmeId, target_type: 'organization', target_id: acmeId });
    expect(entry.details).toEqual({ kind: 'svg' }); // no file name, no size, nothing else

    // the partner's own access log names the person
    const log = await admin.call('GET', '/api/audit?action=org.logo');
    expect(log.status).toBe(200);
    expect(log.json.entries[0]).toMatchObject({ action: 'org.logo_changed', actorLabel: 'Uma Upload', details: { kind: 'svg' } });

    // the administrator hears about it in the app, the person who did it does not, and no email was queued
    const notes = await admin.call('GET', '/api/notifications');
    const n = notes.json.items.find((i: any) => i.kind === 'org_logo_changed');
    expect(n).toMatchObject({ title: 'Uma Upload changed the company logo', read: false });
    expect(n.body ?? null).toBeNull();
    expect(JSON.stringify(n)).not.toMatch(/uma\.svg|\.svg|\.png/);
    expect((await up.call('GET', '/api/notifications')).json.items.filter((i: any) => i.kind === 'org_logo_changed')).toHaveLength(0);
    expect((await q(`SELECT user_id FROM notifications WHERE kind = 'org_logo_changed' AND org_id = $1 ORDER BY created_at DESC LIMIT 1`, [acmeId]))[0].user_id).toBe(alex);
    expect(await logoNotes()).toBe(notesBefore + 1);
    expect(await emailJobs()).toBe(mailBefore);

    // removal is recorded the same way
    expect((await finance.call('DELETE', '/api/org/logo')).status).toBe(200);
    const gone = (await q(`SELECT actor_id, details FROM audit_log WHERE org_id = $1 AND action = 'org.logo_removed' ORDER BY seq DESC LIMIT 1`, [acmeId]))[0];
    expect(gone.actor_id).toBe(await userId('finance@acme.demo'));
    expect(gone.details).toEqual({ kind: 'svg' });
    expect((await admin.call('GET', '/api/notifications')).json.items.find((i: any) => i.kind === 'org_logo_removed').title).toBe('Finn Finance removed the company logo');
    expect(await logoOf(acmeId)).toBeNull();
    expect(await q(`SELECT 1 FROM files WHERE id = $1`, [u.fileId])).toHaveLength(0);
    expect(await emailJobs()).toBe(mailBefore);

    // an administrator's own change tells nobody else (Alex is the only administrator) and still reaches the log
    const own = await uploadLogo(admin, 'alex.png', LOGO_PNG);
    expect((await admin.call('POST', '/api/org/logo', { fileId: own.fileId })).status).toBe(200);
    expect(await logoNotes()).toBe(notesBefore + 2);
    expect((await q(`SELECT actor_id FROM audit_log WHERE org_id = $1 AND action = 'org.logo_changed' ORDER BY seq DESC LIMIT 1`, [acmeId]))[0].actor_id).toBe(alex);
  });

  it('keeps the other logo files safe when one is replaced', async () => {
    // a brand logo is a separate file: replacing the company logo never touches it
    const brand = await admin.call('POST', '/api/org/brands', { name: 'Keeper Brand' });
    const bid = brand.json.brand.id as string;
    const bl = await uploadLogo(admin, 'keeper.png', LOGO_PNG);
    expect((await admin.call('POST', `/api/org/brands/${bid}/logo`, { fileId: bl.fileId })).status).toBe(200);
    const next = await uploadLogo(quality, 'quinn.png', LOGO_PNG);
    expect((await quality.call('POST', '/api/org/logo', { fileId: next.fileId })).status).toBe(200);
    expect((await admin.call('GET', `/api/org/brands/${bid}/logo`)).status).toBe(200);
    // a file that already serves another purpose cannot be taken over by the company logo
    expect((await quality.call('POST', '/api/org/logo', { fileId: bl.fileId })).status).toBe(409);
    expect((await admin.call('GET', `/api/org/brands/${bid}/logo`)).status).toBe(200);
    expect(await logoOf(acmeId)).toBe(next.fileId);
    // choosing the file that is already the logo changes nothing and deletes nothing
    expect((await quality.call('POST', '/api/org/logo', { fileId: next.fileId })).status).toBe(200);
    expect((await q(`SELECT state FROM files WHERE id = $1`, [next.fileId]))[0].state).toBe('ready');
    expect((await admin.call('GET', '/api/org/logo')).status).toBe(200);
    expect((await admin.call('DELETE', `/api/org/brands/${bid}`)).status).toBe(200);
  });

  it('applies every check to people who are not administrators and deletes a refused file', async () => {
    const keep = await logoOf(acmeId);
    const small = await uploadLogo(up, 'small.png', pngOfSize(300, 100));
    const r = await up.call('POST', '/api/org/logo', { fileId: small.fileId });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('logo_too_small');
    expect(await q(`SELECT 1 FROM files WHERE id = $1`, [small.fileId])).toHaveLength(0);
    const evil = await uploadLogo(quality, 'evil.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 90"><script>alert(1)</script></svg>'));
    expect(evil.state).toBe('rejected');
    expect((await quality.call('POST', '/api/org/logo', { fileId: evil.fileId })).json.code).toBe('file_not_ready');
    const big = await up.call('POST', '/api/uploads', { purpose: 'logo', name: 'huge.png', size: 5 * 1024 * 1024 + 1 });
    expect(big.status).toBe(413);
    const exe = await finance.call('POST', '/api/uploads', { purpose: 'logo', name: 'run.exe', size: 100 });
    expect(exe.status).toBe(415);
    expect(await logoOf(acmeId)).toBe(keep);
    await q(`DELETE FROM files WHERE id = $1`, [evil.fileId]);
  });

  it('keeps companies apart', async () => {
    const contosoId = await orgIdOf('CONT');
    const cBefore = (await contoso.call('GET', '/api/org')).json.logo.version;
    const contosoNotes = (await contoso.call('GET', '/api/notifications')).json.items.length;
    const u = await uploadLogo(up, 'acme-only.png', LOGO_PNG);
    // another company cannot use or see Acme's file
    expect((await contoso.call('POST', '/api/org/logo', { fileId: u.fileId })).status).toBe(404);
    expect((await up.call('POST', '/api/org/logo', { fileId: u.fileId })).status).toBe(200);
    // Acme's change leaves Contoso's logo, log and bell alone
    expect((await contoso.call('GET', '/api/org')).json.logo.version).toBe(cBefore);
    expect((await contoso.call('GET', '/api/notifications')).json.items).toHaveLength(contosoNotes);
    expect((await contoso.call('GET', '/api/audit?action=org.logo')).json.entries.every((e: any) => e.actorLabel !== 'Uma Upload')).toBe(true);
    expect(await q(`SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'org.logo_changed' AND actor_id = $2`, [contosoId, await userId('upload@acme.demo')])).toHaveLength(0);
    // the other way round: a Contoso user's change is written to Contoso's log only
    const cu = await uploadLogo(contoso, 'contoso-new.png', LOGO_PNG);
    expect((await contoso.call('POST', '/api/org/logo', { fileId: cu.fileId })).status).toBe(200);
    expect(await q(`SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'org.logo_changed' AND actor_id = $2`, [acmeId, await userId('owner@contoso.demo')])).toHaveLength(0);
    expect(await logoOf(acmeId)).toBe(u.fileId);
  });
});
