import type { PoolClient } from '../db';
import { isRequestedFile, itemsOf } from './requested';

export interface CheckIssue {
  code: string;
  message: string;
  fileId?: string;
  arch?: 'upper' | 'lower';
  step?: number;
}

export interface CheckFile {
  id: string;
  kind: string;
  arch: 'upper' | 'lower' | null;
  step: number | null;
  is_template: boolean;
  state: string;
  validation: { errors?: { code: string; message: string }[]; warnings?: { code: string; message: string }[] } | null;
  meta: Record<string, any> | null;
}

export interface CheckResult {
  errors: CheckIssue[];
  warnings: CheckIssue[];
  counts: { upper: number; lower: number; templates: number };
}

const slot = (f: Pick<CheckFile, 'kind' | 'arch' | 'step' | 'is_template'>) => `${f.kind}|${f.arch}|${f.step}|${f.is_template ? 'T' : 'A'}`;
const pairKey = (f: Pick<CheckFile, 'arch' | 'step' | 'is_template'>) => `${f.arch}|${f.step}|${f.is_template ? 'T' : 'A'}`;

/** Compact list of steps, for example "4, 7 to 9". */
export function describeSteps(steps: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < steps.length; ) {
    let j = i;
    while (j + 1 < steps.length && steps[j + 1] === steps[j]! + 1) j++;
    out.push(j - i >= 2 ? `${steps[i]} to ${steps[j]}` : steps.slice(i, j + 1).join(', '));
    i = j + 1;
  }
  return out.join(', ');
}

const bboxOf = (f: CheckFile): { min: number[]; max: number[] } | null => {
  const b = f.meta?.bbox;
  return b && Array.isArray(b.min) && Array.isArray(b.max) ? b : null;
};

/**
 * Case checks per BRIEF section 8. Errors block submission. Warnings need the partner's confirmation.
 * Template files (`U01_T`) live in their own slot and never clash with the aligner of the same step.
 */
export function computeChecks(all: CheckFile[], opts: { requirePts: boolean }): CheckResult {
  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];
  const files = all.filter((f) => f.state !== 'purged');
  const live = files.filter((f) => f.state !== 'rejected');

  for (const f of files) {
    if (f.state === 'rejected') {
      const why = f.validation?.errors?.[0]?.message ?? 'The file did not pass the checks.';
      errors.push({ code: 'file_rejected', message: `A file was rejected. ${why}`, fileId: f.id, ...(f.arch ? { arch: f.arch } : {}), ...(f.step !== null ? { step: f.step } : {}) });
    }
  }
  const uploading = live.filter((f) => f.state === 'uploading').length;
  const processing = live.filter((f) => f.state === 'processing').length;
  // Files that are still on their way do not block submitting. They are shown as warnings the partner confirms.
  if (uploading) warnings.push({ code: 'files_incomplete', message: `${uploading} file${uploading === 1 ? ' has' : 's have'} not finished uploading.` });
  if (processing) warnings.push({ code: 'files_processing', message: `${processing} file${processing === 1 ? ' is' : 's are'} still being checked.` });

  const stls = live.filter((f) => f.kind === 'stl');
  const ptsFiles = live.filter((f) => f.kind === 'pts');
  if (stls.length === 0) errors.push({ code: 'no_stl', message: 'Add at least one STL model.' });

  for (const f of [...stls, ...ptsFiles]) {
    if (f.arch === null || f.step === null) {
      errors.push({ code: 'missing_mapping', message: `A ${f.kind.toUpperCase()} file needs an arch and a step.`, fileId: f.id });
    }
  }

  const mapped = [...stls, ...ptsFiles].filter((f) => f.arch !== null && f.step !== null);
  const seen = new Map<string, CheckFile>();
  for (const f of mapped) {
    const k = slot(f);
    if (seen.has(k)) {
      errors.push({
        code: 'duplicate_file',
        message: `Two ${f.kind.toUpperCase()} files are set for the ${f.arch} ${f.is_template ? 'template ' : 'aligner '}step ${f.step}.`,
        fileId: f.id,
        arch: f.arch!,
        step: f.step!,
      });
    } else seen.set(k, f);
  }

  // Warnings
  const ptsPairs = new Set(ptsFiles.filter((f) => f.arch !== null && f.step !== null).map(pairKey));
  const stlPairs = new Set(stls.filter((f) => f.arch !== null && f.step !== null).map(pairKey));
  if (opts.requirePts) {
    for (const f of stls) {
      if (f.arch === null || f.step === null || f.is_template) continue;
      if (!ptsPairs.has(pairKey(f))) {
        warnings.push({ code: 'missing_pts', message: `The ${f.arch} aligner for step ${f.step} has no trim line (PTS).`, fileId: f.id, arch: f.arch, step: f.step });
      }
    }
  }
  for (const f of ptsFiles) {
    if (f.arch === null || f.step === null) continue;
    if (!stlPairs.has(pairKey(f))) {
      warnings.push({ code: 'trim_without_model', message: `The trim line for the ${f.arch} ${f.is_template ? 'template' : 'aligner'} step ${f.step} has no matching model.`, fileId: f.id, arch: f.arch, step: f.step });
    }
  }
  for (const arch of ['upper', 'lower'] as const) {
    const steps = [...new Set(stls.filter((f) => f.arch === arch && !f.is_template && f.step !== null).map((f) => f.step!))].sort((a, b) => a - b);
    if (steps.length >= 2) {
      const have = new Set(steps);
      const missing: number[] = [];
      for (let s = steps[0]!; s <= steps[steps.length - 1]!; s++) if (!have.has(s)) missing.push(s);
      if (missing.length) warnings.push({ code: 'missing_steps', message: `The ${arch} aligners are missing steps ${describeSteps(missing)}.`, arch });
    }
  }
  for (const f of ptsFiles) {
    if (f.state !== 'ready' || f.arch === null || f.step === null) continue;
    const model = stls.find((m) => m.state === 'ready' && m.arch === f.arch && m.step === f.step && m.is_template === f.is_template);
    const pb = bboxOf(f);
    const mb = model ? bboxOf(model) : null;
    if (pb && mb) {
      const tol = 1; // millimetres
      const outside = [0, 1, 2].some((i) => pb.min[i]! < mb.min[i]! - tol || pb.max[i]! > mb.max[i]! + tol);
      if (outside) warnings.push({ code: 'trim_outside_model', message: `The trim line for the ${f.arch} step ${f.step} is not on its model.`, fileId: f.id, arch: f.arch, step: f.step });
    }
  }
  for (const f of live) {
    if (f.state !== 'ready') continue;
    for (const w of f.validation?.warnings ?? []) {
      warnings.push({ code: w.code, message: w.message, fileId: f.id, ...(f.arch ? { arch: f.arch } : {}), ...(f.step !== null ? { step: f.step } : {}) });
    }
  }

  const upperSteps = new Set(stls.filter((f) => f.arch === 'upper' && !f.is_template && f.step !== null).map((f) => f.step));
  const lowerSteps = new Set(stls.filter((f) => f.arch === 'lower' && !f.is_template && f.step !== null).map((f) => f.step));
  return { errors, warnings, counts: { upper: upperSteps.size, lower: lowerSteps.size, templates: stls.filter((f) => f.is_template).length } };
}

/** Recomputes and stores the checks and aligner counts of a case. Locks the case row so concurrent file checks queue up. */
export async function recomputeCase(c: PoolClient, caseId: string): Promise<CheckResult | null> {
  const cs = await c.query(
    `SELECT c.id, c.requested_items, o.settings FROM cases c JOIN organizations o ON o.id = c.org_id WHERE c.id = $1 FOR UPDATE OF c`,
    [caseId],
  );
  const row = cs.rows[0];
  if (!row) return null;
  const files = await c.query(
    `SELECT id, kind, arch, step, is_template, state, validation, meta FROM files WHERE case_id = $1 AND purpose = 'case' AND state <> 'purged' ORDER BY created_at, id`,
    [caseId],
  );
  const res = computeChecks(files.rows as CheckFile[], { requirePts: !!row.settings?.require_pts });
  // A replacement or rework case only counts the aligners that were ordered again.
  const requested = itemsOf(row.requested_items);
  if (requested) res.counts = computeChecks((files.rows as CheckFile[]).filter((f) => isRequestedFile(f, requested)), { requirePts: false }).counts;
  await c.query(
    `UPDATE cases SET checks = $2::jsonb, aligners_upper = $3, aligners_lower = $4, aligners_templates = $5, updated_at = now() WHERE id = $1`,
    [caseId, JSON.stringify({ errors: res.errors, warnings: res.warnings }), res.counts.upper, res.counts.lower, res.counts.templates],
  );
  return res;
}
