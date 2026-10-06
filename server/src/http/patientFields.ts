import type { AuthContext } from '../auth/context';

/** A partner API key sees patient names only with the `patients:read` scope (which carries the `case.reveal_name` permission). */
export const keyCanSeePatients = (a: AuthContext) => a.scopes.includes('patients:read') && a.permissions.has('case.reveal_name');

/** Names of JSON fields that say something about the patient of a case. */
const PATIENT_FIELDS = new Set(['patientMasked', 'hasPatientName', 'patientName', 'patientFirstName', 'patientLastName', 'firstName', 'lastName']);

/** Copy of the value without any patient related field, at any depth (cases, lists, child cases, bulk results). */
export function stripPatientFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map((x) => stripPatientFields(x)) as unknown as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PATIENT_FIELDS.has(k)) continue;
      out[k] = stripPatientFields(v);
    }
    return out as T;
  }
  return value;
}
