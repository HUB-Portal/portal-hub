import { createSignal, For, Show } from 'solid-js';
import { Download } from 'lucide-solid';
import { ApiError, apiBlob, errorText, qs } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDate, saveBlob } from '../../../lib/format';
import { periodPreset, ymd } from '../../../lib/integrations';
import { Button, Card, Field, Notice } from '../../../ui/Common';

type Result = { tone: 'good' | 'bad'; text: string } | null;

function exportError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'too_many_rows') return 'That period has too many cases for one file (more than 100,000). Choose a shorter period and download it in parts.';
    if (e.code === 'step_up_cancelled') return 'The download was cancelled. To include patient names, confirm with your authenticator code.';
    if (e.code === 'step_up_required') return 'Please confirm with your authenticator code to include patient names.';
  }
  return errorText(e);
}

export function ExportsTab() {
  const { can } = useAuth();
  const canNames = () => can('case.reveal_name');
  const initial = periodPreset('this-month');
  const [from, setFrom] = createSignal(initial.from);
  const [to, setTo] = createSignal(initial.to);
  const [dateField, setDateField] = createSignal<'created' | 'shipped'>('shipped');
  const [names, setNames] = createSignal(false);
  const [busy, setBusy] = createSignal<'cases' | 'shipments' | null>(null);
  const [result, setResult] = createSignal<Result>(null);

  const today = ymd(new Date());
  const rangeError = () => (!from() || !to() ? 'Choose both dates.' : from() > to() ? 'The start date must not be after the end date.' : null);

  async function download(kind: 'cases' | 'shipments') {
    if (rangeError() || busy()) return;
    setBusy(kind);
    setResult(null);
    const f = from();
    const t = to();
    try {
      const path = kind === 'cases'
        ? `/api/exports/cases.csv${qs({ from: f, to: t, include_names: names() && canNames() ? 1 : 0, date_field: dateField() })}`
        : `/api/exports/shipments.csv${qs({ from: f, to: t })}`;
      const { blob, filename } = await apiBlob(path);
      saveBlob(filename ?? `${kind}-${f}-to-${t}.csv`, blob);
      setResult({ tone: 'good', text: `Your file is ready: ${filename ?? `${kind}.csv`}. Check your downloads folder.` });
    } catch (e) {
      setResult({ tone: 'bad', text: exportError(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Download as CSV">
      <p class="muted">
        Get your cases as a spreadsheet file, for example to check an invoice. Files open in Excel, Numbers and Google Sheets. Text is made safe so spreadsheet formulas in it cannot run.
      </p>
      <div class="stack">
        <div class="toolbar">
          <Field label="From">{(f) => <input {...f} type="date" value={from()} max={to() || today} onInput={(e) => setFrom(e.currentTarget.value)} required />}</Field>
          <Field label="To">{(f) => <input {...f} type="date" value={to()} min={from()} onInput={(e) => setTo(e.currentTarget.value)} required />}</Field>
        </div>
        <div class="row" role="group" aria-label="Quick periods">
          <span class="small muted">Quick choice:</span>
          <For each={[['this-month', 'This month'], ['last-month', 'Last month'], ['last-90', 'Last 90 days']] as const}>
            {([id, label]) => (
              <Button size="sm" onClick={() => { const p = periodPreset(id); setFrom(p.from); setTo(p.to); }}>{label}</Button>
            )}
          </For>
        </div>
        <Show when={rangeError()} fallback={<p class="small muted">Period: {formatDate(from())} to {formatDate(to())}.</p>}>
          {(er) => <p class="field-error" role="alert">{er()}</p>}
        </Show>

        <fieldset class="check-group">
          <legend>Which date to use for the cases file</legend>
          <div class="radio-row">
            <label class="radio"><input type="radio" name="date-field" checked={dateField() === 'shipped'} onChange={() => setDateField('shipped')} /> Date shipped</label>
            <label class="radio"><input type="radio" name="date-field" checked={dateField() === 'created'} onChange={() => setDateField('created')} /> Date created</label>
          </div>
          <p class="hint">The shipments file always uses the date shipped.</p>
        </fieldset>

        <div class="check">
          <input id="export-names" type="checkbox" checked={names() && canNames()} disabled={!canNames()} onChange={(e) => setNames(e.currentTarget.checked)} aria-describedby="export-names-h" />
          <label for="export-names">Include patient first and last names</label>
          <p class="hint" id="export-names-h">
            {canNames()
              ? 'This needs a fresh code from your authenticator app. Every name in the file is recorded in your access log, with the number of rows. Only tick this if you really need names.'
              : 'Your role cannot see patient names, so this file never includes them.'}
          </p>
        </div>

        <Show when={names() && canNames()}><Notice tone="warn" title="Patient names are personal health data">Keep the file safe and delete it when you are done. You will be asked for your authenticator code.</Notice></Show>
        <Show when={result()}>{(r) => <Notice tone={r().tone}>{r().text}</Notice>}</Show>

        <div class="row">
          <Button variant="primary" loading={busy() === 'cases'} disabled={!!rangeError() || busy() === 'shipments'} onClick={() => download('cases')}>
            <Download size={16} aria-hidden="true" /> Download cases.csv
          </Button>
          <Button loading={busy() === 'shipments'} disabled={!!rangeError() || busy() === 'cases'} onClick={() => download('shipments')}>
            <Download size={16} aria-hidden="true" /> Download shipments.csv
          </Button>
        </div>
        <p class="small muted">
          cases.csv has one row per case with status, dates, aligner counts and tracking. shipments.csv lists cases shipped in the period with aligner counts, for invoicing. Files hold at most 100,000 rows.
        </p>
      </div>
    </Card>
  );
}
