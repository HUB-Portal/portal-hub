// Upload engine: resumable chunked uploads with a SHA-256 per chunk, parallel files, waiting for checks, submitting clean cases.
import { createSignal } from 'solid-js';
import { api, ApiError, CASE_ADDRESS_REQUIRED_TEXT } from './api';
import type { Arch, FileKind } from '@shared/filenames';
import type { FileSource } from './source';
import type { CaseFile, CaseItem } from './types';

export const FILES_PER_CASE = 4;
export const CASES_AT_ONCE = 2;

/** Extensions the server accepts for case files (BRIEF section 9). */
export const UPLOAD_EXTS = new Set(['stl', 'pts', 'pdf', 'csv', 'svg', 'txt', 'xml', 'json', 'jpg', 'jpeg', 'png']);

/** True when a file is sent to the server. Instruction files are read in the browser instead. */
export function isUploadable(f: { ext: string; kind: FileKind }): boolean {
  return f.kind !== 'instructions' && f.kind !== 'video' && UPLOAD_EXTS.has(f.ext);
}

export interface UploadSpec {
  key: string;
  name: string;
  source: FileSource;
  arch: Arch | null;
  step: number | null;
  template: boolean;
}

export type FilePhase = 'queued' | 'uploading' | 'processing' | 'ready' | 'rejected' | 'error';

export interface FileStatus {
  phase: FilePhase;
  sent: number;
  total: number;
  fileId?: string;
  error?: string;
}

export interface UploadHooks {
  onFile?: (key: string, status: FileStatus) => void;
  signal?: AbortSignal;
  /** How long to wait for the server checks (default 15 minutes). */
  timeoutMs?: number;
}

/** What an upload belongs to. A plain string means a case, as in phases 2 and 3. */
export type UploadTarget =
  | string
  | { purpose: 'case'; caseId: string }
  | { purpose: 'claim'; claimId: string }
  | { purpose: 'shipment'; shipmentId: string }
  | { purpose: 'logo' }
  | { purpose: 'document'; kind: 'qc_criteria' | 'packaging' | 'other' };

function startBody(target: UploadTarget, spec: UploadSpec, total: number): Record<string, unknown> {
  const t = typeof target === 'string' ? ({ purpose: 'case', caseId: target } as const) : target;
  if (t.purpose === 'claim') return { purpose: 'claim', claimId: t.claimId, name: spec.name, size: total };
  if (t.purpose === 'shipment') return { purpose: 'shipment', shipmentId: t.shipmentId, name: spec.name, size: total };
  if (t.purpose === 'logo') return { purpose: 'logo', name: spec.name, size: total };
  if (t.purpose === 'document') return { purpose: 'document', kind: t.kind, name: spec.name, size: total };
  return {
    purpose: 'case', caseId: t.caseId, name: spec.name, size: total,
    ...(spec.arch ? { arch: spec.arch } : {}), ...(spec.step !== null ? { step: spec.step } : {}), template: spec.template,
  };
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('This browser cannot check files safely. Use a current browser over a secure connection.');
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  const bytes = new Uint8Array(digest);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

export function isRetriable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  return e.status === 0 || e.status === 429 || e.status >= 500 || e.code === 'checksum_mismatch';
}

export async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if ((e as Error).name === 'AbortError' || !isRetriable(e) || i === attempts - 1) throw e;
      await sleep(Math.min(16000, 1000 * 2 ** i), signal);
    }
  }
  throw last;
}

export async function pool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

interface StartResponse { fileId: string; chunkSize: number; chunkCount: number; received: number[] }

/** Upload one file (resumes when the server already holds some chunks). Returns the file ID. */
export async function uploadOne(target: UploadTarget, spec: UploadSpec, hooks: UploadHooks = {}): Promise<string> {
  const total = spec.source.size;
  const report = (s: Partial<FileStatus> & { phase: FilePhase }) => hooks.onFile?.(spec.key, { sent: 0, total, ...s });
  report({ phase: 'uploading', sent: 0 });
  const start = await withRetry(
    () => api<StartResponse>('/api/uploads', {
      method: 'POST',
      signal: hooks.signal,
      body: startBody(target, spec, total),
    }),
    hooks.signal,
  );
  const have = new Set(start.received ?? []);
  let sent = Math.min(total, have.size * start.chunkSize);
  report({ phase: 'uploading', sent, fileId: start.fileId });
  for await (const chunk of spec.source.chunks(start.chunkSize, have)) {
    if (hooks.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const hash = await sha256Hex(chunk.data);
    await withRetry(
      () => api(`/api/uploads/${start.fileId}/chunks/${chunk.idx}`, {
        method: 'PUT', rawBody: chunk.data as unknown as BodyInit, headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash }, signal: hooks.signal,
      }),
      hooks.signal,
    );
    sent += chunk.data.length;
    report({ phase: 'uploading', sent: Math.min(sent, total), fileId: start.fileId });
  }
  await withRetry(() => api(`/api/uploads/${start.fileId}/complete`, { method: 'POST', body: {}, signal: hooks.signal }), hooks.signal);
  report({ phase: 'processing', sent: total, fileId: start.fileId });
  return start.fileId;
}

/** Poll until every file is ready or rejected. */
export async function waitForFiles(
  fileIds: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number; onState?: (id: string, f: CaseFile) => void } = {},
): Promise<Map<string, CaseFile>> {
  const done = new Map<string, CaseFile>();
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  let delay = 1200;
  while (done.size < fileIds.length) {
    const open = fileIds.filter((id) => !done.has(id));
    await pool(open, 6, async (id) => {
      try {
        const f = await api<CaseFile>(`/api/files/${id}`, { signal: opts.signal });
        if (f.state === 'ready' || f.state === 'rejected' || f.state === 'purged') { done.set(id, f); opts.onState?.(id, f); }
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        if (e instanceof ApiError && e.status === 404) done.set(id, { id, state: 'rejected' } as CaseFile);
      }
    });
    if (done.size >= fileIds.length) break;
    if (Date.now() > deadline) break;
    await sleep(delay, opts.signal);
    delay = Math.min(4000, delay + 400);
  }
  return done;
}

// ---- uploads that are running in this tab -------------------------------------------------------------------------------
// The count lives here and not in a page, so it survives the page that started the upload. A case page opened while the files of that
// case are still going up (for example from the Direct manufacturing page) can then tell "still uploading" from "cut off".
const [runningByCase, setRunningByCase] = createSignal<ReadonlyMap<string, number>>(new Map());
let runningTotal = 0;
const warnLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };

/** True while an upload of files for this case is running in this browser tab. */
export const uploadRunningFor = (caseId: string): boolean => (runningByCase().get(caseId) ?? 0) > 0;

function trackUpload(caseId: string | null): () => void {
  if (runningTotal++ === 0) window.addEventListener('beforeunload', warnLeave);
  if (caseId) setRunningByCase((m) => new Map(m).set(caseId, (m.get(caseId) ?? 0) + 1));
  return () => {
    if (--runningTotal === 0) window.removeEventListener('beforeunload', warnLeave);
    if (caseId) setRunningByCase((m) => { const n = new Map(m); const left = (n.get(caseId) ?? 1) - 1; if (left > 0) n.set(caseId, left); else n.delete(caseId); return n; });
  };
}

export interface CaseUploadResult {
  files: Map<string, FileStatus>;
  ok: boolean;
}

/** Upload all files of one case (4 at a time), then wait for the checks to finish. */
export async function uploadCaseFiles(caseUuid: UploadTarget, specs: UploadSpec[], hooks: UploadHooks = {}): Promise<CaseUploadResult> {
  const done = trackUpload(typeof caseUuid === 'string' ? caseUuid : caseUuid.purpose === 'case' ? caseUuid.caseId : null);
  try {
    return await uploadCaseFilesNow(caseUuid, specs, hooks);
  } finally {
    done();
  }
}

async function uploadCaseFilesNow(caseUuid: UploadTarget, specs: UploadSpec[], hooks: UploadHooks): Promise<CaseUploadResult> {
  const status = new Map<string, FileStatus>();
  const set = (key: string, s: FileStatus) => { status.set(key, s); hooks.onFile?.(key, s); };
  for (const s of specs) set(s.key, { phase: 'queued', sent: 0, total: s.source.size });
  const ids = new Map<string, string>(); // fileId -> key
  await pool(specs, FILES_PER_CASE, async (spec) => {
    try {
      const fileId = await uploadOne(caseUuid, spec, { signal: hooks.signal, onFile: (k, s) => set(k, s) });
      ids.set(fileId, spec.key);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      set(spec.key, { phase: 'error', sent: 0, total: spec.source.size, error: friendlyUploadError(e) });
    }
  });
  const final = await waitForFiles([...ids.keys()], {
    signal: hooks.signal,
    timeoutMs: hooks.timeoutMs,
    onState: (id, f) => {
      const key = ids.get(id)!;
      const prev = status.get(key)!;
      set(key, { ...prev, phase: f.state === 'ready' ? 'ready' : 'rejected', sent: prev.total, error: f.state === 'ready' ? undefined : 'This file did not pass the checks.' });
    },
  });
  for (const [id, key] of ids) {
    if (!final.has(id)) set(key, { ...status.get(key)!, phase: 'error', error: 'The checks are taking too long. Open the case later to see the result.' });
  }
  const ok = [...status.values()].every((s) => s.phase === 'ready');
  return { files: status, ok };
}

export function friendlyUploadError(e: unknown): string {
  if (e instanceof ApiError) {
    // A 413 without our own code comes from the host in front of the Hub (a request body above its limit), not from a file rule.
    if (e.status === 413 && e.code !== 'file_too_large') return 'The server refused a part of this file because it was too big. Try again, and tell K Line support if it keeps failing.';
    switch (e.code) {
      case 'file_type_not_allowed': return 'This file type is not accepted.';
      case 'file_too_large': return 'This file is too large.';
      case 'too_many_files': return 'This case already has the maximum number of files.';
      case 'case_not_open': return 'This case can no longer take files.';
      case 'org_not_approved': return 'Uploads are locked until K Line approves your company.';
      case 'case_address_required': return CASE_ADDRESS_REQUIRED_TEXT;
      case 'profile_files_limit': return 'You can store at most 10 files on your company profile until K Line approves your company.';
      case 'network': return 'The connection was lost. Try again.';
      default: return e.message;
    }
  }
  return 'The upload failed. Try again.';
}

export type SubmitOutcome =
  | { outcome: 'submitted'; status: string }
  | { outcome: 'locked' }
  | { outcome: 'failed'; reason: string };

/** Submits a case. Nothing in the checks stops it (decision of 8 Oct 2026): what can still go wrong is the account being locked or the case address missing. */
export async function submitCase(caseUuid: string, signal?: AbortSignal): Promise<SubmitOutcome> {
  try {
    const res = await api<{ case?: CaseItem; status?: string }>(`/api/cases/${caseUuid}/submit`, { method: 'POST', body: {}, signal });
    return { outcome: 'submitted', status: res?.case?.status ?? res?.status ?? 'submitted' };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    if (e instanceof ApiError) {
      if (e.code === 'org_not_approved') return { outcome: 'locked' };
      if (e.code === 'case_address_required') return { outcome: 'failed', reason: CASE_ADDRESS_REQUIRED_TEXT };
      return { outcome: 'failed', reason: e.message };
    }
    return { outcome: 'failed', reason: 'The case could not be submitted.' };
  }
}
