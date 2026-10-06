import { describe, expect, it } from 'vitest';
import {
  COUNTRIES, EU_COUNTRIES, FREE_MAIL_DOMAINS, PRIVACY_VERSION, THROWAWAY_DOMAINS, VOLUME_BANDS, codeCandidates, countryName, isCountryCode, isEuCountry, isFreeMailDomain,
  isThrowawayDomain, isValidCompanyCode, nameWords, suggestCompanyCode, validateCompanyName, validateEmail, validatePersonName, validateRegistration, validateWebsite,
} from '../../shared/signup';
import { checkCaseIdRegex } from '../src/services/profile';
import { renderEmail } from '../src/services/mail';
import { redactUrl } from '../src/http/util';
import { parseConfig } from '../src/config';

describe('countries and volume bands', () => {
  it('lists the ISO countries with English names, sorted', () => {
    expect(COUNTRIES.length).toBeGreaterThanOrEqual(240);
    expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(COUNTRIES.length);
    expect(COUNTRIES.every((c) => /^[A-Z]{2}$/.test(c.code) && c.name.length > 1)).toBe(true);
    expect(countryName('DE')).toBe('Germany');
    expect(countryName('PT')).toBe('Portugal');
    expect(isCountryCode('EG')).toBe(true);
    expect(isCountryCode('ZZ')).toBe(false);
    expect(isCountryCode('de')).toBe(false);
    const names = COUNTRIES.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
  });
  it('knows EU members for VAT rules', () => {
    expect(EU_COUNTRIES.length).toBe(27);
    expect(isEuCountry('FR')).toBe(true);
    expect(isEuCountry('NO')).toBe(false);
    expect(isEuCountry(null)).toBe(false);
  });
  it('has the four volume bands with labels', () => {
    expect(VOLUME_BANDS.map((b) => b.id)).toEqual(['under_1000', '1000_5000', '5000_20000', 'over_20000']);
    expect(VOLUME_BANDS.every((b) => b.label.length > 5)).toBe(true);
    expect(PRIVACY_VERSION).toBe('2026-09');
  });
});

describe('name validators', () => {
  const ok = ['Acme Aligners Ltd', "O'Brien & Sons (Dental)", 'Müller Zahntechnik GmbH', 'Клиника Улыбка', '牙科 诊所', 'Clinique Dentaire Saint-Éloi', '3M Dental', 'A. B. Smith, Inc.'];
  const bad = ['x', '', ' ', 'www.acme.com', 'https://acme.com', 'acme.com', 'Smile.Dental', 'a@b.com', '<script>alert(1)</script>', 'Acme/Partners', 'Acme\\Partners', '12345', 'Acme ✔', 'javascript:alert(1)', 'a'.repeat(121)];
  it('accepts real company names in many scripts', () => {
    for (const v of ok) expect(validateCompanyName(v), v).toMatchObject({ ok: true });
  });
  it('refuses web addresses, markup and odd characters', () => {
    for (const v of bad) expect(validateCompanyName(v), v).toMatchObject({ ok: false });
  });
  it('cleans white space and composes accents', () => {
    const r = validateCompanyName('  Café   Dental \n Lab ');
    expect(r).toEqual({ ok: true, value: 'Café Dental Lab' });
  });
  it('applies the same rules to person names', () => {
    expect(validatePersonName('Dr. Ana María Núñez-Álvarez')).toMatchObject({ ok: true });
    expect(validatePersonName('ana@acme.com')).toMatchObject({ ok: false });
    expect(validatePersonName('A')).toMatchObject({ ok: false });
  });
});

describe('website and email validators', () => {
  it('website is optional, http or https only, at most 200 characters', () => {
    expect(validateWebsite('')).toEqual({ ok: true, value: null });
    expect(validateWebsite(undefined)).toEqual({ ok: true, value: null });
    expect(validateWebsite('https://www.example.com/path?x=1')).toMatchObject({ ok: true });
    expect(validateWebsite('http://example.com')).toMatchObject({ ok: true });
    for (const v of ['ftp://example.com', 'javascript:alert(1)', 'www.example.com', 'https://', 'https://localhost', 'https://user:pw@example.com', 'https://exa mple.com', `https://example.com/${'a'.repeat(200)}`]) {
      expect(validateWebsite(v), v).toMatchObject({ ok: false });
    }
  });
  it('email is normalised to lower case and checked for syntax', () => {
    expect(validateEmail('  Jo.Smith@Acme-Dental.COM ')).toEqual({ ok: true, value: 'jo.smith@acme-dental.com' });
    for (const v of ['', 'nope', 'a@b', 'a@@b.com', 'a b@c.com', '@c.com', 'a@.com', 'a@c..com', 'a@c.c', `${'a'.repeat(65)}@c.com`, 'a@-c.com']) {
      expect(validateEmail(v), v).toMatchObject({ ok: false });
    }
  });
});

describe('mailbox domains', () => {
  it('has at least 60 lower case throwaway domains without duplicates', () => {
    expect(THROWAWAY_DOMAINS.length).toBeGreaterThanOrEqual(60);
    expect(THROWAWAY_DOMAINS.every((d) => d === d.toLowerCase() && d.includes('.'))).toBe(true);
    expect(new Set(THROWAWAY_DOMAINS).size).toBe(THROWAWAY_DOMAINS.length);
  });
  it('recognises throwaway mailboxes, sub domains and mixed case', () => {
    expect(isThrowawayDomain('mailinator.com')).toBe(true);
    expect(isThrowawayDomain('someone@Mailinator.COM')).toBe(true);
    expect(isThrowawayDomain('x@inbox.guerrillamail.com')).toBe(true);
    expect(isThrowawayDomain('x@acme-dental.com')).toBe(false);
    expect(isThrowawayDomain('x@notmailinator.com')).toBe(false);
  });
  it('recognises personal mailbox providers, including country domains', () => {
    for (const d of ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'gmx.de', 'gmx.net', 'gmx.at', 'web.de', 'aol.com', 'hotmail.co.uk', 'yahoo.fr', 'outlook.de', 'live.nl']) {
      expect(isFreeMailDomain(d), d).toBe(true);
    }
    expect(isFreeMailDomain('a@Gmail.com')).toBe(true);
    expect(isFreeMailDomain('acme-dental.com')).toBe(false);
    expect(FREE_MAIL_DOMAINS.every((d) => d === d.toLowerCase())).toBe(true);
    // A work domain that is not a free mailbox is not flagged, and free mailboxes are not throwaway.
    expect(isThrowawayDomain('gmail.com')).toBe(false);
  });
});

describe('company codes', () => {
  it('uses the first four letters for one or two words', () => {
    expect(suggestCompanyCode('Contoso Smile')).toBe('CONT');
    expect(suggestCompanyCode('Acme Aligners Ltd')).toBe('ACME');
    expect(suggestCompanyCode('Dentalux')).toBe('DENT');
    expect(suggestCompanyCode('Ivo')).toBe('IVO');
  });
  it('uses initials for three or more words', () => {
    expect(suggestCompanyCode('Fabrikam Dental Lab')).toBe('FDL');
    expect(suggestCompanyCode('Clear Smile Dental GmbH')).toBe('CSD');
    expect(suggestCompanyCode('Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota')).toBe('ABGDEZET');
  });
  it('ignores legal forms only', () => {
    expect(nameWords('Nordic Smile S.L.')).toEqual(['NORDIC', 'SMILE']);
    for (const legal of ['GmbH', 'Ltd', 'LLC', 'SL', 'SA', 'UAB', 'BV', 'AG', 'Inc', 'Co', 'Limited']) {
      expect(nameWords(`Blue Tooth ${legal}`), legal).toEqual(['BLUE', 'TOOTH']);
    }
    // Ordinary words such as "and", "the" or "Aligners" stay.
    expect(suggestCompanyCode('The Smile Aligners')).toBe('TSA');
    expect(nameWords('Smile Aligners')).toEqual(['SMILE', 'ALIGNERS']);
  });
  it('folds accents and non Latin scripts to A-Z0-9 and always yields 2 to 8 characters', () => {
    expect(suggestCompanyCode('Müller Zahntechnik GmbH')).toBe('MULL');
    expect(suggestCompanyCode('Straße Dental')).toBe('STRA');
    expect(suggestCompanyCode('Ølsted Tænder')).toBe('OLST');
    for (const n of ['牙科 诊所', 'GmbH', 'X', '!!!', 'Q Q Q Q Q Q Q Q Q Q', 'Клиника Улыбка Плюс']) {
      const c = suggestCompanyCode(n);
      expect(c, n).toMatch(/^[A-Z0-9]{2,8}$/);
    }
  });
  it('never suggests the reserved code KL and gives numbered alternatives', () => {
    expect(suggestCompanyCode('K L')).not.toBe('KL');
    expect(suggestCompanyCode('Kl Ltd')).not.toBe('KL');
    const list = codeCandidates('Contoso Smile');
    expect(list[0]).toBe('CONT');
    expect(list.slice(1, 4)).toEqual(['CONT2', 'CONT3', 'CONT4']);
    expect(list.every(isValidCompanyCode)).toBe(true);
    expect(codeCandidates('Alpha Beta Gamma Delta Epsilon Zeta Eta Theta')[1]).toBe('ABGDEZE2');
    expect(isValidCompanyCode('KL')).toBe(false);
    expect(isValidCompanyCode('K')).toBe(false);
    expect(isValidCompanyCode('abcd')).toBe(false);
    expect(isValidCompanyCode('ACME')).toBe(true);
  });
});

describe('whole registration form', () => {
  const good = {
    companyName: 'Acme Aligners Ltd', country: 'PT', personName: 'Alex Acme', email: 'Alex@acme-aligners.com', website: 'https://acme-aligners.com', volume: '1000_5000',
    acceptAuthority: true, acceptPrivacy: true, privacyVersion: PRIVACY_VERSION,
    caseAddress: { street: '1 Rua Direita', city: 'Chaves', postalCode: '5400-001', stateProvince: 'Vila Real', country: 'PT', phone: '+351276000000' },
  };
  it('accepts a good form and cleans it', () => {
    const r = validateRegistration(good);
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ email: 'alex@acme-aligners.com', country: 'PT', freeEmail: false, volume: '1000_5000', privacyVersion: PRIVACY_VERSION }) });
    expect(validateRegistration({ ...good, email: 'alex@gmail.com', website: '', volume: undefined })).toEqual({ ok: true, value: expect.objectContaining({ freeEmail: true, website: null, volume: null }) });
  });
  it('lists a message per bad field', () => {
    const r = validateRegistration({ companyName: 'x', country: 'ZZ', personName: '', email: 'bad', website: 'ftp://x.y', volume: 'lots', acceptAuthority: false, acceptPrivacy: 'yes', privacyVersion: 'old' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.path).sort()).toEqual(['acceptAuthority', 'acceptPrivacy', 'caseAddress.city', 'caseAddress.country', 'caseAddress.phone', 'caseAddress.postalCode', 'caseAddress.stateProvince', 'caseAddress.street', 'companyName', 'country', 'email', 'personName', 'privacyVersion', 'volume', 'website'].sort());
  });
  it('flags throwaway mailboxes with the email_not_allowed code', () => {
    const r = validateRegistration({ ...good, email: 'x@mailinator.com' });
    expect(r).toEqual({ ok: false, problems: [{ path: 'email', message: expect.stringMatching(/work email/), code: 'email_not_allowed' }] });
  });
});

describe('case ID pattern check', () => {
  it('accepts ordinary patterns', () => {
    for (const p of ['^AC-\\d{4}$', '^[A-Z]{2}\\d+$', '^\\d{5,8}$', '.*']) expect(checkCaseIdRegex(p), p).toBeNull();
  });
  it('refuses broken, over long and catastrophic patterns quickly', () => {
    expect(checkCaseIdRegex('([a-z')).toMatch(/not a valid pattern/);
    expect(checkCaseIdRegex('a'.repeat(201))).toMatch(/200/);
    const t0 = Date.now();
    expect(checkCaseIdRegex('^(A+)+$')).toMatch(/too slow/);
    expect(checkCaseIdRegex('^(a|aa)+$')).toMatch(/too slow/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('registration emails and logging', () => {
  it('has fixed text: nothing typed by the registrant can appear', () => {
    const typed = { name: 'TypedPersonName', orgName: 'TypedCompanyName', company: 'TypedCompanyName', link: 'https://hub.test/x' };
    for (const t of ['signup_confirm', 'signup_existing', 'signup_declined', 'signup_approved', 'admin_new_signup', 'admin_signup_ceiling'] as const) {
      const m = renderEmail(t, typed);
      expect(m.subject + m.text, t).not.toMatch(/Typed/);
      expect(m.text, t).not.toMatch(/[—–]/);
    }
    expect(renderEmail('admin_new_signup', typed).text).toContain('A new company has confirmed its email address');
    expect(renderEmail('signup_confirm', typed).text).toContain('https://hub.test/x');
  });
  it('redacts the verify token in request logs', () => {
    expect(redactUrl('/api/auth/verify/abcDEF123_-xyz0123456789')).toBe('/api/auth/verify/[redacted]');
    expect(redactUrl('/verify?token=abc123')).toBe('/verify?token=[redacted]');
  });
});

describe('configuration', () => {
  const base = {
    NODE_ENV: 'production', DATABASE_URL: 'postgres://u:averylongpassword123@h/db', MASTER_KEYS: JSON.stringify({ k: Buffer.alloc(32, 1).toString('base64') }), ACTIVE_KEY_ID: 'k', BLIND_INDEX_KEY_ID: 'k',
    PUBLIC_URL: 'https://hub.example', SMTP_URL: 'smtp://x', SCANNER: 'clamav', SCRYPT_LOG_N: '17',
  };
  it('production refuses signup without a privacy contact', () => {
    expect(() => parseConfig({ ...base, SIGNUP_ENABLED: 'true' })).toThrow(/PRIVACY_EMAIL/);
    expect(parseConfig({ ...base, SIGNUP_ENABLED: 'true', PRIVACY_EMAIL: 'privacy@hub.example' }).signupEnabled).toBe(true);
    expect(parseConfig(base).signupEnabled).toBe(false);
  });
  it('registration answers take 600 ms by default and the ceiling defaults to 100', () => {
    const c = parseConfig({ ...base, SIGNUP_ENABLED: 'true', PRIVACY_EMAIL: 'p@x.example' });
    expect(c.signupMinMs).toBe(600);
    expect(c.signupDailyLimit).toBe(100);
    expect(() => parseConfig({ ...base, SIGNUP_ENABLED: 'true', PRIVACY_EMAIL: 'p@x.example', SIGNUP_MIN_MS: '10' })).toThrow(/SIGNUP_MIN_MS/);
  });
});
