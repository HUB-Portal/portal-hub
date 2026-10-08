import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { base32Decode, totpCode } from '../src/crypto/totp';
import { runDueJobs } from '../src/worker';
import { runRetention } from '../src/services/retention';
import { PRIVACY_VERSION } from '../../shared/signup';
import { chunkKey, storage } from '../src/storage';
import { Client, LOGO_PNG, LOGO_SVG, PNG_BYTES, createDemoUser, jpegOfSize, minimalPdf, orgIdOf } from './helpers';

let app: FastifyInstance;
let acmeId: string;
let klineId: string;
let klAdmin: Client;
let intake: Client;
let acmeAdmin: Client;
let acmeUp: Client;
let acmeQuality: Client;
let acmeFinance: Client;
let acmeViewer: Client;
let contoso: Client; // seed: Contoso Smile owner, confirmed and waiting for review
let contosoId: string;
let fabrikamId: string;
const logLines: string[] = [];

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);
let n = 0;
const uniqueEmail = () => `p5.user${++n}.${Math.random().toString(36).slice(2, 6)}@zyxwv-dental.test`;
const form = (over: Record<string, unknown> = {}) => ({
  companyName: 'Zyxwv Quartz Dental',
  country: 'DE',
  personName: 'Pascal Quirk',
  email: uniqueEmail(),
  website: 'https://zyxwv.example',
  volume: '1000_5000',
  acceptAuthority: true,
  acceptPrivacy: true,
  privacyVersion: PRIVACY_VERSION,
  caseAddress: { street: '5 Quarzweg', city: 'Hamburg', postalCode: '20095', stateProvince: 'Hamburg', country: 'DE', phone: '+4940123456' },
  ...over,
});
const GOOD_PASSWORD = 'Correct-Horse-Battery-Staple-7';

async function register(over: Record<string, unknown> = {}, client: Client = new Client(app)) {
  const body = form(over);
  const r = await client.call('POST', '/api/auth/register', body);
  return { r, body: body as Record<string, any>, email: body.email as string };
}
const flush = () => runDueJobs();
const mailTo = (email: string) => q<{ subject: string; body: string }>(`SELECT subject, body FROM dev_mailbox WHERE to_addr = $1 ORDER BY created_at, id`, [email]);
const tokenIn = (body: string) => /\/verify\?token=([A-Za-z0-9_-]+)/.exec(body)?.[1] ?? null;
async function confirmToken(email: string): Promise<string> {
  await flush();
  const mails = (await mailTo(email)).filter((m) => m.subject.startsWith('Confirm your email'));
  // the live link: earlier ones are retired when a fresh one is sent, and parallel workers may write the emails in any order
  for (const m of mails) {
    const t = tokenIn(m.body);
    if (t && (await new Client(app).call('GET', `/api/auth/verify/${t}`)).json.valid) return t;
  }
  throw new Error('no live confirmation link for ' + email);
}
const orgOf = async (email: string) => (await q(`SELECT o.* FROM organizations o JOIN users u ON u.org_id = o.id WHERE lower(u.email) = $1`, [email.toLowerCase()]))[0];
const countMail = async (email: string, subjectStart: string) => (await mailTo(email)).filter((m) => m.subject.startsWith(subjectStart)).length;

/** Registers, confirms the email address and sets a password. Returns the client (mfa_setup session) and identifiers. */
async function registerAndVerify(over: Record<string, unknown> = {}) {
  const { r, email, body } = await register(over);
  expect(r.status).toBe(202);
  const token = await confirmToken(email);
  const c = new Client(app);
  const v = await c.call('POST', '/api/auth/verify', { token, password: GOOD_PASSWORD });
  expect(v.status, JSON.stringify(v.json)).toBe(200);
  expect(v.json.stage).toBe('mfa_setup');
  const org = await orgOf(email);
  return { c, email, token, org, orgId: org.id as string, body };
}
/** Completes the authenticator setup of a session in stage mfa_setup. */
async function enrol(c: Client) {
  const s = await c.call('POST', '/api/auth/mfa/setup', {});
  expect(s.status).toBe(200);
  const code = totpCode(base32Decode(s.json.secret), Date.now() / 1000);
  const done = await c.call('POST', '/api/auth/mfa/setup/confirm', { code });
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  expect(done.json.stage).toBe('full');
  return { secret: s.json.secret as string };
}
async function grantDpaAndSite(orgId: string) {
  await q(`INSERT INTO agreements (org_id, type, signed_at, signed_by) VALUES ($1, 'dpa', current_date, 'K Line test')`, [orgId]);
  await q(`INSERT INTO org_sites (org_id, site_id) SELECT $1, id FROM sites WHERE code = 'PT-CHV' ON CONFLICT DO NOTHING`, [orgId]);
}
const activate = (id: string) => klAdmin.call('POST', `/api/partners/${id}/activate`, {});
const sortJson = (v: unknown) => JSON.stringify(v);

async function uploadProfile(c: Client, purpose: 'logo' | 'document', name: string, data: Buffer, extra: Record<string, unknown> = {}) {
  const init = await c.call('POST', '/api/uploads', { purpose, name, size: data.length, ...extra });
  if (init.status !== 200) return { init, fileId: null as string | null, state: null as string | null, row: null as any };
  const fileId = init.json.fileId as string;
  const put = await c.putChunk(fileId, 0, data);
  expect(put.status, JSON.stringify(put.json)).toBe(200);
  const done = await c.call('POST', `/api/uploads/${fileId}/complete`, {});
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  await runDueJobs();
  const row = (await q(`SELECT state, validation FROM files WHERE id = $1`, [fileId]))[0];
  return { init, fileId, state: row.state as string, row };
}
const SVG_OK = LOGO_SVG;
const SVG_BAD = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const JPEG = jpegOfSize(600, 200);
/** Uploads a logo that passes the company logo rules and attaches it. */
async function attachLogo(c: Client, data: Buffer = LOGO_PNG, name = 'logo.png') {
  const up = await uploadProfile(c, 'logo', name, data);
  expect(up.state).toBe('ready');
  const set = await c.call('POST', '/api/org/logo', { fileId: up.fileId });
  expect(set.status, JSON.stringify(set.json)).toBe(200);
  return up.fileId as string;
}

beforeAll(async () => {
  await seedDemo({ force: true });
  const stream = new Writable({ write: (chunk, _e, cb) => { logLines.push(String(chunk)); cb(); } });
  app = await buildApp({ logStream: stream });
  await app.ready();
  acmeId = await orgIdOf('ACME');
  klineId = await orgIdOf('KLINE');
  contosoId = await orgIdOf('CONT');
  fabrikamId = await orgIdOf('FDL');
  await createDemoUser(acmeId, 'viewer@acme.demo', 'Vic Viewer', ['viewer']);
  klAdmin = await new Client(app).full('admin@kline.demo');
  intake = await new Client(app).full('intake@kline.demo');
  acmeAdmin = await new Client(app).full('admin@acme.demo');
  acmeUp = await new Client(app).full('upload@acme.demo');
  acmeQuality = await new Client(app).full('quality@acme.demo');
  acmeFinance = await new Client(app).full('finance@acme.demo');
  acmeViewer = await new Client(app).full('viewer@acme.demo');
  contoso = await new Client(app).full('owner@contoso.demo');
});
afterAll(async () => {
  config.signupMinMs = 20;
  await app.close();
  await closePools();
});

// ===========================================================================
describe('public configuration and seed', () => {
  it('answers the public config without signing in', async () => {
    const r = await new Client(app).call('GET', '/api/public/config');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ privacyEmail: 'privacy@hub.test', supportEmail: 'support@hub.test', signupEnabled: true, privacyVersion: PRIVACY_VERSION, googleSignIn: false, mfaRequired: true });
  });

  it('seeds Contoso Smile confirmed and waiting, and Fabrikam Dental Lab unconfirmed with a live link', async () => {
    const contosoRow = (await q(`SELECT * FROM organizations WHERE id = $1`, [contosoId]))[0];
    expect(contosoRow).toMatchObject({ name: 'Contoso Smile', status: 'onboarding', country: 'ES' });
    expect(contosoRow.signup).toMatchObject({ email: 'owner@contoso.demo', volume: '1000_5000', free_email: false, privacy_version: PRIVACY_VERSION });
    expect(contosoRow.signup.verified_at).toBeTruthy();
    expect(contosoRow.settings.manual_review).toBe(true);
    const fab = (await q(`SELECT * FROM organizations WHERE id = $1`, [fabrikamId]))[0];
    expect(fab.signup.verified_at).toBeNull();
    const list = await new Client(app).call('GET', '/api/demo/registrations');
    expect(list.status).toBe(200);
    const item = list.json.items.find((i: any) => i.email === 'owner@fabrikam.demo');
    expect(item).toMatchObject({ path: expect.stringMatching(/^\/verify\?token=/), link: expect.stringContaining('/verify?token=') });
    // the listed link works: the token is valid
    const token = new URL(item.link).searchParams.get('token')!;
    const v = await new Client(app).call('GET', `/api/auth/verify/${token}`);
    expect(v.json).toMatchObject({ valid: true, email: 'owner@fabrikam.demo', orgName: 'Fabrikam Dental Lab' });
  });
});

// ===========================================================================
describe('registration end to end', () => {
  let email: string;
  let orgId: string;
  let c: Client;
  const typed = { companyName: 'Zyxwv Quartz Dental', personName: 'Pascal Quirk' };

  it('answers 202 with the fixed text and creates the company, the admin, a draft spec and one confirmation email', async () => {
    const { r, email: e } = await register(typed);
    email = e;
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true, message: expect.stringContaining('Please check your inbox') });
    const org = await orgOf(email);
    orgId = org.id;
    expect(org).toMatchObject({ kind: 'partner', name: 'Zyxwv Quartz Dental', status: 'onboarding', country: 'DE' });
    expect(org.code).toBe('ZQD');
    expect(org.settings).toMatchObject({ manual_review: true });
    expect(org.signup).toMatchObject({ email, name: 'Pascal Quirk', website: 'https://zyxwv.example', volume: '1000_5000', free_email: false, privacy_version: PRIVACY_VERSION, verified_at: null });
    const users = await q(`SELECT email, name, roles, status, password_hash FROM users WHERE org_id = $1`, [orgId]);
    expect(users).toEqual([{ email, name: 'Pascal Quirk', roles: ['admin'], status: 'invited', password_hash: null }]);
    expect(await q(`SELECT status, version FROM specs WHERE org_id = $1`, [orgId])).toEqual([{ status: 'draft', version: 1 }]);
    const tokens = await q(`SELECT kind, used_at, expires_at > now() + interval '47 hours' AS long_life FROM user_tokens WHERE org_id = $1`, [orgId]);
    expect(tokens).toEqual([{ kind: 'verify', used_at: null, long_life: true }]);
    await flush();
    const mails = await mailTo(email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toMatch(/^Confirm your email address/);
    expect(mails[0]!.body).toContain('/verify?token=');
    // the email does not repeat what was typed
    expect(mails[0]!.body).not.toMatch(/Zyxwv|Quirk/);
  });

  it('cannot sign in before the email address is confirmed', async () => {
    const l = await new Client(app).call('POST', '/api/auth/login', { email, password: GOOD_PASSWORD });
    expect(l.status).toBe(401);
  });

  it('shows the registrant their own details for a valid link and nothing for a bad one', async () => {
    const token = await confirmToken(email);
    const ok = await new Client(app).call('GET', `/api/auth/verify/${token}`);
    expect(ok.json).toEqual({ valid: true, email, name: 'Pascal Quirk', orgName: 'Zyxwv Quartz Dental' });
    const bad = await new Client(app).call('GET', '/api/auth/verify/not-a-real-token-1234567890');
    expect(bad.status).toBe(200);
    expect(bad.json).toEqual({ valid: false });
  });

  it('refuses weak passwords, then sets the password, marks the registration and starts an authenticator session', async () => {
    const token = await confirmToken(email);
    c = new Client(app);
    const weak = await c.call('POST', '/api/auth/verify', { token, password: 'password1234' });
    expect(weak.status).toBe(400);
    expect(weak.json.code).toBe('weak_password');
    const stillValid = await new Client(app).call('GET', `/api/auth/verify/${token}`);
    expect(stillValid.json.valid).toBe(true);
    const bad = await new Client(app).call('POST', '/api/auth/verify', { token: 'nonsense-token-nonsense', password: GOOD_PASSWORD });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('invalid_token');

    const v = await c.call('POST', '/api/auth/verify', { token, password: GOOD_PASSWORD });
    expect(v.status).toBe(200);
    expect(v.json).toEqual({ stage: 'mfa_setup', csrfToken: expect.any(String) });
    const org = await orgOf(email);
    expect(org.signup.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // single use
    const again = await new Client(app).call('POST', '/api/auth/verify', { token, password: GOOD_PASSWORD });
    expect(again.status).toBe(400);
    expect((await new Client(app).call('GET', `/api/auth/verify/${token}`)).json).toEqual({ valid: false });
    // still invited until the authenticator is set up
    expect((await q(`SELECT status, mfa_enabled FROM users WHERE lower(email) = $1`, [email]))[0]).toEqual({ status: 'invited', mfa_enabled: false });
    const me = await c.call('GET', '/api/auth/me');
    expect(me.json).toMatchObject({ stage: 'mfa_setup', permissions: [] });
  });

  it('tells K Line administrators once, in the app and by email, with fixed text and no typed name', async () => {
    await flush();
    const notes = await q(`SELECT kind, title, body, data FROM notifications WHERE org_id = $1 AND kind = 'signup_confirmed'`, [klineId]);
    const mine = notes.filter((x) => x.data.orgId === orgId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'A new company is waiting for review', body: 'A new company has confirmed its email address.' });
    const mails = (await mailTo('admin@kline.demo')).filter((m) => m.subject === 'A new company is waiting for review');
    expect(mails.length).toBeGreaterThanOrEqual(1);
    for (const m of mails) {
      expect(m.body).toContain('A new company has confirmed its email address');
      expect(m.body).toContain('/console/partners?tab=review');
      expect(m.body).not.toMatch(/Zyxwv|Quirk|ZQD/);
    }
    // nothing typed reaches any staff notification, queued job or audit entry
    const all = JSON.stringify([
      await q(`SELECT title, body, data FROM notifications WHERE org_id = $1`, [klineId]),
      await q(`SELECT action, details FROM audit_log WHERE org_id = $1`, [orgId]),
      await q(`SELECT subject, body FROM dev_mailbox WHERE to_addr LIKE '%@kline.demo'`),
    ]);
    expect(all).not.toMatch(/Zyxwv|Quirk/);
  });

  it('is locked until approval: uploads, team invites', async () => {
    await enrol(c);
    const inv = await c.call('POST', '/api/team/invite', { email: uniqueEmail(), name: 'Team Mate', roles: ['viewer'] });
    expect(inv.status).toBe(403);
    expect(inv.json.code).toBe('org_not_approved');
    const cs = await c.call('POST', '/api/cases', { caseId: 'Z-1' });
    expect(cs.status, JSON.stringify(cs.json)).toBe(201);
    const up = await c.call('POST', '/api/uploads', { purpose: 'case', caseId: cs.json.case.id, name: 'U01.stl', size: 100 });
    expect(up.status).toBe(403);
    expect(up.json.code).toBe('org_not_approved');
    // it can still read the account and edit the profile
    const me = await c.call('GET', '/api/auth/me');
    expect(me.json).toMatchObject({ stage: 'full', org: { status: 'onboarding' }, user: { mfaEnabled: true } });
    expect((await c.call('GET', '/api/org/profile')).status).toBe(200);
  });

  it('can be approved only once confirmed, with a DPA and a site, and then hears about it', async () => {
    const noDpa = await activate(orgId);
    expect(noDpa.status).toBe(409);
    expect(noDpa.json.code).toBe('dpa_required');
    await grantDpaAndSite(orgId);
    // K Line cannot approve a company without a logo
    const noLogo = await activate(orgId);
    expect(noLogo.status).toBe(409);
    expect(noLogo.json.code).toBe('logo_required');
    await attachLogo(c);
    const ok = await activate(orgId);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toEqual({ status: 'active' });
    const org = await orgOf(email);
    expect(org.status).toBe('active');
    expect(org.signup.approved_at).toMatch(/^\d{4}/);
    expect(org.signup.approved_by).toBeTruthy();
    await flush();
    const mails = (await mailTo(email)).filter((m) => m.subject.startsWith('Your company is approved'));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.body).toContain('/login');
    expect(mails[0]!.body).not.toMatch(/Zyxwv|Quirk/);
    expect(await q(`SELECT title FROM notifications WHERE org_id = $1 AND kind = 'org_approved'`, [orgId])).toHaveLength(1);
    expect((await q(`SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'partner.activated'`, [orgId])).length).toBe(1);
    // the team invite is open now (sessions read the organisation status on every request)
    const inv = await c.call('POST', '/api/team/invite', { email: uniqueEmail(), name: 'Team Mate', roles: ['viewer'] });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    // approving twice sends nothing more
    await activate(orgId);
    await flush();
    expect((await mailTo(email)).filter((m) => m.subject.startsWith('Your company is approved'))).toHaveLength(1);
  });
});

// ===========================================================================
describe('registration edge cases', () => {
  it('refuses activation of an unconfirmed registration', async () => {
    const { r, email } = await register();
    expect(r.status).toBe(202);
    const org = await orgOf(email);
    await grantDpaAndSite(org.id);
    const a = await activate(org.id);
    expect(a.status).toBe(409);
    expect(a.json.code).toBe('email_not_confirmed');
    expect((await orgOf(email)).status).toBe('onboarding');
    const detail = await klAdmin.call('GET', `/api/partners/${org.id}`);
    expect(detail.json.gates).toMatchObject({ emailConfirmed: false, dpaOnFile: true, hasSite: true, canActivate: false });
    expect(detail.json.gates.blockers.map((b: any) => b.code)).toEqual(['email_not_confirmed', 'logo_required']);
  });

  it('never changes a stored company when the same address registers again, and sends a fresh link', async () => {
    const first = await register({ companyName: 'Original Dental Studio', personName: 'Olive Original', country: 'FR', website: 'https://original.example' });
    const before = await orgOf(first.email);
    const second = await register({ email: first.email, companyName: 'Hijacked Name', personName: 'Mallory Mallet', country: 'US', website: 'https://evil.example', volume: 'over_20000' });
    expect(second.r.status).toBe(202);
    expect(second.r.json).toEqual(first.r.json);
    const after = await orgOf(first.email);
    expect(after.id).toBe(before.id);
    expect(after.name).toBe('Original Dental Studio');
    expect(after.country).toBe('FR');
    expect(after.code).toBe(before.code);
    expect(after.signup).toEqual(before.signup);
    expect((await q(`SELECT name FROM users WHERE org_id = $1`, [after.id]))[0].name).toBe('Olive Original');
    expect(await q(`SELECT 1 FROM organizations WHERE name = 'Hijacked Name'`)).toHaveLength(0);
    await flush();
    expect(await countMail(first.email, 'Confirm your email')).toBe(2);
    // only the newest link works
    const mails = (await mailTo(first.email)).filter((m) => m.subject.startsWith('Confirm your email'));
    const [t1, t2] = mails.map((m) => tokenIn(m.body)!);
    // (emails are sent by parallel workers, so the order in the mailbox is not the order of creation)
    const valid = [(await new Client(app).call('GET', `/api/auth/verify/${t1}`)).json.valid, (await new Client(app).call('GET', `/api/auth/verify/${t2}`)).json.valid];
    expect(valid.filter(Boolean)).toHaveLength(1);
  });

  it('lets a person who stopped before the authenticator sign in and finish the setup', async () => {
    const { email } = await registerAndVerify();
    const later = new Client(app);
    const l = await later.call('POST', '/api/auth/login', { email, password: GOOD_PASSWORD });
    expect(l.status).toBe(200);
    expect(l.json.stage).toBe('mfa_setup');
    expect((await later.call('GET', '/api/auth/me')).json.permissions).toEqual([]);
    await enrol(later);
    expect((await later.call('GET', '/api/org/profile')).status).toBe(200);
    expect((await q(`SELECT status, mfa_enabled FROM users WHERE lower(email) = $1`, [email]))[0]).toEqual({ status: 'active', mfa_enabled: true });
    // registering again now only sends the "already have an account" email
    const again = await register({ email });
    expect(again.r.status).toBe(202);
    await flush();
    expect(await countMail(email, 'You already have')).toBe(1);
  });

  it('gives the same answer for new, unconfirmed, known and declined addresses, with the notices throttled to one an hour', async () => {
    const fresh = await register();
    const unconfirmed = await register({ email: fresh.email });
    const known = await register({ email: 'admin@acme.demo' });
    // a declined address
    const d = await registerAndVerify();
    const dec = await klAdmin.call('POST', `/api/partners/${d.orgId}/decline`, { reason: 'Not a dental company' });
    expect(dec.status, JSON.stringify(dec.json)).toBe(200);
    const declined = await register({ email: d.email });
    const again = await register({ email: d.email });
    const unknownDomain = await register({ email: 'somebody@zyxwv-dental.test' });
    for (const x of [fresh, unconfirmed, known, declined, again, unknownDomain]) expect(x.r.status).toBe(202);
    const bodies = new Set([fresh, unconfirmed, known, declined, again, unknownDomain].map((x) => sortJson(x.r.json)));
    expect(bodies.size).toBe(1);
    await flush();
    expect(await countMail('admin@acme.demo', 'You already have')).toBe(1);
    // the second attempt for the same known address within the hour sends nothing more
    await register({ email: 'admin@acme.demo' });
    await flush();
    expect(await countMail('admin@acme.demo', 'You already have')).toBe(1);
    // declined: one notice for the decision, one for the first new attempt, none for the repeat
    const declinedNotices = (await mailTo(d.email)).filter((m) => m.subject === 'Your Portal Hub registration');
    expect(declinedNotices).toHaveLength(2);
    for (const m of declinedNotices) expect(m.body).not.toMatch(/Not a dental company|Zyxwv|Quirk/);
    // nothing was created for the known and declined addresses
    expect(await q(`SELECT 1 FROM users WHERE lower(email) = 'admin@acme.demo'`)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM users WHERE lower(email) = $1`, [d.email])).toHaveLength(1);
  });

  it('holds every answer back for at least 600 ms with the real setting, malformed input excepted', async () => {
    config.signupMinMs = 600;
    try {
      const timed = async (over: Record<string, unknown>) => {
        const t0 = performance.now();
        const { r } = await register(over);
        return { ms: performance.now() - t0, r };
      };
      const known = await timed({ email: 'admin@acme.demo' });
      const fresh = await timed({});
      const freshAgain = await timed({ email: (await q(`SELECT email FROM users WHERE lower(email) LIKE 'p5.user%' ORDER BY created_at DESC LIMIT 1`))[0].email });
      const honeypot = await timed({ hp: 'http://spam.example' });
      for (const t of [known, fresh, freshAgain, honeypot]) {
        expect(t.r.status).toBe(202);
        expect(t.ms).toBeGreaterThanOrEqual(595);
        expect(t.ms).toBeLessThan(2500);
      }
      expect(sortJson(known.r.json)).toBe(sortJson(fresh.r.json));
      // malformed input is answered at once (it says nothing about any address)
      const t0 = performance.now();
      const bad = await new Client(app).call('POST', '/api/auth/register', { companyName: 'x' });
      expect(bad.status).toBe(400);
      expect(performance.now() - t0).toBeLessThan(500);
    } finally {
      config.signupMinMs = 20;
    }
  });

  it('limits fresh links to 3 an hour and 5 in total', async () => {
    const first = await register();
    const org = await orgOf(first.email);
    for (let i = 0; i < 5; i++) await register({ email: first.email });
    await flush();
    expect(await countMail(first.email, 'Confirm your email')).toBe(3);
    // an hour later the hourly allowance is back, but never more than 5 in total
    await q(`UPDATE user_tokens SET created_at = now() - interval '2 hours' WHERE org_id = $1`, [org.id]);
    for (let i = 0; i < 5; i++) await register({ email: first.email });
    await flush();
    expect(await countMail(first.email, 'Confirm your email')).toBe(5);
    expect((await q(`SELECT count(*)::int AS n FROM user_tokens WHERE org_id = $1 AND kind = 'verify'`, [org.id]))[0].n).toBe(5);
    await q(`UPDATE user_tokens SET created_at = now() - interval '4 hours' WHERE org_id = $1`, [org.id]);
    await register({ email: first.email });
    await flush();
    expect(await countMail(first.email, 'Confirm your email')).toBe(5);
  });

  it('refuses throwaway mailboxes, bad input and answers the honeypot like success without doing anything', async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM organizations`))[0].n;
    const attempts = (await q(`SELECT count(*)::int AS n FROM signup_attempts`))[0].n;
    const throwaway = await new Client(app).call('POST', '/api/auth/register', form({ email: 'someone@mailinator.com' }));
    expect(throwaway.status).toBe(400);
    expect(throwaway.json).toMatchObject({ code: 'email_not_allowed', message: expect.stringMatching(/work email/) });
    expect(throwaway.json.fields).toEqual([{ path: 'email', message: expect.any(String) }]);
    const sub = await new Client(app).call('POST', '/api/auth/register', form({ email: 'x@eu.guerrillamail.com' }));
    expect(sub.json.code).toBe('email_not_allowed');

    const bad = await new Client(app).call('POST', '/api/auth/register', { companyName: 'www.evil.com', country: 'ZZ', personName: '', email: 'nope', acceptAuthority: false, acceptPrivacy: false, privacyVersion: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('invalid_request');
    expect(bad.json.fields.map((f: any) => f.path).sort()).toEqual(['acceptAuthority', 'acceptPrivacy', 'caseAddress.city', 'caseAddress.country', 'caseAddress.phone', 'caseAddress.postalCode', 'caseAddress.stateProvince', 'caseAddress.street', 'companyName', 'country', 'email', 'personName', 'privacyVersion']);
    const stale = await new Client(app).call('POST', '/api/auth/register', form({ privacyVersion: '2020-01' }));
    expect(stale.status).toBe(400);
    expect(stale.json.fields[0].path).toBe('privacyVersion');

    const trap = await new Client(app).call('POST', '/api/auth/register', form({ hp: 'buy cheap pills' }));
    expect(trap.status).toBe(202);
    expect(trap.json).toEqual((await register()).r.json);
    // the honeypot with junk in the other fields is still just "success"
    const trap2 = await new Client(app).call('POST', '/api/auth/register', { hp: 'x', companyName: '<b>' });
    expect(trap2.status).toBe(202);
    // only the one real registration above was created, and none of the refusals touched the database or the ceiling
    expect((await q(`SELECT count(*)::int AS n FROM organizations`))[0].n).toBe(before + 1);
    expect((await q(`SELECT count(*)::int AS n FROM signup_attempts`))[0].n).toBe(attempts + 1);
  });

  it('marks personal mailboxes for the reviewer', async () => {
    const { email } = await register({ email: `gina.${Math.random().toString(36).slice(2, 7)}@gmail.com` });
    expect((await orgOf(email)).signup.free_email).toBe(true);
  });

  it('limits one address to 5 attempts in 10 minutes', async () => {
    const c = new Client(app);
    for (let i = 0; i < 5; i++) expect((await c.call('POST', '/api/auth/register', { companyName: 'x' })).status).toBe(400);
    const sixth = await c.call('POST', '/api/auth/register', form());
    expect(sixth.status).toBe(429);
    expect(sixth.json.code).toBe('rate_limited');
    // another address is not affected
    expect((await register()).r.status).toBe(202);
  });

  it('answers 403 when registration is switched off', async () => {
    config.signupEnabled = false;
    try {
      const r = await new Client(app).call('POST', '/api/auth/register', form());
      expect(r.status).toBe(403);
      expect(r.json.code).toBe('signup_disabled');
      expect((await new Client(app).call('GET', '/api/public/config')).json.signupEnabled).toBe(false);
    } finally {
      config.signupEnabled = true;
    }
  });

  it('never writes a confirmation token to the request log', async () => {
    const { email } = await register();
    const token = await confirmToken(email);
    logLines.length = 0;
    await new Client(app).call('GET', `/api/auth/verify/${token}`);
    await new Client(app).call('POST', '/api/auth/verify', { token, password: GOOD_PASSWORD });
    expect(logLines.join('')).not.toContain(token);
    expect(logLines.join('')).toContain('/api/auth/verify/[redacted]');
  });
});

// ===========================================================================
describe('daily ceiling', () => {
  it('answers every address the same way once reached, does nothing, and alerts the administrators once a day', async () => {
    await q('DELETE FROM signup_attempts');
    await q(`DELETE FROM job_runs WHERE name = 'signup_ceiling_alert'`);
    const orgsBefore = (await q(`SELECT count(*)::int AS n FROM organizations`))[0].n;
    const notesBefore = (await q(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'signup_ceiling'`))[0].n;
    config.signupDailyLimit = 3;
    try {
      const ok = [await register(), await register(), await register()];
      for (const x of ok) expect(x.r.status).toBe(202);
      expect((await q(`SELECT count(*)::int AS n FROM organizations`))[0].n).toBe(orgsBefore + 3);
      await flush();
      const mailBefore = (await q(`SELECT count(*)::int AS n FROM dev_mailbox`))[0].n;

      const over = [await register(), await register({ email: ok[0]!.email }), await register({ email: 'admin@acme.demo' }), await register({ email: 'owner@fabrikam.demo' }), await register()];
      for (const x of over) expect(x.r.status).toBe(202);
      expect(new Set([...ok, ...over].map((x) => sortJson(x.r.json))).size).toBe(1);
      // nothing new was created and no address was looked at: no fresh link, no "already have an account" notice
      expect((await q(`SELECT count(*)::int AS n FROM organizations`))[0].n).toBe(orgsBefore + 3);
      await flush();
      const newMail = await q(`SELECT to_addr, subject FROM dev_mailbox ORDER BY created_at, id OFFSET $1`, [mailBefore]);
      expect(newMail.filter((m) => !m.to_addr.endsWith('@kline.demo'))).toEqual([]);
      // the administrators were told exactly once, with fixed text
      expect((await q(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'signup_ceiling'`))[0].n).toBe(notesBefore + 1);
      const adminMails = newMail.filter((m) => m.subject === 'The daily registration limit has been reached');
      expect(adminMails.length).toBeGreaterThanOrEqual(1);
      expect(new Set(adminMails.map((m) => m.to_addr)).size).toBe(adminMails.length);
      expect((await q(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'signup.ceiling_reached'`))[0].n).toBe(1);
      // attempts older than a day stop counting
      await q(`UPDATE signup_attempts SET at = now() - interval '25 hours'`);
      expect((await register()).r.status).toBe(202);
      expect((await q(`SELECT count(*)::int AS n FROM organizations`))[0].n).toBe(orgsBefore + 4);
    } finally {
      config.signupDailyLimit = 100;
      await q('DELETE FROM signup_attempts');
    }
  });
});

// ===========================================================================
describe('K Line review', () => {
  it('lists the review tab with confirmed companies first, badges and counts', async () => {
    const review = await klAdmin.call('GET', '/api/partners?tab=review');
    expect(review.status).toBe(200);
    const names = review.json.items.map((i: any) => i.name);
    expect(names.indexOf('Contoso Smile')).toBe(0);
    const firstUnconfirmed = review.json.items.findIndex((i: any) => i.emailNotConfirmed);
    expect(firstUnconfirmed).toBeGreaterThan(0);
    expect(review.json.items.slice(0, firstUnconfirmed).every((i: any) => !i.emailNotConfirmed)).toBe(true);
    expect(review.json.items.slice(firstUnconfirmed).every((i: any) => i.emailNotConfirmed)).toBe(true);
    const contosoItem = review.json.items[0];
    expect(contosoItem).toMatchObject({ newSignup: true, emailNotConfirmed: false, declined: false, freeEmail: false, volume: '1000_5000', signupAt: expect.any(String), status: 'onboarding' });
    const fab = review.json.items.find((i: any) => i.name === 'Fabrikam Dental Lab');
    expect(fab).toMatchObject({ newSignup: true, emailNotConfirmed: true, declined: false });
    expect(review.json.items.every((i: any) => i.status === 'onboarding' && !i.declined)).toBe(true);
    expect(review.json.counts.review).toBe(review.json.items.length);
    const all = await klAdmin.call('GET', '/api/partners');
    expect(all.json.tab).toBe('all');
    expect(all.json.items.map((i: any) => i.name)).toContain('Acme Aligners');
    expect(all.json.items.find((i: any) => i.name === 'Acme Aligners')).toMatchObject({ newSignup: false, emailNotConfirmed: false, declined: false, signupAt: null });
    expect(all.json.counts.all).toBe(all.json.items.length);
  });

  it('searches by name, code and registrant email', async () => {
    const byName = await klAdmin.call('GET', '/api/partners?search=contoso');
    expect(byName.json.items.map((i: any) => i.name)).toEqual(['Contoso Smile']);
    const byCode = await klAdmin.call('GET', '/api/partners?search=FDL');
    expect(byCode.json.items.map((i: any) => i.name)).toEqual(['Fabrikam Dental Lab']);
    const byMail = await klAdmin.call('GET', '/api/partners?tab=review&search=owner%40contoso');
    expect(byMail.json.items.map((i: any) => i.name)).toEqual(['Contoso Smile']);
    const wildcard = await klAdmin.call('GET', '/api/partners?search=%25');
    expect(wildcard.json.items).toEqual([]);
    expect((await klAdmin.call('GET', '/api/partners?tab=bogus')).status).toBe(400);
  });

  it('shows registration details and gates on the partner page (staff only)', async () => {
    const d = await klAdmin.call('GET', `/api/partners/${contosoId}`);
    expect(d.status).toBe(200);
    expect(d.json).toMatchObject({
      selfRegistered: true, emailConfirmed: true, declined: false, status: 'onboarding',
      signup: { registrantName: 'Olga Owner', email: 'owner@contoso.demo', website: 'https://www.contoso-smile.example', volume: '1000_5000', freeEmail: false, privacyVersion: PRIVACY_VERSION, confirmedAt: expect.any(String), approvedAt: null, declinedAt: null },
      gates: { dpaOnFile: false, emailConfirmed: true, hasSite: false, canActivate: false },
    });
    expect(d.json.gates.blockers.map((b: any) => b.code)).toEqual(['dpa_required', 'site_required']);
    const acme = await klAdmin.call('GET', `/api/partners/${acmeId}`);
    expect(acme.json.signup).toBeNull();
    expect(acme.json.gates).toMatchObject({ dpaOnFile: true, emailConfirmed: true, canActivate: true });
    // partners and other staff roles cannot read it
    expect((await acmeAdmin.call('GET', `/api/partners/${contosoId}`)).status).toBe(403);
    expect((await intake.call('GET', `/api/partners/${contosoId}`)).status).toBe(403);
    expect((await acmeAdmin.call('GET', '/api/partners?tab=review')).status).toBe(403);
  });

  it('counts confirmed registrations in the console overview', async () => {
    const o = await klAdmin.call('GET', '/api/console/overview');
    const expected = (await q(`SELECT count(*)::int AS n FROM organizations WHERE kind = 'partner' AND status = 'onboarding' AND signup ? 'at' AND signup->>'verified_at' IS NOT NULL AND NOT signup ? 'declined_at'`))[0].n;
    expect(o.json.newSignups).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(2);
    const before = o.json.newSignups;
    await registerAndVerify();
    expect((await klAdmin.call('GET', '/api/console/overview')).json.newSignups).toBe(before + 1);
  });

  it('adds a partner directly (step up, code rules) and invites a user to it', async () => {
    const stale = await new Client(app).full('admin@kline.demo');
    await q(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE id = (SELECT id FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'admin@kline.demo') AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1)`);
    const body = { name: 'Direct Add Aligners', code: 'DIRECT', country: 'IT', legalName: 'Direct Add Aligners Srl', retentionMonths: 36, siteCodes: ['PT-CHV', 'EG-CFZ'], defaultSiteCode: 'PT-CHV' };
    const noStep = await stale.call('POST', '/api/partners', body);
    expect(noStep.status).toBe(403);
    expect(noStep.json.code).toBe('step_up_required');

    const ok = await klAdmin.call('POST', '/api/partners', body);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json).toEqual({ id: expect.any(String), code: 'DIRECT', status: 'onboarding' });
    const id = ok.json.id as string;
    const detail = await klAdmin.call('GET', `/api/partners/${id}`);
    expect(detail.json).toMatchObject({ name: 'Direct Add Aligners', code: 'DIRECT', legalName: 'Direct Add Aligners Srl', country: 'IT', status: 'onboarding', retentionMonths: 36, defaultSiteCode: 'PT-CHV', usersCount: 0, selfRegistered: false, signup: null });
    expect(detail.json.settings.manualReview).toBe(true);
    expect(detail.json.sites.map((s: any) => s.code)).toEqual(['EG-CFZ', 'PT-CHV']);

    const dup = await klAdmin.call('POST', '/api/partners', { ...body, name: 'Other' });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe('code_taken');
    expect((await klAdmin.call('POST', '/api/partners', { ...body, code: 'KL' })).json.code).toBe('code_reserved');
    expect((await klAdmin.call('POST', '/api/partners', { ...body, code: 'kline' })).json.code).toBe('code_taken');
    expect((await klAdmin.call('POST', '/api/partners', { ...body, code: 'a' })).json.code).toBe('invalid_code');
    expect((await klAdmin.call('POST', '/api/partners', { ...body, code: 'TOO-LONG-CODE' })).json.code).toBe('invalid_code');
    expect((await klAdmin.call('POST', '/api/partners', { ...body, code: 'NEWCO', country: 'ZZ' })).status).toBe(400);
    expect((await klAdmin.call('POST', '/api/partners', { ...body, code: 'NEWCO', siteCodes: ['XX-NOPE'] })).json.code).toBe('invalid_site');
    expect((await klAdmin.call('POST', '/api/partners', { ...body, code: 'NEWCO', name: 'www.spam.com' })).status).toBe(400);
    // only K Line administrators of partners may do this
    expect((await intake.call('POST', '/api/partners', { ...body, code: 'NEWCO' })).status).toBe(403);
    expect((await acmeAdmin.call('POST', '/api/partners', { ...body, code: 'NEWCO' })).status).toBe(403);

    // invite a user
    const inv = await klAdmin.call('POST', `/api/partners/${id}/users/invite`, { email: 'first.user@direct-add.test', name: 'First User', roles: ['admin'] });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    await flush();
    const mail = (await mailTo('first.user@direct-add.test'))[0]!;
    expect(mail.subject).toBe('You are invited to the Portal Hub');
    expect(mail.body).toContain('Direct Add Aligners');
    expect(mail.body).toContain('K Line has invited you');
    expect((await q(`SELECT org_id, status, roles FROM users WHERE email = 'first.user@direct-add.test'`))[0]).toEqual({ org_id: id, status: 'invited', roles: ['admin'] });
    expect((await klAdmin.call('POST', `/api/partners/${id}/users/invite`, { email: 'first.user@direct-add.test', name: 'Again', roles: ['admin'] })).json.code).toBe('email_unavailable');
    expect((await klAdmin.call('POST', `/api/partners/${id}/users/invite`, { email: 'x@direct-add.test', name: 'X', roles: ['kl_admin'] })).status).toBe(400);
    expect((await klAdmin.call('POST', `/api/partners/${klineId}/users/invite`, { email: 'y@direct-add.test', name: 'Y', roles: ['admin'] })).status).toBe(404);
    expect((await q(`SELECT action FROM audit_log WHERE org_id = $1 ORDER BY seq`, [id])).map((r) => r.action)).toEqual(['partner.created', 'partner_user.invited']);
  });

  it('changes the code only while there are no cases, with the same code rules', async () => {
    const created = await klAdmin.call('POST', '/api/partners', { name: 'Code Change Ltd', code: 'CCHANGE', country: 'PT', siteCodes: [] });
    const id = created.json.id as string;
    expect((await klAdmin.call('PATCH', `/api/partners/${id}/code`, { code: 'cc2' })).json).toEqual({ code: 'CC2' });
    expect((await q(`SELECT code FROM organizations WHERE id = $1`, [id]))[0].code).toBe('CC2');
    expect((await klAdmin.call('PATCH', `/api/partners/${id}/code`, { code: 'KL' })).json.code).toBe('code_reserved');
    expect((await klAdmin.call('PATCH', `/api/partners/${id}/code`, { code: 'ACME' })).json.code).toBe('code_taken');
    expect((await klAdmin.call('PATCH', `/api/partners/${id}/code`, { code: 'bad code' })).json.code).toBe('invalid_code');
    expect((await klAdmin.call('PATCH', `/api/partners/${id}/code`, { code: 'X' })).json.code).toBe('invalid_code');
    // Acme has cases
    await q(`INSERT INTO cases (org_id, ref, partner_case_id) VALUES ($1, 'ACME-900001', 'P5-1')`, [acmeId]);
    const acme = await klAdmin.call('PATCH', `/api/partners/${acmeId}/code`, { code: 'ACME2' });
    expect(acme.status).toBe(409);
    expect(acme.json.code).toBe('has_cases');
    // a draft case is enough to fix the code
    await q(`INSERT INTO cases (org_id, ref, partner_case_id) VALUES ($1, 'CC2-000001', 'D-1')`, [id]);
    expect((await klAdmin.call('PATCH', `/api/partners/${id}/code`, { code: 'CC3' })).json.code).toBe('has_cases');
    expect((await klAdmin.call('PATCH', `/api/partners/${'00000000-0000-4000-8000-000000000000'}/code`, { code: 'ZZ9' })).status).toBe(404);
    expect((await intake.call('PATCH', `/api/partners/${id}/code`, { code: 'CC4' })).status).toBe(403);
    expect((await q(`SELECT details FROM audit_log WHERE org_id = $1 AND action = 'partner.code_changed'`, [id]))[0].details).toEqual({ from: 'CCHANGE', to: 'CC2' });
  });
});

// ===========================================================================
describe('declining a registration', () => {
  it('needs a fresh authenticator code', async () => {
    const { orgId } = await registerAndVerify();
    const stale = await new Client(app).full('admin@kline.demo');
    await q(`UPDATE sessions SET step_up_at = now() - interval '2 hours' WHERE id = (SELECT id FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'admin@kline.demo') AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1)`);
    const r = await stale.call('POST', `/api/partners/${orgId}/decline`, {});
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('step_up_required');
    expect((await orgOf((await q(`SELECT email FROM users WHERE org_id = $1`, [orgId]))[0].email)).signup.declined_at).toBeUndefined();
    expect((await intake.call('POST', `/api/partners/${orgId}/decline`, {})).status).toBe(403);
    expect((await acmeAdmin.call('POST', `/api/partners/${orgId}/decline`, {})).status).toBe(403);
  });

  it('deletes an unconfirmed registration at once and tells nobody', async () => {
    const { email, r } = await register({ companyName: 'Unconfirmed Typed Co' });
    expect(r.status).toBe(202);
    const org = await orgOf(email);
    await flush();
    const mailsBefore = (await mailTo(email)).length;
    const dec = await klAdmin.call('POST', `/api/partners/${org.id}/decline`, { reason: 'looks fake' });
    expect(dec.status, JSON.stringify(dec.json)).toBe(200);
    expect(dec.json).toEqual({ status: 'declined', deleted: true, deletesAt: null });
    for (const t of ['organizations WHERE id', 'users WHERE org_id', 'user_tokens WHERE org_id', 'specs WHERE org_id']) {
      expect(await q(`SELECT 1 FROM ${t} = $1`, [org.id]), t).toHaveLength(0);
    }
    await flush();
    expect((await mailTo(email)).length).toBe(mailsBefore);
    const entries = await q(`SELECT actor_type, action, details FROM audit_log WHERE org_id = $1 ORDER BY seq`, [org.id]);
    const declineEntry = entries.find((e) => e.action === 'partner.registration_declined')!;
    expect(declineEntry.details).toEqual({ code: org.code, confirmed: false, deleted: true });
    expect(JSON.stringify(entries)).not.toMatch(/Unconfirmed Typed|looks fake|@/);
    // the address can register again straight away
    const again = await register({ email });
    expect(again.r.status).toBe(202);
    expect((await orgOf(email)).id).not.toBe(org.id);
    expect((await klAdmin.call('POST', `/api/partners/${org.id}/decline`, {})).status).toBe(404);
  });

  it('disables a confirmed registration at once, keeps it for 30 days and deletes it through the retention job', async () => {
    const { c, email, orgId } = await registerAndVerify({ companyName: 'Confirmed Typed Co' });
    await enrol(c);
    expect((await c.call('GET', '/api/org/profile')).status).toBe(200);
    await grantDpaAndSite(orgId);
    // a brand and a logo exist, so the deletion has files to remove
    expect((await c.call('POST', '/api/org/brands', { name: 'Typed Brand' })).status).toBe(201);
    const logo = await uploadProfile(c, 'logo', 'logo.png', LOGO_PNG);
    expect(logo.state).toBe('ready');
    expect((await c.call('POST', '/api/org/logo', { fileId: logo.fileId })).status).toBe(200);
    const prefix = (await q(`SELECT storage_prefix FROM files WHERE id = $1`, [logo.fileId]))[0].storage_prefix as string;
    await flush();
    expect(await (await storage()).exists(chunkKey(prefix, 0))).toBe(true);

    const dec = await klAdmin.call('POST', `/api/partners/${orgId}/decline`, { reason: 'Internal: not a dental business' });
    expect(dec.status, JSON.stringify(dec.json)).toBe(200);
    expect(dec.json).toMatchObject({ status: 'declined', deleted: false, deletesAt: expect.stringMatching(/^\d{4}/) });
    const deletesInDays = (new Date(dec.json.deletesAt).getTime() - Date.now()) / 86_400_000;
    expect(deletesInDays).toBeGreaterThan(29.9);
    expect(deletesInDays).toBeLessThan(30.1);

    const org = await orgOf(email);
    expect(org.signup).toMatchObject({ declined_at: expect.any(String), declined_by: expect.any(String), decline_reason: 'Internal: not a dental business' });
    expect(org.status).toBe('onboarding');
    expect((await q(`SELECT status FROM users WHERE org_id = $1`, [orgId])).map((u) => u.status)).toEqual(['disabled']);
    // the running session is over and signing in fails
    expect((await c.call('GET', '/api/auth/me')).status).toBe(401);
    expect((await new Client(app).call('POST', '/api/auth/login', { email, password: GOOD_PASSWORD })).status).toBe(401);
    // a fixed notice goes to the registrant, without the reason
    await flush();
    const notice = (await mailTo(email)).filter((m) => m.subject === 'Your Portal Hub registration');
    expect(notice).toHaveLength(1);
    expect(notice[0]!.body).toContain('30 days');
    expect(notice[0]!.body).not.toMatch(/Internal|dental business|Confirmed Typed/);
    // it moves to the declined tab and cannot be approved any more
    const declined = await klAdmin.call('GET', '/api/partners?tab=declined');
    const item = declined.json.items.find((i: any) => i.id === orgId);
    expect(item).toMatchObject({ declined: true, newSignup: false, declinedAt: expect.any(String), deletesAt: expect.any(String) });
    expect((await klAdmin.call('GET', '/api/partners?tab=review')).json.items.some((i: any) => i.id === orgId)).toBe(false);
    expect((await klAdmin.call('GET', '/api/partners?tab=all')).json.items.some((i: any) => i.id === orgId)).toBe(false);
    const act = await activate(orgId);
    expect(act.status).toBe(409);
    expect(act.json.code).toBe('partner_declined');
    expect((await klAdmin.call('POST', `/api/partners/${orgId}/decline`, {})).json.code).toBe('already_declined');
    expect((await klAdmin.call('POST', `/api/partners/${orgId}/users/invite`, { email: 'late@confirmed-typed.test', name: 'Late', roles: ['viewer'] })).json.code).toBe('partner_declined');
    const detail = await klAdmin.call('GET', `/api/partners/${orgId}`);
    expect(detail.json).toMatchObject({ declined: true, signup: { declinedAt: expect.any(String), declineReason: 'Internal: not a dental business' }, gates: { canActivate: false } });
    // the audit entry names no reason and no typed text
    const entry = (await q(`SELECT details FROM audit_log WHERE org_id = $1 AND action = 'partner.registration_declined'`, [orgId]))[0];
    expect(entry.details).toMatchObject({ code: org.code, confirmed: true, deleted: false, hasReason: true });
    expect(JSON.stringify(entry)).not.toMatch(/Internal|dental business/);

    // retention: not yet at 29 days ...
    await q(`UPDATE organizations SET signup = jsonb_set(signup, '{declined_at}', to_jsonb($2::text)) WHERE id = $1`, [orgId, new Date(Date.now() - 29 * 86_400_000).toISOString()]);
    const early = await runRetention();
    expect(early.declinedRegistrations).toBe(0);
    expect(await q(`SELECT 1 FROM organizations WHERE id = $1`, [orgId])).toHaveLength(1);
    // ... after 30 days everything goes: organisation, people, brands, files and the stored bytes
    await q(`UPDATE organizations SET signup = jsonb_set(signup, '{declined_at}', to_jsonb($2::text)) WHERE id = $1`, [orgId, new Date(Date.now() - 31 * 86_400_000).toISOString()]);
    const late = await runRetention();
    expect(late.declinedRegistrations).toBe(1);
    for (const t of ['organizations WHERE id', 'users WHERE org_id', 'brands WHERE org_id', 'files WHERE org_id', 'specs WHERE org_id', 'agreements WHERE org_id', 'org_sites WHERE org_id', 'sessions WHERE org_id', 'notifications WHERE org_id']) {
      expect(await q(`SELECT 1 FROM ${t} = $1`, [orgId]), t).toHaveLength(0);
    }
    expect(await (await storage()).exists(chunkKey(prefix, 0))).toBe(false);
    const gone = (await q(`SELECT details FROM audit_log WHERE org_id = $1 AND action = 'partner.registration_deleted'`, [orgId]))[0];
    expect(gone.details).toEqual({ code: org.code, reason: 'declined_30_days' });
    // and the address is free again
    expect((await register({ email })).r.status).toBe(202);
    expect((await orgOf(email)).id).not.toBe(orgId);
  });

  it('deletes unconfirmed registrations 7 days after registering and leaves everything else alone', async () => {
    const stale = await register();
    const recent = await register();
    const confirmedOld = await registerAndVerify();
    const staleOrg = await orgOf(stale.email);
    const recentOrg = await orgOf(recent.email);
    const old = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    await q(`UPDATE organizations SET signup = jsonb_set(signup, '{at}', to_jsonb($2::text)) WHERE id = $1`, [staleOrg.id, old(8)]);
    await q(`UPDATE organizations SET signup = jsonb_set(signup, '{at}', to_jsonb($2::text)) WHERE id = $1`, [recentOrg.id, old(6)]);
    await q(`UPDATE organizations SET signup = jsonb_set(signup, '{at}', to_jsonb($2::text)) WHERE id = $1`, [confirmedOld.orgId, old(8)]);
    const rep = await runRetention();
    expect(rep.unconfirmedRegistrations).toBeGreaterThanOrEqual(1);
    expect(await q(`SELECT 1 FROM organizations WHERE id = $1`, [staleOrg.id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM users WHERE org_id = $1`, [staleOrg.id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM user_tokens WHERE org_id = $1`, [staleOrg.id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM specs WHERE org_id = $1`, [staleOrg.id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM organizations WHERE id = $1`, [recentOrg.id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM organizations WHERE id = $1`, [confirmedOld.orgId])).toHaveLength(1);
    // the seeded Fabrikam registration (1 day old) is untouched
    expect(await q(`SELECT 1 FROM organizations WHERE id = $1`, [fabrikamId])).toHaveLength(1);
    const e = (await q(`SELECT details FROM audit_log WHERE org_id = $1 AND action = 'signup.expired'`, [staleOrg.id]))[0];
    expect(e.details).toEqual({ code: staleOrg.code, reason: 'email_not_confirmed_7_days' });
  });
});

// ===========================================================================
describe('company profile permissions', () => {
  const profileBody = { legalName: 'Acme Aligners Limited', vatId: 'pt 501 964 843', address: { street: '1 Rua Direita', city: 'Chaves', postalCode: '5400-001', country: 'PT' }, contacts: { operations: { name: 'Olga Ops', email: 'ops@acme.demo', phone: '+351 276 000 000' } }, settings: { requirePts: true, caseIdRegex: '^AC-\\d{4}$' } };

  it('lets every partner role read, only administrators edit and every role except viewer change the company logo', async () => {
    // [role, client, read status, write status (org.edit), company logo permitted (org.logo)]
    const roles: [string, Client, number, number, boolean][] = [
      ['admin', acmeAdmin, 200, 200, true],
      ['uploader', acmeUp, 200, 403, true],
      ['quality', acmeQuality, 200, 403, true],
      ['finance', acmeFinance, 200, 403, true],
      ['viewer', acmeViewer, 200, 403, false],
      ['kl_admin', klAdmin, 403, 403, false],
      ['kl_intake', intake, 403, 403, false],
    ];
    for (const [role, c, read, write, logoOk] of roles) {
      expect((await c.call('GET', '/api/org/profile')).status, `${role} GET profile`).toBe(read);
      expect((await c.call('PUT', '/api/org/profile', {})).status, `${role} PUT profile`).toBe(write);
      expect((await c.call('GET', '/api/org/brands')).status, `${role} GET brands`).toBe(read);
      expect((await c.call('POST', '/api/org/brands', { name: `B-${role}` })).status, `${role} POST brand`).toBe(write === 200 ? 201 : 403);
      expect((await c.call('GET', '/api/org/documents')).status, `${role} GET documents`).toBe(read);
      expect((await c.call('GET', '/api/org/agreements')).status, `${role} GET agreements`).toBe(read);
      expect((await c.call('GET', '/api/org/sites')).status, `${role} GET sites`).toBe(read);
      expect((await c.call('GET', '/api/org/onboarding')).status, `${role} GET onboarding`).toBe(read);
      expect((await c.call('POST', '/api/org/logo', { fileId: '00000000-0000-4000-8000-000000000000' })).status, `${role} POST logo`).toBe(logoOk ? 404 : 403);
      expect((await c.call('POST', '/api/org/brands/00000000-0000-4000-8000-000000000000/logo', { fileId: '00000000-0000-4000-8000-000000000000' })).status, `${role} POST brand logo`).toBe(write === 200 ? 404 : 403);
      expect((await c.call('DELETE', '/api/org/documents/00000000-0000-4000-8000-000000000000')).status, `${role} DELETE document`).toBe(write === 200 ? 404 : 403);
      const up = await c.call('POST', '/api/uploads', { purpose: 'document', kind: 'other', name: 'x.pdf', size: 10 });
      expect(up.status === 200, `${role} document upload`).toBe(write === 200);
    }
    // no session at all
    expect((await new Client(app).call('GET', '/api/org/profile')).status).toBe(401);
    expect((await new Client(app).call('GET', '/api/org/logo')).status).toBe(401);
  });

  it('reads and saves the profile, audits the change without values and validates', async () => {
    const put = await acmeAdmin.call('PUT', '/api/org/profile', profileBody);
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json).toMatchObject({
      id: acmeId, name: 'Acme Aligners', code: 'ACME', status: 'active', approved: true, legalName: 'Acme Aligners Limited', country: 'PT', vatId: 'PT501964843', vatRequired: true,
      address: { street: '1 Rua Direita', city: 'Chaves', postalCode: '5400-001', country: 'PT' },
      contacts: { operations: { name: 'Olga Ops', email: 'ops@acme.demo', phone: '+351 276 000 000' }, quality: { name: '', email: '', phone: '' }, finance: { name: '', email: '', phone: '' }, it: { name: '', email: '', phone: '' } },
      settings: { caseIdRegex: '^AC-\\d{4}$', requirePts: true }, logo: { hasLogo: true, version: expect.any(String) }, hasLogo: true, logoRequired: true, profileFiles: { count: expect.any(Number), max: null },
    });
    const again = await acmeAdmin.call('GET', '/api/org/profile');
    expect(again.json).toEqual(put.json);
    // a partial update leaves the rest
    const part = await acmeAdmin.call('PUT', '/api/org/profile', { contacts: { it: { email: 'it@acme.demo' } }, settings: { requirePts: false } });
    expect(part.json.contacts.it.email).toBe('it@acme.demo');
    expect(part.json.contacts.operations.name).toBe('Olga Ops');
    expect(part.json.settings).toEqual({ caseIdRegex: '^AC-\\d{4}$', requirePts: false });
    expect(part.json.legalName).toBe('Acme Aligners Limited');
    // the K Line settings view reflects it
    expect((await klAdmin.call('GET', `/api/partners/${acmeId}`)).json).toMatchObject({ settings: { requirePts: false }, contacts: { it: { email: 'it@acme.demo' } }, addressDetails: { city: 'Chaves' } });
    // clearing the pattern
    const cleared = await acmeAdmin.call('PUT', '/api/org/profile', { settings: { caseIdRegex: null } });
    expect(cleared.json.settings.caseIdRegex).toBeNull();
    await acmeAdmin.call('PUT', '/api/org/profile', { settings: { caseIdRegex: '^AC-\\d{4}$' } });

    const audit = await q(`SELECT details FROM audit_log WHERE org_id = $1 AND action = 'org.profile_updated' ORDER BY seq`, [acmeId]);
    expect(audit.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audit)).not.toMatch(/ops@acme|Olga|Rua Direita|501964843/);
    expect(audit[0]!.details.changed.sort()).toEqual(['address', 'contacts', 'legalName', 'settings.caseIdRegex', 'settings.requirePts', 'vatId'].sort());

    // validation
    const bad = async (body: unknown) => acmeAdmin.call('PUT', '/api/org/profile', body);
    expect((await bad({ settings: { caseIdRegex: '([a-z' } })).status).toBe(400);
    const evil = await bad({ settings: { caseIdRegex: '^(A+)+$' } });
    expect(evil.status).toBe(400);
    expect(evil.json.fields[0]).toMatchObject({ path: 'settings.caseIdRegex', message: expect.stringMatching(/too slow/) });
    expect((await bad({ settings: { caseIdRegex: 'a'.repeat(201) } })).status).toBe(400);
    expect((await bad({ contacts: { finance: { email: 'not an email' } } })).status).toBe(400);
    expect((await bad({ contacts: { finance: { phone: 'call me maybe' } } })).status).toBe(400);
    expect((await bad({ address: { country: 'ZZ' } })).status).toBe(400);
    expect((await bad({ legalName: '<script>' })).status).toBe(400);
    expect((await bad({ name: 'www.acme.com' })).status).toBe(400);
    expect((await bad({ vatId: 'x'.repeat(30) })).status).toBe(400);
    // the pattern is still the good one
    expect((await acmeAdmin.call('GET', '/api/org/profile')).json.settings.caseIdRegex).toBe('^AC-\\d{4}$');
  });

  it('locks the country after approval because it decides where cases may be produced', async () => {
    const r = await acmeAdmin.call('PUT', '/api/org/profile', { country: 'US' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('country_locked');
    expect((await acmeAdmin.call('PUT', '/api/org/profile', { country: 'PT' })).status).toBe(200);
    expect((await q(`SELECT country FROM organizations WHERE id = $1`, [acmeId]))[0].country).toBe('PT');
  });

  it('shows agreements without notes and the allowed sites', async () => {
    const ag = await acmeAdmin.call('GET', '/api/org/agreements');
    expect(ag.json.items).toEqual([{ id: expect.any(String), kind: 'dpa', signedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), expiresAt: null, reference: null }]);
    expect(JSON.stringify(ag.json)).not.toMatch(/notes|Demo data processing|signedBy|Alex/);
    await klAdmin.stepUp('admin@kline.demo');
    const rec = await klAdmin.call('POST', `/api/partners/${acmeId}/agreements`, { kind: 'msa', signedAt: '2026-01-15', expiresAt: '2028-01-15', reference: 'MSA-42', notes: 'internal note' });
    expect(rec.status).toBe(201);
    const withMsa = await acmeViewer.call('GET', '/api/org/agreements');
    expect(withMsa.json.items.map((i: any) => i.kind).sort()).toEqual(['dpa', 'msa']);
    expect(withMsa.json.items.find((i: any) => i.kind === 'msa')).toEqual({ id: rec.json.id, kind: 'msa', signedAt: '2026-01-15', expiresAt: '2028-01-15', reference: 'MSA-42' });
    await klAdmin.call('DELETE', `/api/partners/${acmeId}/agreements/${rec.json.id}`);
    expect((await acmeViewer.call('GET', '/api/org/agreements')).json.items.map((i: any) => i.kind)).toEqual(['dpa']);
    const sites = await acmeViewer.call('GET', '/api/org/sites');
    expect(sites.json.items.map((s: any) => s.code)).toEqual(['EG-CFZ', 'PT-CHV']);
    expect(sites.json.items.find((s: any) => s.code === 'PT-CHV')).toMatchObject({ name: 'Chaves', country: 'PT', isDefault: true, active: true });
  });
});

// ===========================================================================
describe('brands, logos and documents', () => {
  it('manages brands: unique names, rename, delete, in use', async () => {
    const a = await acmeAdmin.call('POST', '/api/org/brands', { name: 'Acme Fresh' });
    expect(a.status).toBe(201);
    expect(a.json.brand).toEqual({ id: expect.any(String), name: 'Acme Fresh', hasLogo: false, createdAt: expect.any(String) });
    const dup = await acmeAdmin.call('POST', '/api/org/brands', { name: 'acme fresh' });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe('brand_exists');
    expect((await acmeAdmin.call('POST', '/api/org/brands', { name: '  ' })).status).toBe(400);
    expect((await acmeAdmin.call('POST', '/api/org/brands', { name: '<b>x</b>' })).status).toBe(400);
    const ren = await acmeAdmin.call('PATCH', `/api/org/brands/${a.json.brand.id}`, { name: 'Acme Fresh Two' });
    expect(ren.json.brand.name).toBe('Acme Fresh Two');
    expect((await acmeAdmin.call('PATCH', `/api/org/brands/${a.json.brand.id}`, { name: 'Acme Clear' })).json.code).toBe('brand_exists');
    const list = await acmeViewer.call('GET', '/api/org/brands');
    expect(list.json.items.map((b: any) => b.name)).toContain('Acme Fresh Two');
    // a brand used by a case cannot go
    const cs = await acmeUp.call('POST', '/api/cases', { caseId: 'BR-1', brandId: a.json.brand.id });
    expect(cs.status, JSON.stringify(cs.json)).toBe(201);
    const inUse = await acmeAdmin.call('DELETE', `/api/org/brands/${a.json.brand.id}`);
    expect(inUse.status).toBe(409);
    expect(inUse.json.code).toBe('brand_in_use');
    const free = await acmeAdmin.call('POST', '/api/org/brands', { name: 'Throwaway' });
    expect((await acmeAdmin.call('DELETE', `/api/org/brands/${free.json.brand.id}`)).status).toBe(200);
    expect((await acmeAdmin.call('DELETE', `/api/org/brands/${free.json.brand.id}`)).status).toBe(404);
  });

  it('uploads, checks, assigns and streams a company logo and a brand logo', async () => {
    // Contoso is still waiting for approval: logos are allowed
    const png = await uploadProfile(contoso, 'logo', 'contoso-logo.png', LOGO_PNG);
    expect(png.state).toBe('ready');
    const set = await contoso.call('POST', '/api/org/logo', { fileId: png.fileId });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json).toEqual({ hasLogo: true, version: png.fileId });
    const get = await contoso.call('GET', '/api/org/logo');
    expect(get.status).toBe(200);
    expect(get.res.headers['content-type']).toBe('image/png');
    expect(get.res.headers['x-content-type-options']).toBe('nosniff');
    expect(get.res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(get.res.headers['cache-control']).toBe('private, max-age=3600');
    expect(get.res.headers['content-disposition']).toBe('inline');
    expect(get.res.rawPayload.equals(LOGO_PNG)).toBe(true);
    expect((await contoso.call('GET', '/api/org/profile')).json.logo).toEqual({ hasLogo: true, version: png.fileId });
    // K Line staff can see the partner's logo on its page
    const seen = await klAdmin.call('GET', `/api/partners/${contosoId}/logo`);
    expect(seen.status).toBe(200);
    expect(seen.res.rawPayload.equals(LOGO_PNG)).toBe(true);
    expect((await intake.call('GET', `/api/partners/${contosoId}/logo`)).status).toBe(403);
    // Acme has its own (seeded) logo, which is a different file
    const acmeSeen = await klAdmin.call('GET', `/api/partners/${acmeId}/logo`);
    expect(acmeSeen.status).toBe(200);
    expect(acmeSeen.res.headers['content-type']).toBe('image/svg+xml');
    expect(acmeSeen.res.rawPayload.equals(seen.res.rawPayload)).toBe(false);

    // replacing removes the old file
    const svg = await uploadProfile(contoso, 'logo', 'contoso-logo.svg', SVG_OK);
    expect(svg.state).toBe('ready');
    expect((await contoso.call('POST', '/api/org/logo', { fileId: svg.fileId })).status).toBe(200);
    expect(await q(`SELECT 1 FROM files WHERE id = $1`, [png.fileId])).toHaveLength(0);
    const svgGet = await contoso.call('GET', '/api/org/logo');
    expect(svgGet.res.headers['content-type']).toBe('image/svg+xml');
    expect(svgGet.res.rawPayload.equals(SVG_OK)).toBe(true);
    // the same file cannot serve two purposes
    const brand = await contoso.call('POST', '/api/org/brands', { name: 'Contoso Kids' });
    expect((await contoso.call('POST', `/api/org/brands/${brand.json.brand.id}/logo`, { fileId: svg.fileId })).json.code).toBe('file_in_use');
    const jpg = await uploadProfile(contoso, 'logo', 'kids.jpg', JPEG);
    expect(jpg.state).toBe('ready');
    expect((await contoso.call('POST', `/api/org/brands/${brand.json.brand.id}/logo`, { fileId: jpg.fileId })).status).toBe(200);
    const bg = await contoso.call('GET', `/api/org/brands/${brand.json.brand.id}/logo`);
    expect(bg.res.headers['content-type']).toBe('image/jpeg');
    expect(bg.res.rawPayload.equals(JPEG)).toBe(true);
    expect((await contoso.call('GET', '/api/org/brands')).json.items.find((b: any) => b.name === 'Contoso Kids').hasLogo).toBe(true);
    // removing
    expect((await contoso.call('DELETE', `/api/org/brands/${brand.json.brand.id}/logo`)).status).toBe(200);
    expect((await contoso.call('GET', `/api/org/brands/${brand.json.brand.id}/logo`)).status).toBe(404);
    expect(await q(`SELECT 1 FROM files WHERE id = $1`, [jpg.fileId])).toHaveLength(0);
  });

  it('refuses unsafe, wrong and oversized logos and documents', async () => {
    const bad = await uploadProfile(contoso, 'logo', 'evil.svg', SVG_BAD);
    expect(bad.state).toBe('rejected');
    expect(JSON.stringify(bad.row.validation)).toMatch(/script/);
    const use = await contoso.call('POST', '/api/org/logo', { fileId: bad.fileId });
    expect(use.status).toBe(409);
    expect(use.json.code).toBe('file_not_ready');
    const fake = await uploadProfile(contoso, 'logo', 'fake.png', Buffer.from('this is not a png at all'));
    expect(fake.state).toBe('rejected');
    for (const [name, type] of [['logo.gif', 'gif'], ['logo.pdf', 'pdf'], ['logo.exe', 'exe'], ['logo.stl', 'stl']] as const) {
      const r = await contoso.call('POST', '/api/uploads', { purpose: 'logo', name, size: 100 });
      expect(r.status, type).toBe(415);
    }
    const big = await contoso.call('POST', '/api/uploads', { purpose: 'logo', name: 'huge.png', size: 5 * 1024 * 1024 + 1 });
    expect(big.status).toBe(413);
    const docBig = await contoso.call('POST', '/api/uploads', { purpose: 'document', kind: 'other', name: 'huge.pdf', size: 50 * 1024 * 1024 + 1 });
    expect(docBig.status).toBe(413);
    expect((await contoso.call('POST', '/api/uploads', { purpose: 'document', kind: 'other', name: 'sheet.csv', size: 100 })).status).toBe(415);
    expect((await contoso.call('POST', '/api/uploads', { purpose: 'document', kind: 'nonsense', name: 'a.pdf', size: 100 })).status).toBe(400);
    // an exe renamed to png is caught at the first chunk
    const mz = await contoso.call('POST', '/api/uploads', { purpose: 'logo', name: 'renamed.png', size: 64 });
    expect(mz.status).toBe(200);
    const put = await contoso.putChunk(mz.json.fileId, 0, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62)]));
    expect(put.status).toBe(415);
    // remove the leftovers so the file limit test below starts clean
    await q(`DELETE FROM files WHERE org_id = $1 AND purpose IN ('logo', 'document') AND state IN ('rejected', 'uploading')`, [contosoId]);
  });

  it('lists, downloads (audited) and deletes documents', async () => {
    const pdf = await uploadProfile(acmeAdmin, 'document', 'QC criteria v2.pdf', minimalPdf(), { kind: 'qc_criteria' });
    expect(pdf.state).toBe('ready');
    const png = await uploadProfile(acmeAdmin, 'document', 'packaging.png', PNG_BYTES, { kind: 'packaging' });
    const list = await acmeViewer.call('GET', '/api/org/documents');
    expect(list.status).toBe(200);
    expect(list.json.items.map((d: any) => [d.name, d.kind, d.state]).sort()).toEqual([['QC criteria v2.pdf', 'qc_criteria', 'ready'], ['packaging.png', 'packaging', 'ready']]);
    expect(list.json.items[0]).toMatchObject({ id: expect.any(String), ext: expect.any(String), size: expect.any(Number), problem: null, uploadedBy: 'Alex Acme', createdAt: expect.any(String) });
    // download through the audited file route
    const dl = await acmeAdmin.call('GET', `/api/files/${pdf.fileId}/download`);
    expect(dl.status).toBe(200);
    expect(dl.res.rawPayload.equals(minimalPdf())).toBe(true);
    expect(dl.res.headers['content-disposition']).toContain('QC criteria v2.pdf');
    expect((await q(`SELECT details FROM audit_log WHERE org_id = $1 AND action = 'file.download' AND target_id = $2`, [acmeId, pdf.fileId])).length).toBe(1);
    // K Line can download it too, and that is written to the partner's log
    const kl = await klAdmin.call('GET', `/api/files/${pdf.fileId}/download`);
    expect(kl.status).toBe(200);
    expect((await q(`SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'file.download' AND target_id = $2`, [acmeId, pdf.fileId])).length).toBe(2);
    // delete
    expect((await acmeAdmin.call('DELETE', `/api/org/documents/${pdf.fileId}`)).status).toBe(200);
    expect((await acmeAdmin.call('DELETE', `/api/org/documents/${pdf.fileId}`)).status).toBe(404);
    expect(await q(`SELECT 1 FROM files WHERE id = $1`, [pdf.fileId])).toHaveLength(0);
    expect((await acmeAdmin.call('GET', '/api/org/documents')).json.items).toHaveLength(1);
    // a logo id is not a document
    const logo = await uploadProfile(acmeAdmin, 'logo', 'acme.png', PNG_BYTES);
    expect((await acmeAdmin.call('DELETE', `/api/org/documents/${logo.fileId}`)).status).toBe(404);
    await acmeAdmin.call('DELETE', `/api/org/documents/${png.fileId}`);
    await q(`DELETE FROM files WHERE org_id = $1 AND purpose IN ('logo', 'document')`, [acmeId]);
  });

  it('stores at most 10 profile files while the company is not approved', async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM files WHERE org_id = $1 AND purpose IN ('logo', 'document') AND state <> 'purged'`, [contosoId]))[0].n;
    const prof = await contoso.call('GET', '/api/org/profile');
    expect(prof.json.profileFiles).toEqual({ count: before, max: 10 });
    for (let i = before; i < 10; i++) {
      const r = await uploadProfile(contoso, 'document', `doc-${i}.pdf`, minimalPdf(`/Pad ${i}`), { kind: 'other' });
      expect(r.state, `file ${i}`).toBe('ready');
    }
    const eleventh = await contoso.call('POST', '/api/uploads', { purpose: 'document', kind: 'other', name: 'eleventh.pdf', size: 100 });
    expect(eleventh.status).toBe(409);
    expect(eleventh.json.code).toBe('profile_files_limit');
    // logos count as well
    const logo = await contoso.call('POST', '/api/uploads', { purpose: 'logo', name: 'one-more.png', size: 100 });
    expect(logo.json.code).toBe('profile_files_limit');
    // resuming an existing upload is not a new file
    const again = await contoso.call('POST', '/api/uploads', { purpose: 'document', kind: 'other', name: 'doc-9.pdf', size: minimalPdf('/Pad 9').length });
    expect(again.status).toBe(200);
    // after approval the limit is gone
    await grantDpaAndSite(contosoId);
    const act = await activate(contosoId);
    expect(act.status, JSON.stringify(act.json)).toBe(200);
    const free = await contoso.call('POST', '/api/uploads', { purpose: 'document', kind: 'other', name: 'eleventh.pdf', size: 100 });
    expect(free.status, JSON.stringify(free.json)).toBe(200);
    expect((await contoso.call('GET', '/api/org/profile')).json.profileFiles.max).toBeNull();
  });

  it('keeps one company away from the brands, documents and logos of another', async () => {
    const brand = await acmeAdmin.call('POST', '/api/org/brands', { name: 'Acme Secret Brand' });
    const brandId = brand.json.brand.id as string;
    const doc = await uploadProfile(acmeAdmin, 'document', 'acme-private.pdf', minimalPdf('/Acme 1'), { kind: 'other' });
    const logo = await uploadProfile(acmeAdmin, 'logo', 'acme-private.png', LOGO_PNG);
    expect((await acmeAdmin.call('POST', '/api/org/logo', { fileId: logo.fileId })).status).toBe(200);
    // Contoso sees none of it
    const cb = await contoso.call('GET', '/api/org/brands');
    expect(JSON.stringify(cb.json)).not.toMatch(/Acme/);
    const cd = await contoso.call('GET', '/api/org/documents');
    expect(JSON.stringify(cd.json)).not.toMatch(/acme-private/);
    expect((await contoso.call('PATCH', `/api/org/brands/${brandId}`, { name: 'Taken Over' })).status).toBe(404);
    expect((await contoso.call('DELETE', `/api/org/brands/${brandId}`)).status).toBe(404);
    expect((await contoso.call('GET', `/api/org/brands/${brandId}/logo`)).status).toBe(404);
    expect((await contoso.call('POST', `/api/org/brands/${brandId}/logo`, { fileId: logo.fileId })).status).toBe(404);
    expect((await contoso.call('DELETE', `/api/org/documents/${doc.fileId}`)).status).toBe(404);
    expect((await contoso.call('GET', `/api/files/${doc.fileId}/download`)).status).toBe(404);
    // Acme's file id cannot be adopted as Contoso's logo, and Contoso's logo is not Acme's
    expect((await contoso.call('POST', '/api/org/logo', { fileId: logo.fileId })).status).toBe(404);
    const cLogo = await contoso.call('GET', '/api/org/logo');
    expect(cLogo.res.headers['content-type']).toBe('image/svg+xml');
    const aLogo = await acmeAdmin.call('GET', '/api/org/logo');
    expect(aLogo.res.rawPayload.equals(LOGO_PNG)).toBe(true);
    // database level: Contoso's context reads none of Acme's rows
    const rows = await tx({ orgId: contosoId, bypass: false }, async (c) => ({
      brands: (await c.query(`SELECT count(*)::int AS n FROM brands WHERE org_id = $1`, [acmeId])).rows[0].n,
      files: (await c.query(`SELECT count(*)::int AS n FROM files WHERE org_id = $1`, [acmeId])).rows[0].n,
    }));
    expect(rows).toEqual({ brands: 0, files: 0 });
    // and a stranger cannot attach a brand to a case of the other company
    await q(`DELETE FROM files WHERE org_id = $1 AND purpose IN ('logo', 'document')`, [acmeId]);
    await q(`UPDATE organizations SET logo_file_id = NULL WHERE id = $1`, [acmeId]);
  });
});

// ===========================================================================
describe('getting started checklist and locked features', () => {
  it('follows the steps of a waiting company through to approval', async () => {
    // Fabrikam-like fresh registration: confirmed, no authenticator yet
    const r = await registerAndVerify();
    await enrol(r.c);
    const first = await r.c.call('GET', '/api/org/onboarding');
    expect(first.status).toBe(200);
    expect(first.json.items.map((i: any) => i.id)).toEqual(['account_secured', 'logo', 'case_address', 'spec', 'dpa', 'approval']);
    expect(first.json.items.every((i: any) => typeof i.label === 'string' && i.label.length > 5 && !/ [-–—] /.test(i.label))).toBe(true);
    expect(Object.fromEntries(first.json.items.map((i: any) => [i.id, i.done]))).toEqual({ account_secured: true, logo: false, case_address: true, spec: false, dpa: false, approval: false });
    expect(first.json.approved).toBe(false);

    // there is no checklist step for the company details any more (the card is gone from the profile page)

    // the spec step waits for a proposed or active version (the registration draft does not count)
    const specs = await r.c.call('GET', '/api/specs');
    expect(specs.json.items).toHaveLength(1);
    expect(specs.json.items[0].status).toBe('draft');
    await q(`UPDATE specs SET status = 'proposed' WHERE org_id = $1`, [r.orgId]);
    expect((await r.c.call('GET', '/api/org/onboarding')).json.items.find((i: any) => i.id === 'spec').done).toBe(true);
    // a DPA recorded by K Line
    await grantDpaAndSite(r.orgId);
    expect((await r.c.call('GET', '/api/org/onboarding')).json.items.find((i: any) => i.id === 'dpa').done).toBe(true);
    // the logo is the last thing K Line waits for
    expect((await activate(r.orgId)).json.code).toBe('logo_required');
    await attachLogo(r.c);
    expect((await r.c.call('GET', '/api/org/onboarding')).json.items.find((i: any) => i.id === 'logo').done).toBe(true);
    expect((await activate(r.orgId)).status).toBe(200);
    const last = await r.c.call('GET', '/api/org/onboarding');
    expect(last.json.approved).toBe(true);
    expect(last.json.items.every((i: any) => i.done)).toBe(true);
    // K Line staff have no checklist
    expect((await klAdmin.call('GET', '/api/org/onboarding')).status).toBe(403);
  });

  it('tells a waiting company why a feature is locked, in plain words', async () => {
    const r = await registerAndVerify();
    await enrol(r.c);
    const inv = await r.c.call('POST', '/api/team/invite', { email: uniqueEmail(), name: 'Mate', roles: ['viewer'] });
    expect(inv.status).toBe(403);
    expect(inv.json.message).toMatch(/approved your company/);
    expect(inv.json.message).not.toMatch(/ [-–—] /);
    const resend = await r.c.call('POST', `/api/team/${r.org.id}/resend-invite`, {});
    expect([403, 400]).toContain(resend.status);
  });
});

// ===========================================================================
describe('demo registrations list', () => {
  it('lists live confirmation links only', async () => {
    const { email, token } = await (async () => {
      const { email } = await register();
      const token = await confirmToken(email);
      return { email, token };
    })();
    const list = await new Client(app).call('GET', '/api/demo/registrations');
    const item = list.json.items.find((i: any) => i.email === email);
    expect(item).toBeTruthy();
    expect(item.link).toContain(token);
    expect(item.path).toBe(`/verify?token=${token}`);
    expect(new Date(item.expiresAt).getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000);
    // once used it disappears
    await new Client(app).call('POST', '/api/auth/verify', { token, password: GOOD_PASSWORD });
    expect((await new Client(app).call('GET', '/api/demo/registrations')).json.items.some((i: any) => i.email === email)).toBe(false);
    // not available outside demo mode
    config.demoMode = false;
    try {
      expect((await new Client(app).call('GET', '/api/demo/registrations')).status).toBe(404);
    } finally {
      config.demoMode = true;
    }
  });

  it('lets the seeded Fabrikam registration be confirmed through its listed link', async () => {
    const list = await new Client(app).call('GET', '/api/demo/registrations');
    const item = list.json.items.find((i: any) => i.email === 'owner@fabrikam.demo');
    const token = new URL(item.link).searchParams.get('token')!;
    const c = new Client(app);
    const v = await c.call('POST', '/api/auth/verify', { token, password: GOOD_PASSWORD });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect((await q(`SELECT signup->>'verified_at' AS v FROM organizations WHERE id = $1`, [fabrikamId]))[0].v).toBeTruthy();
    const review = await klAdmin.call('GET', '/api/partners?tab=review');
    expect(review.json.items.find((i: any) => i.id === fabrikamId).emailNotConfirmed).toBe(false);
  });
});
