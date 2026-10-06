// File name parsing and folder grouping for case intake. Pure TypeScript, used by server and web.

export type Arch = 'upper' | 'lower';
export type FileKind = 'stl' | 'pts' | 'pdf' | 'csv' | 'svg' | 'image' | 'video' | 'instructions' | 'other';

export interface InputFile {
  /** Path relative to the dropped item, using "/" (a zip name may be the first segment). */
  path: string;
  size: number;
}

export interface ParsedName {
  kind: FileKind;
  ext: string;
  arch: Arch | null;
  step: number | null;
  template: boolean;
}

export interface MappedFile extends ParsedName {
  path: string;
  name: string;
  size: number;
}

export interface CaseGroup {
  /** Case ID after cleaning (letters, digits, spaces and _ . / # -). */
  caseId: string;
  /** True when the ID is only the folder name (no ID token found), so it may be a patient name. */
  idFromFolderName: boolean;
  /** Path of the folder that holds the case (top level item for loose files). */
  folder: string;
  /** Name of the folder the ID was taken from (not cleaned). */
  nameFolder: string;
  files: MappedFile[];
  problems: string[];
}

export const CASE_ID_ALPHABET = /^[A-Za-z0-9 _./#-]+$/;
export const CASE_ID_MAX = 64;

/**
 * Why a case ID is not acceptable, or null. Letters, digits, spaces and _ . / # - only, up to 64 characters. It may not contain two dots in a row
 * and may not start or end with a dot or a slash (an ID ends up in file and folder names, where those would read as a path).
 */
export function caseIdRuleProblem(raw: string): string | null {
  const id = raw.trim();
  if (!id) return 'Add a case ID.';
  if (id.length > CASE_ID_MAX) return `The case ID is longer than ${CASE_ID_MAX} characters.`;
  if (!CASE_ID_ALPHABET.test(id)) return 'Use only letters, digits, spaces and _ . / # - in the case ID.';
  if (id.includes('..') || /^[./]|[./]$/.test(id)) return 'A case ID cannot have two dots in a row, and cannot start or end with a dot or a slash.';
  return null;
}

const STRUCTURAL_WORDS = [
  'upper', 'lower', 'maxilla', 'mandible', 'oberkiefer', 'unterkiefer', 'ok', 'uk', 'uj', 'lj', 'u', 'l',
  'steps', 'stages', 'subsetups', 'setups', 'aligners', 'trays', 'models', 'stl', 'pts', 'csv', 'trim lines',
  'trim line', 'trimlines', 'cut lines', 'cutlines', 'templates', 'attachments', 'exports', 'files', '3d',
  'scans', 'prints', 'output', 'results', 'photos', 'images', 'pictures', 'documents', 'docs', 'reports',
  'prescriptions', 'rx', 'instructions', 'notes', 'pdfs', 'other', 'misc', 'extras',
];
const STRUCTURAL_SUFFIX = ['jaw', 'arch', 'models', 'model', 'steps', 'step'];

export function isStructuralFolder(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!n) return true;
  const base = n.replace(/\s*\d+$/, '').trim();
  if (STRUCTURAL_WORDS.includes(base)) return true;
  for (const w of ['upper', 'lower', 'maxilla', 'mandible', 'ok', 'uk', 'uj', 'lj', 'u', 'l', 'oberkiefer', 'unterkiefer']) {
    if (base.startsWith(w + ' ')) {
      const rest = base.slice(w.length + 1).trim();
      if (STRUCTURAL_SUFFIX.includes(rest)) return true;
    }
  }
  return false;
}

const UPPER_WORDS = ['upper', 'maxilla', 'maxillary', 'oberkiefer', 'superior', 'u', 'up', 'ok', 'sup', 'max', 'mx', 'uj', 'top'];
const LOWER_WORDS = ['lower', 'mandible', 'mandibular', 'unterkiefer', 'inferior', 'l', 'low', 'uk', 'inf', 'mand', 'md', 'lj', 'bottom', 'bot'];
const STEP_WORDS = ['step', 'stage', 'subsetup', 'setup', 'aligner', 'tray'];
const STEP_WORD_ONLY = ['step', 'stage', 'subsetup', 'setup', 'aligner', 'tray', 'steps', 'stages', 'setups', 'aligners', 'trays'];

const EXT_KIND: Record<string, FileKind> = {
  stl: 'stl', pts: 'pts', pdf: 'pdf', csv: 'csv', svg: 'svg',
  jpg: 'image', jpeg: 'image', png: 'image',
  mp4: 'video', mov: 'video', m4v: 'video',
  txt: 'instructions', md: 'instructions', rtf: 'instructions', docx: 'instructions', doc: 'instructions',
};

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}
export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}
export function stem(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function splitTokens(s: string): string[] {
  // Split on non alphanumerics, then split letter/digit joins such as "Step12" (not "U04").
  const raw = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  for (const t of raw) {
    const m = /^([A-Za-z]{3,})(\d+)$/.exec(t);
    if (m) out.push(m[1]!, m[2]!);
    else out.push(t);
  }
  return out;
}

interface Hints { arch: Arch | null; step: number | null; template: boolean }

/** Read arch, step and template hints from free text (a folder name or a file stem). */
function readHints(text: string, opts: { allowBareNumber: boolean; idToken?: string | null }): Hints {
  const tokens = splitTokens(text);
  let arch: Arch | null = null;
  let step: number | null = null;
  let template = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const low = tok.toLowerCase();
    if (opts.idToken && tok === opts.idToken) continue;
    const ls = /^([ul])0*(\d{1,3})$/i.exec(tok); // U04, L06
    if (ls) {
      arch = ls[1]!.toLowerCase() === 'u' ? 'upper' : 'lower';
      step = Number(ls[2]);
      continue;
    }
    if (low === 't' && i > 0) { template = true; continue; }
    if (low === 'template' || low === 'templates') { template = true; continue; }
    if (UPPER_WORDS.includes(low)) { arch = arch ?? 'upper'; continue; }
    if (LOWER_WORDS.includes(low)) { arch = arch ?? 'lower'; continue; }
    if (STEP_WORDS.includes(low)) {
      const next = tokens[i + 1];
      if (next && /^\d{1,3}$/.test(next)) { step = Number(next); i++; }
      continue;
    }
    if (/^\d{1,3}$/.test(tok) && opts.allowBareNumber) step = step ?? Number(tok);
  }
  return { arch, step, template };
}

export function findCaseIdToken(text: string, customRegex?: string | null): string | null {
  if (customRegex) {
    try {
      const m = new RegExp(customRegex).exec(text);
      if (m) return m[1] ?? m[0];
    } catch { /* ignore an invalid partner expression */ }
  }
  for (const tok of text.split(/[\s_.\-/#()[\]]+/)) {
    if (!/^\d{4,}$/.test(tok)) continue;
    if (/^(19|20)\d{2}$/.test(tok)) continue; // year
    if (/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(tok)) continue; // date yyyymmdd
    return tok;
  }
  return null;
}

export function cleanCaseId(raw: string): string {
  const noAccents = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Folder names often end in a dot or a slash or hold "..": those are cut so the ID follows the case ID rules (see caseIdRuleProblem).
  const replaced = noAccents
    .replace(/[^A-Za-z0-9 _./#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s./]+|[\s./]+$/g, '');
  return replaced.slice(0, CASE_ID_MAX).replace(/[\s./]+$/, '');
}

export function parseFileName(path: string, folderSegments: string[] = [], idToken: string | null = null): ParsedName {
  const name = baseName(path);
  const ext = extOf(name);
  const kind = EXT_KIND[ext] ?? 'other';
  let arch: Arch | null = null;
  let step: number | null = null;
  let template = false;

  for (const seg of folderSegments) {
    const h = readHints(seg, { allowBareNumber: false, idToken });
    if (h.arch) arch = h.arch;
    if (h.step !== null) step = h.step;
    if (h.template) template = true;
  }
  const own = readHints(stem(name), { allowBareNumber: true, idToken });
  if (own.arch) arch = own.arch;
  if (own.step !== null) step = own.step;
  if (own.template) template = true;
  if (template && step === null) step = 0;
  return { kind, ext, arch, step, template };
}

interface Node { segs: string[]; file: InputFile }

function uniq<T>(a: T[]): T[] { return [...new Set(a)]; }

function pickName(pathSegs: string[], custom?: string | null): { name: string; hasId: boolean; id: string | null } {
  for (let i = pathSegs.length - 1; i >= 0; i--) {
    const id = findCaseIdToken(pathSegs[i]!, custom);
    if (id) return { name: pathSegs[i]!, hasId: true, id };
  }
  for (let i = pathSegs.length - 1; i >= 0; i--) {
    if (!isStructuralFolder(pathSegs[i]!)) return { name: pathSegs[i]!, hasId: false, id: null };
  }
  return { name: pathSegs[pathSegs.length - 1] ?? 'Case', hasId: false, id: null };
}

function findCaseFolders(nodes: Node[], prefix: string[]): string[][] {
  // nodes all share `prefix`. Descend while a single sub folder holds everything.
  const depth = prefix.length;
  const nexts = nodes.map((n) => (n.segs.length > depth + 1 ? n.segs[depth]! : null));
  const direct = nexts.filter((x) => x === null).length;
  const folderNames = uniq(nexts.filter((x): x is string => x !== null));
  if (folderNames.length === 1 && direct === 0) return findCaseFolders(nodes, [...prefix, folderNames[0]!]);
  const nonStructural = folderNames.filter((f) => !isStructuralFolder(f));
  const structural = folderNames.filter((f) => isStructuralFolder(f));
  if (nonStructural.length >= 1 && structural.length === 0 && (nonStructural.length > 1 || direct > 0)) {
    // Batch folder: one case per sub folder. A single sub folder next to loose files also counts.
    if (nonStructural.length === 1 && direct > 0) return [prefix];
    return nonStructural.map((f) => [...prefix, f]);
  }
  return [prefix];
}

export interface GroupOptions { caseIdRegex?: string | null }

/** Group dropped files into cases. Paths use "/"; the first segment is the dropped item (folder or zip name). */
export function groupCases(files: InputFile[], opts: GroupOptions = {}): CaseGroup[] {
  const custom = opts.caseIdRegex ?? null;
  const items = new Map<string, Node[]>();
  const loose: InputFile[] = [];
  for (const f of files) {
    const segs = f.path.split('/').filter(Boolean);
    if (segs.length === 0) continue;
    if (segs.length === 1) { loose.push(f); continue; }
    const top = segs[0]!;
    if (!items.has(top)) items.set(top, []);
    items.get(top)!.push({ segs, file: f });
  }

  const groups: CaseGroup[] = [];
  for (const [top, nodes] of items) {
    const folders = findCaseFolders(nodes, [top]);
    const single = folders.length === 1;
    for (const folder of folders) {
      const inFolder = nodes.filter((n) => folder.every((s, i) => n.segs[i] === s));
      // Files outside every case folder in a batch (loose files in the batch folder) are handled below.
      const picked = pickName(folder, custom);
      const caseRaw = picked.id ?? picked.name;
      const g = buildGroup(inFolder, folder, picked.name, picked.hasId, caseRaw, custom);
      groups.push(g);
    }
    if (!single) {
      const inAny = new Set(folders.flatMap((f) => nodes.filter((n) => f.every((s, i) => n.segs[i] === s))));
      const strays = nodes.filter((n) => !inAny.has(n));
      for (const s of strays) loose.push({ path: s.segs.slice(1).join('/'), size: s.file.size });
    }
  }

  // Loose files: group by case ID at the start of the name; a file without an ID joins the case when only one exists.
  for (const f of loose) {
    const name = baseName(f.path);
    const id = /^(\d{4,})/.exec(stem(name))?.[1] ?? findCaseIdToken(stem(name), custom);
    let target = id ? groups.find((g) => g.caseId === cleanCaseId(id)) : undefined;
    if (!target && id) {
      target = {
        caseId: cleanCaseId(id), idFromFolderName: false, folder: '', nameFolder: '', files: [], problems: [],
      };
      groups.push(target);
    }
    if (!target) {
      if (groups.length === 1) target = groups[0]!;
      else {
        target = groups.find((g) => g.folder === '' && g.caseId === 'Loose files');
        if (!target) {
          target = { caseId: 'Loose files', idFromFolderName: true, folder: '', nameFolder: '', files: [], problems: [] };
          groups.push(target);
        }
      }
    }
    const idTok = findCaseIdToken(target.caseId, custom) ?? target.caseId;
    target.files.push({ path: f.path, name: name, size: f.size, ...parseFileName(f.path, [], idTok) });
  }

  // Refresh problems now that all files are in.
  const seen = new Map<string, number>();
  for (const g of groups) seen.set(g.caseId, (seen.get(g.caseId) ?? 0) + 1);
  for (const g of groups) {
    g.problems = caseProblems(g);
    if ((seen.get(g.caseId) ?? 0) > 1) g.problems.push('Two folders use this case ID. Rename one before uploading.');
  }
  return groups;
}

function buildGroup(nodes: Node[], folder: string[], nameFolder: string, hasId: boolean, caseRaw: string, custom: string | null): CaseGroup {
  const caseId = cleanCaseId(caseRaw);
  const idTok = findCaseIdToken(caseRaw, custom);
  const mapped: MappedFile[] = nodes.map((n) => {
    const inner = n.segs.slice(folder.length, -1);
    const parsed = parseFileName(n.file.path, inner, idTok ?? findCaseIdToken(n.segs.slice(0, -1).join(' '), custom));
    return { path: n.file.path, name: baseName(n.file.path), size: n.file.size, ...parsed };
  });
  mapped.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  const g: CaseGroup = {
    caseId, idFromFolderName: !hasId, folder: folder.join('/'), nameFolder, files: mapped, problems: [],
  };
  return g;
}

export function caseProblems(g: CaseGroup): string[] {
  const out: string[] = [];
  if (!g.caseId || g.caseId === 'Loose files') out.push('No case ID found. Add one before uploading.');
  const models = g.files.filter((f) => f.kind === 'stl');
  if (models.length === 0) out.push('No 3D models (STL) found.');
  const missing = g.files.filter((f) => (f.kind === 'stl' || f.kind === 'pts') && (f.arch === null || f.step === null));
  if (missing.length) out.push(`${missing.length} file${missing.length === 1 ? '' : 's'} without arch or step.`);
  return out;
}

export function rangeOf(files: MappedFile[], arch: Arch): { min: number; max: number; count: number } | null {
  const steps = files.filter((f) => f.kind === 'stl' && f.arch === arch && !f.template && f.step !== null).map((f) => f.step!);
  if (!steps.length) return null;
  return { min: Math.min(...steps), max: Math.max(...steps), count: steps.length };
}

export function missingTrimLines(files: MappedFile[]): MappedFile[] {
  const pts = new Set(files.filter((f) => f.kind === 'pts' && f.arch && f.step !== null).map((f) => `${f.arch}|${f.step}|${f.template}`));
  return files.filter((f) => f.kind === 'stl' && f.arch && f.step !== null && !pts.has(`${f.arch}|${f.step}|${f.template}`));
}
