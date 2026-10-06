// Pure helpers for the review screen of Direct manufacturing. Uses the shared parsing rules.
import { caseIdRuleProblem, missingTrimLines, rangeOf, type Arch, type MappedFile } from '@shared/filenames';
import { INSTRUCTIONS_MAX, joinInstructions, readInstructionBytes, type InstructionRead } from './instructions';
import { isUploadable, type UploadSpec } from './upload';
import { readAll, type FileSource, type SourceFile } from './source';
import { formatBytes, formatNumber } from './format';

export type MapFile = MappedFile & { skip?: boolean };

export type SourceMap = Map<string, FileSource>;

export function sourceMapOf(files: SourceFile[]): SourceMap {
  return new Map(files.map((f) => [f.path, f.source]));
}

export function resolveSource(map: SourceMap, path: string): FileSource | undefined {
  const exact = map.get(path);
  if (exact) return exact;
  for (const [k, v] of map) if (k.endsWith(`/${path}`)) return v;
  return undefined;
}

/** Read the instruction files of each case in the browser (small files only). */
export async function readInstructionsFor(files: MapFile[], sources: SourceMap): Promise<InstructionRead> {
  const parts: InstructionRead[] = [];
  for (const f of files.filter((x) => x.kind === 'instructions')) {
    const src = resolveSource(sources, f.path);
    if (!src) continue;
    if (src.size > 8 * 1024 * 1024) { parts.push({ text: '', truncated: false, message: 'An instructions file was too large to read.' }); continue; }
    try {
      parts.push(readInstructionBytes(f.name, await readAll(src)));
    } catch {
      parts.push({ text: '', truncated: false, message: 'An instructions file could not be read.' });
    }
  }
  return joinInstructions(parts);
}

export function activeFiles(files: MapFile[]): MapFile[] {
  return files.filter((f) => !f.skip && isUploadable(f));
}

export function fileSummary(files: MapFile[]) {
  const act = activeFiles(files);
  const models = act.filter((f) => f.kind === 'stl');
  return {
    upper: rangeOf(act, 'upper'),
    lower: rangeOf(act, 'lower'),
    fileCount: act.length,
    modelCount: models.length,
    ptsCount: act.filter((f) => f.kind === 'pts').length,
    bytes: act.reduce((a, f) => a + f.size, 0),
    missingTrim: missingTrimLines(act).length,
    notSent: files.length - act.length,
  };
}

export function sizeText(bytes: number): string { return formatBytes(bytes); }

const ARCH_NAME: Record<Arch, string> = { upper: 'upper', lower: 'lower' };

/** Problems with the mapping itself: two files in one slot, missing arch or step. */
export function mappingProblems(files: MapFile[]): string[] {
  const act = activeFiles(files).filter((f) => f.kind === 'stl' || f.kind === 'pts');
  const out: string[] = [];
  const missing = act.filter((f) => f.arch === null || f.step === null).length;
  if (missing) out.push(`${formatNumber(missing)} ${missing === 1 ? 'file has' : 'files have'} no arch or step.`);
  const seen = new Map<string, number>();
  for (const f of act) {
    if (f.arch === null || f.step === null) continue;
    const key = `${f.kind}|${f.arch}|${f.step}|${f.template}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let dup = 0;
  const examples: string[] = [];
  for (const [k, n] of seen) {
    if (n > 1) {
      dup++;
      if (examples.length < 2) {
        const [kind, arch, step, template] = k.split('|');
        examples.push(`${kind === 'stl' ? 'model' : 'trim line'} for ${ARCH_NAME[arch as Arch]} step ${step}${template === 'true' ? ' template' : ''}`);
      }
    }
  }
  if (dup) out.push(`Two files fill the same place: ${examples.join(', ')}${dup > examples.length ? ' and more' : ''}.`);
  return out;
}

export function toSpecs(files: MapFile[], sources: SourceMap): { specs: UploadSpec[]; missing: number } {
  const specs: UploadSpec[] = [];
  let missing = 0;
  for (const f of activeFiles(files)) {
    const src = resolveSource(sources, f.path);
    if (!src) { missing++; continue; }
    specs.push({ key: f.path, name: f.name, source: src, arch: f.arch, step: f.step, template: f.template });
  }
  return { specs, missing };
}

export function caseIdProblems(caseId: string): string | null {
  return caseIdRuleProblem(caseId);
}

export { INSTRUCTIONS_MAX };
