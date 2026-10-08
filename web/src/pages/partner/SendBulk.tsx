import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, CheckCircle2, CircleAlert, Lock, RefreshCw, Trash2 } from 'lucide-react';
import { buildBulkCases, NAME_MAX, swapNames } from '@shared/bulk';
import { CASE_ID_ALPHABET, CASE_ID_MAX } from '@shared/filenames';
import { api, ApiError } from '../../lib/api';
import { formatBytes, formatNumber, plural } from '../../lib/format';
import { INSTRUCTIONS_MAX } from '../../lib/instructions';
import { readDrop, readFileList, type IntakeResult } from '../../lib/intake';
import { activeFiles, caseIdProblems, fileSummary, mappingProblems, readInstructionsFor, toSpecs, type MapFile, type SourceMap } from '../../lib/review';
import { CASES_AT_ONCE, friendlyUploadError, submitWhenClean, uploadCaseFiles } from '../../lib/upload';
import type { CaseItem, OrgInfo } from '../../lib/types';
import { AddDocuments } from '../../ui/AddDocuments';
import { Badge, Button, Field, Notice, PageHeader, ProgressBar, Spinner, Toggle } from '../../ui/Common';
import { DemoSamples } from '../../ui/DemoSamples';
import { DropZone, PageDropOverlay, usePageDrop } from '../../ui/DropZone';
import { FileMapTable } from '../../ui/FileMapTable';
import { useCaseCounts, useProfile, useUserCaseAddress } from '../../lib/orgApi';
import { useAuth } from '../../lib/auth';

/**
 * One case card. A card is created for every case found in a drop and starts uploading at once when it has nothing to fix, so the drop zone can
 * stay at the top of the page and take the next batch while this one is still going. The case stays a draft until the partner sends it.
 */
type Stage = 'queued' | 'creating' | 'uploading' | 'checking' | 'uploaded' | 'attention' | 'sending' | 'sent' | 'failed';

interface Row {
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
  /** Warnings the server's checks gave the uploaded case. */
  serverWarnings?: number;
  /** What the server holds, so only a real change is sent. */
  synced?: { patientId: string; firstName: string; lastName: string; instructions: string };
  nameError?: string;
}

const BUSY: Stage[] = ['creating', 'uploading', 'checking'];

const STAGE_TEXT: Partial<Record<Stage, string>> = {
  queued: 'Waiting', creating: 'Creating the case', uploading: 'Uploading', checking: 'Checking files', uploaded: 'Successfully uploaded',
  attention: 'Needs attention', sending: 'Sending to K Line', sent: 'Sent to K Line', failed: 'Failed',
};

const tone = (s: Stage) => (s === 'uploaded' || s === 'sent' ? 'good' : s === 'failed' ? 'bad' : s === 'attention' ? 'warn' : 'info');

/** Why a card cannot start uploading yet. Empty means it can. Names and the patient ID are optional. */
function problemsOf(r: Row): string[] {
  const act = activeFiles(r.files);
  const out: string[] = [];
  if (act.length === 0) out.push('This folder has no files to send.');
  else if (act.filter((f) => f.kind === 'stl').length === 0) out.push('No 3D models (STL) found.');
  out.push(...mappingProblems(r.files));
  if (r.firstName.length > NAME_MAX) out.push(`First name is longer than ${NAME_MAX} characters.`);
  if (r.lastName.length > NAME_MAX) out.push(`Last name is longer than ${NAME_MAX} characters.`);
  const id = r.patientId.trim();
  if (id) {
    if (id.length > CASE_ID_MAX || !CASE_ID_ALPHABET.test(id)) out.push(`Patient ID may use letters, digits, spaces and _ . / # - only, up to ${CASE_ID_MAX} characters.`);
    else { const p = caseIdProblems(id); if (p) out.push(p); }
  }
  return out;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const nameOf = (r: Row) => [clean(r.firstName), clean(r.lastName)].filter(Boolean).join(' ');

const ENTRY_ERRORS: Record<string, string> = {
  invalid_request: 'The details for this case were not accepted. Check the names.',
  invalid_patient_id: 'The patient ID was not accepted. Check it.',
  name_too_long: `Names can be at most ${NAME_MAX} characters.`,
};

/** The brand and auto-submit options are hidden for now. The defaults apply: no brand, warnings need your confirmation before a case is sent. */
export default function SendBulk() {
  const qc = useQueryClient();
  const org = useQuery({ queryKey: ['org'], queryFn: () => api<OrgInfo>('/api/org'), retry: false });
  const profile = useProfile();
  const myAddress = useUserCaseAddress();
  const counts = useCaseCounts(true);
  const { can } = useAuth();
  const [addressRefused, setAddressRefused] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [reading, setReading] = useState(0);
  const [ack, setAck] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const addCount = useRef(0);
  const sources = useRef<SourceMap>(new Map());
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;
  const started = useRef(new Set<string>());
  const aborts = useRef(new Map<string, AbortController>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const isLocked = locked || (org.data ? !org.data.uploadsUnlocked : false);
  // Direct manufacturing needs a case address: the sender's own when complete, otherwise the company's. The server also refuses (case_address_required), so the notice shows either way.
  const needsAddress = addressRefused || (myAddress.data ? myAddress.data.effective === 'none' : profile.data?.caseAddressComplete === false);
  const blocked = isLocked || needsAddress;

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const edit = (key: string, p: Partial<Row>) => patch(key, { ...p, nameError: undefined });

  /** Reads a drop or a pick and adds its cases to the list. Nothing is replaced: every drop appends. */
  async function ingest(read: Promise<IntakeResult>) {
    setReading((n) => n + 1);
    setFatal(null);
    try {
      const r = await read;
      const msgs = [...r.notes];
      let files = r.files;
      // The same file picked twice is skipped. A different file under the same path goes in as its own group so nothing is overwritten.
      const fresh = files.filter((f) => sources.current.get(f.path)?.size !== f.size);
      if (fresh.length < files.length) msgs.push(`${plural(files.length - fresh.length, 'file')} already in this list ${files.length - fresh.length === 1 ? 'was' : 'were'} skipped.`);
      files = fresh;
      if (files.some((f) => sources.current.has(f.path))) {
        addCount.current += 1;
        const prefix = `Added ${addCount.current}/`;
        files = files.map((f) => ({ ...f, path: `${prefix}${f.path}` }));
      }
      if (!files.length) { setNotes(msgs.length ? msgs : ['No new files were found.']); return; }
      setNotes(msgs);
      const merged: SourceMap = new Map(sources.current);
      for (const f of files) merged.set(f.path, f.source);
      sources.current = merged;
      const built = buildBulkCases(files.map((f) => ({ path: f.path, size: f.size })));
      const taken = new Set(rowsRef.current.map((x) => x.key));
      const list: Row[] = await Promise.all(built.map(async (b) => {
        const t = await readInstructionsFor(b.files as MapFile[], sources.current);
        let key = b.key;
        for (let n = 2; taken.has(key); n++) key = `${b.key} (added ${n})`;
        taken.add(key);
        return {
          key, folder: b.folder, patientId: '', firstName: b.firstName, lastName: b.lastName, guessed: b.needsReview,
          files: b.files.map((f) => ({ ...f })) as MapFile[], instructions: t.text, instructionNote: t.message,
          stage: 'queued' as Stage, sent: 0,
        };
      }));
      setRows((rs) => [...rs, ...list]);
    } finally {
      setReading((n) => n - 1);
    }
  }

  const analysis = useMemo(() => rows.map((r) => ({ problems: problemsOf(r), sum: fileSummary(r.files), documents: activeFiles(r.files).filter((f) => f.kind !== 'stl' && f.kind !== 'pts').length })), [rows]);

  const dragging = usePageDrop((snap) => { void ingest(readDrop(snap)); });

  // ---- the upload of one case ---------------------------------------------------------------------------------------------
  async function runCase(key: string, only?: string[]) {
    const r0 = rowsRef.current.find((x) => x.key === key);
    if (!r0) return;
    const ctrl = new AbortController();
    aborts.current.set(key, ctrl);
    try {
      let caseUuid = r0.caseUuid;
      if (!caseUuid) {
        patch(key, { stage: 'creating', message: undefined });
        const r = rowsRef.current.find((x) => x.key === key)!;
        const body = { key: r.key, patientId: clean(r.patientId) || undefined, firstName: clean(r.firstName), lastName: clean(r.lastName), ...(r.instructions.trim() ? { instructions: r.instructions.slice(0, INSTRUCTIONS_MAX) } : {}) };
        const created = await api<{ batchId: string | null; cases: { key: string; id?: string; ref?: string; error?: string }[] }>('/api/bulk/batches', { method: 'POST', signal: ctrl.signal, body: { cases: [body] } });
        const c = created.cases[0];
        if (!c?.id) { patch(key, { stage: 'failed', message: ENTRY_ERRORS[c?.error ?? ''] ?? 'This case could not be created.' }); return; }
        caseUuid = c.id;
        patch(key, { caseUuid, ref: c.ref, synced: { patientId: body.patientId ?? '', firstName: body.firstName, lastName: body.lastName, instructions: r.instructions.trim() ? r.instructions.slice(0, INSTRUCTIONS_MAX) : '' } });
        void qc.invalidateQueries({ queryKey: ['cases'] });
      }
      const row = rowsRef.current.find((x) => x.key === key)!;
      const { specs } = toSpecs(row.files, sources.current);
      const todo = only ? specs.filter((s) => only.includes(s.key)) : specs;
      if (!todo.length) { patch(key, { stage: 'attention', message: 'No files could be read.' }); return; }
      patch(key, { stage: 'uploading', message: undefined, failedKeys: undefined });
      const statuses = new Map<string, { sent: number; processing: boolean }>();
      const result = await uploadCaseFiles(caseUuid, todo, {
        signal: ctrl.signal,
        onFile: (k, s) => {
          statuses.set(k, { sent: s.sent, processing: s.phase === 'processing' });
          let sent = 0;
          let processing = false;
          for (const v of statuses.values()) { sent += v.sent; if (v.processing) processing = true; }
          patch(key, { sent, stage: processing ? 'checking' : 'uploading' });
        },
      });
      const bad = [...result.files].filter(([, s]) => s.phase !== 'ready').map(([k]) => k);
      if (bad.length) {
        patch(key, { stage: 'attention', failedKeys: bad, message: `${plural(bad.length, 'file')} did not upload or did not pass the checks.` });
        return;
      }
      const detail = await api<{ case: CaseItem }>(`/api/cases/${caseUuid}`, { signal: ctrl.signal });
      if (detail.case.checks.errors.length) {
        patch(key, { stage: 'attention', message: `The checks found ${plural(detail.case.checks.errors.length, 'problem')}. Open the case to see them.` });
        return;
      }
      patch(key, { stage: 'uploaded', serverWarnings: detail.case.checks.warnings.length, message: undefined });
      void qc.invalidateQueries({ queryKey: ['cases'] });
      void qc.invalidateQueries({ queryKey: ['case-counts'] });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'org_not_approved') setLocked(true);
      if (e instanceof ApiError && e.code === 'case_address_required') setAddressRefused(true);
      if ((e as Error).name === 'AbortError') return;
      patch(key, { stage: 'failed', message: e instanceof ApiError && e.code === 'org_not_approved' ? 'Uploads are locked until K Line approves your account.' : friendlyUploadError(e) });
    } finally {
      aborts.current.delete(key);
    }
  }

  // Start every card that has nothing to fix, two cases at a time, while the drop zone stays free for the next batch.
  useEffect(() => {
    if (blocked) return;
    const active = rows.filter((r) => BUSY.includes(r.stage)).length;
    let free = CASES_AT_ONCE - active;
    rows.forEach((r, i) => {
      if (free <= 0 || r.stage !== 'queued' || started.current.has(r.key) || analysis[i]!.problems.length) return;
      started.current.add(r.key);
      free--;
      void runCase(r.key);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, blocked, analysis]);

  // A card that was held back starts as soon as its problems are fixed. A card that failed or needs attention is started again by hand.
  function retry(r: Row) {
    started.current.add(r.key);
    void runCase(r.key, r.failedKeys);
  }

  // Name, patient ID and instruction edits reach the case while it is still a draft.
  useEffect(() => {
    for (const r of rows) {
      if (!r.caseUuid || !r.synced || (r.stage !== 'uploaded' && r.stage !== 'attention' && r.stage !== 'uploading' && r.stage !== 'checking')) continue;
      const now = { patientId: clean(r.patientId), firstName: clean(r.firstName), lastName: clean(r.lastName), instructions: r.instructions.trim() ? r.instructions.slice(0, INSTRUCTIONS_MAX) : '' };
      const was = r.synced;
      const diff: Record<string, unknown> = {};
      if (now.patientId !== was.patientId) diff.caseId = now.patientId || null;
      if (now.firstName !== was.firstName) diff.firstName = now.firstName;
      if (now.lastName !== was.lastName) diff.lastName = now.lastName;
      if (now.instructions !== was.instructions) diff.instructions = now.instructions;
      const existing = timers.current.get(r.key);
      if (existing) clearTimeout(existing);
      if (!Object.keys(diff).length || problemsOf(r).some((p) => /Patient ID|name is longer/.test(p))) continue;
      const key = r.key;
      const caseUuid = r.caseUuid;
      timers.current.set(key, setTimeout(async () => {
        timers.current.delete(key);
        try {
          await api(`/api/cases/${caseUuid}`, { method: 'PATCH', body: diff });
          patch(key, { synced: now });
        } catch (e) {
          patch(key, { nameError: e instanceof ApiError && e.code === 'case_not_open' ? 'This case was already sent, so the details cannot be changed here. Contact K Line.' : friendlyUploadError(e) });
        }
      }, 700));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => `${r.key}|${r.stage}|${r.patientId}|${r.firstName}|${r.lastName}|${r.instructions}|${r.synced?.firstName}|${r.synced?.lastName}|${r.synced?.patientId}|${r.synced?.instructions}`).join('\n')]);

  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); for (const a of aborts.current.values()) a.abort(); }, []);

  // Closing the tab while files are still going would stop the upload.
  const working = rows.some((r) => BUSY.includes(r.stage) || r.stage === 'sending');
  useEffect(() => {
    if (!working) return undefined;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [working]);

  async function remove(r: Row) {
    aborts.current.get(r.key)?.abort();
    const t = timers.current.get(r.key);
    if (t) clearTimeout(t);
    if (r.caseUuid && r.stage !== 'sent') {
      try { await api(`/api/cases/${r.caseUuid}`, { method: 'DELETE' }); void qc.invalidateQueries({ queryKey: ['cases'] }); } catch (e) {
        patch(r.key, { nameError: e instanceof ApiError ? e.message : 'The draft could not be deleted.' });
        return;
      }
    }
    started.current.delete(r.key);
    setRows((rs) => rs.filter((x) => x.key !== r.key));
  }

  const ready = rows.filter((r) => r.stage === 'uploaded');
  const sendable = ready.filter((r) => !r.serverWarnings || ack);
  const withWarnings = ready.filter((r) => r.serverWarnings).length;

  async function sendAll() {
    for (const r of sendable) patch(r.key, { stage: 'sending', message: undefined });
    for (const r of sendable) {
      // Details typed a moment ago must have arrived before the case leaves the draft state.
      const t = timers.current.get(r.key);
      if (t) { clearTimeout(t); timers.current.delete(r.key); }
      const cur = rowsRef.current.find((x) => x.key === r.key)!;
      const now = { patientId: clean(cur.patientId), firstName: clean(cur.firstName), lastName: clean(cur.lastName), instructions: cur.instructions.trim() ? cur.instructions.slice(0, INSTRUCTIONS_MAX) : '' };
      const diff: Record<string, unknown> = {};
      if (cur.synced && now.patientId !== cur.synced.patientId) diff.caseId = now.patientId || null;
      if (cur.synced && now.firstName !== cur.synced.firstName) diff.firstName = now.firstName;
      if (cur.synced && now.lastName !== cur.synced.lastName) diff.lastName = now.lastName;
      if (cur.synced && now.instructions !== cur.synced.instructions) diff.instructions = now.instructions;
      try {
        if (Object.keys(diff).length) await api(`/api/cases/${r.caseUuid}`, { method: 'PATCH', body: diff });
        const s = await submitWhenClean(r.caseUuid!, ack);
        if (s.outcome === 'submitted') patch(r.key, { stage: 'sent', synced: now });
        else if (s.outcome === 'locked') patch(r.key, { stage: 'uploaded', message: 'Sending is locked until your account is approved.' });
        else patch(r.key, { stage: 'attention', message: s.outcome === 'needs_review' ? s.reason : s.reason });
      } catch (e) {
        patch(r.key, { stage: 'attention', message: e instanceof ApiError ? e.message : 'The case could not be sent.' });
      }
    }
    void qc.invalidateQueries({ queryKey: ['cases'] });
    void qc.invalidateQueries({ queryKey: ['case-counts'] });
  }

  const totals = rows.reduce((t, r) => ({ cases: t.cases + 1, files: t.files + fileSummary(r.files).fileCount, bytes: t.bytes + fileSummary(r.files).bytes }), { cases: 0, files: 0, bytes: 0 });
  const guessed = rows.some((r) => r.guessed && !r.caseUuid);
  const hasRows = rows.length > 0;
  const finished = rows.filter((r) => r.stage === 'sent').length;

  return (
    <div className="page">
      <PageDropOverlay show={dragging} />
      <PageHeader
        title="Direct manufacturing"
        subtitle="This is how you send cases to K Line. Drop a zip file or a folder with one folder per case, as often as you like. Every drop adds to the list and starts uploading at once. The patient ID and the names are optional."
        actions={counts.data && counts.data.attention > 0 ? <Link className="btn btn-sm" to="/portal/cases?status=attention"><CircleAlert size={14} aria-hidden="true" /> {plural(counts.data.attention, 'case')} {counts.data.attention === 1 ? 'needs' : 'need'} attention</Link> : undefined}
      />

      {isLocked ? (
        <Notice tone="warn" title="Sending is locked for now" action={<Link className="btn btn-sm" to="/portal/getting-started">See what is left to do</Link>}>
          <Lock size={14} aria-hidden="true" /> K Line needs to approve your account first. You can check your folders here, but the cases cannot be uploaded yet.
        </Notice>
      ) : null}
      {needsAddress ? (
        <Notice tone="warn" title="Add your case address first" action={<Link className="btn btn-sm" to="/portal/account#case-address">Open case address</Link>}>
          K Line needs to know where to send your cases back to. Add a case address of your own in your account{can('org.edit') ? ', or one for the whole company in the company profile' : ', or ask an administrator to add the company address'}, then come back. You can check your folders here, but the cases cannot be uploaded until an address is saved.
        </Notice>
      ) : null}

      {/* Always the first thing on the page: full size while the list is empty, a single pinned row once cases are listed. */}
      <DropZone
        title={hasRows ? 'Drop more case folders or zip files anywhere on this page' : 'Drop your zip file or folder here'}
        compact={hasRows}
        pinned
        active={dragging}
        busy={false}
        onList={(l) => { void ingest(readFileList(l)); }}
      >
        {hasRows ? 'New cases are added below and start uploading at once.' : 'Each case folder holds its models, trim lines and documents. You can drop again at any time. Every drop adds to the list.'}
      </DropZone>

      {!hasRows ? <DemoSamples /> : null}
      {reading > 0 ? <Spinner label="Reading your files" /> : null}
      {notes.map((n) => <Notice key={n} tone="warn">{n}</Notice>)}
      {fatal ? <Notice tone="bad">{fatal}</Notice> : null}

      {hasRows ? (
        <div className="stack">
          {guessed ? (
            <Notice tone="info" title="Check the names">
              Where a folder name could not be split into first and last name with certainty, we made a guess. Change a name in its card if it is wrong, or use Swap names. You can also leave a name empty.
            </Notice>
          ) : null}
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>{plural(rows.length, 'case')}</h2>
            <span className="small muted">{plural(totals.files, 'file')}, {formatBytes(totals.bytes)}{finished ? `, ${finished} sent` : ''}</span>
          </div>
          {rows.map((r, i) => {
            const a = analysis[i]!;
            const busy = BUSY.includes(r.stage);
            const total = a.sum.bytes;
            const holdBack = r.stage === 'queued' && a.problems.length > 0;
            const noTrim = a.sum.modelCount > 0 && a.sum.ptsCount === 0;
            const lockedFields = r.stage === 'sending' || r.stage === 'sent';
            return (
              <article key={r.key} className={`case-card case-card-${holdBack ? 'hold' : r.stage}`} aria-label={`Case ${nameOf(r) || r.folder || 'without a name'}`}>
                <div className="case-sum">
                  <span className="id">{nameOf(r) || <span className="muted">No name</span>}</span>
                  {r.ref ? <span className="muted small">{r.ref}</span> : null}
                  <Badge tone="info">{plural(a.sum.modelCount, 'model')}</Badge>
                  <Badge tone="info">{plural(a.sum.ptsCount, 'trim line')}</Badge>
                  <Badge>{plural(a.documents, 'other document')}</Badge>
                  <Badge>{formatBytes(total)}</Badge>
                  <span className="grow" />
                  {holdBack
                    ? <Badge tone="warn"><CircleAlert size={12} aria-hidden="true" /> Needs attention</Badge>
                    : (
                      <Badge tone={tone(r.stage)}>
                        {r.stage === 'uploaded' || r.stage === 'sent' ? <CheckCircle2 size={12} aria-hidden="true" /> : r.stage === 'failed' || r.stage === 'attention' ? <CircleAlert size={12} aria-hidden="true" /> : null}
                        {STAGE_TEXT[r.stage]}
                      </Badge>
                    )}
                </div>
                <div className="small muted">From {r.folder || 'loose files'}</div>

                {busy || r.stage === 'sending' ? (
                  <div className="case-progress">
                    <ProgressBar label={`Progress for ${nameOf(r) || r.folder || 'this case'}`} value={r.stage === 'creating' || r.stage === 'sending' ? 0.02 : r.stage === 'checking' ? 1 : total ? Math.min(0.98, r.sent / total) : 0} />
                    <span className="small muted">{r.stage === 'uploading' ? `${formatBytes(r.sent)} of ${formatBytes(total)}` : r.stage === 'checking' ? 'Checking the files' : r.stage === 'sending' ? 'Sending to K Line' : 'Creating the case'}</span>
                  </div>
                ) : null}
                {r.stage === 'queued' && !holdBack ? <p className="small muted">{blocked ? 'Waiting. Uploads start once the notice above is dealt with.' : 'Waiting for its turn. Two cases upload at a time.'}</p> : null}

                {holdBack ? <ul className="problem-list">{a.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
                {r.message ? <p className={r.stage === 'failed' || r.stage === 'attention' ? 'field-error' : 'small muted'} role="status">{r.message}</p> : null}
                {noTrim && (r.stage === 'uploaded' || r.stage === 'queued' || busy) ? <p className="soft-warning">No trim lines found. K Line can still make this case, but the trim lines are normally sent too.</p> : null}
                {r.stage === 'uploaded' && r.serverWarnings ? <p className="soft-warning">The checks gave {plural(r.serverWarnings, 'warning')}. <Link to={`/portal/cases/${r.caseUuid}`}>Read {r.serverWarnings === 1 ? 'it' : 'them'}</Link> before you send.</p> : null}
                {r.instructionNote ? <p className="small muted">{r.instructionNote}</p> : null}

                <div className="form-grid case-names">
                  <Field label="Patient ID (optional)">{(p) => <input {...p} value={r.patientId} onChange={(e) => edit(r.key, { patientId: e.target.value })} maxLength={CASE_ID_MAX + 10} autoComplete="off" disabled={lockedFields} />}</Field>
                  <Field label="First name (optional)">{(p) => <input {...p} value={r.firstName} onChange={(e) => edit(r.key, { firstName: e.target.value, guessed: false })} maxLength={NAME_MAX + 20} autoComplete="off" disabled={lockedFields} />}</Field>
                  <Field label="Last name (optional)">{(p) => <input {...p} value={r.lastName} onChange={(e) => edit(r.key, { lastName: e.target.value, guessed: false })} maxLength={NAME_MAX + 20} autoComplete="off" disabled={lockedFields} />}</Field>
                </div>
                {r.nameError ? <p className="field-error" role="alert">{r.nameError}</p> : null}

                <div className="row case-actions">
                  <Button size="sm" disabled={lockedFields} onClick={() => edit(r.key, { ...swapNames(r), guessed: false })}><ArrowLeftRight size={14} aria-hidden="true" /> Swap names</Button>
                  {r.caseUuid && (r.stage === 'uploaded' || r.stage === 'sent' || r.stage === 'attention') ? <AddDocuments caseId={r.caseUuid} status={r.stage === 'sent' ? 'submitted' : 'draft'} /> : null}
                  {r.stage === 'attention' || r.stage === 'failed' ? <Button size="sm" onClick={() => retry(r)}><RefreshCw size={14} aria-hidden="true" /> Try again</Button> : null}
                  {r.caseUuid ? <Link className="btn btn-sm" to={`/portal/cases/${r.caseUuid}`}>Open the case</Link> : null}
                  {r.stage !== 'sent' && r.stage !== 'sending' ? <Button size="sm" onClick={() => { void remove(r); }}><Trash2 size={14} aria-hidden="true" /> {r.caseUuid ? 'Delete this draft' : 'Remove from this list'}</Button> : null}
                </div>

                <details className="case-more" open={holdBack || undefined}>
                  <summary>Files and instructions</summary>
                  <div className="stack">
                    <Field label="Instructions (optional)" hint={r.instructionNote ?? `${formatNumber(r.instructions.length)} of ${formatNumber(INSTRUCTIONS_MAX)} characters. Read from any text or Word file in the folder.`}>
                      {(p) => <textarea {...p} value={r.instructions} maxLength={INSTRUCTIONS_MAX} onChange={(e) => edit(r.key, { instructions: e.target.value })} rows={3} disabled={lockedFields} />}
                    </Field>
                    <FileMapTable idPrefix={`b-${i}`} files={r.files} readOnly={!!r.caseUuid || lockedFields} onChange={(files) => patch(r.key, { files })} />
                    {r.caseUuid ? <p className="small muted">The files are already uploaded. Use Add documents to send more.</p> : null}
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      ) : null}

      {hasRows ? (
        <div className="send-bar" role="region" aria-label="Send to K Line">
          <div className="send-bar-text">
            <strong>{ready.length ? `${plural(ready.length, 'case')} uploaded and ready to send` : working ? 'Uploading. You can keep dropping more cases.' : finished === rows.length ? 'All cases were sent to K Line.' : 'Nothing is ready to send yet.'}</strong>
            {withWarnings ? <Toggle checked={ack} onChange={setAck} label={`Also send the ${plural(withWarnings, 'case')} with warnings`} hint="You confirm you have read the warnings. Your confirmation is stored with each case." /> : <span className="small muted">Check the names, then send. A case stays a draft until you do.</span>}
          </div>
          <Button variant="primary" disabled={sendable.length === 0 || blocked} onClick={() => { void sendAll(); }}>Send {plural(sendable.length, 'case')} to K Line</Button>
        </div>
      ) : null}
    </div>
  );
}
