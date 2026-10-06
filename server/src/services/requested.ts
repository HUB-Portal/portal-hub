/**
 * Items requested on a child case (replacement or rework): the aligners that must be made again.
 * The child case holds all of its parent's files; only the requested aligners' files are required by the factory.
 */
export interface RequestedItem {
  arch: 'upper' | 'lower';
  step: number;
  template: boolean;
  /** Set on rework cases: the defect the claim reported. */
  defectCode?: string;
}

export function itemsOf(json: unknown): RequestedItem[] | null {
  if (!Array.isArray(json)) return null;
  return json
    .filter((x) => x && (x.arch === 'upper' || x.arch === 'lower') && Number.isInteger(x.step))
    .map((x) => ({ arch: x.arch, step: x.step, template: !!x.template, ...(typeof x.defectCode === 'string' ? { defectCode: x.defectCode } : {}) }));
}

/** True when the file is needed for the case. Files that are not tied to one aligner (documents, images) always count. */
export function isRequestedFile(f: { arch: string | null; step: number | null; is_template: boolean }, items: RequestedItem[] | null): boolean {
  if (!items) return true;
  if (!f.arch || f.step === null || f.step === undefined) return true;
  return items.some((i) => i.arch === f.arch && i.step === f.step && i.template === !!f.is_template);
}
