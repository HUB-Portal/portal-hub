// Country rules for the transfer gate (art. 44 GDPR). Pure TypeScript, used by server and web.
// Cases of EEA partners may only be produced in the EEA, in a country with an adequacy decision,
// or elsewhere when Standard Contractual Clauses are on file.

/** EU member states plus Iceland, Liechtenstein and Norway (ISO 3166 alpha 2). */
export const EEA_COUNTRIES: readonly string[] = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
];

/** Countries with a European Commission adequacy decision (general or for commercial organisations). */
export const ADEQUACY_COUNTRIES: readonly string[] = ['AD', 'AR', 'CA', 'FO', 'GG', 'IL', 'IM', 'JP', 'JE', 'NZ', 'KR', 'CH', 'GB', 'UY'];

const norm = (c: string | null | undefined) => (c ?? '').trim().toUpperCase();

export function isEea(country: string | null | undefined): boolean {
  return EEA_COUNTRIES.includes(norm(country));
}
export function isAdequate(country: string | null | undefined): boolean {
  return ADEQUACY_COUNTRIES.includes(norm(country));
}

export interface SiteLike {
  country: string;
  eea?: boolean | null;
  adequacy?: boolean | null;
}

/**
 * True when a partner in `partnerCountry` may have cases produced at `site`.
 * Partners outside the EEA are not restricted by this rule. An unknown partner country is treated as EEA (safest).
 */
export function canReceive(partnerCountry: string | null | undefined, site: SiteLike, sccOnFile: boolean): boolean {
  const partnerEea = !norm(partnerCountry) || isEea(partnerCountry);
  if (!partnerEea) return true;
  if (site.eea || isEea(site.country)) return true;
  if (site.adequacy || isAdequate(site.country)) return true;
  return sccOnFile;
}
