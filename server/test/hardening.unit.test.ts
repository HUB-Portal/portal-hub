import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { checkPasswordPolicy, COMMON_PASSWORD_COUNT, hasRepeats, hasSequence, isCommonPassword } from '../src/crypto/password';
import { parseConfig, parseTrustProxy } from '../src/config';
import { containsNul } from '../src/http/nulBytes';
import { stripPatientFields } from '../src/http/patientFields';
import { hasProxyHeaders, isLocalPeer } from '../src/http/proxy';
import { cleanFileName } from '../src/services/files';
import { EVENT_BEFORE_CREATED_HOURS, isPlausibleEventTime, planTransition } from '../src/services/stageEngine';
import { assertUniqueCodes } from '../src/services/mes';
import { assertNoBidi } from '../src/http/util';
import { CASE_ID_MAX, caseIdRuleProblem, cleanCaseId } from '../../shared/filenames';
import { hasBidiControl } from '../../shared/text';
import { parseSpecContent, defaultSpecContent } from '../../shared/spec';

// ---------------------------------------------------------------------------------------------------------------------
describe('password policy', () => {
  const refused = [
    'password1234567', 'Password12345678', 'admin12345678', 'Admin@123456789', '123456789012', 'abcdefghijkl', 'letmein12345678',
    'iloveyou1234567', 'qwertzuiopasdf', '1qaz2wsx3edc4rfv',
  ];
  const accepted = ['Blue-Harbour-Kettle-2026!', 'Demo2026PartnerHub', 'violet-sofa-marathon-42', 'Correct-Horse-Battery-Staple', 'Liberty-Property-Poverty-Blue'];

  it('refuses the weak passwords the tester found', () => {
    for (const p of refused) expect(checkPasswordPolicy(p), p).not.toBeNull();
  });

  it('accepts strong passphrases and the demo password', () => {
    for (const p of accepted) expect(checkPasswordPolicy(p, { email: 'x@y.example', name: 'Ann Other' }), p).toBeNull();
  });

  it('keeps the old rules (length, one repeated character, common words, own email and name)', () => {
    expect(checkPasswordPolicy('short1!')).toMatch(/12/);
    expect(checkPasswordPolicy('x'.repeat(129))).toMatch(/128/);
    expect(checkPasswordPolicy('aaaaaaaaaaaaaaaa')).not.toBeNull();
    expect(checkPasswordPolicy('Welcome2026!')).toMatch(/common/);
    expect(checkPasswordPolicy('alexander-is-great-99', { email: 'alexander@acme.demo' })).toMatch(/email/);
    expect(checkPasswordPolicy('my name is Katrin ok ok', { name: 'Katrin Admin' })).toMatch(/name/);
  });

  it('has a large list and normalises before looking things up', () => {
    expect(COMMON_PASSWORD_COUNT).toBeGreaterThanOrEqual(900);
    // capitals, leet spelling, symbols and any tail of digits or symbols after a common stem
    for (const p of ['P@ssw0rd2026!', 'P@ssw0rd!2026', 'PASSWORD-0000000', 'L3tm31n-2026', 'Adm1n#2026', 'iLoveYou-123', 'S0mmer2026!!', 'W3lc0me!2027', 'Qwerty-2026-2027']) {
      expect(isCommonPassword(p) || hasSequence(p) || hasRepeats(p), p).toBe(true);
    }
    expect(isCommonPassword('Blue-Harbour-Kettle-2026!')).toBe(false);
  });

  it('refuses runs of four or more sequential characters and keyboard rows, up or down', () => {
    for (const p of ['Xk-abcd-Tr7vq9', 'Xk-4321-Tr7vqz', 'Xk-wxyz-Tr7vq9', 'Tr7-qwer-Kp9vzx', 'Tr7-asdf-Kp9vzx', 'Tr7-zxcv-Kp9vzx', 'Tr7-poiu-Kp9vzx', 'Tr7-ytrew-Kp9vz', 'Tr7-azerty-Kp9vz', 'Tr7-0987-Kp9vzxq', 'Tr7-1234-Kp9vzxq']) {
      expect(hasSequence(p), p).toBe(true);
      expect(checkPasswordPolicy(p), p).not.toBeNull();
    }
    // three in a row is fine, and words that happen to hold "erty" are fine
    for (const p of ['Xk-abc-Tr7vq9-Lm2', 'Liberty-Property-Poverty-Blue']) expect(hasSequence(p), p).toBe(false);
  });

  it('refuses repeated characters and repeated short blocks', () => {
    for (const p of ['Xk-aaaa-Tr7vq9-Lm', 'abababababab', 'Abc1Abc1Abc1Abc1', 'xyz123xyz123xyz123', 'Kp9vz-Kp9vz-Kp9vz']) {
      expect(hasRepeats(p) || hasSequence(p), p).toBe(true);
      expect(checkPasswordPolicy(p), p).not.toBeNull();
    }
    expect(hasRepeats('Blue-Harbour-Kettle-2026!')).toBe(false);
  });

  it('refuses a single kind of character under 16 characters, but not a long passphrase of one kind', () => {
    expect(checkPasswordPolicy('kxqzvbmtrplw')).toMatch(/passphrase/);
    expect(checkPasswordPolicy('KXQZVBMTRPLWJH')).toMatch(/passphrase/);
    expect(checkPasswordPolicy('839402716584')).not.toBeNull();
    expect(checkPasswordPolicy('kxqzvbmtrplwjhgnf')).toBeNull();
    expect(checkPasswordPolicy('kxqzvbmtrplW')).toBeNull();
  });

  it('keeps messages friendly: no dash separators', () => {
    for (const p of [...refused, 'kxqzvbmtrplw', 'short']) expect(checkPasswordPolicy(p) ?? '', p).not.toMatch(/[—–]| - /);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('TRUST_PROXY', () => {
  it('reads false, true, hops, loopback and a comma separated list', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('TRUE')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy(' Loopback , 172.29.10.2 ,10.0.0.0/8 ')).toBe('loopback,172.29.10.2,10.0.0.0/8');
    expect(parseTrustProxy('::1, fd00::/8')).toBe('::1,fd00::/8');
    expect(parseTrustProxy('linklocal,uniquelocal')).toBe('linklocal,uniquelocal');
  });

  it('stops on anything it does not understand', () => {
    for (const bad of ['maybe', 'loopbak', '999.1.1.1', '10.0.0.0/33', '10.0.0.0/8/8', 'loopback;10.0.0.1']) {
      expect(parseTrustProxy(bad), bad).toMatchObject({ problem: expect.stringMatching(/TRUST_PROXY/) });
    }
  });

  const base = {
    NODE_ENV: 'development', DATABASE_URL: 'postgres://u:averylongpassword123@h/db', MASTER_KEYS: JSON.stringify({ k: Buffer.alloc(32, 1).toString('base64') }), ACTIVE_KEY_ID: 'k', BLIND_INDEX_KEY_ID: 'k',
  };

  it('is passed through the configuration, and a typo stops the server from starting', () => {
    expect(parseConfig({ ...base, TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
    expect(parseConfig({ ...base, TRUST_PROXY: 'loopback, 172.29.10.2' }).trustProxy).toBe('loopback,172.29.10.2');
    expect(parseConfig(base).trustProxy).toBe(false);
    expect(() => parseConfig({ ...base, TRUST_PROXY: 'loopbak' })).toThrow(/TRUST_PROXY/);
  });

  it('makes Fastify use the forwarded client address only for a trusted proxy', async () => {
    const build = async (trustProxy: boolean | string) => {
      const app = Fastify({ trustProxy });
      app.get('/ip', async (req) => ({ ip: req.ip }));
      await app.ready();
      return app;
    };
    const headers = { 'x-forwarded-for': '203.0.113.7' };
    const trusted = await build(parseTrustProxy('loopback') as string);
    expect((await trusted.inject({ url: '/ip', headers, remoteAddress: '127.0.0.1' })).json().ip).toBe('203.0.113.7');
    // a peer that is not on the list cannot choose its own address
    expect((await trusted.inject({ url: '/ip', headers, remoteAddress: '198.51.100.9' })).json().ip).toBe('198.51.100.9');
    const list = await build(parseTrustProxy('loopback, 172.29.10.2') as string);
    expect((await list.inject({ url: '/ip', headers, remoteAddress: '172.29.10.2' })).json().ip).toBe('203.0.113.7');
    expect((await list.inject({ url: '/ip', headers, remoteAddress: '172.29.10.3' })).json().ip).toBe('172.29.10.3');
    const off = await build(false);
    expect((await off.inject({ url: '/ip', headers, remoteAddress: '127.0.0.1' })).json().ip).toBe('127.0.0.1');
    await Promise.all([trusted.close(), list.close(), off.close()]);
  });

  it('TUNNEL_HOOKS_ONLY defaults to off and is refused in production', () => {
    expect(parseConfig(base).tunnelHooksOnly).toBe(false);
    expect(parseConfig({ ...base, TUNNEL_HOOKS_ONLY: 'true' }).tunnelHooksOnly).toBe(true);
    const prod = { ...base, NODE_ENV: 'production', PUBLIC_URL: 'https://hub.example', SMTP_URL: 'smtp://x', SCANNER: 'clamav', SCRYPT_LOG_N: '17' };
    expect(() => parseConfig({ ...prod, TUNNEL_HOOKS_ONLY: 'true' })).toThrow(/TUNNEL_HOOKS_ONLY/);
    expect(parseConfig(prod).tunnelHooksOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('proxy headers and local peers', () => {
  it('sees every proxy header', () => {
    for (const h of ['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'x-real-ip']) expect(hasProxyHeaders({ [h]: 'x' }), h).toBe(true);
    expect(hasProxyHeaders({ host: 'localhost', 'user-agent': 'x' })).toBe(false);
  });

  it('accepts loopback and private peers only', () => {
    for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.20', 'fd00::1', 'fe80::1']) expect(isLocalPeer(ok), ok).toBe(true);
    for (const bad of ['203.0.113.7', '8.8.8.8', '2001:db8::1', '', undefined, 'not an address']) expect(isLocalPeer(bad as any), String(bad)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('NUL characters', () => {
  it('finds a NUL in strings, keys and nested values', () => {
    expect(containsNul('a\u0000b')).toBe(true);
    expect(containsNul({ a: { b: ['x', { c: 'y\u0000' }] } })).toBe(true);
    expect(containsNul({ ['k\u0000']: 1 })).toBe(true);
    expect(containsNul({ a: 'fine', b: [1, 2, null, true], c: { d: 'also fine' } })).toBe(false);
    expect(containsNul(Buffer.from([0, 1, 2]))).toBe(false);
    expect(containsNul(undefined)).toBe(false);
  });

  it('does not overflow the stack on a deeply nested value', () => {
    let v: unknown = 'x\u0000';
    for (let i = 0; i < 50_000; i++) v = [v];
    expect(containsNul(v)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('patient fields for keys without patients:read', () => {
  it('strips patient fields at any depth and leaves everything else', () => {
    const out = stripPatientFields({
      case: { id: 'c1', patientMasked: 'M*** A*****', hasPatientName: true, status: 'draft', counts: { upper: 1 } },
      items: [{ id: 'c2', patientMasked: null, hasPatientName: false, ref: 'ACME-000002' }],
      cases: [{ id: 'c3', patientMasked: 'X', firstName: 'A', lastName: 'B', createdAt: new Date(0) }],
    });
    expect(JSON.stringify(out)).not.toMatch(/patientMasked|hasPatientName|firstName|lastName/);
    expect(out.case).toEqual({ id: 'c1', status: 'draft', counts: { upper: 1 } });
    expect(out.items[0]).toEqual({ id: 'c2', ref: 'ACME-000002' });
    expect(out.cases[0]!.createdAt).toEqual(new Date(0));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('case ID rules', () => {
  it('refuses two dots, and a dot or a slash at the start or the end', () => {
    for (const bad of ['a..b', '..', '.abc', 'abc.', '/abc', 'abc/', 'a/../b', ' .a', '..\\x', 'x'.repeat(CASE_ID_MAX + 1), 'bad<id>', '']) expect(caseIdRuleProblem(bad), bad).not.toBeNull();
    for (const ok of ['55813', 'AB 12_3.4/5#6-7', 'a.b', 'a/b', 'x'.repeat(CASE_ID_MAX), 'A-1.2']) expect(caseIdRuleProblem(ok), ok).toBeNull();
  });

  it('cleans folder names into IDs that follow the rules', () => {
    for (const raw of ['..', '.hidden', 'case 7/', 'a..b', '  /x/  ', '...', 'name.', '../x']) {
      const id = cleanCaseId(raw);
      expect(id === '' || caseIdRuleProblem(id) === null, `${raw} -> ${id}`).toBe(true);
    }
    expect(cleanCaseId('a..b')).toBe('a.b');
    expect(cleanCaseId('case 7/')).toBe('case 7');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('hidden text direction characters', () => {
  const bidi = ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F'];

  it('finds every one of them', () => {
    for (const ch of bidi) {
      expect(hasBidiControl(`photo${ch}gnp.exe`), JSON.stringify(ch)).toBe(true);
      expect(() => assertNoBidi('fine', `x${ch}y`)).toThrow(/direction/);
    }
    expect(hasBidiControl('plain text, with Ünicode and عربي')).toBe(false);
    expect(() => assertNoBidi('a', null, undefined, 'b')).not.toThrow();
  });

  it('is refused in specification clause text and titles when someone writes them, but a stored specification can still be read', () => {
    const spec = defaultSpecContent() as any;
    expect(parseSpecContent(spec, { rejectBidi: true }).ok).toBe(true);
    for (const field of ['title', 'text'] as const) {
      const bad = structuredClone(spec);
      bad.material.clauses[0][field] = `Fine\u202Etext`;
      const r = parseSpecContent(bad, { rejectBidi: true });
      expect(r.ok, field).toBe(false);
      if (!r.ok) expect(r.problems.join(' ')).toMatch(/direction/);
      // reading what was stored before the rule existed is not refused
      expect(parseSpecContent(bad).ok, field).toBe(true);
    }
    const bag = structuredClone(spec);
    bag.bag.lines = [`Bag\u2067line`];
    expect(parseSpecContent(bag, { rejectBidi: true }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('file names', () => {
  it('keeps the extension when a long name is shortened', () => {
    const name = 'a'.repeat(300) + '.stl';
    const out = cleanFileName(name);
    expect(out.length).toBe(255);
    expect(out.endsWith('.stl')).toBe(true);
    expect(cleanFileName('b'.repeat(255) + '.PTS').endsWith('.pts') || cleanFileName('b'.repeat(255) + '.PTS').endsWith('.PTS')).toBe(true);
    expect(cleanFileName('c'.repeat(400)).length).toBe(255);
    expect(cleanFileName('folder/sub\\' + 'd'.repeat(260) + '.png')).toMatch(/^d+\.png$/);
    expect(cleanFileName('  U01.stl ')).toBe('U01.stl');
    expect(cleanFileName('x\u0000y.stl')).toBe('xy.stl');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('factory events: time and delivery rules', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const created = new Date('2026-10-01T09:00:00Z');

  it('accepts a believable time and refuses one long before the case, or years old', () => {
    expect(isPlausibleEventTime(new Date('2026-10-02T10:00:00Z'), created, now)).toBe(true);
    expect(isPlausibleEventTime(new Date(created.getTime() - (EVENT_BEFORE_CREATED_HOURS - 1) * 3_600_000), created, now)).toBe(true);
    expect(isPlausibleEventTime(new Date(created.getTime() - (EVENT_BEFORE_CREATED_HOURS + 1) * 3_600_000), created, now)).toBe(false);
    expect(isPlausibleEventTime(new Date('2023-10-04T12:00:00Z'), new Date('2023-09-01T00:00:00Z'), now)).toBe(false);
    expect(isPlausibleEventTime(new Date('2023-10-06T12:00:00Z'), new Date('2023-09-01T00:00:00Z'), now)).toBe(true);
    expect(isPlausibleEventTime(new Date(Number.NaN), created, now)).toBe(false);
    // the future is not refused here (it is treated as now)
    expect(isPlausibleEventTime(new Date('2027-01-01T00:00:00Z'), created, now)).toBe(true);
  });

  const row = (status: string, stage: string | null) => ({ status, stage, manufacturing_mode: 'standard', mes_case_id: null });
  const input = { source: 'mes' as const, carrier: null, trackingNumber: null, alignersShipped: null, holdReason: null, mesCaseId: null };

  it('ignores DELIVERED unless the case has shipped, and still delivers a shipped case', () => {
    for (const [s, st] of [['ready', null], ['received', 'received'], ['in_production', 'packing'], ['in_production', 'quality_check']] as const) {
      expect(planTransition(row(s, st), { ...input, target: 'delivered' }), `${s}/${st}`).toEqual({ kind: 'ignored', message: 'Send SHIP before DELIVERED.' });
    }
    expect(planTransition(row('shipped', 'shipped'), { ...input, target: 'delivered' })).toEqual({ kind: 'apply' });
    // already delivered stays "already at or past that stage"
    expect(planTransition(row('delivered', 'delivered'), { ...input, target: 'delivered' })).toMatchObject({ kind: 'ignored', message: expect.stringMatching(/already at or past/) });
  });

  it('refuses a stage map with a code twice, whatever its capitals', () => {
    expect(() => assertUniqueCodes([{ code: 'SHIP' }, { code: 'ship' }])).toThrow(/only once/);
    expect(() => assertUniqueCodes([{ code: 'SHIP' }, { code: 'PRINT' }])).not.toThrow();
  });
});
