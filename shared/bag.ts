// Aligner bag labels: layout, tokens and rendering. Pure TypeScript, used by server and web.
// The Code 128 encoding itself is done by the printer system; only the barcode text is produced here.

export const BAG_TOKENS = [
  'brand', 'case_id', 'ref', 'aligner', 'arch', 'arch_short', 'step', 'step_padded', 'total_steps', 'wear_days', 'patient_initials', 'patient_name',
] as const;
export type BagToken = (typeof BAG_TOKENS)[number];
export const PERSONAL_TOKENS: readonly BagToken[] = ['patient_initials', 'patient_name'];

export const BAG_LIMITS = {
  widthMm: { min: 20, max: 300 },
  heightMm: { min: 20, max: 300 },
  marginMm: { min: 0, max: 20 },
  wearDays: { min: 1, max: 60 },
  maxLines: 8,
  maxLineLength: 60,
  maxBarcodeLength: 60,
} as const;

export interface BagLayout {
  widthMm: number;
  heightMm: number;
  marginMm: number;
  /** One bag per aligner is the only supported grouping today. */
  perAligner: true;
  wearDays: number;
  lines: string[];
  /** Text encoded as the Code 128 barcode. */
  barcode: string;
  /** Patient tokens stay empty unless the matching switch is on. */
  showPatientName: boolean;
  showPatientInitials: boolean;
}

export const DEFAULT_BAG_LAYOUT: BagLayout = {
  widthMm: 76,
  heightMm: 127,
  marginMm: 4,
  perAligner: true,
  wearDays: 14,
  lines: ['{brand}', '{case_id}', '{aligner} {arch}', 'Step {step} of {total_steps}', 'Wear for {wear_days} days'],
  barcode: '{ref} {aligner}',
  showPatientName: false,
  showPatientInitials: false,
};

export interface BagCase {
  ref: string;
  caseId?: string | null;
  brand?: string | null;
  /** One entry per aligner (templates left out by the caller). */
  aligners: { arch: 'upper' | 'lower'; step: number }[];
  /** Only used when the layout enables it. Callers that must not carry personal data leave it out. */
  patientName?: string | null;
}

export interface RenderedBag {
  aligner: string;
  arch: 'upper' | 'lower';
  step: number;
  lines: string[];
  barcode: string;
}

const TOKEN_RE = /\{([a-z_]+)\}/g;

/** Tokens found in a template that are not known. Also reports stray braces as "{". */
export function unknownTokens(template: string): string[] {
  const bad: string[] = [];
  for (const m of template.matchAll(TOKEN_RE)) if (!(BAG_TOKENS as readonly string[]).includes(m[1]!)) bad.push(m[1]!);
  const rest = template.replace(TOKEN_RE, '');
  if (/[{}]/.test(rest)) bad.push('{');
  return bad;
}

export function tokensIn(template: string): string[] {
  return [...template.matchAll(TOKEN_RE)].map((m) => m[1]!);
}

/** True when the layout is set to print patient data and a line or the barcode uses it. */
export function printsPersonalData(layout: Pick<BagLayout, 'lines' | 'barcode' | 'showPatientName' | 'showPatientInitials'>): boolean {
  const used = new Set([...layout.lines.flatMap(tokensIn), ...tokensIn(layout.barcode)]);
  return (layout.showPatientName && used.has('patient_name')) || (layout.showPatientInitials && used.has('patient_initials'));
}

export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w][0]!.toUpperCase())
    .join('.')
    .replace(/(.)$/, '$1.');
}

export function alignerCode(arch: 'upper' | 'lower', step: number): string {
  return `${arch === 'upper' ? 'U' : 'L'}${String(step).padStart(2, '0')}`;
}

/** One entry per bag, upper aligners first, in step order. Duplicate arch and step pairs collapse to one bag. */
export function renderBags(layout: BagLayout, data: BagCase): RenderedBag[] {
  const seen = new Set<string>();
  const list = data.aligners
    .filter((a) => {
      const k = `${a.arch}|${a.step}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (a.arch === b.arch ? a.step - b.step : a.arch === 'upper' ? -1 : 1));
  const totals = { upper: list.filter((a) => a.arch === 'upper').length, lower: list.filter((a) => a.arch === 'lower').length };
  const name = layout.showPatientName && data.patientName ? data.patientName : '';
  const initials = layout.showPatientInitials && data.patientName ? initialsOf(data.patientName) : '';

  return list.map((a) => {
    const values: Record<BagToken, string> = {
      brand: data.brand ?? '',
      case_id: data.caseId ?? '',
      ref: data.ref,
      aligner: alignerCode(a.arch, a.step),
      arch: a.arch === 'upper' ? 'Upper' : 'Lower',
      arch_short: a.arch === 'upper' ? 'U' : 'L',
      step: String(a.step),
      step_padded: String(a.step).padStart(2, '0'),
      total_steps: String(totals[a.arch]),
      wear_days: String(layout.wearDays),
      patient_initials: initials,
      patient_name: name,
    };
    const fill = (t: string) => t.replace(TOKEN_RE, (_m, k: string) => values[k as BagToken] ?? '').replace(/\s{2,}/g, ' ').trim();
    return {
      aligner: values.aligner,
      arch: a.arch,
      step: a.step,
      lines: layout.lines.map(fill),
      barcode: fill(layout.barcode),
    };
  });
}

/** Human readable problems with a layout. Empty when valid. Shared by the server (which also runs a zod schema) and the web form. */
export function layoutProblems(l: unknown): string[] {
  const p: string[] = [];
  if (!l || typeof l !== 'object') return ['The layout is missing.'];
  const x = l as Partial<BagLayout>;
  const num = (v: unknown, r: { min: number; max: number }, label: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < r.min || v > r.max) p.push(`${label} must be between ${r.min} and ${r.max}.`);
  };
  num(x.widthMm, BAG_LIMITS.widthMm, 'Width');
  num(x.heightMm, BAG_LIMITS.heightMm, 'Height');
  num(x.marginMm, BAG_LIMITS.marginMm, 'Margin');
  num(x.wearDays, BAG_LIMITS.wearDays, 'Wear days');
  if (!Array.isArray(x.lines) || x.lines.length > BAG_LIMITS.maxLines) p.push(`Use at most ${BAG_LIMITS.maxLines} lines.`);
  else
    for (const line of x.lines) {
      if (typeof line !== 'string' || line.length > BAG_LIMITS.maxLineLength) p.push(`Each line can have at most ${BAG_LIMITS.maxLineLength} characters.`);
      else if (unknownTokens(line).length) p.push('A line uses a placeholder that does not exist.');
    }
  if (typeof x.barcode !== 'string' || !x.barcode.trim() || x.barcode.length > BAG_LIMITS.maxBarcodeLength) p.push('The barcode text is missing or too long.');
  else if (unknownTokens(x.barcode).length) p.push('The barcode uses a placeholder that does not exist.');
  return [...new Set(p)];
}
