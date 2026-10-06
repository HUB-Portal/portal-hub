// Registration data for the web app. The lists and rules live in shared/signup.ts (also used by the server);
// this file adds small helpers that turn them into messages for the forms.
// The server always validates again; these checks only give quick, friendly feedback.
import {
  COUNTRIES, PRIVACY_VERSION, RESERVED_CODES, THROWAWAY_MESSAGE, VOLUME_BANDS,
  countryName as sharedCountryName, isThrowawayDomain, isValidCompanyCode, suggestCompanyCode, validateCompanyName, validateEmail, validatePersonName, validateWebsite,
  volumeLabel as sharedVolumeLabel,
} from '@shared/signup';

export { COUNTRIES, PRIVACY_VERSION, RESERVED_CODES, VOLUME_BANDS, suggestCompanyCode };

/** English country name for an ISO code. Unknown values are shown as they are. */
export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  return sharedCountryName(code) || code;
}

export function volumeLabel(id: string | null | undefined): string {
  if (!id) return 'Not given';
  return sharedVolumeLabel(id) || id;
}

/** Company or person name. Returns an error text or null. */
export function nameProblem(value: string, what: 'company' | 'person'): string | null {
  const r = what === 'company' ? validateCompanyName(value) : validatePersonName(value);
  return r.ok ? null : r.message;
}

export function websiteProblem(value: string): string | null {
  const r = validateWebsite(value);
  return r.ok ? null : r.message;
}

export function emailProblem(value: string): string | null {
  const r = validateEmail(value);
  if (!r.ok) return r.message;
  return isThrowawayDomain(r.value) ? THROWAWAY_MESSAGE : null;
}

export function codeProblem(code: string): string | null {
  if (isValidCompanyCode(code)) return null;
  if (RESERVED_CODES.includes(code)) return 'This code is reserved. Choose another.';
  return 'Use 2 to 8 capital letters or digits.';
}
