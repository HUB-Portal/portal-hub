import { useEffect, useMemo, useRef, useState } from 'react';
import { plural } from './format';
import { ApiError } from './api';
import { httpBulkGateway, type BulkGateway } from './bulkGateway';
import { buildRows, detailsOf, entryError, isBusy, planIntake, problemsOf, type Row } from './bulkRows';
import type { IntakeResult } from './intake';
import { activeFiles, fileSummary, toSpecs, type SourceMap } from './review';
import { CASES_AT_ONCE, friendlyUploadError } from './upload';
import { useDetailSync } from './useDetailSync';
import { useLeaveWarning } from './useLeaveWarning';

export interface BulkUploaderOptions {
  /** True while nothing may start (uploads locked, or no case address). Cards then wait. */
  blocked: boolean;
  /** Called when cases were created, changed or sent, so lists and counts elsewhere can refresh. */
  onChanged?: () => void;
  gateway?: BulkGateway;
}

/**
 * The work behind Direct manufacturing: it turns drops into cards, uploads them two at a time, keeps their details in step with the draft cases
 * and sends them to K Line. It knows nothing about how a card looks (that is the page and its components) or how the server is reached (that is the
 * gateway), so both can change without touching it.
 */
export function useBulkUploader({ blocked, onChanged, gateway = httpBulkGateway }: BulkUploaderOptions) {
  const [rows, setRows] = useState<Row[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [reading, setReading] = useState(0);
  const [ack, setAck] = useState(false);
  const [locked, setLocked] = useState(false);
  const [addressRefused, setAddressRefused] = useState(false);
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;
  const sources = useRef<SourceMap>(new Map());
  const clashes = useRef(0);
  const started = useRef(new Set<string>());
  const aborts = useRef(new Map<string, AbortController>());

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  /** A change the partner makes on a card. It also clears an old error about the details. */
  const edit = (key: string, p: Partial<Row>) => patch(key, { ...p, nameError: undefined });

  const sync = useDetailSync(rows, rowsRef, patch, gateway);
  const analysis = useMemo(
    () => rows.map((r) => {
      return { problems: problemsOf(r), sum: fileSummary(r.files), documents: activeFiles(r.files).filter((f) => f.kind !== 'stl' && f.kind !== 'pts').length };
    }),
    [rows],
  );

  // ---- a drop becomes cards: every drop appends and nothing is replaced -------------------------------------------------
  async function ingest(read: Promise<IntakeResult>) {
    setReading((n) => n + 1);
    try {
      const r = await read;
      const msgs = [...r.notes];
      const plan = planIntake(sources.current, r.files, clashes.current);
      clashes.current = plan.clashes;
      if (plan.skipped) msgs.push(`${plural(plan.skipped, 'file')} already in this list ${plan.skipped === 1 ? 'was' : 'were'} skipped.`);
      if (!plan.files.length) { setNotes(msgs.length ? msgs : ['No new files were found.']); return; }
      setNotes(msgs);
      const merged: SourceMap = new Map(sources.current);
      for (const f of plan.files) merged.set(f.path, f.source);
      sources.current = merged;
      const fresh = await buildRows(plan.files, merged, new Set(rowsRef.current.map((x) => x.key)));
      setRows((rs) => [...rs, ...fresh]);
    } finally {
      setReading((n) => n - 1);
    }
  }

  // ---- the work for one card --------------------------------------------------------------------------------------------
  async function createCase(row: Row, signal: AbortSignal): Promise<string | null> {
    patch(row.key, { stage: 'creating', message: undefined });
    const made = await gateway.create(rowsRef.current.find((x) => x.key === row.key) ?? row, signal);
    if (!made.id) { patch(row.key, { stage: 'failed', message: entryError(made.error) }); return null; }
    patch(row.key, { caseUuid: made.id, ref: made.ref, synced: detailsOf(rowsRef.current.find((x) => x.key === row.key) ?? row) });
    onChanged?.();
    return made.id;
  }

  async function runCase(key: string, only?: string[]) {
    const first = rowsRef.current.find((x) => x.key === key);
    if (!first) return;
    const ctrl = new AbortController();
    aborts.current.set(key, ctrl);
    try {
      const caseUuid = first.caseUuid ?? (await createCase(first, ctrl.signal));
      if (!caseUuid) return;
      const row = rowsRef.current.find((x) => x.key === key)!;
      const { specs } = toSpecs(row.files, sources.current);
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
      const checks = await gateway.checks(caseUuid, ctrl.signal);
      if (checks.errors) { patch(key, { stage: 'attention', message: `The checks found ${plural(checks.errors, 'problem')}. Open the case to see them.` }); return; }
      patch(key, { stage: 'uploaded', serverWarnings: checks.warnings, message: undefined });
      onChanged?.();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'org_not_approved') setLocked(true);
      if (e instanceof ApiError && e.code === 'case_address_required') setAddressRefused(true);
      if ((e as Error).name === 'AbortError') return;
      patch(key, { stage: 'failed', message: e instanceof ApiError && e.code === 'org_not_approved' ? 'Uploads are locked until K Line approves your account.' : friendlyUploadError(e) });
    } finally {
      aborts.current.delete(key);
    }
  }

  // Start every card that has nothing to fix, a few at a time, while the drop zone stays free for the next batch.
  useEffect(() => {
    if (blocked || locked || addressRefused) return;
    let free = CASES_AT_ONCE - rows.filter(isBusy).length;
    rows.forEach((r, i) => {
      if (free <= 0 || r.stage !== 'queued' || started.current.has(r.key) || analysis[i]!.problems.length) return;
      started.current.add(r.key);
      free--;
      void runCase(r.key);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, blocked, locked, addressRefused, analysis]);

  useEffect(() => () => { for (const a of aborts.current.values()) a.abort(); }, []);

  const sendable = rows.filter((r) => r.stage === 'uploaded' && (!r.serverWarnings || ack));
  const working = rows.some((r) => isBusy(r) || r.stage === 'sending');
  useLeaveWarning(working);

  // ---- what the partner does with a card ---------------------------------------------------------------------------------
  function retry(r: Row) {
    started.current.add(r.key);
    void runCase(r.key, r.failedKeys);
  }

  async function remove(r: Row) {
    aborts.current.get(r.key)?.abort();
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
    started.current.delete(r.key);
    setRows((rs) => rs.filter((x) => x.key !== r.key));
  }

  /** Sends the cards that are ready. Details typed a moment ago reach the case first, because a sent case can no longer be changed. */
  async function sendAll() {
    const batch = sendable;
    for (const r of batch) patch(r.key, { stage: 'sending', message: undefined });
    for (const r of batch) {
      const cur = rowsRef.current.find((x) => x.key === r.key)!;
      try {
        await sync.flush(cur);
        const s = await gateway.submit(r.caseUuid!, ack);
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
    rows, analysis, notes, reading, ack, setAck, working,
    locked, addressRefused,
    ready: rows.filter((r) => r.stage === 'uploaded'),
    sendable,
    finished: rows.filter((r) => r.stage === 'sent').length,
    ingest, edit, patch, retry, remove, sendAll,
  };
}
