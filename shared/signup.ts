// Self registration rules shared by the server and the web app. Plain TypeScript (imports only ./caseAddress).
// Nothing in here touches a database: validation is the same for known and unknown addresses.
import { validateCaseAddress, type CaseAddress } from './caseAddress';

/** Version of the privacy notice shown on the registration form. The form sends it back and the server compares. */
export const PRIVACY_VERSION = '2026-09';

/** Codes that only K Line may use. */
export const RESERVED_CODES: readonly string[] = ['KL'];
export const COMPANY_CODE_RE = /^[A-Z0-9]{2,8}$/;

// ---------------------------------------------------------------------------
// Countries (ISO 3166-1 alpha 2, English short names)
// ---------------------------------------------------------------------------
export interface Country {
  code: string;
  name: string;
}

const COUNTRY_LIST = `AF Afghanistan|AX Åland Islands|AL Albania|DZ Algeria|AS American Samoa|AD Andorra|AO Angola|AI Anguilla|AQ Antarctica|AG Antigua and Barbuda|AR Argentina|AM Armenia|AW Aruba|AU Australia|AT Austria|AZ Azerbaijan|BS Bahamas|BH Bahrain|BD Bangladesh|BB Barbados|BY Belarus|BE Belgium|BZ Belize|BJ Benin|BM Bermuda|BT Bhutan|BO Bolivia|BQ Bonaire, Sint Eustatius and Saba|BA Bosnia and Herzegovina|BW Botswana|BV Bouvet Island|BR Brazil|IO British Indian Ocean Territory|BN Brunei Darussalam|BG Bulgaria|BF Burkina Faso|BI Burundi|CV Cabo Verde|KH Cambodia|CM Cameroon|CA Canada|KY Cayman Islands|CF Central African Republic|TD Chad|CL Chile|CN China|CX Christmas Island|CC Cocos (Keeling) Islands|CO Colombia|KM Comoros|CG Congo|CD Congo (Democratic Republic)|CK Cook Islands|CR Costa Rica|CI Côte d'Ivoire|HR Croatia|CU Cuba|CW Curaçao|CY Cyprus|CZ Czechia|DK Denmark|DJ Djibouti|DM Dominica|DO Dominican Republic|EC Ecuador|EG Egypt|SV El Salvador|GQ Equatorial Guinea|ER Eritrea|EE Estonia|SZ Eswatini|ET Ethiopia|FK Falkland Islands|FO Faroe Islands|FJ Fiji|FI Finland|FR France|GF French Guiana|PF French Polynesia|TF French Southern Territories|GA Gabon|GM Gambia|GE Georgia|DE Germany|GH Ghana|GI Gibraltar|GR Greece|GL Greenland|GD Grenada|GP Guadeloupe|GU Guam|GT Guatemala|GG Guernsey|GN Guinea|GW Guinea-Bissau|GY Guyana|HT Haiti|HM Heard Island and McDonald Islands|VA Holy See|HN Honduras|HK Hong Kong|HU Hungary|IS Iceland|IN India|ID Indonesia|IR Iran|IQ Iraq|IE Ireland|IM Isle of Man|IL Israel|IT Italy|JM Jamaica|JP Japan|JE Jersey|JO Jordan|KZ Kazakhstan|KE Kenya|KI Kiribati|KP Korea (Democratic People's Republic)|KR Korea (Republic)|KW Kuwait|KG Kyrgyzstan|LA Lao People's Democratic Republic|LV Latvia|LB Lebanon|LS Lesotho|LR Liberia|LY Libya|LI Liechtenstein|LT Lithuania|LU Luxembourg|MO Macao|MG Madagascar|MW Malawi|MY Malaysia|MV Maldives|ML Mali|MT Malta|MH Marshall Islands|MQ Martinique|MR Mauritania|MU Mauritius|YT Mayotte|MX Mexico|FM Micronesia|MD Moldova|MC Monaco|MN Mongolia|ME Montenegro|MS Montserrat|MA Morocco|MZ Mozambique|MM Myanmar|NA Namibia|NR Nauru|NP Nepal|NL Netherlands|NC New Caledonia|NZ New Zealand|NI Nicaragua|NE Niger|NG Nigeria|NU Niue|NF Norfolk Island|MK North Macedonia|MP Northern Mariana Islands|NO Norway|OM Oman|PK Pakistan|PW Palau|PS Palestine, State of|PA Panama|PG Papua New Guinea|PY Paraguay|PE Peru|PH Philippines|PN Pitcairn|PL Poland|PT Portugal|PR Puerto Rico|QA Qatar|RE Réunion|RO Romania|RU Russian Federation|RW Rwanda|BL Saint Barthélemy|SH Saint Helena, Ascension and Tristan da Cunha|KN Saint Kitts and Nevis|LC Saint Lucia|MF Saint Martin (French part)|PM Saint Pierre and Miquelon|VC Saint Vincent and the Grenadines|WS Samoa|SM San Marino|ST Sao Tome and Principe|SA Saudi Arabia|SN Senegal|RS Serbia|SC Seychelles|SL Sierra Leone|SG Singapore|SX Sint Maarten (Dutch part)|SK Slovakia|SI Slovenia|SB Solomon Islands|SO Somalia|ZA South Africa|GS South Georgia and the South Sandwich Islands|SS South Sudan|ES Spain|LK Sri Lanka|SD Sudan|SR Suriname|SJ Svalbard and Jan Mayen|SE Sweden|CH Switzerland|SY Syrian Arab Republic|TW Taiwan|TJ Tajikistan|TZ Tanzania|TH Thailand|TL Timor-Leste|TG Togo|TK Tokelau|TO Tonga|TT Trinidad and Tobago|TN Tunisia|TR Türkiye|TM Turkmenistan|TC Turks and Caicos Islands|TV Tuvalu|UG Uganda|UA Ukraine|AE United Arab Emirates|GB United Kingdom|US United States|UM United States Minor Outlying Islands|UY Uruguay|UZ Uzbekistan|VU Vanuatu|VE Venezuela|VN Viet Nam|VG Virgin Islands (British)|VI Virgin Islands (U.S.)|WF Wallis and Futuna|EH Western Sahara|YE Yemen|ZM Zambia|ZW Zimbabwe|XK Kosovo`;

/** Every country the form offers, sorted by English name. */
export const COUNTRIES: readonly Country[] = COUNTRY_LIST.split('|')
  .map((s) => ({ code: s.slice(0, 2), name: s.slice(3) }))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));

const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.code));
export const isCountryCode = (v: unknown): v is string => typeof v === 'string' && COUNTRY_CODES.has(v);
export const countryName = (code: string | null | undefined): string => COUNTRIES.find((c) => c.code === code)?.name ?? '';

/** Members of the European Union (VAT identification numbers exist for these). */
export const EU_COUNTRIES: readonly string[] = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
];
export const isEuCountry = (code: string | null | undefined): boolean => EU_COUNTRIES.includes((code ?? '').toUpperCase());

// ---------------------------------------------------------------------------
// Volume bands
// ---------------------------------------------------------------------------
export const VOLUME_BANDS = [
  { id: 'under_1000', label: 'Under 1,000 cases a year' },
  { id: '1000_5000', label: '1,000 to 5,000 cases a year' },
  { id: '5000_20000', label: '5,000 to 20,000 cases a year' },
  { id: 'over_20000', label: 'More than 20,000 cases a year' },
] as const;
export type VolumeBand = (typeof VOLUME_BANDS)[number]['id'];
export const isVolumeBand = (v: unknown): v is VolumeBand => VOLUME_BANDS.some((b) => b.id === v);
export const volumeLabel = (id: string | null | undefined): string => VOLUME_BANDS.find((b) => b.id === id)?.label ?? '';

// ---------------------------------------------------------------------------
// Validators. Each returns { ok: true, value } (cleaned) or { ok: false, message }.
// ---------------------------------------------------------------------------
export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** Trims, joins white space into single spaces and composes accents (NFC). */
export function cleanText(raw: unknown): string {
  return typeof raw === 'string' ? raw.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

const NAME_CHARS = /^[\p{L}\p{M}\p{N} .,'’&()\-]+$/u;
const NAME_URL_LIKE = /(^|[\s(])[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,24}(?=$|[\s,)])/u;

function checkName(raw: unknown, label: string): Checked<string> {
  const v = cleanText(raw);
  if (v.length < 2) return bad(`Enter the ${label}.`);
  if (v.length > 120) return bad(`The ${label} can have at most 120 characters.`);
  if (/[<>@/\\]/.test(v) || /:\/\//.test(v) || /\bwww\./i.test(v) || /\b(?:https?|ftp|javascript|data):/i.test(v) || NAME_URL_LIKE.test(v)) {
    return bad(`Enter a name, not a web address or email address.`);
  }
  if (!NAME_CHARS.test(v)) return bad(`The ${label} can only have letters, digits, spaces and . , ' & - ( ).`);
  if (!/\p{L}/u.test(v)) return bad(`The ${label} needs at least one letter.`);
  return { ok: true, value: v };
}
export const validateCompanyName = (raw: unknown): Checked<string> => checkName(raw, 'company name');
export const validatePersonName = (raw: unknown): Checked<string> => checkName(raw, 'name');

/** Optional website. Empty means none. Only http and https, at most 200 characters. */
export function validateWebsite(raw: unknown): Checked<string | null> {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return { ok: true, value: null };
  if (v.length > 200) return bad('The website address can have at most 200 characters.');
  if (/\s/.test(v)) return bad('Enter the website address without spaces, for example https://www.example.com.');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return bad('Enter the website address including https://, for example https://www.example.com.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return bad('The website address must start with https:// or http://.');
  if (u.username || u.password) return bad('The website address cannot contain a user name or password.');
  if (!u.hostname.includes('.') || u.hostname.length > 190) return bad('Enter a full website address, for example https://www.example.com.');
  return { ok: true, value: v };
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normaliseEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}
export const emailDomain = (email: string): string => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** Work email address: syntax only. Whether the domain is allowed is decided by isThrowawayDomain. */
export function validateEmail(raw: unknown): Checked<string> {
  const v = normaliseEmail(raw);
  if (!v) return bad('Enter your work email address.');
  const at = v.lastIndexOf('@');
  if (v.length > 254 || at < 1 || at > 64 || !EMAIL_RE.test(v) || v.includes('..') || !/[a-z]{2,}$/.test(v)) {
    return bad('Enter a valid email address, for example name@company.com.');
  }
  return { ok: true, value: v };
}

// ---------------------------------------------------------------------------
// Mailbox domains
// ---------------------------------------------------------------------------
/** Well known disposable mailbox providers (lower case). A domain matches itself and its sub domains. */
export const THROWAWAY_DOMAINS: readonly string[] = [
  '0-mail.com', '10minutemail.com', '10minutemail.net', '10minutemail.org', '20minutemail.com', '33mail.com', 'anonbox.net', 'anonymbox.com',
  'binkmail.com', 'bobmail.info', 'boximail.com', 'burnermail.io', 'byom.de', 'cool.fr.nf', 'crazymailing.com', 'deadaddress.com', 'despam.it',
  'discard.email', 'discardmail.com', 'discardmail.de', 'disposableemailaddresses.com', 'dispostable.com', 'dropmail.me', 'dump-email.info',
  'e4ward.com', 'einrot.com', 'emailondeck.com', 'emailsensei.com', 'emailtemporanea.net', 'emkei.cz', 'fakeinbox.com', 'fakemail.net',
  'filzmail.com', 'fixmail.tk', 'getairmail.com', 'getnada.com', 'grr.la', 'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de',
  'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'harakirimail.com', 'inboxbear.com', 'inboxkitten.com',
  'incognitomail.com', 'instantemailaddress.com', 'jetable.org', 'kasmail.com', 'klassmaster.com', 'kurzepost.de', 'letthemeatspam.com',
  'mail-temporaire.fr', 'mail.tm', 'mailcatch.com', 'maildrop.cc', 'maileater.com', 'mailexpire.com', 'mailforspam.com', 'mailinator.com',
  'mailinator.net', 'mailinator2.com', 'mailnesia.com', 'mailnull.com', 'mailsac.com', 'mailtemp.info', 'mailtothis.com', 'meltmail.com',
  'mintemail.com', 'moakt.com', 'mohmal.com', 'mt2015.com', 'mytemp.email', 'mytrashmail.com', 'nada.email', 'nospam.ze.tc', 'nowmymail.com',
  'objectmail.com', 'owlpic.com', 'proxymail.eu', 'putthisinyourspamdatabase.com', 'rcpt.at', 'rmqkr.net', 'safetymail.info', 'sharklasers.com',
  'shieldemail.com', 'smashmail.de', 'sneakemail.com', 'sogetthis.com', 'spam4.me', 'spamavert.com', 'spambog.com', 'spambox.us', 'spamex.com',
  'spamfree24.org', 'spamgourmet.com', 'spamherelots.com', 'spamhole.com', 'spaml.com', 'spamspot.com', 'supermailer.jp', 'teleworm.us',
  'temp-mail.io', 'temp-mail.org', 'tempail.com', 'tempemail.co.za', 'tempemail.com', 'tempemail.net', 'tempinbox.com', 'tempmail.com',
  'tempmail.dev', 'tempmail.net', 'tempmailaddress.com', 'tempmailo.com', 'tempr.email', 'thankyou2010.com', 'throwam.com', 'throwawaymail.com',
  'tmail.ws', 'tmpmail.net', 'tmpmail.org', 'trash-mail.com', 'trash-mail.de', 'trashmail.at', 'trashmail.com', 'trashmail.io', 'trashmail.me',
  'trashmail.net', 'trashmail.org', 'trbvm.com', 'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org', 'yopmail.com', 'yopmail.fr', 'yopmail.net',
  'zetmail.com', 'zippymail.info',
];

/** Personal mailbox providers. Allowed, but flagged for the K Line reviewer. */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'icloud.com',
  'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'gmx.eu', 'web.de',
  'aol.com', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 't-online.de', 'freenet.de', 'posteo.de', 'mailbox.org', 'fastmail.com', 'tutanota.com',
  'tuta.io', 'hey.com', 'qq.com', '163.com', 'libero.it', 'orange.fr', 'wanadoo.fr', 'free.fr', 'laposte.net', 'sapo.pt', 'terra.com.br', 'bol.com.br',
  'uol.com.br', 'mail.ru', 'seznam.cz', 'wp.pl', 'o2.pl', 'interia.pl', 'abv.bg',
];
/** Families of personal providers that use many country domains. */
const FREE_MAIL_PATTERNS: readonly RegExp[] = [/^gmx\.[a-z.]+$/, /^yahoo\.[a-z.]+$/, /^hotmail\.[a-z.]+$/, /^outlook\.[a-z.]+$/, /^live\.[a-z.]+$/, /^icloud\.[a-z.]+$/];

const THROWAWAY_SET = new Set(THROWAWAY_DOMAINS);
const FREE_SET = new Set(FREE_MAIL_DOMAINS);

function domainOf(input: string): string {
  const v = input.trim().toLowerCase();
  return v.includes('@') ? emailDomain(v) : v;
}

/** True for a disposable mailbox domain or any sub domain of one. Accepts a domain or a full email address. */
export function isThrowawayDomain(input: string): boolean {
  const parts = domainOf(input).split('.');
  for (let i = 0; i < parts.length - 1; i++) if (THROWAWAY_SET.has(parts.slice(i).join('.'))) return true;
  return false;
}

/** True for personal mailbox providers (gmail.com, outlook.com, gmx.de ...). Accepts a domain or a full email address. */
export function isFreeMailDomain(input: string): boolean {
  const d = domainOf(input);
  return FREE_SET.has(d) || FREE_MAIL_PATTERNS.some((re) => re.test(d));
}

export const THROWAWAY_MESSAGE = 'Please use your work email address. Temporary mailboxes cannot be used to register.';

// ---------------------------------------------------------------------------
// Whole form
// ---------------------------------------------------------------------------
export interface RegistrationInput {
  companyName: string;
  country: string;
  personName: string;
  email: string;
  website: string | null;
  volume: VolumeBand | null;
  freeEmail: boolean;
  privacyVersion: string;
  /** Where K Line sends the cases back to. Recipient, company and email default to the registrant's own details. */
  caseAddress: CaseAddress;
}
export interface FieldProblem {
  path: string;
  message: string;
  code?: string;
}

/** Checks the whole registration form. Never looks at any database. */
export function validateRegistration(raw: Record<string, unknown>): { ok: true; value: RegistrationInput } | { ok: false; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const add = (path: string, message: string, code?: string) => problems.push({ path, message, ...(code ? { code } : {}) });

  const company = validateCompanyName(raw.companyName);
  if (!company.ok) add('companyName', company.message);
  const person = validatePersonName(raw.personName);
  if (!person.ok) add('personName', person.message);
  const country = typeof raw.country === 'string' ? raw.country.trim().toUpperCase() : '';
  if (!isCountryCode(country)) add('country', 'Choose your country.');
  const email = validateEmail(raw.email);
  if (!email.ok) add('email', email.message);
  else if (isThrowawayDomain(email.value)) add('email', THROWAWAY_MESSAGE, 'email_not_allowed');
  const website = validateWebsite(raw.website);
  if (!website.ok) add('website', website.message);
  let volume: VolumeBand | null = null;
  if (raw.volume !== undefined && raw.volume !== null && raw.volume !== '') {
    if (isVolumeBand(raw.volume)) volume = raw.volume;
    else add('volume', 'Choose one of the volume options.');
  }
  // Case address: street, city, postal code, state or province, country and phone are typed in the form. Recipient, company and email
  // default to the registrant's person name, company name and email address (the registrant can change them later in the profile).
  const ca = raw.caseAddress && typeof raw.caseAddress === 'object' && !Array.isArray(raw.caseAddress) ? (raw.caseAddress as Record<string, unknown>) : {};
  const typed = (k: string) => (typeof ca[k] === 'string' && (ca[k] as string).trim() !== '' ? ca[k] : undefined);
  const caseAddress = validateCaseAddress({
    company: typed('company') ?? (company.ok ? company.value : ''),
    fullName: typed('fullName') ?? (person.ok ? person.value : ''),
    email: typed('email') ?? (email.ok ? email.value : ''),
    street: ca.street,
    city: ca.city,
    postalCode: ca.postalCode,
    stateProvince: ca.stateProvince,
    country: ca.country,
    phone: ca.phone,
  });
  if (!caseAddress.ok) {
    // Problems with a default that was already reported above (company, name, email) are not repeated.
    for (const p of caseAddress.problems) {
      const inherited = (p.path === 'company' && !typed('company') && !company.ok) || (p.path === 'fullName' && !typed('fullName') && !person.ok) || (p.path === 'email' && !typed('email') && !email.ok);
      if (!inherited) add(`caseAddress.${p.path}`, p.message);
    }
  }
  if (raw.acceptAuthority !== true) add('acceptAuthority', 'Please confirm that you are allowed to register this company.');
  if (raw.acceptPrivacy !== true) add('acceptPrivacy', 'Please confirm that you have read the privacy notice.');
  if (raw.privacyVersion !== PRIVACY_VERSION) add('privacyVersion', 'The privacy notice has changed. Please reload the page and read it again.');

  if (problems.length || !company.ok || !person.ok || !email.ok || !website.ok || !caseAddress.ok) return { ok: false, problems };
  return {
    ok: true,
    value: {
      companyName: company.value,
      country,
      personName: person.value,
      email: email.value,
      website: website.value,
      volume,
      freeEmail: isFreeMailDomain(email.value),
      privacyVersion: PRIVACY_VERSION,
      caseAddress: caseAddress.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Company codes
// ---------------------------------------------------------------------------
/** Legal forms that never count as part of the name (compared without dots, upper case). */
const LEGAL_FORMS = new Set([
  'GMBH', 'MBH', 'LTD', 'LLC', 'LLP', 'LP', 'SL', 'SLU', 'SA', 'SAS', 'SARL', 'SRL', 'SPA', 'UAB', 'BV', 'NV', 'AG', 'KG', 'UG', 'OHG', 'EG', 'EV',
  'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LIMITED', 'PLC', 'PTY', 'LDA', 'LTDA', 'AB', 'AS', 'ASA', 'APS', 'OY', 'OYJ', 'SE', 'SP', 'ZOO', 'SRO', 'KFT', 'EOOD', 'OOD', 'DOO',
]);

const FOLD: Record<string, string> = { ß: 'SS', Æ: 'AE', æ: 'AE', Ø: 'O', ø: 'O', Œ: 'OE', œ: 'OE', Đ: 'D', đ: 'D', Ł: 'L', ł: 'L', Þ: 'TH', þ: 'TH' };

/** Upper case A-Z and 0-9 only: accents removed, ß to SS, anything else dropped. */
function foldToken(s: string): string {
  return s
    .replace(/[ßÆæØøŒœĐđŁłÞþ]/g, (ch) => FOLD[ch] ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** The words of a company name without legal forms, folded to A-Z0-9. */
export function nameWords(name: string): string[] {
  const words: string[] = [];
  for (const part of cleanText(name).split(/[\s&,/()]+/)) {
    const w = foldToken(part);
    if (w && !LEGAL_FORMS.has(w)) words.push(w);
  }
  return words;
}

/**
 * Suggests a company code: initials for three or more words (at most 8), otherwise the first four letters of the first word.
 * Always 2 to 8 characters of A-Z0-9. Legal forms such as GmbH or Ltd are ignored. KL is reserved for K Line.
 */
export function suggestCompanyCode(name: string): string {
  const words = nameWords(name);
  let code = '';
  if (words.length >= 3) code = words.map((w) => w[0]).join('').slice(0, 8);
  else if (words.length >= 1) code = words[0]!.slice(0, 4);
  if (code.length < 2) code = (words.join('') + 'PARTNER').slice(0, 4);
  if (RESERVED_CODES.includes(code)) code = `${code}1`;
  return code;
}

/** The suggested code followed by numbered alternatives (CODE2 ... CODE9, then CODE10 ... CODE20), all valid and none reserved. */
export function codeCandidates(name: string): string[] {
  const base = suggestCompanyCode(name);
  const out = [base];
  for (let n = 2; n <= 20; n++) {
    const suffix = String(n);
    out.push(base.slice(0, 8 - suffix.length) + suffix);
  }
  return out.filter((c) => COMPANY_CODE_RE.test(c) && !RESERVED_CODES.includes(c));
}

/** True when a code has the right shape and is not reserved. */
export function isValidCompanyCode(code: string): boolean {
  return COMPANY_CODE_RE.test(code) && !RESERVED_CODES.includes(code);
}
