// Direct manufacturing bulk intake: read the optional patient data from case folder names.
// Folder name pattern: "<first name> <last name>", for example "Marc Alonso". A leading number (an old patient ID) is ignored.
// Product type does not appear in the zip and is ignored.

import { CaseGroup, MappedFile, caseProblems, groupCases, InputFile, findCaseIdToken } from './filenames';

export const NAME_MAX = 50;

export interface BulkFolderName {
  patientId: string | null;
  firstName: string;
  lastName: string;
  /** True when the split between first and last name is a guess (three or more words, or one word). */
  needsReview: boolean;
  problems: string[];
}

const COPY_SUFFIX = /(\s*[-_ ]?\s*(\(\d{1,3}\)|copy(\s*\d+)?|kopie|\[\d{1,3}\]))+\s*$/i;

export function stripCopySuffix(name: string): string {
  return name.replace(COPY_SUFFIX, '').trim();
}

const NAME_TOKEN = /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u;

export function parseBulkFolderName(folderName: string): BulkFolderName {
  const problems: string[] = [];
  const cleaned = stripCopySuffix(folderName.normalize('NFC'));
  const patientId = findCaseIdToken(cleaned) ?? null;
  let rest = cleaned;
  if (patientId) rest = rest.replace(patientId, ' ');
  // "Alonso, Marc" means last name first.
  const comma = /^\s*([^,]+),\s*(.+)$/.exec(rest);
  let words: string[];
  let lastFirst = false;
  if (comma) {
    lastFirst = true;
    words = [comma[1]!.trim(), ...comma[2]!.trim().split(/[\s_]+/)].filter(Boolean);
  } else {
    words = rest.split(/[\s_]+/).filter(Boolean);
  }
  words = words.filter((w) => NAME_TOKEN.test(w));

  let firstName = '';
  let lastName = '';
  let needsReview = false;
  if (lastFirst && words.length >= 2) {
    lastName = words[0]!;
    firstName = words.slice(1).join(' ');
  } else if (words.length === 2) {
    firstName = words[0]!;
    lastName = words[1]!;
  } else if (words.length >= 3) {
    firstName = words[0]!;
    lastName = words.slice(1).join(' ');
    needsReview = true;
  } else if (words.length === 1) {
    lastName = words[0]!; // the API only strictly needs the last name
    needsReview = true;
  }
  if (!lastName) problems.push('No patient last name found in the folder name.');
  if (!firstName) problems.push('No patient first name found in the folder name.');
  return { patientId, firstName, lastName, needsReview, problems };
}

export function swapNames(n: { firstName: string; lastName: string }): { firstName: string; lastName: string } {
  return { firstName: n.lastName, lastName: n.firstName };
}

export interface BulkCase {
  /** Stable key for the review screen (folder path). */
  key: string;
  folder: string;
  firstName: string;
  lastName: string;
  needsReview: boolean;
  files: MappedFile[];
  /** Files that are not 3D models or trim lines: PDFs, images, CSV, everything else (the "other documents"). */
  documents: MappedFile[];
  instructionFiles: MappedFile[];
  problems: string[];
}

export function validateBulkCase(c: Pick<BulkCase, 'firstName' | 'lastName' | 'files'>): string[] {
  // The patient ID and the names are optional (review of 8 Oct 2026). The case reference identifies a case without them.
  const out: string[] = [];
  if (c.firstName.length > NAME_MAX) out.push(`First name is longer than ${NAME_MAX} characters.`);
  if (c.lastName.length > NAME_MAX) out.push(`Last name is longer than ${NAME_MAX} characters.`);
  if (c.files.length === 0) out.push('This folder has no files.');
  return out;
}

function fromGroup(g: CaseGroup): BulkCase {
  const parsed = parseBulkFolderName(g.nameFolder || g.caseId);
  const c: BulkCase = {
    key: g.folder || g.caseId,
    folder: g.folder,
    firstName: parsed.firstName,
    lastName: parsed.lastName,
    needsReview: parsed.needsReview,
    files: g.files,
    documents: g.files.filter((f) => f.kind !== 'stl' && f.kind !== 'pts' && f.kind !== 'instructions'),
    instructionFiles: g.files.filter((f) => f.kind === 'instructions'),
    problems: [],
  };
  c.problems = [...validateBulkCase(c), ...caseProblems(g).filter((p) => !p.startsWith('No case ID'))];
  return c;
}

/** Group a dropped zip or folder into direct manufacturing cases with the optional patient data. */
export function buildBulkCases(files: InputFile[]): BulkCase[] {
  return groupCases(files).map(fromGroup);
}

export function refreshBulkCase(c: BulkCase): BulkCase {
  const problems = validateBulkCase(c);
  const models = c.files.filter((f) => f.kind === 'stl');
  if (models.length === 0) problems.push('No 3D models (STL) found.');
  const missing = c.files.filter((f) => (f.kind === 'stl' || f.kind === 'pts') && (f.arch === null || f.step === null));
  if (missing.length) problems.push(`${missing.length} file${missing.length === 1 ? '' : 's'} without arch or step.`);
  return { ...c, problems };
}

/** Patient name to pre-fill on the standard intake screen when the folder name is "<ID> <name words>". Empty when there is none. */
export function patientNameFromFolder(folderName: string): string {
  const p = parseBulkFolderName(folderName);
  if (!p.patientId) return '';
  return [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
}
