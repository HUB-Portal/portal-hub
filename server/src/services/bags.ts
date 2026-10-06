import { z } from 'zod';
import { many, one, type PoolClient } from '../db';
import { BAG_LIMITS, DEFAULT_BAG_LAYOUT, layoutProblems, printsPersonalData, renderBags, type BagCase, type BagLayout, type RenderedBag } from '../../../shared/bag';
import { badRequest } from '../http/errors';
import { patientOf } from './cases';
import { isRequestedFile, itemsOf } from './requested';

const lineSchema = z.string().max(BAG_LIMITS.maxLineLength);

/** Request body for PUT /api/org/bag-layout. Unknown placeholders are rejected by layoutProblems. */
export const bagLayoutSchema = z.object({
  widthMm: z.number().min(BAG_LIMITS.widthMm.min).max(BAG_LIMITS.widthMm.max),
  heightMm: z.number().min(BAG_LIMITS.heightMm.min).max(BAG_LIMITS.heightMm.max),
  marginMm: z.number().min(BAG_LIMITS.marginMm.min).max(BAG_LIMITS.marginMm.max),
  wearDays: z.number().int().min(BAG_LIMITS.wearDays.min).max(BAG_LIMITS.wearDays.max),
  lines: z.array(lineSchema).max(BAG_LIMITS.maxLines),
  barcode: z.string().min(1).max(BAG_LIMITS.maxBarcodeLength),
  showPatientName: z.boolean().default(false),
  showPatientInitials: z.boolean().default(false),
});

export function parseBagLayout(input: unknown): BagLayout {
  const r = bagLayoutSchema.safeParse(input);
  if (!r.success) throw badRequest('Some of the bag layout details are not valid.', 'invalid_bag_layout', { fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const layout: BagLayout = { ...r.data, perAligner: true };
  const problems = layoutProblems(layout);
  if (problems.length) throw badRequest(problems[0]!, 'invalid_bag_layout', { problems });
  return layout;
}

/** The stored layout of an organisation, falling back to the default and to the default for anything invalid. */
export function layoutFromSettings(settings: Record<string, any> | null | undefined): BagLayout {
  const stored = settings?.bag;
  if (!stored || typeof stored !== 'object') return DEFAULT_BAG_LAYOUT;
  const merged = { ...DEFAULT_BAG_LAYOUT, ...stored, perAligner: true as const };
  return layoutProblems(merged).length ? DEFAULT_BAG_LAYOUT : merged;
}

/**
 * The bag layout in force for a partner: the layout of the active production specification is authoritative
 * (BRIEF section 15); without one, the layout the partner saved in its settings, then the default.
 */
export async function orgBagLayout(c: PoolClient, orgId: string): Promise<BagLayout> {
  const spec = await one<{ bag: unknown }>(c, `SELECT content->'bag' AS bag FROM specs WHERE org_id = $1 AND status = 'active'`, [orgId]);
  if (spec?.bag && typeof spec.bag === 'object') {
    const merged = { ...DEFAULT_BAG_LAYOUT, ...(spec.bag as object), perAligner: true as const } as BagLayout;
    if (!layoutProblems(merged).length) return merged;
  }
  const o = await one<{ settings: Record<string, any> | null }>(c, 'SELECT settings FROM organizations WHERE id = $1', [orgId]);
  return layoutFromSettings(o?.settings);
}

/** Aligners of a case (ready STL models, templates left out) for bag rendering. A replacement or rework case only labels the aligners ordered again. */
export async function bagCaseData(c: PoolClient, row: any, opts: { withPatient: boolean }): Promise<BagCase> {
  const all = await many<{ arch: 'upper' | 'lower'; step: number }>(
    c,
    `SELECT DISTINCT arch, step FROM files WHERE case_id = $1 AND purpose = 'case' AND kind = 'stl' AND is_template = false AND state = 'ready' AND arch IS NOT NULL AND step IS NOT NULL`,
    [row.id],
  );
  const requested = itemsOf(row.requested_items);
  const files = all.filter((f) => isRequestedFile({ arch: f.arch, step: f.step, is_template: false }, requested));
  const brand = row.brand_id ? await one<{ name: string }>(c, 'SELECT name FROM brands WHERE id = $1', [row.brand_id]) : undefined;
  return {
    ref: row.ref,
    caseId: row.partner_case_id ?? null,
    brand: brand?.name ?? null,
    aligners: files,
    patientName: opts.withPatient ? patientOf(row).full : null,
  };
}

/** Bags for the factory system: never carries patient data, whatever the layout says. */
export async function bagsForMes(c: PoolClient, row: any): Promise<{ bags: RenderedBag[]; personalData: boolean }> {
  const layout = await orgBagLayout(c, row.org_id);
  const data = await bagCaseData(c, row, { withPatient: false });
  return { bags: renderBags(layout, data), personalData: printsPersonalData(layout) };
}

export const SAMPLE_BAG_CASE: BagCase = {
  ref: 'ACME-000123',
  caseId: '55813',
  brand: 'Acme Clear',
  aligners: [
    { arch: 'upper', step: 1 }, { arch: 'upper', step: 2 }, { arch: 'upper', step: 3 },
    { arch: 'lower', step: 1 }, { arch: 'lower', step: 2 }, { arch: 'lower', step: 3 },
  ],
  patientName: 'Sample Patient',
};
