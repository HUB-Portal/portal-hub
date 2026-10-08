import { Link } from 'react-router-dom';
import { ArrowLeftRight, CheckCircle2, CircleAlert, RefreshCw, Trash2 } from 'lucide-react';
import { NAME_MAX, swapNames } from '@shared/bulk';
import { CASE_ID_MAX } from '@shared/filenames';
import { formatBytes, formatNumber, plural } from '../lib/format';
import { INSTRUCTIONS_MAX } from '../lib/instructions';
import { isBusy, nameOf, stageText, stageTone, type Row } from '../lib/bulkRows';
import type { MapFile, fileSummary } from '../lib/review';
import { AddDocuments } from './AddDocuments';
import { Badge, Button, Field, ProgressBar } from './Common';
import { FileMapTable } from './FileMapTable';

/** What the card tells the page the partner did. The card holds no state of its own about the case. */
export interface CardActions {
  edit(key: string, changes: Partial<Row>): void;
  changeFiles(key: string, files: MapFile[]): void;
  retry(row: Row): void;
  remove(row: Row): void;
}

export interface CardAnalysis {
  problems: string[];
  sum: ReturnType<typeof fileSummary>;
  documents: number;
}

/** The little line of facts about the files of a case. */
function Facts({ a }: { a: CardAnalysis }) {
  return (
    <>
      <Badge tone="info">{plural(a.sum.modelCount, 'model')}</Badge>
      <Badge tone="info">{plural(a.sum.ptsCount, 'trim line')}</Badge>
      <Badge>{plural(a.documents, 'other document')}</Badge>
      <Badge>{formatBytes(a.sum.bytes)}</Badge>
    </>
  );
}

/** The badge that says where the card is. A card held back by problems reads "Needs attention" whatever its stage. */
function StageBadge({ row, heldBack }: { row: Row; heldBack: boolean }) {
  if (heldBack) return <Badge tone="warn"><CircleAlert size={12} aria-hidden="true" /> Needs attention</Badge>;
  const done = row.stage === 'uploaded' || row.stage === 'sent';
  const problem = row.stage === 'failed' || row.stage === 'attention';
  return (
    <Badge tone={stageTone(row.stage)}>
      {done ? <CheckCircle2 size={12} aria-hidden="true" /> : problem ? <CircleAlert size={12} aria-hidden="true" /> : null}
      {stageText(row.stage)}
    </Badge>
  );
}

/** Progress of a card that is working. */
function Progress({ row, total }: { row: Row; total: number }) {
  const value = row.stage === 'creating' || row.stage === 'sending' ? 0.02 : row.stage === 'checking' ? 1 : total ? Math.min(0.98, row.sent / total) : 0;
  const text = row.stage === 'uploading' ? `${formatBytes(row.sent)} of ${formatBytes(total)}` : row.stage === 'checking' ? 'Checking the files' : row.stage === 'sending' ? 'Sending to K Line' : 'Creating the case';
  return (
    <div className="case-progress">
      <ProgressBar label={`Progress for ${nameOf(row) || row.folder || 'this case'}`} value={value} />
      <span className="small muted">{text}</span>
    </div>
  );
}

/** The soft notes under the title: nothing here stops a case. */
function Notes({ row, a, busy }: { row: Row; a: CardAnalysis; busy: boolean }) {
  const noTrim = a.sum.modelCount > 0 && a.sum.ptsCount === 0;
  return (
    <>
      {noTrim && (row.stage === 'uploaded' || row.stage === 'queued' || busy) ? <p className="soft-warning">No trim lines found. K Line can still make this case, but the trim lines are normally sent too.</p> : null}
      {row.stage === 'uploaded' && row.serverWarnings ? <p className="soft-warning">The checks gave {plural(row.serverWarnings, 'warning')}. <Link to={`/portal/cases/${row.caseUuid}`}>Read {row.serverWarnings === 1 ? 'it' : 'them'}</Link> before you send.</p> : null}
      {row.instructionNote ? <p className="small muted">{row.instructionNote}</p> : null}
    </>
  );
}

/** The three optional detail fields. */
function DetailFields({ row, locked, actions }: { row: Row; locked: boolean; actions: CardActions }) {
  return (
    <div className="form-grid case-names">
      <Field label="Patient ID (optional)">{(p) => <input {...p} value={row.patientId} onChange={(e) => actions.edit(row.key, { patientId: e.target.value })} maxLength={CASE_ID_MAX + 10} autoComplete="off" disabled={locked} />}</Field>
      <Field label="First name (optional)">{(p) => <input {...p} value={row.firstName} onChange={(e) => actions.edit(row.key, { firstName: e.target.value, guessed: false })} maxLength={NAME_MAX + 20} autoComplete="off" disabled={locked} />}</Field>
      <Field label="Last name (optional)">{(p) => <input {...p} value={row.lastName} onChange={(e) => actions.edit(row.key, { lastName: e.target.value, guessed: false })} maxLength={NAME_MAX + 20} autoComplete="off" disabled={locked} />}</Field>
    </div>
  );
}

/** The buttons of a card. Which ones show depends only on the stage of the card. */
function CardButtons({ row, locked, actions }: { row: Row; locked: boolean; actions: CardActions }) {
  const uploadedOrSent = row.stage === 'uploaded' || row.stage === 'sent' || row.stage === 'attention';
  return (
    <div className="row case-actions">
      <Button size="sm" disabled={locked} onClick={() => actions.edit(row.key, { ...swapNames(row), guessed: false })}><ArrowLeftRight size={14} aria-hidden="true" /> Swap names</Button>
      {row.caseUuid && uploadedOrSent ? <AddDocuments caseId={row.caseUuid} status={row.stage === 'sent' ? 'submitted' : 'draft'} /> : null}
      {row.stage === 'attention' || row.stage === 'failed' ? <Button size="sm" onClick={() => actions.retry(row)}><RefreshCw size={14} aria-hidden="true" /> Try again</Button> : null}
      {row.caseUuid ? <Link className="btn btn-sm" to={`/portal/cases/${row.caseUuid}`}>Open the case</Link> : null}
      {row.stage !== 'sent' && row.stage !== 'sending' ? <Button size="sm" onClick={() => actions.remove(row)}><Trash2 size={14} aria-hidden="true" /> {row.caseUuid ? 'Delete this draft' : 'Remove from this list'}</Button> : null}
    </div>
  );
}

/** One case of a drop: its files, its optional details, where it stands and what can be done with it. */
export function BulkCaseCard({ row, analysis, index, blocked, actions }: { row: Row; analysis: CardAnalysis; index: number; blocked: boolean; actions: CardActions }) {
  const busy = isBusy(row);
  const heldBack = row.stage === 'queued' && analysis.problems.length > 0;
  const locked = row.stage === 'sending' || row.stage === 'sent';
  return (
    <article className={`case-card case-card-${heldBack ? 'hold' : row.stage}`} aria-label={`Case ${nameOf(row) || row.folder || 'without a name'}`}>
      <div className="case-sum">
        <span className="id">{nameOf(row) || <span className="muted">No name</span>}</span>
        {row.ref ? <span className="muted small">{row.ref}</span> : null}
        <Facts a={analysis} />
        <span className="grow" />
        <StageBadge row={row} heldBack={heldBack} />
      </div>
      <div className="small muted">From {row.folder || 'loose files'}</div>

      {busy || row.stage === 'sending' ? <Progress row={row} total={analysis.sum.bytes} /> : null}
      {row.stage === 'queued' && !heldBack ? <p className="small muted">{blocked ? 'Waiting. Uploads start once the notice above is dealt with.' : 'Waiting for its turn. Two cases upload at a time.'}</p> : null}
      {heldBack ? <ul className="problem-list">{analysis.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      {row.message ? <p className={row.stage === 'failed' || row.stage === 'attention' ? 'field-error' : 'small muted'} role="status">{row.message}</p> : null}
      <Notes row={row} a={analysis} busy={busy} />

      <DetailFields row={row} locked={locked} actions={actions} />
      {row.nameError ? <p className="field-error" role="alert">{row.nameError}</p> : null}
      <CardButtons row={row} locked={locked} actions={actions} />

      <details className="case-more" open={heldBack || undefined}>
        <summary>Files and instructions</summary>
        <div className="stack">
          <Field label="Instructions (optional)" hint={row.instructionNote ?? `${formatNumber(row.instructions.length)} of ${formatNumber(INSTRUCTIONS_MAX)} characters. Read from any text or Word file in the folder.`}>
            {(p) => <textarea {...p} value={row.instructions} maxLength={INSTRUCTIONS_MAX} onChange={(e) => actions.edit(row.key, { instructions: e.target.value })} rows={3} disabled={locked} />}
          </Field>
          <FileMapTable idPrefix={`b-${index}`} files={row.files} readOnly={!!row.caseUuid || locked} onChange={(files) => actions.changeFiles(row.key, files)} />
          {row.caseUuid ? <p className="small muted">The files are already uploaded. Use Add documents to send more.</p> : null}
        </div>
      </details>
    </article>
  );
}
