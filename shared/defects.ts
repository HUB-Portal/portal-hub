// Quality claim defect codes (BRIEF section 14). Pure TypeScript, used by server and web.

export const DEFECT_CODES = [
  'DEBRIS', 'FOIL_RESIDUE', 'WASH_RESIDUE', 'SCRATCHES', 'TRANSPARENCY', 'THERMO_INSUFFICIENT', 'DEFORMED', 'CRACK',
  'TRIM_LINE', 'TRIM_DISTAL', 'SHARP_EDGE', 'NOTCH_CUT', 'TEMPLATE_TRIM', 'LASER_MARK', 'WRONG_STEP', 'MISSING', 'PACKAGING', 'OTHER',
] as const;
export type DefectCode = (typeof DEFECT_CODES)[number];

export const DEFECTS: readonly { code: DefectCode; label: string }[] = [
  { code: 'DEBRIS', label: 'Debris on the aligner' },
  { code: 'FOIL_RESIDUE', label: 'Foil residue' },
  { code: 'WASH_RESIDUE', label: 'Wash residue' },
  { code: 'SCRATCHES', label: 'Scratches' },
  { code: 'TRANSPARENCY', label: 'Cloudy or not transparent' },
  { code: 'THERMO_INSUFFICIENT', label: 'Thermoforming not sufficient' },
  { code: 'DEFORMED', label: 'Deformed aligner' },
  { code: 'CRACK', label: 'Crack' },
  { code: 'TRIM_LINE', label: 'Trim line not as specified' },
  { code: 'TRIM_DISTAL', label: 'Distal trim not as specified' },
  { code: 'SHARP_EDGE', label: 'Sharp edge' },
  { code: 'NOTCH_CUT', label: 'Notch cut not as specified' },
  { code: 'TEMPLATE_TRIM', label: 'Template trim not as specified' },
  { code: 'LASER_MARK', label: 'Laser marking wrong or missing' },
  { code: 'WRONG_STEP', label: 'Wrong step supplied' },
  { code: 'MISSING', label: 'Aligner missing' },
  { code: 'PACKAGING', label: 'Packaging problem' },
  { code: 'OTHER', label: 'Something else' },
];

export function isDefectCode(v: unknown): v is DefectCode {
  return typeof v === 'string' && (DEFECT_CODES as readonly string[]).includes(v);
}

export function defectLabel(code: string): string {
  return DEFECTS.find((d) => d.code === code)?.label ?? code;
}

export const CLAIM_STATUSES = ['open', 'in_review', 'awaiting_partner', 'accepted', 'rejected', 'closed'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
/** Claims that still need attention from someone. */
export const OPEN_CLAIM_STATUSES: readonly ClaimStatus[] = ['open', 'in_review', 'awaiting_partner'];
export const CLAIM_RESOLUTIONS = ['remake', 'credit', 'no_action', 'other'] as const;
export type ClaimResolution = (typeof CLAIM_RESOLUTIONS)[number];
/** Case statuses on which a claim can be raised. */
export const CLAIMABLE_CASE_STATUSES = ['received', 'in_production', 'shipped', 'delivered'] as const;
