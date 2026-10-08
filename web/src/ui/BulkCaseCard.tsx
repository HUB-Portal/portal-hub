import { For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { ArrowLeftRight, CheckCircle2, CircleAlert, RefreshCw, Trash2 } from 'lucide-solid';
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
function Facts(props: { a: CardAnalysis }) {
  return (
    <>
      <Badge tone="info">{plural(props.a.sum.modelCount, 'model')}</Badge>
      <Badge tone="info">{plural(props.a.sum.ptsCount, 'trim line')}</Badge>
      <Badge>{plural(props.a.documents, 'other document')}</Badge>
      <Badge>{formatBytes(props.a.sum.bytes)}</Badge>
    </>
  );
}

/** The badge that says where the card is. */
function StageBadge(props: { row: Row }) {
  const done = () => props.row.stage === 'uploaded' || props.row.stage === 'sent';
  const problem = () => props.row.stage === 'failed' || props.row.stage === 'attention';
  return (
    <Badge tone={stageTone(props.row.stage)}>
      {done() ? <CheckCircle2 size={12} aria-hidden="true" /> : problem() ? <CircleAlert size={12} aria-hidden="true" /> : null}
      {stageText(props.row.stage)}
    </Badge>
  );
}

/** Progress of a card that is working. */
function Progress(props: { row: Row; total: number }) {
  const value = () => (props.row.stage === 'creating' || props.row.stage === 'sending' ? 0.02 : props.row.stage === 'checking' ? 1 : props.total ? Math.min(0.98, props.row.sent / props.total) : 0);
  const text = () => (props.row.stage === 'uploading' ? `${formatBytes(props.row.sent)} of ${formatBytes(props.total)}` : props.row.stage === 'checking' ? 'Checking the files' : props.row.stage === 'sending' ? 'Sending to K Line' : 'Creating the case');
  return (
    <div class="case-progress">
      <ProgressBar label={`Progress for ${nameOf(props.row) || props.row.folder || 'this case'}`} value={value()} />
      <span class="small muted">{text()}</span>
    </div>
  );
}

/** The soft notes under the title: nothing here stops a case. */
function Notes(props: { row: Row; a: CardAnalysis; busy: boolean }) {
  const noTrim = () => props.a.sum.modelCount > 0 && props.a.sum.ptsCount === 0;
  return (
    <>
      <Show when={noTrim() && (props.row.stage === 'uploaded' || props.row.stage === 'queued' || props.busy)}><p class="soft-warning">No trim lines found. K Line can still make this case, but the trim lines are normally sent too.</p></Show>
      <Show when={props.row.instructionNote}><p class="small muted">{props.row.instructionNote}</p></Show>
    </>
  );
}

/** The three optional detail fields. */
function DetailFields(props: { row: Row; locked: boolean; actions: CardActions }) {
  return (
    <div class="form-grid case-names">
      <Field label="Patient ID (optional)">{(p) => <input {...p} value={props.row.patientId} onInput={(e) => props.actions.edit(props.row.key, { patientId: e.currentTarget.value })} maxLength={CASE_ID_MAX + 10} autocomplete="off" disabled={props.locked} />}</Field>
      <Field label="First name (optional)">{(p) => <input {...p} value={props.row.firstName} onInput={(e) => props.actions.edit(props.row.key, { firstName: e.currentTarget.value, guessed: false })} maxLength={NAME_MAX + 20} autocomplete="off" disabled={props.locked} />}</Field>
      <Field label="Last name (optional)">{(p) => <input {...p} value={props.row.lastName} onInput={(e) => props.actions.edit(props.row.key, { lastName: e.currentTarget.value, guessed: false })} maxLength={NAME_MAX + 20} autocomplete="off" disabled={props.locked} />}</Field>
    </div>
  );
}

/** The buttons of a card. Which ones show depends only on the stage of the card. */
function CardButtons(props: { row: Row; locked: boolean; actions: CardActions }) {
  const uploadedOrSent = () => props.row.stage === 'uploaded' || props.row.stage === 'sent' || props.row.stage === 'attention';
  return (
    <div class="row case-actions">
      <Button size="sm" disabled={props.locked} onClick={() => props.actions.edit(props.row.key, { ...swapNames(props.row), guessed: false })}><ArrowLeftRight size={14} aria-hidden="true" /> Swap names</Button>
      <Show when={props.row.caseUuid && uploadedOrSent()}><AddDocuments caseId={props.row.caseUuid!} status={props.row.stage === 'sent' ? 'submitted' : 'draft'} /></Show>
      <Show when={props.row.stage === 'attention' || props.row.stage === 'failed'}><Button size="sm" onClick={() => props.actions.retry(props.row)}><RefreshCw size={14} aria-hidden="true" /> Try again</Button></Show>
      <Show when={props.row.caseUuid}><A class="btn btn-sm" href={`/portal/cases/${props.row.caseUuid}`}>Open the case</A></Show>
      <Show when={props.row.stage !== 'sent' && props.row.stage !== 'sending'}><Button size="sm" onClick={() => props.actions.remove(props.row)}><Trash2 size={14} aria-hidden="true" /> {props.row.caseUuid ? 'Delete this draft' : 'Remove from this list'}</Button></Show>
    </div>
  );
}

/** One case of a drop: its files, its optional details, where it stands and what can be done with it. */
export function BulkCaseCard(props: { row: Row; analysis: CardAnalysis; index: number; blocked: boolean; actions: CardActions }) {
  const busy = () => isBusy(props.row);
  const heldBack = () => props.row.stage === 'queued' && props.analysis.problems.length > 0;
  const locked = () => props.row.stage === 'sending' || props.row.stage === 'sent';
  return (
    <article class={`case-card case-card-${heldBack() ? 'hold' : props.row.stage}`} aria-label={`Case ${nameOf(props.row) || props.row.folder || 'without a name'}`}>
      <div class="case-sum">
        <span class="id">{nameOf(props.row) || <span class="muted">No name</span>}</span>
        <Show when={props.row.ref}><span class="muted small">{props.row.ref}</span></Show>
        <Facts a={props.analysis} />
        <span class="grow" />
        <StageBadge row={props.row} />
      </div>
      <div class="small muted">From {props.row.folder || 'loose files'}</div>

      <Show when={busy() || props.row.stage === 'sending'}><Progress row={props.row} total={props.analysis.sum.bytes} /></Show>
      <Show when={props.row.stage === 'queued' && !heldBack()}><p class="small muted">{props.blocked ? 'Waiting. Uploads start once the notice above is dealt with.' : 'Waiting for its turn. Two cases upload at a time.'}</p></Show>
      <Show when={heldBack()}><ul class="problem-list" role="alert"><For each={props.analysis.problems}>{(p) => <li>{p}</li>}</For></ul></Show>
      <Show when={props.row.message}><p class={props.row.stage === 'failed' || props.row.stage === 'attention' ? 'field-error' : 'small muted'} role="status">{props.row.message}</p></Show>
      <Notes row={props.row} a={props.analysis} busy={busy()} />

      <DetailFields row={props.row} locked={locked()} actions={props.actions} />
      <Show when={props.row.nameError}><p class="field-error" role="alert">{props.row.nameError}</p></Show>
      <CardButtons row={props.row} locked={locked()} actions={props.actions} />

      <details class="case-more" open={heldBack() || undefined}>
        <summary>Files and instructions</summary>
        <div class="stack">
          <Field label="Instructions (optional)" hint={props.row.instructionNote ?? `${formatNumber(props.row.instructions.length)} of ${formatNumber(INSTRUCTIONS_MAX)} characters. Read from any text or Word file in the folder.`}>
            {(p) => <textarea {...p} value={props.row.instructions} maxLength={INSTRUCTIONS_MAX} onInput={(e) => props.actions.edit(props.row.key, { instructions: e.currentTarget.value })} rows={3} disabled={locked()} />}
          </Field>
          <FileMapTable idPrefix={`b-${props.index}`} files={props.row.files} readOnly={!!props.row.caseUuid || locked()} onChange={(files) => props.actions.changeFiles(props.row.key, files)} />
          <Show when={props.row.caseUuid}><p class="small muted">The files are already uploaded. Use Add documents to send more.</p></Show>
        </div>
      </details>
    </article>
  );
}
