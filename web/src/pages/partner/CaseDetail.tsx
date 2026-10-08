import { createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { A, useNavigate, useParams } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { ClipboardList, Download, Eraser, Eye, Flag, MoreHorizontal, PackagePlus, Pause, Play, RefreshCw, Route as RouteIcon, Send, Trash2, Upload, X, XCircle } from 'lucide-solid';
import { api, ApiError, errorText } from '../../lib/api';
import { useAuth, useMenu } from '../../lib/auth';
import { archLabel, caseStatus, eventLabel, formatBytes, formatDate, formatDateTime, formatNumber, humanise, portalLabel, portalTone, simpleStatusLabel, simpleStatusOf, simpleStatusTone, sourceLabel, stepLabel, statusLabel, statusTone } from '../../lib/format';
import { fallbackStepper, stageLabel } from '../../lib/stages';
import { INSTRUCTIONS_MAX, readInstructionBytes } from '../../lib/instructions';
import { readDrop, readFileList } from '../../lib/intake';
import { CLAIMABLE_CASE_STATUSES, REPLACEABLE_CASE_STATUSES, alignerName, alignersOf, claimStatusLabel, claimStatusTone } from '../../lib/quality';
import type { CaseChild, CaseClaimRef, CaseDetail as CaseDetailData, CaseEvent, CaseFile, CaseItem, Issue, Routing } from '../../lib/types';
import { AddDocuments } from '../../ui/AddDocuments';
import { Badge, Button, Card, Dialog, Field, IssueList, Notice, PageHeader, Spinner, Toggle } from '../../ui/Common';
import { UploadList, useCaseUploader } from '../../ui/CaseUploader';
import { DropZone, PageDropOverlay, usePageDrop } from '../../ui/DropZone';
import { Stepper } from '../../ui/Stepper';
import { StlViewer } from '../../viewer/StlViewer';
import { HoldDialog, ReleaseDialog, RouteDialog, StageDialog } from '../console/caseActions';
import { AlignerPicker } from './ClaimNew';
import { useMfaRequired } from '../../lib/orgApi';

const OPEN_STATUSES = ['draft', 'submitted', 'on_hold', 'ready'];

function fileTone(s: string, idle = false) { return s === 'ready' ? 'good' : s === 'rejected' || (s === 'uploading' && idle) ? 'bad' : 'info'; }
/** `idle` is true when no upload of this case is running in this browser. A file still in the Uploading state then was cut off (for example a closed tab). */
function fileStateLabel(s: string, idle = false) {
  if (s === 'uploading' && idle) return 'Upload not finished';
  return ({ uploading: 'Uploading', processing: 'Checking', ready: 'Ready', rejected: 'Rejected', purged: 'Removed' } as Record<string, string>)[s] ?? humanise(s);
}

function issuesFor(f: CaseFile, c: CaseItem): { errors: Issue[]; warnings: Issue[] } {
  const errors = [...(f.validation?.errors ?? []), ...c.checks.errors.filter((i) => i.fileId === f.id)];
  const warnings = [...(f.validation?.warnings ?? []), ...c.checks.warnings.filter((i) => i.fileId === f.id)];
  return { errors, warnings };
}

/** In a draft the steps that are missing a file or have a failed one stand out, so the partner sees what to fix (review of 8 Oct 2026, R5). */
function stepTone(r: ManifestRow, idle: boolean): string {
  const bad = (f?: CaseFile) => !!f && (f.state === 'rejected' || (f.state === 'uploading' && idle) || (f.validation?.errors?.length ?? 0) > 0);
  if (!r.model || bad(r.model) || bad(r.pts)) return 'row-bad';
  if (!r.pts) return 'row-warn';
  return '';
}

interface ManifestRow { key: string; arch: 'upper' | 'lower'; step: number; template: boolean; model?: CaseFile; pts?: CaseFile }

function buildManifest(files: CaseFile[]): { rows: ManifestRow[]; unmapped: CaseFile[] } {
  const map = new Map<string, ManifestRow>();
  const unmapped: CaseFile[] = [];
  for (const f of files) {
    if (f.kind !== 'stl' && f.kind !== 'pts') continue;
    if (!f.arch || f.step === null) { unmapped.push(f); continue; }
    const key = `${f.arch}|${f.step}|${f.template}`;
    const row = map.get(key) ?? { key, arch: f.arch, step: f.step, template: f.template };
    if (f.kind === 'stl') row.model = f; else row.pts = f;
    map.set(key, row);
  }
  const rows = [...map.values()].sort((a, b) => a.arch.localeCompare(b.arch) * -1 || a.step - b.step || Number(a.template) - Number(b.template));
  return { rows, unmapped };
}

const STAFF_STAGE_STATUSES = ['ready', 'received', 'in_production', 'shipped'];

type DialogName = 'submit' | 'cancel' | 'delete' | 'route' | 'hold' | 'release' | 'stage' | 'replace' | 'erase';

/** Case page for partners, and for K Line staff when `staff` is set (same components, staff actions instead of partner edits). */
export default function CaseDetail(props: { staff?: boolean }) {
  const staff = () => props.staff ?? false;
  const params = useParams();
  const id = () => params.id ?? '';
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  // Menu visibility (visibility only): people who may not see Quality claims or the Production spec get no links to them.
  const menu = useMenu();
  const showClaims = () => staff() || menu.claims;
  const showSpec = () => staff() || menu.spec;
  const q = createQuery(() => ({
    queryKey: [staff() ? 'console-case' : 'case', id()],
    queryFn: () => api<CaseDetailData>(staff() ? `/api/console/cases/${id()}` : `/api/cases/${id()}`),
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      const busy = d.files.some((f) => f.state === 'uploading' || f.state === 'processing') || ['pending', 'pushing'].includes(d.case.portal.status);
      return busy ? 3000 : false;
    },
  }));
  const [selected, setSelected] = createSignal<string | null>(null);
  const [viewerOpen, setViewerOpen] = createSignal(false);
  const [notice, setNotice] = createSignal<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const [dialog, setDialog] = createSignal<DialogName | null>(null);
  const [mapFile, setMapFile] = createSignal<CaseFile | null>(null);

  const data = () => q.data;
  const item = createMemo<CaseItem | undefined>(() => {
    const d = data();
    return d?.case && d.instructions !== undefined ? { ...d.case, instructions: d.instructions } : d?.case;
  });
  const routing = () => data()?.routing ?? null;
  const files = createMemo(() => data()?.files ?? []);
  const manifest = createMemo(() => buildManifest(files()));
  const rows = () => manifest().rows;
  const unmapped = () => manifest().unmapped;
  const others = createMemo(() => files().filter((f) => f.kind !== 'stl' && f.kind !== 'pts'));
  const sel = createMemo(() => rows().find((r) => r.key === selected()) ?? rows().find((r) => r.model?.state === 'ready') ?? rows()[0]);
  const showViewer = () => viewerOpen() && !!sel()?.model && sel()!.model!.state === 'ready';
  const filesEditable = () => {
    const c = item();
    return !staff() && !!c && (c.status === 'draft' || c.status === 'on_hold') && can('case.write');
  };

  const refresh = () => { for (const k of ['case', 'console-case', 'cases', 'console-cases', 'intake', 'console-overview', 'case-counts']) qc.invalidateQueries({ queryKey: [k] }); };
  const back = () => (staff() ? '/console/cases' : '/portal/cases');
  // A draft takes new files at any time: the drop zone sits in the Aligners card and the whole page accepts drops (review of 8 Oct 2026, R5).
  const uploader = useCaseUploader(id, refresh);
  const dragging = usePageDrop((snap) => { void uploader.add(readDrop(snap)); }, filesEditable);
  const idle = () => !uploader.busy;

  const cancel = createMutation(() => ({
    mutationFn: () => api(`/api/cases/${id()}/cancel`, { method: 'POST', body: {} }),
    onSuccess: () => { setDialog(null); setNotice({ tone: 'good', text: 'The case was cancelled.' }); refresh(); },
    onError: (e: unknown) => { setDialog(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  }));
  const del = createMutation(() => ({
    mutationFn: () => api(`/api/cases/${id()}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cases'] }); nav(back(), { replace: true }); },
    onError: (e: unknown) => { setDialog(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  }));
  const refreshPortal = createMutation(() => ({
    mutationFn: () => api<{ case: CaseItem }>(`/api/cases/${id()}/portal/refresh`, { method: 'POST', body: {} }),
    onSuccess: (r: { case: CaseItem }) => {
      setNotice(r.case.portal.syncError ? { tone: 'warn', text: r.case.portal.syncError } : { tone: 'good', text: 'Checked the K Line portal.' });
      refresh();
    },
    onError: (e: unknown) => setNotice({ tone: 'bad', text: errorText(e) }),
  }));
  const retry = createMutation(() => ({
    mutationFn: () => api(`/api/cases/${id()}/portal/retry`, { method: 'POST', body: {} }),
    onSuccess: () => { setNotice({ tone: 'good', text: 'We will try sending this case to the portal again.' }); refresh(); },
    onError: (e: unknown) => setNotice({ tone: 'bad', text: errorText(e) }),
  }));
  const removeFile = createMutation(() => ({
    mutationFn: (fid: string) => api(`/api/files/${fid}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e: unknown) => setNotice({ tone: 'bad', text: errorText(e) }),
  }));

  // Opening a case that was sent to the K Line portal checks the portal once, so the status is current without waiting for the 10 minute sync.
  let autoChecked: string | null = null;
  createEffect(() => {
    const c = item();
    if (!c || c.manufacturingMode !== 'direct' || c.portal.status !== 'pushed' || c.portal.demo) return;
    if (['shipped', 'delivered', 'cancelled'].includes(c.status) || autoChecked === c.id) return;
    const last = c.portal.syncedAt ? Date.parse(c.portal.syncedAt) : 0;
    if (Date.now() - last < 2 * 60 * 1000) return;
    autoChecked = c.id;
    api(`/api/cases/${c.id}/portal/refresh`, { method: 'POST', body: {} }).then(() => refresh()).catch(() => undefined);
  });

  return (
    <Switch>
      <Match when={q.isLoading}><div class="page"><Spinner /></div></Match>
      <Match when={q.isError || !item()}>
        <div class="page">
          <Notice tone="bad" title="We could not open this case">{errorText(q.error)}</Notice>
          <div><A href={back()}>Back to cases</A></div>
        </div>
      </Match>
      <Match when={item()}>
        {(c) => {
          const canWrite = () => !staff() && can('case.write');
          const canRoute = () => staff() && can('intake.manage');
          const canStage = () => staff() && can('stage.manual') && STAFF_STAGE_STATUSES.includes(c().status);
          const canBags = () => staff() && (can('file.download') || can('stage.manual')) && ['ready', 'received', 'in_production', 'shipped', 'delivered'].includes(c().status);
          const direct = () => c().manufacturingMode === 'direct';
          const erased = () => !!c().purgedAt;
          const canErase = () => can('case.erase') && c().status !== 'draft' && !erased();
          const uploading = () => files().some((f) => f.state === 'uploading' || f.state === 'processing') || uploader.busy;
          // Why Submit is switched off: an error blocks it, so say so instead of letting the partner press it and read the answer afterwards.
          const submitBlock = (): string | null => (c().checks.errors.length ? `Fix ${c().checks.errors.length === 1 ? 'the error' : `the ${c().checks.errors.length} errors`} first: ${c().checks.errors[0]!.message}` : uploading() && files().some((f) => f.state === 'uploading' && idle()) ? 'Some files were not finished uploading. Remove them or add them again.' : null);
          const onSubmitted = (text: string) => { setDialog(null); setNotice({ tone: 'good', text }); refresh(); };

          return (
            <div class="page">
              <PageDropOverlay show={dragging()} text="Drop to add files to this case" />
              <div><A href={back()} class="small">Back to cases</A></div>
              <PageHeader
                title={<span class="row" style={{ gap: '12px' }}>{c().ref} {staff() ? <><Badge tone={statusTone(c().status)}>{statusLabel(c().status)}</Badge><Badge tone={simpleStatusTone(simpleStatusOf(c()))} title="Shown to the partner">{simpleStatusLabel(simpleStatusOf(c()))}</Badge></> : <Badge tone={simpleStatusTone(simpleStatusOf(c()))}>{simpleStatusLabel(simpleStatusOf(c()))}</Badge>}{direct() ? <Badge tone="info">Direct manufacturing</Badge> : null}</span>}
                subtitle={c().caseId ? `Case ID ${c().caseId}` : undefined}
                actions={
                  <>
                    <Show when={canWrite() && (c().status === 'draft' || c().status === 'on_hold')}>
                      <Button
                        variant="primary"
                        disabled={submitBlock() !== null}
                        title={submitBlock() ?? undefined}
                        aria-describedby={submitBlock() ? 'submit-why' : undefined}
                        onClick={() => setDialog('submit')}
                      >
                        <Send size={16} aria-hidden="true" /> {c().status === 'on_hold' ? 'Submit again' : 'Submit case'}
                      </Button>
                    </Show>
                    <Show when={canWrite() && submitBlock()}><span id="submit-why" class="sr-only">{submitBlock()}</span></Show>
                    <Show when={canRoute() && c().status === 'submitted'}><Button variant="primary" onClick={() => setDialog('route')}><RouteIcon size={16} aria-hidden="true" /> Send to a site</Button></Show>
                    <Show when={canRoute() && c().status === 'ready'}><Button onClick={() => setDialog('route')}><RouteIcon size={16} aria-hidden="true" /> Change site</Button></Show>
                    <Show when={canRoute() && c().status === 'on_hold'}><Button variant="primary" onClick={() => setDialog('release')}><Play size={16} aria-hidden="true" /> Release</Button></Show>
                    <Show when={canRoute() && (c().status === 'submitted' || c().status === 'ready')}><Button onClick={() => setDialog('hold')}><Pause size={16} aria-hidden="true" /> Put on hold</Button></Show>
                    <Show when={canStage()}><Button onClick={() => setDialog('stage')}><ClipboardList size={16} aria-hidden="true" /> Update stage</Button></Show>
                    <Show when={canBags()}><a class="btn" href={`/api/cases/${c().id}/bags.csv`}><Download size={16} aria-hidden="true" /> Bag print file</a></Show>
                    <Show when={can('file.download') && files().some((f) => f.state === 'ready')}><a class="btn" href={`/api/cases/${c().id}/package.zip`}><Download size={16} aria-hidden="true" /> Production package</a></Show>
                    <Show when={!staff() && showClaims() && can('claim.write') && CLAIMABLE_CASE_STATUSES.includes(c().status)}><A class="btn" href={`/portal/cases/${c().id}/claim`}><Flag size={16} aria-hidden="true" /> Report an issue</A></Show>
                    <Show when={canWrite() && REPLACEABLE_CASE_STATUSES.includes(c().status)}><Button onClick={() => setDialog('replace')}><PackagePlus size={16} aria-hidden="true" /> Order replacement</Button></Show>
                    <Show when={canWrite() && !c().purgedAt && c().status !== 'cancelled'}><AddDocuments caseId={c().id} status={c().status} onDone={refresh} /></Show>
                    <Show when={canWrite() && !c().purgedAt && OPEN_STATUSES.includes(c().status) && c().status !== 'draft'}><Button onClick={() => setDialog('cancel')}><XCircle size={16} aria-hidden="true" /> Cancel case</Button></Show>
                    <Show when={canWrite() && c().status === 'draft'}>
                      {/* A draft has one way out, and it sits in a menu so it is not next to Submit by mistake. */}
                      <details class="more-menu">
                        <summary class="btn" aria-label="More actions"><MoreHorizontal size={16} aria-hidden="true" /> More</summary>
                        <div class="more-menu-list"><Button variant="danger" onClick={() => setDialog('delete')}><Trash2 size={16} aria-hidden="true" /> Delete draft</Button></div>
                      </details>
                    </Show>
                    <Show when={canErase()}><Button variant="danger" onClick={() => setDialog('erase')}><Eraser size={16} aria-hidden="true" /> Erase case data</Button></Show>
                  </>
                }
              />
              <Show when={notice()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show>
              <Show when={!staff() && !erased() && c().status !== 'cancelled'}><PlainStatus c={c()} /></Show>
              <Show when={erased()}><Notice tone="info" title="The data of this case was removed">The files, the patient name, the instructions and the text people typed were removed on {formatDate(c().purgedAt!)}. Only the production record is kept: the reference, status, dates, counts and history.</Notice></Show>
              <Show when={c().status === 'on_hold'}>
                <Notice
                  tone="warn"
                  title="This case is on hold"
                  action={canWrite() ? <Button size="sm" variant="primary" onClick={() => setDialog('submit')}>Submit again</Button> : undefined}
                >
                  {c().holdReason ?? 'K Line needs something before work can start.'}
                  <Show when={canWrite()}><div class="small" style={{ 'margin-top': '4px' }}>Fix the files or details, then submit the case again. K Line will look at it as soon as you do.</div></Show>
                </Notice>
              </Show>
              <Card title="Progress">
                <Stepper steps={c().stepper ?? fallbackStepper(c())} cancelled={c().status === 'cancelled'} cancelledAt={c().cancelledAt} />
                <Show when={c().expectedShipDate && !['shipped', 'delivered', 'cancelled'].includes(c().status)}><p class="small muted">Expected to ship on {formatDate(c().expectedShipDate!)}.</p></Show>
              </Card>
              <Show when={c().carrier || c().trackingNumber || c().shippedAt}>
                <Card title="Shipping">
                  <dl class="facts">
                    <dt>Carrier</dt><dd>{c().carrier ?? 'Not given'}</dd>
                    <dt>Tracking number</dt><dd>{c().trackingNumber ? <span class="mono">{c().trackingNumber}</span> : 'Not given'}</dd>
                    <dt>Aligners shipped</dt><dd>{formatNumber(c().counts.shipped)}</dd>
                    <dt>Shipped</dt><dd>{c().shippedAt ? formatDate(c().shippedAt!) : 'Not yet'}</dd>
                    <Show when={c().deliveredAt}><dt>Delivered</dt><dd>{formatDate(c().deliveredAt!)}</dd></Show>
                  </dl>
                </Card>
              </Show>
              <Show when={!staff() && c().status === 'draft'}><Notice tone="info">This case is a draft. K Line will not start work until you submit it.</Notice></Show>

              <Show when={direct() && staff()}>
                <Card title="Customer portal">
                  <div class="row">
                    <Badge tone={portalTone(c().portal.status, c().portal.demo)}>{portalLabel(c().portal.status, c().portal.demo)}</Badge>
                    <Show when={c().portal.status === 'pushing' && c().portal.step}><span class="muted small">Step {c().portal.step} of {c().portal.steps ?? 3}: {['', 'Creating the case', 'Sending the files, this can take a few minutes', 'Submitting the case'][c().portal.step!] ?? 'Working'}</span></Show>
                    <Show when={c().portal.attempts}><span class="muted small">{formatNumber(c().portal.attempts!)} {c().portal.attempts === 1 ? 'attempt' : 'attempts'}</span></Show>
                  </div>
                  <Show when={c().portal.status === 'failed' && c().portal.lastError}><Notice tone="bad" title="Last error">{c().portal.lastError}</Notice></Show>
                  <Show when={c().portal.status === 'pushed' && !c().portal.demo}>
                    <div class="row" style={{ 'margin-top': '8px' }}>
                      <span class="small">
                        Status at the K Line portal: <strong>{c().portal.portalStatusLabel ?? 'Not checked yet'}</strong>
                        <Show when={c().portal.syncedAt}><span class="muted"> (checked {formatDateTime(c().portal.syncedAt)})</span></Show>
                      </span>
                      <Show when={!['shipped', 'delivered', 'cancelled'].includes(c().status)}>
                        <Button size="sm" loading={refreshPortal.isPending} onClick={() => refreshPortal.mutate()}><RefreshCw size={14} aria-hidden="true" /> Refresh from portal</Button>
                      </Show>
                    </div>
                  </Show>
                  <Show when={c().portal.status === 'pushed' && !c().portal.demo && c().portal.syncError}><p class="small muted" role="status">The last check did not work: {c().portal.syncError}</p></Show>
                </Card>
              </Show>

              <RelatedCard c={c()} kids={data()!.children} claims={showClaims() ? data()!.claims : []} staff={staff()} />

              <div class="grid-2">
                <Card title="Checks">
                  <Show when={c().checks.errors.length === 0 && c().checks.warnings.length === 0}><Notice tone="good">All checks passed.</Notice></Show>
                  <Show when={c().checks.errors.length}><h3>Errors</h3><p class="small muted">These stop the case from being submitted.</p><IssueList tone="bad" items={c().checks.errors} /></Show>
                  <Show when={c().checks.warnings.length}><h3>Warnings</h3><p class="small muted">{c().status === 'draft' || c().status === 'on_hold' ? 'You can submit, but you must confirm you have read them.' : 'You confirmed these warnings when the case was submitted. They do not stop production.'}{c().status === 'draft' || c().status === 'on_hold' ? (c().warningsAcknowledged ? ' You confirmed them already.' : '') : ''}</p><IssueList tone="warn" items={c().checks.warnings} /></Show>
                </Card>
                <FactsCard c={c()} staff={staff()} routing={routing()} />
              </div>

              <Card title="Aligners">
                <Show when={filesEditable()}>
                  <div class="stack-sm">
                    <DropZone
                      title={rows().length || unmapped().length ? 'Drop more files here to add them to this case' : 'Drop the models and trim lines of this case here'}
                      compact
                      active={dragging()}
                      onList={(l) => { void uploader.add(readFileList(l)); }}
                    >
                      Missing or failed steps are marked below. Files you drop are added to the case at once.
                    </DropZone>
                    <UploadList uploader={uploader} />
                  </div>
                </Show>
                <Show when={rows().length === 0 && unmapped().length === 0}><p class="muted">No models yet.{filesEditable() ? ' Drop files above to get started.' : ''}</p></Show>
                <Show when={rows().length}>
                  <Show when={showViewer()}>
                    <div class="stack-sm">
                      <div class="row" style={{ 'justify-content': 'flex-end' }}><Button size="sm" onClick={() => setViewerOpen(false)}><X size={14} aria-hidden="true" /> Close 3D view</Button></div>
                      <StlViewer
                        label={sel() ? `3D view of ${archLabel(sel()!.arch)} ${stepLabel(sel()!.step, sel()!.template)}` : '3D view'}
                        modelUrl={sel()?.model && sel()!.model!.state === 'ready' ? `/api/files/${sel()!.model!.id}/content` : null}
                        ptsUrl={sel()?.pts && sel()!.pts!.state === 'ready' ? `/api/files/${sel()!.pts!.id}/content` : null}
                      />
                    </div>
                  </Show>
                  <For each={['upper', 'lower'] as const}>
                    {(arch) => {
                      const list = createMemo(() => rows().filter((r) => r.arch === arch));
                      return (
                        <Show when={list().length}>
                          <div class="stack-sm">
                            <h3>{archLabel(arch)} arch, {formatNumber(list().filter((r) => !r.template).length)} steps</h3>
                            <div class="table-wrap">
                              <table class="table">
                                <thead><tr><th>Step</th><th>Model</th><th>Trim line</th><th><span class="sr-only">Actions</span></th></tr></thead>
                                <tbody>
                                  {/* Index keeps a row in place while its files change (the list is rebuilt on every refresh). */}
                                  <Index each={list()}>
                                    {(r) => (
                                      <tr class={[r().key === sel()?.key && showViewer() ? 'selected' : '', filesEditable() ? stepTone(r(), idle()) : ''].filter(Boolean).join(' ') || undefined}>
                                        <td class="nowrap"><strong>{stepLabel(r().step, r().template)}</strong></td>
                                        <td><FileCell f={r().model} c={c()} missing="Missing" idle={idle()} onEdit={filesEditable() ? setMapFile : undefined} onRemove={filesEditable() ? (f) => removeFile.mutate(f.id) : undefined} /></td>
                                        <td><FileCell f={r().pts} c={c()} missing={r().model ? 'Missing' : 'None'} warnMissing={!!r().model} idle={idle()} onEdit={filesEditable() ? setMapFile : undefined} onRemove={filesEditable() ? (f) => removeFile.mutate(f.id) : undefined} /></td>
                                        <td class="right"><Button size="sm" disabled={!r().model} onClick={() => { setSelected(r().key); setViewerOpen(true); }} aria-pressed={showViewer() && r().key === sel()?.key} aria-label={`View ${archLabel(arch)} ${stepLabel(r().step, r().template)} in 3D`}><Eye size={14} aria-hidden="true" /> View</Button></td>
                                      </tr>
                                    )}
                                  </Index>
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </Show>
                      );
                    }}
                  </For>
                </Show>
                <Show when={unmapped().length}>
                  <div class="stack-sm">
                    <h3>Files without an arch or step</h3>
                    <IssueList tone="bad" items={[{ message: 'Say which arch and step each of these belongs to before you submit.' }]} />
                    <div class="table-wrap">
                      <table class="table">
                        <tbody>
                          <For each={unmapped()}>
                            {(f) => (
                              <tr>
                                <td><FileCell f={f} c={c()} missing="" idle={idle()} onEdit={filesEditable() ? setMapFile : undefined} onRemove={filesEditable() ? (x) => removeFile.mutate(x.id) : undefined} showName /></td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </Show>
              </Card>

              <Show when={others().length}>
                <Card title="Other files">
                  <div class="table-wrap">
                    <table class="table">
                      <thead><tr><th>Name</th><th>State</th><th class="num">Size</th><th><span class="sr-only">Actions</span></th></tr></thead>
                      <tbody>
                        <For each={others()}>
                          {(f) => {
                            const iss = () => issuesFor(f, c());
                            return (
                              <tr>
                                <td>{f.name}<Show when={iss().errors.length || iss().warnings.length}><div><IssueList tone={iss().errors.length ? 'bad' : 'warn'} items={[...iss().errors, ...iss().warnings]} /></div></Show></td>
                                <td><Badge tone={fileTone(f.state, idle())}>{fileStateLabel(f.state, idle())}</Badge></td>
                                <td class="num nowrap">{formatBytes(f.size)}</td>
                                <td class="right">
                                  <div class="row" style={{ 'justify-content': 'flex-end', gap: '6px' }}>
                                    <Show when={can('file.download') && f.state === 'ready'}><a class="btn btn-sm" href={`/api/files/${f.id}/download`} aria-label={`Download ${f.name}`}><Download size={14} aria-hidden="true" /></a></Show>
                                    <Show when={filesEditable()}><Button size="sm" onClick={() => removeFile.mutate(f.id)} aria-label={`Remove ${f.name}`}><Trash2 size={14} aria-hidden="true" /></Button></Show>
                                  </div>
                                </td>
                              </tr>
                            );
                          }}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Card>
              </Show>

              <div class="grid-2">
                <InstructionsCard c={c()} onSaved={refresh} canWrite={canWrite()} staff={staff()} showSpec={showSpec()} />
                <Card title="Timeline">
                  <Show when={data()!.events.length !== 0} fallback={<p class="muted">Nothing has happened yet.</p>}>
                    <ol class="timeline">
                      <For each={mergeCheckedEvents([...data()!.events].sort((a, b) => new Date(b.at ?? b.createdAt ?? 0).getTime() - new Date(a.at ?? a.createdAt ?? 0).getTime()))}>
                        {({ e, n }) => (
                          <li>
                            <strong>{isPortalEvent(e) ? 'Status changed' : eventLabel(e.type)}{n > 1 ? ` (${n} times)` : ''}{eventStage(e) ? `: ${eventStage(e)}` : ''}</strong>
                            <div class="muted small">{formatDateTime(e.at ?? e.createdAt)}{eventWho(e) ? `, ${eventWho(e)}` : ''}</div>
                            <Show when={e.type === 'on_hold' && typeof eventData(e).reason === 'string'}><div class="small">{String(eventData(e).reason)}</div></Show>
                            <Show when={isPortalEvent(e) && typeof eventData(e).message === 'string'}><div class="small">{String(eventData(e).message)}</div></Show>
                          </li>
                        )}
                      </For>
                    </ol>
                  </Show>
                </Card>
              </div>

              <SubmitDialog open={dialog() === 'submit'} c={c()} onClose={() => setDialog(null)} onDone={onSubmitted} />
              <Dialog open={dialog() === 'cancel'} title="Cancel this case?" onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Keep the case</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel case</Button></>}>
                <p>K Line will not produce a cancelled case. You cannot undo this.</p>
              </Dialog>
              <Dialog open={dialog() === 'delete'} title="Delete this draft?" onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Keep the draft</Button><Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>Delete draft</Button></>}>
                <p>The draft and all of its files will be removed. You cannot undo this.</p>
              </Dialog>
              <Show when={staff()}>
                <RouteDialog c={c()} routing={routing()} open={dialog() === 'route'} onClose={() => setDialog(null)} onDone={onSubmitted} />
                <HoldDialog c={c()} open={dialog() === 'hold'} onClose={() => setDialog(null)} onDone={onSubmitted} />
                <ReleaseDialog c={c()} open={dialog() === 'release'} onClose={() => setDialog(null)} onDone={onSubmitted} />
                <StageDialog c={c()} open={dialog() === 'stage'} onClose={() => setDialog(null)} onDone={(text, tone) => { setDialog(null); setNotice({ tone, text }); refresh(); }} />
              </Show>
              <EraseDialog open={dialog() === 'erase'} c={c()} followUps={data()!.children?.length ?? 0} onClose={() => setDialog(null)} onDone={onSubmitted} />
              <ReplacementDialog showClaimHint={showClaims() && can('claim.write')} open={dialog() === 'replace'} c={c()} files={files()} onClose={() => setDialog(null)} onDone={(newId) => { setDialog(null); refresh(); nav(`/portal/cases/${newId}`); }} />
              <MapDialog file={mapFile()} onClose={() => setMapFile(null)} onDone={() => { setMapFile(null); refresh(); }} />
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}

function eventData(e: CaseEvent): Record<string, unknown> { return (e.data ?? e.details ?? {}) as Record<string, unknown>; }
function isPortalEvent(e: CaseEvent): boolean { return e.type === 'stage' && eventData(e).source === 'portal'; }
function eventStage(e: CaseEvent): string {
  const d = eventData(e);
  if (e.type === 'routed' || e.type === 'rerouted') return typeof d.site === 'string' ? d.site : '';
  if (e.type !== 'stage' && e.type !== 'stage_reported') return '';
  if (isPortalEvent(e)) return '';
  return typeof d.stage === 'string' ? stageLabel(d.stage) : '';
}
function eventWho(e: CaseEvent): string {
  if (e.actorLabel) return e.actorLabel;
  if (e.sourceLabel) return e.sourceLabel;
  const src = e.source ?? eventData(e).source;
  if (typeof src === 'string' && src) return sourceLabel(src);
  if (e.actorType === 'service') return 'Factory system';
  if (e.actorType === 'system') return 'System';
  return '';
}

function FileCell(props: { f?: CaseFile; c: CaseItem; missing: string; warnMissing?: boolean; onEdit?: (f: CaseFile) => void; onRemove?: (f: CaseFile) => void; idle?: boolean; showName?: boolean }) {
  const { can } = useAuth();
  return (
    <Show
      when={props.f}
      fallback={<Show when={props.missing}><Badge tone={props.warnMissing ? 'warn' : 'neutral'}>{props.missing}</Badge></Show>}
    >
      {(f) => {
        const iss = () => issuesFor(f(), props.c);
        return (
          <div class="stack-sm">
            <div class="row" style={{ gap: '6px' }}>
              <Show when={props.showName}><span>{f().name}</span></Show>
              <Badge tone={fileTone(f().state, props.idle)}>{fileStateLabel(f().state, props.idle)}</Badge>
              <span class="muted small">{formatBytes(f().size)}</span>
              <Show when={f().state === 'uploading' && props.idle && props.onRemove}><button type="button" class="btn btn-sm" onClick={() => props.onRemove!(f())} aria-label={`Remove ${f().name} and add it again`}>Remove</button></Show>
              <Show when={can('file.download') && f().state === 'ready'}><a class="small" href={`/api/files/${f().id}/download`} aria-label={`Download ${f().name}`}>Download</a></Show>
              <Show when={props.onEdit}><button type="button" class="btn btn-sm btn-ghost" onClick={() => props.onEdit!(f())} aria-label={`Change the arch and step of ${f().name}`}>Edit</button></Show>
            </div>
            <Show when={iss().errors.length || iss().warnings.length}><IssueList tone={iss().errors.length ? 'bad' : 'warn'} items={[...iss().errors, ...iss().warnings]} /></Show>
          </div>
        );
      }}
    </Show>
  );
}

function FactsCard(props: { c: CaseItem; staff: boolean; routing: Routing | null }) {
  const { can } = useAuth();
  const [name, setName] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => { if (timer) clearTimeout(timer); });
  const reveal = createMutation(() => ({
    mutationFn: () => api<{ patientName?: string; firstName?: string; lastName?: string }>(`/api/cases/${props.c.id}/reveal-name`, { method: 'POST', body: {} }),
    onSuccess: (r: { patientName?: string; firstName?: string; lastName?: string }) => {
      setErr(null);
      setName(r.firstName || r.lastName ? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() : (r.patientName ?? ''));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setName(null), 60_000);
    },
    onError: (e: unknown) => setErr(errorText(e)),
  }));
  return (
    <Card title="Case details">
      <dl class="facts">
        <dt>Reference</dt><dd>{props.c.ref}</dd>
        <Show when={props.staff}><dt>Partner</dt><dd>{props.c.orgName ?? 'Unknown'}<Show when={props.c.orgCode}><span class="muted"> ({props.c.orgCode})</span></Show></dd></Show>
        <Show when={props.c.caseId || props.c.manufacturingMode !== 'direct'}><dt>Case ID</dt><dd>{props.c.caseId ?? 'Not set'}</dd></Show>
        <dt>Patient</dt>
        <dd>
          <Switch fallback={<span class="muted">Not set</span>}>
            <Match when={!props.staff && props.c.patientName}>
              {/* The company that uploaded the name sees it in full: masking it from its own people adds nothing, so no "Show name" step and no access log entry. */}
              <strong>{props.c.patientName}</strong>
            </Match>
            <Match when={name() !== null}>
              <span class="row"><strong>{name() || 'No name stored'}</strong> <Button size="sm" onClick={() => setName(null)}>Hide</Button></span>
            </Match>
            <Match when={props.c.hasPatientName}>
              <span class="row"><span class="masked">{props.c.patientMasked}</span><Show when={can('case.reveal_name')}><Button size="sm" loading={reveal.isPending} onClick={() => reveal.mutate()}><Eye size={14} aria-hidden="true" /> Show name</Button></Show></span>
            </Match>
          </Switch>
          <Show when={err()}><div class="field-error">{err()}</div></Show>
          <Show when={props.staff && props.c.hasPatientName && can('case.reveal_name') && name() === null}><div class="hint">Showing the name is recorded. The partner sees it in their access log.</div></Show>
        </dd>
        <dt>Type</dt><dd>{humanise(props.c.kind)}{props.c.manufacturingMode === 'direct' ? ', direct manufacturing' : ''}</dd>
        <dt>Priority</dt><dd>{props.c.priority === 'rush' ? 'Rush' : 'Normal'}</dd>
        <dt>Site</dt><dd>{props.c.siteCode ?? 'Not chosen yet'}</dd>
        <Show when={props.staff && props.routing}>{(routing) => <><dt>Partner sites</dt><dd>{routing().sites.length ? routing().sites.map((s) => (s.allowed ? s.code : `${s.code} (blocked)`)).join(', ') : 'None'}<Show when={routing().partnerCountry}><div class="hint">Partner country {routing().partnerCountry}. Standard Contractual Clauses {routing().sccOnFile ? 'are on file' : 'are not on file'}.</div></Show></dd></>}</Show>
        <Show when={props.staff && props.routing?.mesCaseId}><dt>Factory case ID</dt><dd class="mono">{props.routing!.mesCaseId}</dd></Show>
        <dt>Stage</dt><dd>{props.c.stageLabel ?? (props.c.stage ? stageLabel(props.c.stage) : 'Not started')}</dd>
        <dt>Due date</dt><dd>{props.c.dueDate ? formatDate(props.c.dueDate) : 'Not set'}</dd>
        <dt>Created</dt><dd>{formatDateTime(props.c.createdAt)}</dd>
        <dt>Submitted</dt><dd>{props.c.submittedAt ? formatDateTime(props.c.submittedAt) : 'Not yet'}</dd>
        <Show when={props.c.expectedShipDate}><dt>Expected to ship</dt><dd>{formatDate(props.c.expectedShipDate!)}</dd></Show>
        <Show when={props.c.receivedAt}><dt>Received at factory</dt><dd>{formatDateTime(props.c.receivedAt)}</dd></Show>
      </dl>
    </Card>
  );
}

function InstructionsCard(props: { c: CaseItem; canWrite: boolean; onSaved: () => void; staff: boolean; showSpec: boolean }) {
  const editable = () => props.canWrite && OPEN_STATUSES.includes(props.c.status);
  const [editing, setEditing] = createSignal(false);
  const [text, setText] = createSignal('');
  const [msg, setMsg] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let fileInput!: HTMLInputElement;
  const known = () => props.c.instructions !== undefined;

  const save = createMutation(() => ({
    mutationFn: () => api(`/api/cases/${props.c.id}`, { method: 'PATCH', body: { instructions: text() } }),
    onSuccess: () => { setEditing(false); setMsg(null); setError(null); props.onSaved(); },
    onError: (e: unknown) => setError(e instanceof ApiError && e.code === 'instructions_locked' ? 'Instructions can no longer be changed because production has started.' : errorText(e)),
  }));

  async function loadFile(f: File | undefined) {
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const r = readInstructionBytes(f.name, bytes);
    if (r.text) setText(r.text);
    setMsg(r.message);
  }

  return (
    <Card title="Instructions" actions={editable() && !editing() ? <Button size="sm" onClick={() => { setText(props.c.instructions ?? ''); setEditing(true); setMsg(null); setError(null); }}>Edit</Button> : null}>
      <Switch fallback={<p class="muted">Instructions are stored encrypted. Choose Edit to add or replace them.</p>}>
        <Match when={editing()}>
          <div class="stack">
            <Show when={error()}><Notice tone="bad">{error()}</Notice></Show>
            <Show when={msg()}><Notice tone="warn">{msg()}</Notice></Show>
            <Show when={!known()}><Notice tone="warn">The current instructions are not shown here. Saving will replace them.</Notice></Show>
            <Field label="Instructions for K Line" hint={`${formatNumber(text().length)} of ${formatNumber(INSTRUCTIONS_MAX)} characters. Instructions are stored encrypted.`}>
              {(p) => <textarea {...p} value={text()} maxLength={INSTRUCTIONS_MAX} onInput={(e) => setText(e.currentTarget.value)} rows={8} />}
            </Field>
            <div class="row">
              <input ref={fileInput} type="file" accept=".txt,.md,.rtf,.docx,.doc" hidden onChange={(e) => { const input = e.currentTarget; void loadFile(input.files?.[0]); input.value = ''; }} aria-label="Choose a text or Word file" />
              <Button size="sm" onClick={() => fileInput.click()}><Upload size={14} aria-hidden="true" /> Load from a text or Word file</Button>
            </div>
            <div class="row-end">
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save instructions</Button>
            </div>
          </div>
        </Match>
        <Match when={known()}>
          <Show when={props.c.instructions} fallback={<p class="muted">No instructions were added.</p>}>
            <p style={{ 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere' }}>{props.c.instructions}</p>
          </Show>
        </Match>
      </Switch>
      <p class="small muted">
        Production specification:{' '}
        <Show
          when={props.c.specVersion}
          fallback={<span>no version recorded for this case</span>}
        >
          <Show
            when={props.showSpec}
            fallback={<span>Version {formatNumber(props.c.specVersion!)}</span>}
          >
            <A href={props.c.specId ? (props.staff ? `/console/specs/${props.c.orgId}/${props.c.specId}` : `/portal/spec/${props.c.specId}`) : (props.staff ? `/console/specs/${props.c.orgId}` : '/portal/spec')}>Version {formatNumber(props.c.specVersion!)}</A>
          </Show>
        </Show>
      </p>
    </Card>
  );
}

/** One row per run of "Files checked" events: a case with 14 files would otherwise list the same line 14 times. Expects newest first. */
function mergeCheckedEvents<T extends { type?: string }>(events: T[]): { e: T; n: number }[] {
  const out: { e: T; n: number }[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type === 'files_checked' && last && last.e.type === 'files_checked') last.n += 1;
    else out.push({ e, n: 1 });
  }
  return out;
}

/** Erasure on request. Says exactly what goes and what stays, and asks for the case reference to be typed. The authenticator prompt comes from the global step up host. */
function EraseDialog(props: { open: boolean; c: CaseItem; followUps: number; onClose: () => void; onDone: (text: string) => void }) {
  const mfa = useMfaRequired();
  const [typed, setTyped] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) { setTyped(''); setError(null); } }));
  // The portal keeps a copy only when the case really reached it. A direct case whose push failed has no copy there and no factory work.
  const direct = () => props.c.manufacturingMode === 'direct' && props.c.portal.status === 'pushed';
  const inFactory = () => ['ready', 'received', 'in_production'].includes(props.c.status) && (props.c.manufacturingMode !== 'direct' || props.c.portal.status === 'pushed');
  const m = createMutation(() => ({
    mutationFn: () => api<{ message: string; portalCopyRemains: boolean }>(`/api/cases/${props.c.id}/erase`, { method: 'POST', body: { confirmRef: typed().trim() } }),
    onSuccess: (r: { message: string }) => props.onDone(r.message),
    onError: (e: unknown) => setError(e instanceof ApiError && e.code === 'step_up_cancelled' ? 'The erasure was cancelled. Nothing was removed.' : errorText(e)),
  }));
  const matches = () => typed().trim().toLowerCase() === props.c.ref.toLowerCase();
  return (
    <Dialog
      open={props.open}
      title="Erase case data"
      wide
      onClose={props.onClose}
      footer={<><Button onClick={props.onClose}>Keep the case data</Button><Button variant="danger" loading={m.isPending} disabled={!matches()} onClick={() => { setError(null); m.mutate(); }}>Erase case data now</Button></>}
    >
      <div class="stack">
        <Show when={error()}><Notice tone="bad">{error()}</Notice></Show>
        <p>This removes the data of case <strong>{props.c.ref}</strong> now, before the retention period ends. <strong>You cannot undo this.</strong></p>
        <div>
          <h3>What is removed</h3>
          <ul>
            <li>All files of the case: models, trim lines, documents and photos. They can no longer be downloaded.</li>
            <li>The patient name and the instructions.</li>
            <Show when={props.c.caseId}><li>The case ID ({props.c.caseId}).</li></Show>
            <li>Text people typed around the case: hold reasons, the notes of quality claims on the case, and the case ID in webhook records.</li>
          </ul>
        </div>
        <div>
          <h3>What stays</h3>
          <ul>
            <li>The production record: the reference {props.c.ref}, status, stage, site, dates, aligner counts, carrier and tracking number.</li>
            <li>File counts and measurements, check results and the history of the case without free text.</li>
            <li>Claim numbers, decisions and dates, and the entries in your access log. The log records who erased the case and when.</li>
          </ul>
        </div>
        <Show when={direct()}><Notice tone="warn" title="The customer portal">The K Line portal keeps its own copy. Ask K Line to remove it there.</Notice></Show>
        <Show when={inFactory()}><Notice tone="warn">K Line is already working on this case. It will be told that the data was erased, and production cannot continue without the files.</Notice></Show>
        <Show when={props.followUps > 0}><Notice tone="info">This case has {props.followUps === 1 ? 'a follow up case' : `${props.followUps} follow up cases`} (a replacement or rework). {props.followUps === 1 ? 'It keeps' : 'They keep'} {props.followUps === 1 ? 'its' : 'their'} own copy of the data. Erase {props.followUps === 1 ? 'it' : 'them'} separately if needed.</Notice></Show>
        <Field label={`Type ${props.c.ref} to confirm`} hint={mfa() ? 'You will be asked for your authenticator code.' : undefined}>
          {(p) => <input {...p} value={typed()} autocomplete="off" spellcheck={false} onInput={(e) => setTyped(e.currentTarget.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

function SubmitDialog(props: { open: boolean; c: CaseItem; onClose: () => void; onDone: (text: string) => void }) {
  const [ack, setAck] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) { setAck(false); setError(null); } }));
  const hasErrors = () => props.c.checks.errors.length > 0;
  const hasWarnings = () => props.c.checks.warnings.length > 0;
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/cases/${props.c.id}/submit`, { method: 'POST', body: { acknowledgeWarnings: hasWarnings() && ack() } }),
    onSuccess: () => props.onDone(props.c.manufacturingMode === 'direct' ? 'The case was submitted. We are sending it to the customer portal.' : 'The case was submitted.'),
    onError: (e: unknown) => setError(e instanceof ApiError && e.code === 'org_not_approved' ? 'Uploads and submissions are locked until K Line approves your account.' : e instanceof ApiError && e.code === 'transfer_blocked' ? 'This case cannot be produced at any site allowed for your organisation. Contact K Line.' : errorText(e)),
  }));
  return (
    <Dialog
      open={props.open}
      title="Submit this case"
      onClose={props.onClose}
      wide
      footer={<><Button onClick={props.onClose}>Not yet</Button><Button variant="primary" loading={m.isPending} disabled={hasErrors() || (hasWarnings() && !ack())} onClick={() => { setError(null); m.mutate(); }}>Submit case</Button></>}
    >
      <div class="stack">
        <Show when={error()}><Notice tone="bad">{error()}</Notice></Show>
        <Show when={hasErrors()}><Notice tone="bad" title="Fix these errors first" /><IssueList tone="bad" items={props.c.checks.errors} /></Show>
        <Show when={hasWarnings()}>
          <Notice tone="warn" title="These warnings need your confirmation" />
          <IssueList tone="warn" items={props.c.checks.warnings} />
          <Toggle checked={ack()} onChange={setAck} label="I have read the warnings and want to submit anyway" hint="Your confirmation is stored with the case." />
        </Show>
        <Show when={!hasErrors() && !hasWarnings()}><p>All checks passed. Once submitted, K Line can start work on this case.</p></Show>
      </div>
    </Dialog>
  );
}

function MapDialog(props: { file: CaseFile | null; onClose: () => void; onDone: () => void }) {
  const [arch, setArch] = createSignal<'upper' | 'lower' | ''>('');
  const [step, setStep] = createSignal('');
  const [template, setTemplate] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // The form starts from the file each time a file is chosen.
  createEffect(on(() => props.file, (file) => {
    if (file) { setArch(file.arch ?? ''); setStep(file.step === null ? '' : String(file.step)); setTemplate(file.template); setError(null); }
  }));
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/files/${props.file!.id}`, { method: 'PATCH', body: { arch: arch(), step: Number(step()), template: template() } }),
    onSuccess: () => props.onDone(),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog open={!!props.file} title="Arch and step" onClose={props.onClose}>
      <div class="stack">
        <Show when={props.file}>{(f) => <p class="muted small">{f().name}</p>}</Show>
        <Show when={error()}><Notice tone="bad">{error()}</Notice></Show>
        <Field label="Arch">{(p) => <select {...p} value={arch()} onChange={(e) => setArch(e.currentTarget.value as 'upper' | 'lower' | '')}><option value="">Choose</option><option value="upper">Upper</option><option value="lower">Lower</option></select>}</Field>
        <Field label="Step">{(p) => <input {...p} type="number" min={0} max={999} value={step()} onInput={(e) => setStep(e.currentTarget.value)} />}</Field>
        <Toggle checked={template()} onChange={setTemplate} label="This is a template" />
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={!arch() || step() === ''} onClick={() => m.mutate()}>Save</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** One plain line about where the case stands and what to do next (review of 8 Oct 2026, A2 and R3). Integration errors never show here. */
function PlainStatus(props: { c: CaseItem }) {
  const st = () => caseStatus(props.c);
  const address = () => props.c.portal.actionNeeded === 'case_address';
  return (
    // the draft and hold notices already say it
    <Show when={props.c.status !== 'draft' && props.c.status !== 'on_hold'}>
      <Notice
        tone={address() ? 'warn' : st().tone === 'good' ? 'good' : 'info'}
        title={st().text}
        action={address() ? <A class="btn btn-sm" href="/portal/account#case-address">Open case address</A> : undefined}
      >
        {address()
          ? 'K Line needs your case address to send the aligners back. Add it, and we send this case on.'
          : props.c.manufacturingMode === 'direct' && props.c.portal.status === 'failed'
            ? 'Your case is safe with us. K Line has been told and keeps trying in the background. You do not need to do anything.'
            : st().next ?? 'You do not need to do anything now.'}
      </Notice>
    </Show>
  );
}

const KIND_LABEL: Record<string, string> = { new: 'New case', replacement: 'Replacement case', rework: 'Rework case' };

/** Parent and child cases, requested aligners and the claims on this case. */
function RelatedCard(props: { c: CaseItem; kids?: CaseChild[]; claims?: CaseClaimRef[]; staff: boolean }) {
  const base = () => (props.staff ? '/console/cases' : '/portal/cases');
  const claimBase = () => (props.staff ? '/console/claims' : '/portal/claims');
  const kids = () => props.kids ?? [];
  const requested = () => props.c.requestedItems ?? [];
  const list = () => props.claims ?? [];
  return (
    <Show when={props.c.parentId || kids().length || requested().length || list().length}>
      <Card title="Related cases and claims">
        <dl class="facts">
          <Show when={props.c.parentId}><dt>Original case</dt><dd><A href={`${base()}/${props.c.parentId}`}>{props.c.parentRef ?? 'Open the original case'}</A> <span class="muted small">(this is a {(KIND_LABEL[props.c.kind] ?? humanise(props.c.kind)).toLowerCase()})</span></dd></Show>
          <Show when={kids().length}><dt>Follow up cases</dt><dd class="stack-sm"><For each={kids()}>{(k) => <span class="row" style={{ gap: '8px' }}><A href={`${base()}/${k.id}`}>{k.ref}</A><span class="muted small">{KIND_LABEL[k.kind] ?? humanise(k.kind)}</span><Badge tone={statusTone(k.status)}>{statusLabel(k.status)}</Badge></span>}</For></dd></Show>
          <Show when={requested().length}><dt>Aligners requested</dt><dd>{requested().map((i) => alignerName(i as { arch: 'upper' | 'lower'; step: number; template?: boolean })).join(', ')}</dd></Show>
          <Show when={list().length}><dt>Claims</dt><dd class="stack-sm"><For each={list()}>{(k) => <span class="row" style={{ gap: '8px' }}><A href={`${claimBase()}/${k.id}`}>{k.number || 'Claim'}</A><Badge tone={claimStatusTone(k.status)}>{claimStatusLabel(k.status, props.staff ? 'kline' : 'partner')}</Badge><span class="muted small">{k.summary}</span></span>}</For></dd></Show>
        </dl>
      </Card>
    </Show>
  );
}

function ReplacementDialog(props: { showClaimHint: boolean; open: boolean; c: CaseItem; files: CaseFile[]; onClose: () => void; onDone: (newCaseId: string) => void }) {
  const aligners = createMemo(() => alignersOf(props.files));
  const [pick, setPick] = createSignal<Set<string>>(new Set());
  const [reason, setReason] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) { setPick(new Set<string>()); setReason(''); setError(null); } }));
  const m = createMutation(() => ({
    mutationFn: () => api<{ case?: { id: string }; id?: string }>(`/api/cases/${props.c.id}/replacement`, {
      method: 'POST',
      body: { items: aligners().filter((a) => pick().has(a.key)).map((a) => ({ arch: a.arch, step: a.step, template: a.template })), ...(reason().trim() ? { reason: reason().trim() } : {}) },
    }),
    onSuccess: (r: { case?: { id: string }; id?: string }) => props.onDone(r?.case?.id ?? r?.id ?? props.c.id),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog open={props.open} title="Order replacement aligners" wide onClose={props.onClose} footer={<><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!pick().size} onClick={() => { setError(null); m.mutate(); }}>Order {pick().size ? formatNumber(pick().size) : ''} {pick().size === 1 ? 'aligner' : 'aligners'}</Button></>}>
      <div class="stack">
        <Show when={error()}><Notice tone="bad">{error()}</Notice></Show>
        <p>This creates a new case linked to {props.c.ref}. K Line reuses the files it already has, so you do not upload anything again. The new case goes to K Line as a normal order.</p>
        <AlignerPicker
          legend="Which aligners do you need again?"
          aligners={aligners()}
          selected={pick()}
          onToggle={(k) => setPick((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
          onSetMany={(keys, checked) => setPick((p) => { const n = new Set(p); keys.forEach((k) => (checked ? n.add(k) : n.delete(k))); return n; })}
        />
        <Field label="Reason (optional)" hint="Do not type patient names.">
          {(p) => <textarea {...p} value={reason()} maxLength={500} rows={3} onInput={(e) => setReason(e.currentTarget.value)} />}
        </Field>
        <Show when={props.showClaimHint}><p class="small muted">If the aligners arrived faulty, report an issue instead. That lets K Line remake them as a rush order.</p></Show>
      </div>
    </Dialog>
  );
}
