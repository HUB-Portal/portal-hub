import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Upload } from 'lucide-react';
import { api, errorText, qs } from '../../lib/api';
import { formatDateTime, formatNumber, humanise } from '../../lib/format';
import { STAGE_CODE_RE } from '@shared/stages';
import { MAP_TARGETS } from '../../lib/stages';
import { Badge, Button, Card, Empty, Field, Notice, PageHeader, Pagination, Spinner } from '../../ui/Common';

type MesTab = 'map' | 'events' | 'import';
const TABS: { id: MesTab; label: string }[] = [
  { id: 'map', label: 'Stage map' },
  { id: 'events', label: 'Event log' },
  { id: 'import', label: 'Import events' },
];

export default function Mes() {
  const [tab, setTab] = useState<MesTab>('map');
  return (
    <div className="page">
      <PageHeader title="MES integration" subtitle="How the factory system talks to the Portal Hub." />
      <div className="tabs" role="group" aria-label="MES sections">
        {TABS.map((t) => <button key={t.id} type="button" className="tab" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      {tab === 'map' ? <StageMap /> : null}
      {tab === 'events' ? <EventLog /> : null}
      {tab === 'import' ? <ImportEvents /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ stage map

interface MapRow { code: string; target: string; note: string }

function StageMap() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['mes-stage-map'], queryFn: () => api<{ items: { code: string; target: string; note?: string | null }[] }>('/api/mes/stage-map') });
  const [rows, setRows] = useState<MapRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (q.data) { setRows(q.data.items.map((r) => ({ code: r.code, target: r.target, note: r.note ?? '' }))); setDirty(false); }
  }, [q.data]);

  const codes = rows.map((r) => r.code.trim().toUpperCase());
  const problems = rows.map((r, i) => {
    const c = r.code.trim().toUpperCase();
    if (!c) return 'Enter a code.';
    if (!STAGE_CODE_RE.test(c)) return 'Use capital letters, numbers, dots, dashes and underscores.';
    if (codes.indexOf(c) !== i) return 'This code is used twice.';
    if (!r.target) return 'Choose what it does.';
    return null;
  });
  const valid = rows.length > 0 && problems.every((p) => !p);

  const save = useMutation({
    mutationFn: () => api('/api/mes/stage-map', { method: 'PUT', body: { items: rows.map((r) => ({ code: r.code.trim().toUpperCase(), target: r.target, note: r.note.trim() })) } }),
    onSuccess: () => { setMsg({ tone: 'good', text: 'Stage map saved. The factory system uses it from now on.' }); setDirty(false); qc.invalidateQueries({ queryKey: ['mes-stage-map'] }); },
    onError: (e) => setMsg({ tone: 'bad', text: errorText(e) }),
  });

  function update(i: number, patch: Partial<MapRow>) { setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r))); setDirty(true); setMsg(null); }

  return (
    <Card title="Stage map" actions={<Button size="sm" onClick={() => { setRows([...rows, { code: '', target: '', note: '' }]); setDirty(true); }}><Plus size={14} aria-hidden="true" /> Add a code</Button>}>
      <p className="muted small">The factory system sends its own stage codes. This table says what each code means here. Unknown codes are logged as errors.</p>
      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      {q.data ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Factory code</th><th>Means</th><th>Note</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ minWidth: 150 }}>
                      <input aria-label={`Factory code, row ${i + 1}`} value={r.code} onChange={(e) => update(i, { code: e.target.value.toUpperCase() })} maxLength={40} autoComplete="off" aria-invalid={!!problems[i] && r.code !== '' ? true : undefined} />
                      {problems[i] && r.code !== '' ? <div className="field-error">{problems[i]}</div> : null}
                    </td>
                    <td style={{ minWidth: 200 }}>
                      <select aria-label={`Meaning, row ${i + 1}`} value={r.target} onChange={(e) => update(i, { target: e.target.value })}>
                        <option value="">Choose</option>
                        {MAP_TARGETS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                    </td>
                    <td style={{ minWidth: 180 }}><input aria-label={`Note, row ${i + 1}`} value={r.note} onChange={(e) => update(i, { note: e.target.value })} maxLength={200} /></td>
                    <td className="right"><Button size="sm" onClick={() => { setRows(rows.filter((_x, n) => n !== i)); setDirty(true); }} aria-label={`Remove code ${r.code || i + 1}`}><Trash2 size={14} aria-hidden="true" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <Button variant="primary" loading={save.isPending} disabled={!valid || !dirty} onClick={() => save.mutate()}>Save stage map</Button>
            {dirty ? <Button onClick={() => { if (q.data) setRows(q.data.items.map((r) => ({ code: r.code, target: r.target, note: r.note ?? '' }))); setDirty(false); setMsg(null); }}>Discard changes</Button> : null}
          </div>
        </>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------ event log

export const OUTCOMES: Record<string, { label: string; tone: 'good' | 'neutral' | 'bad' | 'info' }> = {
  applied: { label: 'Applied', tone: 'good' },
  ignored: { label: 'Ignored', tone: 'neutral' },
  error: { label: 'Error', tone: 'bad' },
  duplicate: { label: 'Duplicate', tone: 'info' },
};

interface MesEvent {
  id: string;
  eventId: string | null;
  caseRef: string | null;
  stageCode: string | null;
  outcome: string;
  message: string | null;
  source: string | null;
  occurredAt: string | null;
  receivedAt: string;
}

const SOURCE_LABEL: Record<string, string> = { mes: 'Factory system', csv: 'CSV import' };

function EventLog() {
  const [outcome, setOutcome] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['mes-events', outcome, page],
    queryFn: () => api<{ items: MesEvent[]; total: number; page: number; pageSize: number }>(`/api/mes/events${qs({ outcome, page })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <Card title="Event log">
      <div className="toolbar">
        <div className="field" style={{ maxWidth: 240 }}>
          <label htmlFor="mes-outcome">Outcome</label>
          <select id="mes-outcome" value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(1); }}>
            <option value="">All outcomes</option>
            {Object.entries(OUTCOMES).map(([id, o]) => <option key={id} value={id}>{o.label}</option>)}
          </select>
        </div>
        <Button onClick={() => q.refetch()} loading={q.isFetching && !q.isLoading}>Refresh</Button>
      </div>
      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
      {q.data && q.data.items.length === 0 ? <Empty title="No events">{outcome ? 'No events with this outcome.' : 'Events from the factory system appear here.'}</Empty> : null}
      {q.data && q.data.items.length ? (
        <>
          <p className="muted small" role="status">{formatNumber(q.data.total)} {q.data.total === 1 ? 'event' : 'events'}</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Received</th><th>Event ID</th><th>Case</th><th>Code</th><th>Outcome</th><th>Message</th></tr></thead>
              <tbody>
                {q.data.items.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{formatDateTime(e.receivedAt)}{e.occurredAt ? <div className="muted small">Happened {formatDateTime(e.occurredAt)}</div> : null}</td>
                    <td className="mono small" style={{ overflowWrap: 'anywhere' }}>{e.eventId ?? ''}</td>
                    <td className="nowrap">{e.caseRef ?? <span className="muted">Unknown</span>}</td>
                    <td className="mono">{e.stageCode ?? ''}</td>
                    <td><Badge tone={OUTCOMES[e.outcome]?.tone ?? 'neutral'}>{OUTCOMES[e.outcome]?.label ?? humanise(e.outcome)}</Badge></td>
                    <td>{e.message ?? ''}{e.source ? <div className="muted small">{SOURCE_LABEL[e.source] ?? humanise(e.source)}</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
        </>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------ CSV import

const IMPORT_COLUMNS = 'event_id,case_ref,partner_code,partner_case_id,mes_case_id,stage_code,occurred_at,carrier,tracking_number,aligners_shipped,hold_reason';
const MAX_CSV = 5 * 1024 * 1024;

interface ImportRowResult { row: number; event_id: string | null; outcome: string; message?: string | null }
interface ImportResponse { summary: { total: number; applied: number; ignored: number; error: number; duplicate: number }; results: ImportRowResult[] }

function ImportEvents() {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const m = useMutation({
    mutationFn: () => api<ImportResponse>('/api/mes/events/import', { method: 'POST', body: { csv: text } }),
    onSuccess: (r) => { setResult(r); setError(null); qc.invalidateQueries({ queryKey: ['mes-events'] }); qc.invalidateQueries({ queryKey: ['console-overview'] }); },
    onError: (e) => { setResult(null); setError(errorText(e)); },
  });

  async function pick(f: File | undefined) {
    if (!f) return;
    setReadError(null);
    if (f.size > MAX_CSV) { setReadError('This file is larger than 5 MB. Split it into smaller files.'); return; }
    setText(await f.text());
    setFileName(f.name);
    setResult(null);
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  const counts = (result?.results ?? []).reduce<Record<string, number>>((a, r) => { a[r.outcome] = (a[r.outcome] ?? 0) + 1; return a; }, {});

  return (
    <Card title="Import events from a CSV file">
      <p className="muted small">Use this when the factory system could not send events itself. Each row is applied like a live event. Rows that were already imported are marked as duplicates.</p>
      <p className="small">Columns, in any order, with a header row:</p>
      <p className="mono small" style={{ overflowWrap: 'anywhere' }}>{IMPORT_COLUMNS}</p>
      <p className="small muted">A row needs a stage_code, occurred_at, and one way to find the case: case_ref, mes_case_id, or partner_code with partner_case_id. A blank event_id is made up from the row, so importing the same file twice does not count events twice. Shipped rows also need carrier, tracking_number and aligners_shipped. Hold rows need hold_reason.</p>
      {readError ? <Notice tone="bad">{readError}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="row">
        <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" hidden aria-label="Choose a CSV file" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        <Button onClick={() => fileRef.current?.click()}><Upload size={16} aria-hidden="true" /> Choose a CSV file</Button>
        {fileName ? <span className="muted small">{fileName}</span> : null}
      </div>
      <Field label="Or paste the CSV here" hint={lines ? `${formatNumber(Math.max(0, lines - 1))} data rows` : undefined}>
        {(p) => <textarea {...p} className="textarea-mono" rows={8} value={text} onChange={(e) => { setText(e.target.value); setFileName(null); setResult(null); }} spellCheck={false} placeholder={IMPORT_COLUMNS} />}
      </Field>
      <div className="row">
        <Button variant="primary" loading={m.isPending} disabled={lines < 2} onClick={() => { setError(null); m.mutate(); }}>Import</Button>
        {text ? <Button onClick={() => { setText(''); setFileName(null); setResult(null); setError(null); }}>Clear</Button> : null}
      </div>
      {result ? (
        <div className="stack" aria-live="polite">
          <div className="row">
            <strong>Result</strong>
            {Object.entries(counts).map(([o, n]) => <Badge key={o} tone={OUTCOMES[o]?.tone ?? 'neutral'}>{OUTCOMES[o]?.label ?? humanise(o)}: {formatNumber(n)}</Badge>)}
          </div>
          <div className="table-wrap result-scroll">
            <table className="table">
              <thead><tr><th className="num">Row</th><th>Event ID</th><th>Outcome</th><th>Message</th></tr></thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.row}>
                    <td className="num">{formatNumber(r.row)}</td>
                    <td className="mono small" style={{ overflowWrap: 'anywhere' }}>{r.event_id ?? ''}</td>
                    <td><Badge tone={OUTCOMES[r.outcome]?.tone ?? 'neutral'}>{OUTCOMES[r.outcome]?.label ?? humanise(r.outcome)}</Badge></td>
                    <td>{r.message ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
