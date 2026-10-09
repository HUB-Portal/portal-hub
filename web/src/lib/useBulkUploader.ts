import { createEffect, createMemo, createSignal, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import { plural } from './format';
import { ApiError } from './api';
import { httpBulkGateway, type BulkGateway } from './bulkGateway';
import { buildRows, detailsOf, entryError, hasFilesToSend, isBusy, planIntake, problemsOf, type Row } from './bulkRows';
import type { IntakeResult } from './intake';
import { activeFiles, fileSummary, toSpecs, type SourceMap } from './review';
import { CASES_AT_ONCE, friendlyUploadError } from './upload';
import { useDetailSync } from './useDetailSync';
import { useLeaveWarning } from './useLeaveWarning';

export interface BulkUploaderOptions {
  /** True while nothing may start (uploads locked, or no case address). Cards then wait. */
  blocked: () => boolean;
  /** Called when cases were created, changed or sent, so lists and counts elsewhere can refresh. */
  onChanged?: () => void;
  gateway?: BulkGateway;
}

/** What a card shows about its files and what holds it back. Pure: the same row gives the same answer. */
export function analyseRow(r: Row) {
  return { problems: problemsOf(r), sum: fileSummary(r.files), documents: activeFiles(r.files).filter((f) => f.kind !== 'stl' && f.kind !== 'pts').length };
}

/**
 * The work behind Direct manufacturing: it turns drops into cards, uploads them two at a time, keeps their details in step with the draft cases
 * and sends them to K Line. It knows nothing about how a card looks (that is the page and its components) or how the server is reached (that is the
 * gateway), so both can change without touching it.
 *
 * What it returns is reactive: `rows` is a store (a list of cards edited in place), and `analysis`, `notes`, `reading`, `locked`,
 * `addressRefused`, `ready`, `sendable`, `finished` and `working` are getters. Read them inside JSX or an effect and do not destructure the result.
 */
export function createBulkUploader({ blocked, onChanged, gateway = httpBulkGateway }: BulkUploaderOptions) {
  const [rows, setRows] = createStore<Row[]>([]);
  const [notes, setNotes] = createSignal<string[]>([]);
  const [reading, setReading] = createSignal(0);
  const [locked, setLocked] = createSignal(false);
  const [addressRefused, setAddressRefused] = createSignal(false);
  let sources: SourceMap = new Map();
  let clashes = 0;
  const started = new Set<string>();
  const aborts = new Map<string, AbortController>();

  const patch = (key: string, p: Partial<Row>) => setRows((r) => r.key === key, p);
  /** A change the partner makes on a card. It also clears an old error about the details. */
  const edit = (key: string, p: Partial<Row>) => patch(key, { ...p, nameError: undefined });
  const find = (key: string) => rows.find((x) => x.key === key);

  const sync = useDetailSync(rows, patch, gateway);
  const analysis = createMemo(() => rows.map(analyseRow));

  // ---- a drop becomes cards: every drop appends and nothing is replaced -------------------------------------------------
  async function ingest(read: Promise<IntakeResult>) {
    setReading((n) => n + 1);
    try {
      const r = await read;
      const msgs = [...r.notes];
      const plan = planIntake(sources, r.files, clashes);
      clashes = plan.clashes;
      if (plan.skipped) msgs.push(`${plural(plan.skipped, 'file')} already in this list ${plan.skipped === 1 ? 'was' : 'were'} skipped.`);
      if (!plan.files.length) { setNotes(msgs.length ? msgs : ['No new files were found.']); return; }
      setNotes(msgs);
      const merged: SourceMap = new Map(sources);
      for (const f of plan.files) merged.set(f.path, f.source);
      sources = merged;
      const built = await buildRows(plan.files, merged, new Set(rows.map((x) => x.key)));
      const fresh = built.filter(hasFilesToSend);
      if (fresh.length < built.length) setNotes([...msgs, `${plural(built.length - fresh.length, 'folder')} had no files to send and ${built.length - fresh.length === 1 ? 'was' : 'were'} left out.`]);
      setRows((rs) => [...rs, ...fresh]);
    } finally {
      setReading((n) => n - 1);
    }
  }

  // ---- the work for one card --------------------------------------------------------------------------------------------
  async function createCase(row: Row, signal: AbortSignal): Promise<string | null> {
    patch(row.key, { stage: 'creating', message: undefined });
    const made = await gateway.create(find(row.key) ?? row, signal);
    if (!made.id) { patch(row.key, { stage: 'failed', message: entryError(made.error) }); return null; }
    patch(row.key, { caseUuid: made.id, ref: made.ref, synced: detailsOf(find(row.key) ?? row) });
    onChanged?.();
    return made.id;
  }

  async function runCase(key: string, only?: string[]) {
    const first = find(key);
    if (!first) return;
    const ctrl = new AbortController();
    aborts.set(key, ctrl);
    try {
      const caseUuid = first.caseUuid ?? (await createCase(first, ctrl.signal));
      if (!caseUuid) return;
      const row = find(key)!;
      const { specs } = toSpecs(row.files, sources);
      const todo = only ? specs.filter((s) => only.includes(s.key)) : specs;
      if (!todo.length) { patch(key, { stage: 'attention', message: 'No files could be read.' }); return; }
      patch(key, { stage: 'uploading', message: undefined, failedKeys: undefined });
      const progress = new Map<string, { sent: number; processing: boolean }>();
      const result = await gateway.upload(caseUuid, todo, {
        signal: ctrl.signal,
        onFile: (k, s) => {
          progress.set(k, { sent: s.sent, processing: s.phase === 'processing' });
          const all = [...progress.values()];
          patch(key, { sent: all.reduce((a, v) => a + v.sent, 0), stage: all.some((v) => v.processing) ? 'checking' : 'uploading' });
        },
      });
      const bad = [...result.files].filter(([, s]) => s.phase !== 'ready').map(([k]) => k);
      if (bad.length) { patch(key, { stage: 'attention', failedKeys: bad, message: `${plural(bad.length, 'file')} did not upload or did not pass the checks.` }); return; }
      patch(key, { stage: 'uploaded', message: undefined });
      onChanged?.();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'org_not_approved') setLocked(true);
      if (e instanceof ApiError && e.code === 'case_address_required') setAddressRefused(true);
      if ((e as Error).name === 'AbortError') return;
      patch(key, { stage: 'failed', message: e instanceof ApiError && e.code === 'org_not_approved' ? 'Uploads are locked until K Line approves your account.' : friendlyUploadError(e) });
    } finally {
      aborts.delete(key);
    }
  }

  // Start every card that has nothing to fix, a few at a time, while the drop zone stays free for the next batch.
  createEffect(() => {
    if (blocked() || locked() || addressRefused()) return;
    const problems = analysis();
    let free = CASES_AT_ONCE - rows.filter(isBusy).length;
    rows.forEach((r, i) => {
      if (free <= 0 || r.stage !== 'queued' || started.has(r.key) || problems[i]!.problems.length) return;
      started.add(r.key);
      free--;
      untrack(() => { void runCase(r.key); });
    });
  });

  // Leaving the page does not stop the uploads that are running: they finish in the background (see uploadRunningFor in lib/upload).
  // Only the Remove button on a card cancels its upload.

  const ready = createMemo(() => rows.filter((r) => r.stage === 'uploaded'));
  const sendable = createMemo(() => rows.filter((r) => r.stage === 'uploaded'));
  const working = createMemo(() => rows.some((r) => isBusy(r) || r.stage === 'sending'));
  useLeaveWarning(working);

  // ---- what the partner does with a card ---------------------------------------------------------------------------------
  function retry(r: Row) {
    started.add(r.key);
    void runCase(r.key, r.failedKeys);
  }

  async function remove(r: Row) {
    aborts.get(r.key)?.abort();
    sync.cancel(r.key);
    if (r.caseUuid && r.stage !== 'sent') {
      try {
        await gateway.remove(r.caseUuid);
        onChanged?.();
      } catch (e) {
        patch(r.key, { nameError: e instanceof ApiError ? e.message : 'The draft could not be deleted.' });
        return;
      }
    }
    started.delete(r.key);
    setRows((rs) => rs.filter((x) => x.key !== r.key));
  }

  /** Sends the cards that are ready. Details typed a moment ago reach the case first, because a sent case can no longer be changed. */
  async function sendAll() {
    const batch = sendable();
    for (const r of batch) patch(r.key, { stage: 'sending', message: undefined });
    for (const r of batch) {
      const cur = find(r.key)!;
      try {
        await sync.flush(cur);
        const s = await gateway.submit(r.caseUuid!);
        if (s.outcome === 'submitted') patch(r.key, { stage: 'sent', synced: detailsOf(cur) });
        else if (s.outcome === 'locked') patch(r.key, { stage: 'uploaded', message: 'Sending is locked until your account is approved.' });
        else patch(r.key, { stage: 'attention', message: s.reason });
      } catch (e) {
        patch(r.key, { stage: 'attention', message: e instanceof ApiError ? e.message : 'The case could not be sent.' });
      }
    }
    onChanged?.();
  }

  return {
    rows,
    get analysis() { return analysis(); },
    get notes() { return notes(); },
    get reading() { return reading(); },
    get working() { return working(); },
    get locked() { return locked(); },
    get addressRefused() { return addressRefused(); },
    get ready() { return ready(); },
    get sendable() { return sendable(); },
    get finished() { return rows.filter((r) => r.stage === 'sent').length; },
    ingest, edit, patch, retry, remove, sendAll,
  };
}

/** The old name of createBulkUploader. */
export const useBulkUploader = createBulkUploader;
