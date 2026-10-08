import { createEffect, createMemo, createSignal, For, Index, Show } from 'solid-js';
import { createMutation, createQuery, keepPreviousData, useQueryClient } from '@tanstack/solid-query';
import { Plus, Trash2, Upload } from 'lucide-solid';
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
  const [tab, setTab] = createSignal<MesTab>('map');
  return (
    <div class="page">
      <PageHeader title="MES integration" subtitle="How the factory system talks to the Portal Hub." />
      <div class="tabs" role="group" aria-label="MES sections">
        <For each={TABS}>{(t) => <button type="button" class="tab" aria-pressed={tab() === t.id} onClick={() => setTab(t.id)}>{t.label}</button>}</For>
      </div>
      <Show when={tab() === 'map'}><StageMap /></Show>
      <Show when={tab() === 'events'}><EventLog /></Show>
      <Show when={tab() === 'import'}><ImportEvents /></Show>
    </div>
  );
}

// ------------------------------------------------------------------ stage map

interface MapRow { code: string; target: string; note: string }

function StageMap() {
  const qc = useQueryClient();
  const q = createQuery(() => ({ queryKey: ['mes-stage-map'], queryFn: () => api<{ items: { code: string; target: string; note?: string | null }[] }>('/api/mes/stage-map') }));
  const [rows, setRows] = createSignal<MapRow[]>([]);
  const [dirty, setDirty] = createSignal(false);
  const [msg, setMsg] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);

  createEffect(() => {
    const d = q.data;
    if (d) { setRows(d.items.map((r) => ({ code: r.code, target: r.target, note: r.note ?? '' }))); setDirty(false); }
  });

  const codes = createMemo(() => rows().map((r) => r.code.trim().toUpperCase()));
  const problems = createMemo(() => rows().map((r, i) => {
    const c = r.code.trim().toUpperCase();
    if (!c) return 'Enter a code.';
    if (!STAGE_CODE_RE.test(c)) return 'Use capital letters, numbers, dots, dashes and underscores.';
    if (codes().indexOf(c) !== i) return 'This code is used twice.';
    if (!r.target) return 'Choose what it does.';
    return null;
  }));
  const valid = () => rows().length > 0 && problems().every((p) => !p);

  const save = createMutation(() => ({
    mutationFn: () => api('/api/mes/stage-map', { method: 'PUT', body: { items: rows().map((r) => ({ code: r.code.trim().toUpperCase(), target: r.target, note: r.note.trim() })) } }),
    onSuccess: () => { setMsg({ tone: 'good', text: 'Stage map saved. The factory system uses it from now on.' }); setDirty(false); qc.invalidateQueries({ queryKey: ['mes-stage-map'] }); },
    onError: (e: unknown) => setMsg({ tone: 'bad', text: errorText(e) }),
  }));

  function update(i: number, patch: Partial<MapRow>) { setRows(rows().map((r, n) => (n === i ? { ...r, ...patch } : r))); setDirty(true); setMsg(null); }

  return (
    <Card title="Stage map" actions={<Button size="sm" onClick={() => { setRows([...rows(), { code: '', target: '', note: '' }]); setDirty(true); }}><Plus size={14} aria-hidden="true" /> Add a code</Button>}>
      <p class="muted small">The factory system sends its own stage codes. This table says what each code means here. Unknown codes are logged as errors.</p>
      <Show when={q.isLoading}><Spinner /></Show>
      <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
      <Show when={msg()}>{(m) => <Notice tone={m().tone}>{m().text}</Notice>}</Show>
      <Show when={q.data}>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Factory code</th><th>Means</th><th>Note</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              <Index each={rows()}>
                {(r, i) => (
                  <tr>
                    <td style={{ 'min-width': '150px' }}>
                      <input aria-label={`Factory code, row ${i + 1}`} value={r().code} onInput={(e) => update(i, { code: e.currentTarget.value.toUpperCase() })} maxLength={40} autocomplete="off" aria-invalid={!!problems()[i] && r().code !== '' ? true : undefined} />
                      {problems()[i] && r().code !== '' ? <div class="field-error">{problems()[i]}</div> : null}
                    </td>
                    <td style={{ 'min-width': '200px' }}>
                      <select aria-label={`Meaning, row ${i + 1}`} value={r().target} onChange={(e) => update(i, { target: e.currentTarget.value })}>
                        <option value="" selected={r().target === ''}>Choose</option>
                        <For each={MAP_TARGETS}>{(t) => <option value={t.id} selected={t.id === r().target}>{t.label}</option>}</For>
                      </select>
                    </td>
                    <td style={{ 'min-width': '180px' }}><input aria-label={`Note, row ${i + 1}`} value={r().note} onInput={(e) => update(i, { note: e.currentTarget.value })} maxLength={200} /></td>
                    <td class="right"><Button size="sm" onClick={() => { setRows(rows().filter((_x, n) => n !== i)); setDirty(true); }} aria-label={`Remove code ${r().code || i + 1}`}><Trash2 size={14} aria-hidden="true" /></Button></td>
                  </tr>
                )}
              </Index>
            </tbody>
          </table>
        </div>
        <div class="row">
          <Button variant="primary" loading={save.isPending} disabled={!valid() || !dirty()} onClick={() => save.mutate()}>Save stage map</Button>
          <Show when={dirty()}>
            <Button onClick={() => { if (q.data) setRows(q.data.items.map((r) => ({ code: r.code, target: r.target, note: r.note ?? '' }))); setDirty(false); setMsg(null); }}>Discard changes</Button>
          </Show>
        </div>
      </Show>
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
  const [outcome, setOutcome] = createSignal('');
  const [page, setPage] = createSignal(1);
  const q = createQuery(() => ({
    queryKey: ['mes-events', outcome(), page()],
    queryFn: () => api<{ items: MesEvent[]; total: number; page: number; pageSize: number }>(`/api/mes/events${qs({ outcome: outcome(), page: page() })}`),
    placeholderData: keepPreviousData,
  }));
  return (
    <Card title="Event log">
      <div class="toolbar">
        <div class="field" style={{ 'max-width': '240px' }}>
          <label for="mes-outcome">Outcome</label>
          <select id="mes-outcome" value={outcome()} onChange={(e) => { setOutcome(e.currentTarget.value); setPage(1); }}>
            <option value="" selected={outcome() === ''}>All outcomes</option>
            <For each={Object.entries(OUTCOMES)}>{([id, o]) => <option value={id} selected={id === outcome()}>{o.label}</option>}</For>
          </select>
        </div>
        <Button onClick={() => q.refetch()} loading={q.isFetching && !q.isLoading}>Refresh</Button>
      </div>
      <Show when={q.isLoading}><Spinner /></Show>
      <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
      <Show when={q.data && q.data.items.length === 0}><Empty title="No events">{outcome() ? 'No events with this outcome.' : 'Events from the factory system appear here.'}</Empty></Show>
      <Show when={q.data}>
        {(d) => (
          <Show when={d().items.length}>
            <p class="muted small" role="status">{formatNumber(d().total)} {d().total === 1 ? 'event' : 'events'}</p>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Received</th><th>Event ID</th><th>Case</th><th>Code</th><th>Outcome</th><th>Message</th></tr></thead>
                <tbody>
                  <For each={d().items}>
                    {(e) => (
                      <tr>
                        <td class="nowrap">{formatDateTime(e.receivedAt)}{e.occurredAt ? <div class="muted small">Happened {formatDateTime(e.occurredAt)}</div> : null}</td>
                        <td class="mono small" style={{ 'overflow-wrap': 'anywhere' }}>{e.eventId ?? ''}</td>
                        <td class="nowrap">{e.caseRef ?? <span class="muted">Unknown</span>}</td>
                        <td class="mono">{e.stageCode ?? ''}</td>
                        <td><Badge tone={OUTCOMES[e.outcome]?.tone ?? 'neutral'}>{OUTCOMES[e.outcome]?.label ?? humanise(e.outcome)}</Badge></td>
                        <td>{e.message ?? ''}{e.source ? <div class="muted small">{SOURCE_LABEL[e.source] ?? humanise(e.source)}</div> : null}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <Pagination page={d().page} pageSize={d().pageSize} total={d().total} onPage={setPage} />
          </Show>
        )}
      </Show>
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
  const [text, setText] = createSignal('');
  const [fileName, setFileName] = createSignal<string | null>(null);
  const [readError, setReadError] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<ImportResponse | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let fileRef!: HTMLInputElement;

  const m = createMutation(() => ({
    mutationFn: () => api<ImportResponse>('/api/mes/events/import', { method: 'POST', body: { csv: text() } }),
    onSuccess: (r: ImportResponse) => { setResult(r); setError(null); qc.invalidateQueries({ queryKey: ['mes-events'] }); qc.invalidateQueries({ queryKey: ['console-overview'] }); },
    onError: (e: unknown) => { setResult(null); setError(errorText(e)); },
  }));

  async function pick(f: File | undefined) {
    if (!f) return;
    setReadError(null);
    if (f.size > MAX_CSV) { setReadError('This file is larger than 5 MB. Split it into smaller files.'); return; }
    setText(await f.text());
    setFileName(f.name);
    setResult(null);
  }

  const lines = () => text().split(/\r?\n/).filter((l) => l.trim()).length;
  const counts = () => (result()?.results ?? []).reduce<Record<string, number>>((a, r) => { a[r.outcome] = (a[r.outcome] ?? 0) + 1; return a; }, {});

  return (
    <Card title="Import events from a CSV file">
      <p class="muted small">Use this when the factory system could not send events itself. Each row is applied like a live event. Rows that were already imported are marked as duplicates.</p>
      <p class="small">Columns, in any order, with a header row:</p>
      <p class="mono small" style={{ 'overflow-wrap': 'anywhere' }}>{IMPORT_COLUMNS}</p>
      <p class="small muted">A row needs a stage_code, occurred_at, and one way to find the case: case_ref, mes_case_id, or partner_code with partner_case_id. A blank event_id is made up from the row, so importing the same file twice does not count events twice. Shipped rows also need carrier, tracking_number and aligners_shipped. Hold rows need hold_reason.</p>
      <Show when={readError()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
      <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
      <div class="row">
        <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" hidden aria-label="Choose a CSV file" onChange={(e) => { void pick(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
        <Button onClick={() => fileRef.click()}><Upload size={16} aria-hidden="true" /> Choose a CSV file</Button>
        <Show when={fileName()}>{(n) => <span class="muted small">{n()}</span>}</Show>
      </div>
      <Field label="Or paste the CSV here" hint={lines() ? `${formatNumber(Math.max(0, lines() - 1))} data rows` : undefined}>
        {(p) => <textarea {...p} class="textarea-mono" rows={8} value={text()} onInput={(e) => { setText(e.currentTarget.value); setFileName(null); setResult(null); }} spellcheck={false} placeholder={IMPORT_COLUMNS} />}
      </Field>
      <div class="row">
        <Button variant="primary" loading={m.isPending} disabled={lines() < 2} onClick={() => { setError(null); m.mutate(); }}>Import</Button>
        <Show when={text()}>
          <Button onClick={() => { setText(''); setFileName(null); setResult(null); setError(null); }}>Clear</Button>
        </Show>
      </div>
      <Show when={result()}>
        {(r) => (
          <div class="stack" aria-live="polite">
            <div class="row">
              <strong>Result</strong>
              <For each={Object.entries(counts())}>{([o, n]) => <Badge tone={OUTCOMES[o]?.tone ?? 'neutral'}>{OUTCOMES[o]?.label ?? humanise(o)}: {formatNumber(n)}</Badge>}</For>
            </div>
            <div class="table-wrap result-scroll">
              <table class="table">
                <thead><tr><th class="num">Row</th><th>Event ID</th><th>Outcome</th><th>Message</th></tr></thead>
                <tbody>
                  <For each={r().results}>
                    {(row) => (
                      <tr>
                        <td class="num">{formatNumber(row.row)}</td>
                        <td class="mono small" style={{ 'overflow-wrap': 'anywhere' }}>{row.event_id ?? ''}</td>
                        <td><Badge tone={OUTCOMES[row.outcome]?.tone ?? 'neutral'}>{OUTCOMES[row.outcome]?.label ?? humanise(row.outcome)}</Badge></td>
                        <td>{row.message ?? ''}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Show>
    </Card>
  );
}
