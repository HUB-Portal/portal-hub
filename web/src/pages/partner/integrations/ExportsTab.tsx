import { useState } from 'react';
import { Download } from 'lucide-react';
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
  const canNames = can('case.reveal_name');
  const initial = periodPreset('this-month');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [dateField, setDateField] = useState<'created' | 'shipped'>('shipped');
  const [names, setNames] = useState(false);
  const [busy, setBusy] = useState<'cases' | 'shipments' | null>(null);
  const [result, setResult] = useState<Result>(null);

  const today = ymd(new Date());
  const rangeError = !from || !to ? 'Choose both dates.' : from > to ? 'The start date must not be after the end date.' : null;

  async function download(kind: 'cases' | 'shipments') {
    if (rangeError || busy) return;
    setBusy(kind);
    setResult(null);
    try {
      const path = kind === 'cases'
        ? `/api/exports/cases.csv${qs({ from, to, include_names: names && canNames ? 1 : 0, date_field: dateField })}`
        : `/api/exports/shipments.csv${qs({ from, to })}`;
      const { blob, filename } = await apiBlob(path);
      saveBlob(filename ?? `${kind}-${from}-to-${to}.csv`, blob);
      setResult({ tone: 'good', text: `Your file is ready: ${filename ?? `${kind}.csv`}. Check your downloads folder.` });
    } catch (e) {
      setResult({ tone: 'bad', text: exportError(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Download as CSV">
      <p className="muted">
        Get your cases as a spreadsheet file, for example to check an invoice. Files open in Excel, Numbers and Google Sheets. Text is made safe so spreadsheet formulas in it cannot run.
      </p>
      <div className="stack">
        <div className="toolbar">
          <Field label="From">{(f) => <input {...f} type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} required />}</Field>
          <Field label="To">{(f) => <input {...f} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />}</Field>
        </div>
        <div className="row" role="group" aria-label="Quick periods">
          <span className="small muted">Quick choice:</span>
          {([['this-month', 'This month'], ['last-month', 'Last month'], ['last-90', 'Last 90 days']] as const).map(([id, label]) => (
            <Button key={id} size="sm" onClick={() => { const p = periodPreset(id); setFrom(p.from); setTo(p.to); }}>{label}</Button>
          ))}
        </div>
        {rangeError ? <p className="field-error" role="alert">{rangeError}</p> : <p className="small muted">Period: {formatDate(from)} to {formatDate(to)}.</p>}

        <fieldset className="check-group">
          <legend>Which date to use for the cases file</legend>
          <div className="radio-row">
            <label className="radio"><input type="radio" name="date-field" checked={dateField === 'shipped'} onChange={() => setDateField('shipped')} /> Date shipped</label>
            <label className="radio"><input type="radio" name="date-field" checked={dateField === 'created'} onChange={() => setDateField('created')} /> Date created</label>
          </div>
          <p className="hint">The shipments file always uses the date shipped.</p>
        </fieldset>

        <div className="check">
          <input id="export-names" type="checkbox" checked={names && canNames} disabled={!canNames} onChange={(e) => setNames(e.target.checked)} aria-describedby="export-names-h" />
          <label htmlFor="export-names">Include patient first and last names</label>
          <p className="hint" id="export-names-h">
            {canNames
              ? 'This needs a fresh code from your authenticator app. Every name in the file is recorded in your access log, with the number of rows. Only tick this if you really need names.'
              : 'Your role cannot see patient names, so this file never includes them.'}
          </p>
        </div>

        {names && canNames ? <Notice tone="warn" title="Patient names are personal health data">Keep the file safe and delete it when you are done. You will be asked for your authenticator code.</Notice> : null}
        {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}

        <div className="row">
          <Button variant="primary" loading={busy === 'cases'} disabled={!!rangeError || busy === 'shipments'} onClick={() => download('cases')}>
            <Download size={16} aria-hidden="true" /> Download cases.csv
          </Button>
          <Button loading={busy === 'shipments'} disabled={!!rangeError || busy === 'cases'} onClick={() => download('shipments')}>
            <Download size={16} aria-hidden="true" /> Download shipments.csv
          </Button>
        </div>
        <p className="small muted">
          cases.csv has one row per case with status, dates, aligner counts and tracking. shipments.csv lists cases shipped in the period with aligner counts, for invoicing. Files hold at most 100,000 rows.
        </p>
      </div>
    </Card>
  );
}
