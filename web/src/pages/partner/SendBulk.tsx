import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, CheckCircle2, CircleAlert, Lock, Trash2 } from 'lucide-react';
import { buildBulkCases, NAME_MAX, swapNames, validateBulkCase } from '@shared/bulk';
import { api, ApiError } from '../../lib/api';
import { formatBytes, formatNumber, plural } from '../../lib/format';
import { INSTRUCTIONS_MAX } from '../../lib/instructions';
import { readDrop, readFileList, type IntakeResult } from '../../lib/intake';
import { activeFiles, fileSummary, mappingProblems, readInstructionsFor, sourceMapOf, toSpecs, type MapFile, type SourceMap } from '../../lib/review';
import { CASES_AT_ONCE, friendlyUploadError, pool, submitWhenClean, uploadCaseFiles, type FileStatus } from '../../lib/upload';
import type { OrgInfo } from '../../lib/types';
import { Badge, Button, Card, Field, Notice, PageHeader, ProgressBar, Spinner, Toggle } from '../../ui/Common';
import { DemoSamples } from '../../ui/DemoSamples';
import { AddMoreButtons, DropZone } from '../../ui/DropZone';
import { FileMapTable } from '../../ui/FileMapTable';
import { useBrands } from '../../lib/brands';
import { useProfile, useUserCaseAddress } from '../../lib/orgApi';
import { useAuth } from '../../lib/auth';

interface Row {
  key: string;
  folder: string;
  firstName: string;
  lastName: string;
  needsReview: boolean;
  files: MapFile[];
  instructions: string;
  instructionNote: string | null;
}

type Stage = 'waiting' | 'creating' | 'uploading' | 'checking' | 'submitted' | 'needs_review' | 'failed';
interface RunState { stage: Stage; caseUuid?: string; sent: number; total: number; message?: string }

const STAGE_TEXT: Record<Stage, string> = {
  waiting: 'Waiting', creating: 'Creating the case', uploading: 'Uploading', checking: 'Checking files', submitted: 'Submitted',
  needs_review: 'Saved as a draft. Needs your review', failed: 'Failed',
};

/** The brand and auto-submit options are hidden for now. The defaults apply: no brand, submit when all checks pass, warnings stay as drafts. */
const SHOW_BATCH_OPTIONS = false;

const ENTRY_ERRORS: Record<string, string> = {
  invalid_request: 'The details for this case were not accepted. Check the names.',
};

export default function SendBulk() {
  const nav = useNavigate();
  const org = useQuery({ queryKey: ['org'], queryFn: () => api<OrgInfo>('/api/org'), retry: false });
  const brands = useBrands();
  const profile = useProfile();
  const myAddress = useUserCaseAddress();
  const { can } = useAuth();
  const [addressRefused, setAddressRefused] = useState(false);
  const [phase, setPhase] = useState<'pick' | 'reading' | 'review' | 'running' | 'done'>('pick');
  const [rows, setRows] = useState<Row[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const addCount = useRef(0);
  const sources = useRef<SourceMap>(new Map());
  const [brandId, setBrandId] = useState('');
  const [auto, setAuto] = useState(true);
  const [ack, setAck] = useState(false);
  const [run, setRun] = useState<Record<string, RunState>>({});
  const [batchId, setBatchId] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const isLocked = locked || (org.data ? !org.data.uploadsUnlocked : false);
  // Direct manufacturing needs a case address: the sender's own when complete, otherwise the company's. The server also refuses (case_address_required), so the notice shows either way.
  const needsAddress = addressRefused || (myAddress.data ? myAddress.data.effective === 'none' : profile.data?.caseAddressComplete === false);

  /** `append` adds to the cases already on screen instead of replacing them. */
  async function ingest(read: Promise<IntakeResult>, append = false) {
    if (append) setAdding(true); else setPhase('reading');
    setFatal(null);
    try {
      const r = await read;
      const msgs = [...r.notes];
      let files = r.files;
      if (append) {
        // The same file picked twice is skipped. A different file under the same path goes in as its own group so nothing is overwritten.
        const fresh = files.filter((f) => sources.current.get(f.path)?.size !== f.size);
        if (fresh.length < files.length) msgs.push(`${plural(files.length - fresh.length, 'file')} already in this batch ${files.length - fresh.length === 1 ? 'was' : 'were'} skipped.`);
        files = fresh;
        if (files.some((f) => sources.current.has(f.path))) {
          addCount.current += 1;
          const prefix = `Added ${addCount.current}/`;
          files = files.map((f) => ({ ...f, path: `${prefix}${f.path}` }));
        }
      }
      if (!files.length) {
        if (append) setNotes(msgs.length ? msgs : ['No new files were found.']);
        else { setPhase('pick'); setNotes(msgs.length ? msgs : ['No files were found. Try dropping a zip file or a folder.']); }
        return;
      }
      setNotes(msgs);
      const merged: SourceMap = append ? new Map(sources.current) : new Map();
      for (const f of files) merged.set(f.path, f.source);
      sources.current = merged;
      const built = buildBulkCases(files.map((f) => ({ path: f.path, size: f.size })));
      const taken = new Set(append ? rows.map((x) => x.key) : []);
      const list: Row[] = await Promise.all(built.map(async (b) => {
        const t = await readInstructionsFor(b.files as MapFile[], sources.current);
        let key = b.key;
        for (let n = 2; taken.has(key); n++) key = `${b.key} (added ${n})`;
        taken.add(key);
        return {
          key, folder: b.folder, firstName: b.firstName, lastName: b.lastName, needsReview: b.needsReview,
          files: b.files.map((f) => ({ ...f })) as MapFile[], instructions: t.text, instructionNote: t.message,
        };
      }));
      setRows((rs) => (append ? [...rs, ...list] : list));
      setPhase('review');
    } finally {
      setAdding(false);
    }
  }

  const update = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const analysis = useMemo(() => {
    return rows.map((r) => {
      const act = activeFiles(r.files);
      const problems = [...validateBulkCase({ firstName: r.firstName, lastName: r.lastName, files: act })];
      if (act.length && act.filter((f) => f.kind === 'stl').length === 0) problems.push('No 3D models (STL) found.');
      problems.push(...mappingProblems(r.files));
      const sum = fileSummary(r.files);
      const documents = act.filter((f) => f.kind !== 'stl' && f.kind !== 'pts');
      return { problems, sum, documents: documents.length };
    });
  }, [rows]);

  const withProblems = analysis.filter((a) => a.problems.length > 0).length;
  const totals = analysis.reduce((t, a) => ({ files: t.files + a.sum.fileCount, bytes: t.bytes + a.sum.bytes }), { files: 0, bytes: 0 });

  async function start() {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setFatal(null);
    setPhase('running');
    const initial: Record<string, RunState> = {};
    rows.forEach((r, i) => { initial[r.key] = { stage: 'waiting', sent: 0, total: analysis[i]!.sum.bytes }; });
    setRun(initial);
    const patch = (key: string, p: Partial<RunState>) => setRun((s) => ({ ...s, [key]: { ...s[key]!, ...p } }));

    let created: { batchId: string; cases: { key: string; id?: string; error?: string }[] };
    try {
      for (const r of rows) patch(r.key, { stage: 'creating' });
      created = await api('/api/bulk/batches', {
        method: 'POST',
        signal: ctrl.signal,
        body: {
          cases: rows.map((r) => ({
            key: r.key, firstName: r.firstName.trim(), lastName: r.lastName.trim(),
            ...(r.instructions.trim() ? { instructions: r.instructions.slice(0, INSTRUCTIONS_MAX) } : {}),
          })),
          ...(brandId ? { brandId } : {}),
        },
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'org_not_approved') setLocked(true);
      if (e instanceof ApiError && e.code === 'case_address_required') setAddressRefused(true);
      setFatal(e instanceof ApiError && e.code === 'org_not_approved' ? 'Uploads are locked until K Line approves your account.' : friendlyUploadError(e));
      setPhase('review');
      return;
    }
    setBatchId(created.batchId);
    const byKey = new Map(created.cases.map((c) => [c.key, c]));
    const todo = rows.filter((r) => {
      const c = byKey.get(r.key);
      if (!c?.id) { patch(r.key, { stage: 'failed', message: ENTRY_ERRORS[c?.error ?? ''] ?? 'This case could not be created.' }); return false; }
      patch(r.key, { caseUuid: c.id, stage: 'uploading' });
      return true;
    });

    await pool(todo, CASES_AT_ONCE, async (r) => {
      const caseUuid = byKey.get(r.key)!.id!;
      try {
        const { specs } = toSpecs(r.files, sources.current);
        if (!specs.length) { patch(r.key, { stage: 'needs_review', message: 'No files could be read.' }); return; }
        const statuses = new Map<string, FileStatus>();
        const result = await uploadCaseFiles(caseUuid, specs, {
          signal: ctrl.signal,
          onFile: (k, s) => {
            statuses.set(k, s);
            let sent = 0;
            let processing = false;
            for (const v of statuses.values()) { sent += v.sent; if (v.phase === 'processing') processing = true; }
            patch(r.key, { sent, stage: processing ? 'checking' : 'uploading' });
          },
        });
        if (!result.ok) {
          const bad = [...result.files.values()].filter((s) => s.phase !== 'ready').length;
          patch(r.key, { stage: 'needs_review', message: `${plural(bad, 'file')} did not upload or did not pass the checks.` });
          return;
        }
        if (!auto) { patch(r.key, { stage: 'needs_review', message: 'Saved as a draft, as you asked.' }); return; }
        const s = await submitWhenClean(caseUuid, ack, ctrl.signal);
        if (s.outcome === 'submitted') patch(r.key, { stage: 'submitted' });
        else if (s.outcome === 'needs_review') patch(r.key, { stage: 'needs_review', message: s.reason });
        else if (s.outcome === 'locked') patch(r.key, { stage: 'needs_review', message: 'Submitting is locked until your account is approved.' });
        else patch(r.key, { stage: 'failed', message: s.reason });
      } catch (e) {
        patch(r.key, { stage: 'failed', message: (e as Error).name === 'AbortError' ? 'Stopped.' : friendlyUploadError(e) });
      }
    });
    setPhase('done');
  }

  function reset() { addCount.current = 0; setRows([]); setRun({}); setNotes([]); setBatchId(null); sources.current = new Map(); setPhase('pick'); }

  return (
    <div className="page">
      <PageHeader title="Direct manufacturing" subtitle="This is how you send cases to K Line. Drop one zip file or folder with one folder per case, named with the patient's first and last name, for example Marc Alonso. You check every case before anything is sent." />

      {isLocked ? (
        <Notice tone="warn" title="Sending is locked for now" action={<Link className="btn btn-sm" to="/portal/getting-started">See what is left to do</Link>}>
          <Lock size={14} aria-hidden="true" /> K Line needs to approve your account first. You can check your folders here, but the cases cannot be sent yet.
        </Notice>
      ) : null}
      {needsAddress ? (
        <Notice tone="warn" title="Add your case address first" action={<Link className="btn btn-sm" to="/portal/account#case-address">Open case address</Link>}>
          K Line needs to know where to send your cases back to. Add a case address of your own in your account{can('org.edit') ? ', or one for the whole company in the company profile' : ', or ask an administrator to add the company address'}, then come back. You can check your folders here, but the cases cannot be sent until an address is saved.
        </Notice>
      ) : null}

      {phase === 'pick' || phase === 'reading' ? (
        <>
          <DemoSamples />
          <DropZone title="Drop your zip file or folder here" busy={phase === 'reading'} onSnapshot={(s) => { void ingest(readDrop(s)); }} onList={(l) => { void ingest(readFileList(l)); }}>
            Each case folder holds its models, trim lines and documents. You will check every patient name on the next screen.
          </DropZone>
          {phase === 'reading' ? <Spinner label="Reading your files" /> : null}
          {notes.map((n) => <Notice key={n} tone="warn">{n}</Notice>)}
        </>
      ) : null}

      {phase === 'review' ? (
        <>
          {fatal ? <Notice tone="bad">{fatal}</Notice> : null}
          {notes.map((n) => <Notice key={n} tone="warn">{n}</Notice>)}
          <Notice tone="info" title="Check the names">
            First name and last name are needed for every case. Name order differs between clinics, so please check each one. Use Swap names if first and last are the wrong way round.
          </Notice>

          {SHOW_BATCH_OPTIONS ? (
          <Card title="Options for this batch">
            <div className="form-grid">
              {brands.data && brands.data.length ? (
                <Field label="Brand">
                  {(p) => <select {...p} value={brandId} onChange={(e) => setBrandId(e.target.value)}><option value="">No brand</option>{brands.data!.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
                </Field>
              ) : null}
            </div>
            <Toggle checked={auto} onChange={setAuto} label="Submit automatically when all checks pass" hint="Cases with errors stay as drafts so you can review them." />
            {auto ? <Toggle checked={ack} onChange={setAck} label="Also submit cases that only have warnings" hint="You confirm you have read the warnings. Your confirmation is stored with each case." /> : null}
          </Card>
          ) : null}

          <div className="stack">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>{plural(rows.length, 'case')} found</h2>
              <AddMoreButtons busy={adding} onList={(l) => { void ingest(readFileList(l), true); }} />
            </div>
            {adding ? <Spinner label="Reading your files" /> : null}
            {rows.map((r, i) => {
              const a = analysis[i]!;
              const bad = a.problems.length > 0;
              return (
                <details key={r.key} className="case-row" open={bad || r.needsReview || undefined} style={bad ? { borderColor: 'var(--bad)' } : undefined}>
                  <summary>
                    <div className="case-sum">
                      <span className="id">{[r.firstName, r.lastName].filter(Boolean).join(' ') || 'No name'}</span>
                      {r.needsReview ? <Badge tone="warn">Check the names</Badge> : null}
                      <Badge tone="info">{plural(a.sum.modelCount, 'model')}</Badge>
                      <Badge tone="info">{plural(a.sum.ptsCount, 'trim line')}</Badge>
                      <Badge>{plural(a.documents, 'other document')}</Badge>
                      <Badge>{formatBytes(a.sum.bytes)}</Badge>
                      {bad ? <Badge tone="bad">{plural(a.problems.length, 'problem')}</Badge> : <Badge tone="good">Ready</Badge>}
                    </div>
                    <div className="small muted">From {r.folder || 'loose files'}</div>
                  </summary>
                  <div className="case-body">
                    {bad ? <ul className="problem-list">{a.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
                    <div className="form-grid">
                      <Field label="First name">{(p) => <input {...p} value={r.firstName} onChange={(e) => update(r.key, { firstName: e.target.value, needsReview: false })} maxLength={NAME_MAX + 20} autoComplete="off" required />}</Field>
                      <Field label="Last name">{(p) => <input {...p} value={r.lastName} onChange={(e) => update(r.key, { lastName: e.target.value, needsReview: false })} maxLength={NAME_MAX + 20} autoComplete="off" required />}</Field>
                    </div>
                    <div className="row">
                      <Button size="sm" onClick={() => update(r.key, { ...swapNames(r), needsReview: false })}><ArrowLeftRight size={14} aria-hidden="true" /> Swap names</Button>
                      <Button size="sm" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 size={14} aria-hidden="true" /> Remove from this batch</Button>
                    </div>
                    <Field label="Instructions (optional)" hint={r.instructionNote ?? `${formatNumber(r.instructions.length)} of ${formatNumber(INSTRUCTIONS_MAX)} characters. Read from any text or Word file in the folder.`}>
                      {(p) => <textarea {...p} value={r.instructions} maxLength={INSTRUCTIONS_MAX} onChange={(e) => update(r.key, { instructions: e.target.value })} rows={3} />}
                    </Field>
                    <FileMapTable idPrefix={`b-${i}`} files={r.files} onChange={(files) => update(r.key, { files })} />
                  </div>
                </details>
              );
            })}
          </div>

          <Card>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>{plural(rows.length, 'case')}, {plural(totals.files, 'file')}, {formatBytes(totals.bytes)}</strong>
                {withProblems ? <div className="field-error">{plural(withProblems, 'case')} still {withProblems === 1 ? 'has' : 'have'} problems. Fix them or remove them to upload.</div> : null}
              </div>
              <div className="row">
                <Button onClick={reset}>Start again</Button>
                <Button variant="primary" disabled={rows.length === 0 || withProblems > 0 || isLocked || needsAddress} onClick={() => { void start(); }}>Upload {plural(rows.length, 'case')}</Button>
              </div>
            </div>
          </Card>
        </>
      ) : null}

      {phase === 'running' || phase === 'done' ? (
        <Card title={phase === 'running' ? 'Sending your cases' : 'Finished'} actions={phase === 'running' ? <Button size="sm" onClick={() => abort.current?.abort()}>Stop</Button> : null}>
          {phase === 'running' ? <Notice tone="info">Keep this page open until it finishes. Submitted cases are then sent on to the K Line customer portal.</Notice> : null}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Patient</th><th>Progress</th><th>Result</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const s = run[r.key];
                  if (!s) return null;
                  const active = s.stage === 'uploading' || s.stage === 'checking' || s.stage === 'creating';
                  return (
                    <tr key={r.key}>
                      <td><strong>{[r.firstName, r.lastName].filter(Boolean).join(' ')}</strong>{s.caseUuid ? <div className="small"><Link to={`/portal/cases/${s.caseUuid}`}>Open the case</Link></div> : null}</td>
                      <td style={{ minWidth: 160 }}>
                        <ProgressBar label={`Progress for ${[r.firstName, r.lastName].filter(Boolean).join(' ')}`} value={s.stage === 'waiting' || s.stage === 'creating' ? 0 : s.total ? (s.stage === 'uploading' ? s.sent / s.total : 1) : 1} />
                        {active && s.stage !== 'creating' ? <div className="small muted">{formatBytes(s.sent)} of {formatBytes(s.total)}</div> : null}
                      </td>
                      <td>
                        <Badge tone={s.stage === 'submitted' ? 'good' : s.stage === 'failed' ? 'bad' : s.stage === 'needs_review' ? 'warn' : 'info'}>
                          {s.stage === 'submitted' ? <CheckCircle2 size={12} aria-hidden="true" /> : s.stage === 'failed' || s.stage === 'needs_review' ? <CircleAlert size={12} aria-hidden="true" /> : null}
                          {STAGE_TEXT[s.stage]}
                        </Badge>
                        {s.message ? <div className="small muted" style={{ marginTop: 4 }}>{s.message}</div> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {phase === 'done' ? (
            <div className="row">
              {batchId ? <Button variant="primary" onClick={() => nav(`/portal/send/bulk/batch/${batchId}`)}>See the batch result</Button> : null}
              <Button onClick={reset}>Send another batch</Button>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
