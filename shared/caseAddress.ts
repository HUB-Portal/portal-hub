// The Case address: the shipping address the K Line portal keeps on every case (API 2.6, Add Case Shipping Address).
// Shared by the server and the web app. Plain TypeScript. Nothing in here touches a database.
import { cleanText, isCountryCode, validateEmail, type Checked, type FieldProblem } from './signup';

/** Hub side names (camelCase). The server maps them to the portal field names when it pushes a case. */
export interface CaseAddress {
  /** Company name on the parcel (portal: shipping_company, at most 150). */
  company: string;
  /** Recipient (portal: shipping_full_name, at most 255). */
  fullName: string;
  /** shipping_street_address, at most 255. */
  street: string;
  /** shipping_city, at most 255. */
  city: string;
  /** shipping_postal_code, at most 10. */
  postalCode: string;
  /** shipping_state_province, at most 64. Required by the portal: write N/A where a country has no states. */
  stateProvince: string;
  /** ISO 3166-1 alpha 2, upper case (shipping_country, 2). */
  country: string;
  /** shipping_phone_number, at most 15 characters exactly as typed. */
  phone: string;
  /** shipping_email_address, at most 255. */
  email: string;
}

export type CaseAddressKey = keyof CaseAddress;

export const CASE_ADDRESS_KEYS: readonly CaseAddressKey[] = ['company', 'fullName', 'street', 'city', 'postalCode', 'stateProvince', 'country', 'phone', 'email'];

/** Longest value the portal accepts for each field. */
export const CASE_ADDRESS_LIMITS: Readonly<Record<CaseAddressKey, number>> = {
  company: 150,
  fullName: 255,
  street: 255,
  city: 255,
  postalCode: 10,
  stateProvince: 64,
  country: 2,
  phone: 15,
  email: 255,
};

/** Labels for forms and messages. */
export const CASE_ADDRESS_LABELS: Readonly<Record<CaseAddressKey, string>> = {
  company: 'company name',
  fullName: 'recipient name',
  street: 'street address',
  city: 'city',
  postalCode: 'postal code',
  stateProvince: 'state or province',
  country: 'country',
  phone: 'phone number',
  email: 'email address',
};

/** Hint for the state or province field. */
export const STATE_PROVINCE_HINT = 'The K Line portal needs a state or province. If your country has none, write N/A.';

/** What a partner sees when a push or a submit needs the address and it is missing or incomplete. */
export const CASE_ADDRESS_REQUIRED_MESSAGE = 'Add your case address in the company profile, then press Try again.';

const PLAIN_BAD = /[<>\u0000-\u001f\u007f]/;
const POSTAL_RE = /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u;
const PHONE_RE = /^[0-9 ()+-]+$/;

function text(raw: unknown, key: CaseAddressKey): Checked<string> {
  const label = CASE_ADDRESS_LABELS[key];
  const v = cleanText(raw);
  if (!v) return { ok: false, message: `Enter the ${label}.` };
  if (v.length > CASE_ADDRESS_LIMITS[key]) return { ok: false, message: `The ${label} can have at most ${CASE_ADDRESS_LIMITS[key]} characters.` };
  if (PLAIN_BAD.test(v)) return { ok: false, message: `Remove the characters < and > and any control characters from the ${label}.` };
  return { ok: true, value: v };
}

const CHECKS: Record<CaseAddressKey, (raw: unknown) => Checked<string>> = {
  company: (raw) => text(raw, 'company'),
  fullName: (raw) => text(raw, 'fullName'),
  street: (raw) => text(raw, 'street'),
  city: (raw) => text(raw, 'city'),
  postalCode: (raw) => {
    const t = text(raw, 'postalCode');
    if (!t.ok) return t;
    if (!POSTAL_RE.test(t.value)) return { ok: false, message: 'The postal code can only have letters, digits, spaces and dashes.' };
    return t;
  },
  stateProvince: (raw) => text(raw, 'stateProvince'),
  country: (raw) => {
    const v = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
    return isCountryCode(v) ? { ok: true, value: v } : { ok: false, message: 'Choose the country from the list.' };
  },
  phone: (raw) => {
    const t = text(raw, 'phone');
    if (!t.ok) {
      return t.message.includes('at most') ? { ok: false, message: `The phone number can have at most ${CASE_ADDRESS_LIMITS.phone} characters. Leave out spaces if you need the room.` } : t;
    }
    if (!PHONE_RE.test(t.value)) return { ok: false, message: 'The phone number can only have digits, spaces and + - ( ).' };
    if ((t.value.match(/\d/g) ?? []).length < 5) return { ok: false, message: 'Enter a phone number with at least 5 digits.' };
    return t;
  },
  email: (raw) => {
    if (!cleanText(raw)) return { ok: false, message: 'Enter the email address.' };
    const e = validateEmail(raw);
    if (!e.ok) return e;
    if (e.value.length > CASE_ADDRESS_LIMITS.email) return { ok: false, message: `The email address can have at most ${CASE_ADDRESS_LIMITS.email} characters.` };
    return e;
  },
};

/** Checks one field. Returns the cleaned value or a message. */
export function validateCaseAddressField(key: CaseAddressKey, raw: unknown): Checked<string> {
  return CHECKS[key](raw);
}

const asRecord = (raw: unknown): Record<string, unknown> => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

/** Checks a whole address: every one of the nine fields is required. Paths in the problems are the field names (street, postalCode ...). */
export function validateCaseAddress(raw: unknown): { ok: true; value: CaseAddress } | { ok: false; problems: FieldProblem[] } {
  const o = asRecord(raw);
  const problems: FieldProblem[] = [];
  const value = {} as CaseAddress;
  for (const key of CASE_ADDRESS_KEYS) {
    const r = CHECKS[key](o[key]);
    if (r.ok) value[key] = r.value;
    else problems.push({ path: key, message: r.message });
  }
  return problems.length ? { ok: false, problems } : { ok: true, value };
}

/** Checks only the fields present in a partial update (for example the profile form). Unknown keys are ignored. */
export function validateCaseAddressPatch(raw: unknown): { ok: true; value: Partial<CaseAddress> } | { ok: false; problems: FieldProblem[] } {
  const o = asRecord(raw);
  const problems: FieldProblem[] = [];
  const value: Partial<CaseAddress> = {};
  for (const key of CASE_ADDRESS_KEYS) {
    if (o[key] === undefined) continue;
    const r = CHECKS[key](o[key]);
    if (r.ok) value[key] = r.value;
    else problems.push({ path: key, message: r.message });
  }
  return problems.length ? { ok: false, problems } : { ok: true, value };
}

/** True when the value holds all nine fields and every one passes its check. This is what the push and the early gates test. */
export function isCompleteCaseAddress(raw: unknown): raw is CaseAddress {
  return validateCaseAddress(raw).ok;
}

/** The stored value as a full object (missing fields are empty strings), or null when nothing is stored. */
export function caseAddressView(raw: unknown): CaseAddress | null {
  const o = asRecord(raw);
  if (!CASE_ADDRESS_KEYS.some((k) => typeof o[k] === 'string' && (o[k] as string).trim() !== '')) return null;
  const view = {} as CaseAddress;
  for (const key of CASE_ADDRESS_KEYS) view[key] = typeof o[key] === 'string' ? (o[key] as string) : '';
  return view;
}
