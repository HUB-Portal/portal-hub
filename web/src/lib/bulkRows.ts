// The rows of Direct manufacturing: what a card on the page is made of and the rules about it. Pure functions and types only (no React, no network),
// so the page, the upload hook and the tests all read the same rules.
import { buildBulkCases, NAME_MAX } from '@shared/bulk';
import { CASE_ID_ALPHABET, CASE_ID_MAX } from '@shared/filenames';
import { INSTRUCTIONS_MAX } from './instructions';
import { activeFiles, caseIdProblems, readInstructionsFor, type MapFile, type SourceMap } from './review';
import type { SourceFile } from './source';

/**
 * Where a card is. `queued` waits for its turn, `creating`, `uploading` and `checking` are the work, `uploaded` is "Successfully uploaded" (the case
 * is still a draft), `sending` and `sent` are the hand over to K Line, `attention` and `failed` need the partner.
 */
export type Stage = 'queued' | 'creating' | 'uploading' | 'checking' | 'uploaded' | 'attention' | 'sending' | 'sent' | 'failed';

/** What the server holds about a case, and what the partner can edit on its card. */
export interface CaseDetails {
  patientId: string;
  firstName: string;
  lastName: string;
  instructions: string;
}

export interface Row {
  key: string;
  folder: string;
  patientId: string;
  firstName: string;
  lastName: string;
  /** The split between first and last name was a guess. */
  guessed: boolean;
  files: MapFile[];
  instructions: string;
  instructionNote: string | null;
  stage: Stage;
  caseUuid?: string;
  ref?: string;
  sent: number;
  message?: string;
  /** Files that did not upload or did not pass the checks, by path, for a retry. */
  failedKeys?: string[];
  /** What the server holds, so only a real change is sent. */
  synced?: CaseDetails;
  nameError?: string;
}

/** The stages in which work is going on for a card. */
export const BUSY: readonly Stage[] = ['creating', 'uploading', 'checking'];
export const isBusy = (r: Pick<Row, 'stage'>): boolean => BUSY.includes(r.stage);

/** A card that has an open draft case on the server that its details can still be written to. */
const EDITABLE_ON_SERVER: readonly Stage[] = ['uploading', 'checking', 'uploaded', 'attention'];
export const canSyncDetails = (r: Row): boolean => !!r.caseUuid && !!r.synced && EDITABLE_ON_SERVER.includes(r.stage);

const STAGE_TEXT: Record<Stage, string> = {
  queued: 'Waiting', creating: 'Creating the case', uploading: 'Uploading', checking: 'Checking files', uploaded: 'Successfully uploaded',
  attention: 'Needs attention', sending: 'Sending to K Line', sent: 'Sent to K Line', failed: 'Failed',
};
export const stageText = (s: Stage): string => STAGE_TEXT[s];

export type StageTone = 'good' | 'bad' | 'warn' | 'info';
const STAGE_TONE: Record<Stage, StageTone> = {
  queued: 'info', creating: 'info', uploading: 'info', checking: 'info', sending: 'info', uploaded: 'good', sent: 'good', attention: 'warn', failed: 'bad',
};
export const stageTone = (s: Stage): StageTone => STAGE_TONE[s];

export const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
export const nameOf = (r: Pick<Row, 'firstName' | 'lastName'>): string => [clean(r.firstName), clean(r.lastName)].filter(Boolean).join(' ');

/**
 * Why a card cannot start uploading yet. Empty means it can. Nothing about the files holds a card back (no arch, step, model or trim line
 * is needed: decision of 8 Oct 2026). The patient ID and the names are optional, but must be well formed when given.
 */
export function problemsOf(r: Row): string[] {
  const out: string[] = [];
  if (r.firstName.length > NAME_MAX) out.push(`First name is longer than ${NAME_MAX} characters.`);
  if (r.lastName.length > NAME_MAX) out.push(`Last name is longer than ${NAME_MAX} characters.`);
  const id = r.patientId.trim();
  if (id) {
    if (id.length > CASE_ID_MAX || !CASE_ID_ALPHABET.test(id)) out.push(`Patient ID may use letters, digits, spaces and _ . / # - only, up to ${CASE_ID_MAX} characters.`);
    else {
      const p = caseIdProblems(id);
      if (p) out.push(p);
    }
  }
  return out;
}

/** True when the card has at least one file that is sent (folders with nothing to send are left out of the list). */
export const hasFilesToSend = (r: Pick<Row, 'files'>): boolean => activeFiles(r.files).length > 0;

/** True when a problem is about the details (and so must not be sent to the server) and not about the files. */
export const isDetailProblem = (p: string): boolean => /Patient ID|name is longer/.test(p);

/** The details of a card in the form the server stores them. */
export function detailsOf(r: Pick<Row, 'patientId' | 'firstName' | 'lastName' | 'instructions'>): CaseDetails {
  return {
    patientId: clean(r.patientId),
    firstName: clean(r.firstName),
    lastName: clean(r.lastName),
    instructions: r.instructions.trim() ? r.instructions.slice(0, INSTRUCTIONS_MAX) : '',
  };
}

/** The PATCH body for what changed since the server last had the details. Empty when nothing changed. */
export function changedDetails(r: Row): Record<string, unknown> {
  if (!r.synced) return {};
  const now = detailsOf(r);
  const diff: Record<string, unknown> = {};
  if (now.patientId !== r.synced.patientId) diff.caseId = now.patientId || null;
  if (now.firstName !== r.synced.firstName) diff.firstName = now.firstName;
  if (now.lastName !== r.synced.lastName) diff.lastName = now.lastName;
  if (now.instructions !== r.synced.instructions) diff.instructions = now.instructions;
  return diff;
}

/** The errors the server gives for one case of a batch, in words the partner can use. */
const ENTRY_ERRORS: Record<string, string> = {
  invalid_request: 'The details for this case were not accepted. Check the names.',
  invalid_patient_id: 'The patient ID was not accepted. Check it.',
  name_too_long: `Names can be at most ${NAME_MAX} characters.`,
};
export const entryError = (code: string | undefined): string => ENTRY_ERRORS[code ?? ''] ?? 'This case could not be created.';

/**
 * Decides what of a new drop is really new. The same file picked twice is skipped. A different file under a path that is already taken goes in
 * under its own prefix, so nothing is overwritten. `clashes` counts the prefixes handed out so far.
 */
export function planIntake(known: SourceMap, files: SourceFile[], clashes: number): { files: SourceFile[]; skipped: number; clashes: number } {
  const fresh = files.filter((f) => known.get(f.path)?.size !== f.size);
  const skipped = files.length - fresh.length;
  if (!fresh.some((f) => known.has(f.path))) return { files: fresh, skipped, clashes };
  const next = clashes + 1;
  return { files: fresh.map((f) => ({ ...f, path: `Added ${next}/${f.path}` })), skipped, clashes: next };
}

/** Builds the cards for the files of one drop. `taken` holds the keys already on the page, so a repeated folder name gets its own key. */
export async function buildRows(files: SourceFile[], sources: SourceMap, taken: Set<string>): Promise<Row[]> {
  const built = buildBulkCases(files.map((f) => ({ path: f.path, size: f.size })));
  return Promise.all(built.map(async (b) => {
    const t = await readInstructionsFor(b.files as MapFile[], sources);
    let key = b.key;
    for (let n = 2; taken.has(key); n++) key = `${b.key} (added ${n})`;
    taken.add(key);
    return {
      key, folder: b.folder, patientId: '', firstName: b.firstName, lastName: b.lastName, guessed: b.needsReview,
      files: b.files.map((f) => ({ ...f })) as MapFile[], instructions: t.text, instructionNote: t.message,
      stage: 'queued' as Stage, sent: 0,
    };
  }));
}
