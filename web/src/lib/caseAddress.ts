// Case address: where K Line sends cases back to. Phase 8 contract, section 1.
// The rules live in shared/caseAddress.ts (also used by the server). This file adds the pieces the forms need.
// The server always validates again; these checks give quick, friendly feedback.
import {
  CASE_ADDRESS_LIMITS, STATE_PROVINCE_HINT, validateCaseAddressField,
  type CaseAddress, type CaseAddressKey,
} from '@shared/caseAddress';

export { CASE_ADDRESS_LIMITS };
export type { CaseAddress };
export type CaseAddressField = CaseAddressKey;

/** The order of the fields in the forms. */
export const CASE_ADDRESS_FIELDS: CaseAddressField[] = ['company', 'fullName', 'email', 'phone', 'street', 'postalCode', 'city', 'stateProvince', 'country'];

export const emptyCaseAddress = (): CaseAddress => ({ company: '', fullName: '', street: '', city: '', postalCode: '', stateProvince: '', country: '', phone: '', email: '' });

export const STATE_HINT = STATE_PROVINCE_HINT;
export const CASE_ADDRESS_INTRO = 'This is where K Line sends your cases back to. You can change it later in your company profile.';

export type CaseAddressProblems = Partial<Record<CaseAddressField, string>>;

/** Checks the given fields (all nine by default). Returns a friendly message for each field that is not right. */
export function validateCaseAddress(a: CaseAddress, fields: CaseAddressField[] = CASE_ADDRESS_FIELDS): CaseAddressProblems {
  const out: CaseAddressProblems = {};
  for (const f of fields) {
    const r = validateCaseAddressField(f, a[f]);
    if (!r.ok) out[f] = r.message;
  }
  return out;
}

export const isCompleteCaseAddress = (a: CaseAddress | null | undefined): boolean => !!a && Object.keys(validateCaseAddress(a)).length === 0;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Reads the address from a server response. Returns null when there is none. */
export function readCaseAddress(raw: any): CaseAddress | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    company: str(raw.company), fullName: str(raw.fullName), street: str(raw.street), city: str(raw.city), postalCode: str(raw.postalCode),
    stateProvince: str(raw.stateProvince), country: str(raw.country), phone: str(raw.phone), email: str(raw.email),
  };
}

/** The address as it is sent: every value trimmed. */
export function caseAddressBody(a: CaseAddress): CaseAddress {
  const o = emptyCaseAddress();
  for (const f of CASE_ADDRESS_FIELDS) o[f] = a[f].trim();
  return o;
}

/** Turns server field errors (paths like "caseAddress.street" or "street") into messages per field. */
export function serverCaseAddressProblems(fields: { path: string; message: string }[]): CaseAddressProblems {
  const out: CaseAddressProblems = {};
  for (const f of fields) {
    const key = f.path.replace(/^caseAddress\./, '') as CaseAddressField;
    if ((CASE_ADDRESS_FIELDS as string[]).includes(key) && f.message) out[key] = f.message;
  }
  return out;
}

/** One line for staff screens. */
export function caseAddressLine(a: CaseAddress, countryLabel: (c: string) => string): string {
  return [a.street, [a.postalCode, a.city].filter(Boolean).join(' '), a.stateProvince && a.stateProvince.toUpperCase() !== 'N/A' ? a.stateProvince : '', countryLabel(a.country)].filter(Boolean).join(', ');
}
