import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Download, Eraser, Eye, FilePlus2, Flag, FolderPlus, PackagePlus, Pause, Play, RefreshCw, Route as RouteIcon, Send, Trash2, Upload, XCircle } from 'lucide-react';
import { parseFileName } from '@shared/filenames';
import { api, ApiError, errorText } from '../../lib/api';
import { useAuth, useMenu } from '../../lib/auth';
import { archLabel, eventLabel, formatBytes, formatDate, formatDateTime, formatNumber, humanise, portalLabel, portalTone, simpleStatusLabel, simpleStatusOf, simpleStatusTone, sourceLabel, stepLabel, statusLabel, statusTone } from '../../lib/format';
import { fallbackStepper, stageLabel } from '../../lib/stages';
import { INSTRUCTIONS_MAX, readInstructionBytes } from '../../lib/instructions';
import { readFileList } from '../../lib/intake';
import { isUploadable, uploadCaseFiles, type FileStatus, type UploadSpec } from '../../lib/upload';
import { CLAIMABLE_CASE_STATUSES, REPLACEABLE_CASE_STATUSES, alignerName, alignersOf, claimStatusLabel, claimStatusTone } from '../../lib/quality';
import type { CaseChild, CaseClaimRef, CaseDetail as CaseDetailData, CaseEvent, CaseFile, CaseItem, Issue, Routing } from '../../lib/types';
import { Badge, Button, Card, Dialog, Field, IssueList, Notice, PageHeader, ProgressBar, Spinner, Toggle } from '../../ui/Common';
import { Stepper } from '../../ui/Stepper';
import { HoldDialog, ReleaseDialog, RouteDialog, StageDialog } from '../console/caseActions';
import { AlignerPicker } from './ClaimNew';

const OPEN_STATUSES = ['draft', 'submitted', 'on_hold', 'ready'];

function fileTone(s: string) { return s === 'ready' ? 'good' : s === 'rejected' ? 'bad' : 'info'; }
function fileStateLabel(s: string) { return ({ uploading: 'Uploading', processing: 'Checking', ready: 'Ready', rejected: 'Rejected', purged: 'Removed' } as Record<string, string>)[s] ?? humanise(s); }

function issuesFor(f: CaseFile, c: CaseItem): { errors: Issue[]; warnings: Issue[] } {
  const errors = [...(f.validation?.errors ?? []), ...c.checks.errors.filter((i) => i.fileId === f.id)];
  const warnings = [...(f.validation?.warnings ?? []), ...c.checks.warnings.filter((i) => i.fileId === f.id)];
  return { errors, warnings };
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

/** Case page for partners, and for K Line staff when `staff` is set (same components, staff actions instead of partner edits). */
export default function CaseDetail({ staff = false }: { staff?: boolean }) {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  // Menu visibility (visibility only): people who may not see Quality claims or the Production spec get no links to them.
  const menu = useMenu();
  const showClaims = staff || menu.claims;
  const showSpec = staff || menu.spec;
  const q = useQuery({
    queryKey: [staff ? 'console-case' : 'case', id],
    queryFn: () => api<CaseDetailData>(staff ? `/api/console/cases/${id}` : `/api/cases/${id}`),
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      const busy = d.files.some((f) => f.state === 'uploading' || f.state === 'processing') || ['pending', 'pushing'].includes(d.case.portal.status);
      return busy ? 3000 : false;
    },
  });
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const [dialog, setDialog] = useState<'submit' | 'cancel' | 'delete' | 'route' | 'hold' | 'release' | 'stage' | 'replace' | 'erase' | null>(null);
  const [mapFile, setMapFile] = useState<CaseFile | null>(null);

  const data = q.data;
  const c = useMemo<CaseItem | undefined>(() => (data?.case && data.instructions !== undefined ? { ...data.case, instructions: data.instructions } : data?.case), [data]);
  const routing = data?.routing ?? null;
  const files = data?.files ?? [];
  const { rows, unmapped } = useMemo(() => buildManifest(files), [files]);
  const others = files.filter((f) => f.kind !== 'stl' && f.kind !== 'pts');
  const filesEditable = !staff && !!c && (c.status === 'draft' || c.status === 'on_hold') && can('case.write');

  const refresh = () => { for (const k of ['case', 'console-case', 'cases', 'console-cases', 'intake', 'console-overview']) qc.invalidateQueries({ queryKey: [k] }); };
  const back = staff ? '/console/cases' : '/portal/cases';

  const cancel = useMutation({
    mutationFn: () => api(`/api/cases/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: () => { setDialog(null); setNotice({ tone: 'good', text: 'The case was cancelled.' }); refresh(); },
    onError: (e) => { setDialog(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  });
  const del = useMutation({
    mutationFn: () => api(`/api/cases/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cases'] }); nav(back, { replace: true }); },
    onError: (e) => { setDialog(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  });
  const refreshPortal = useMutation({
    mutationFn: () => api<{ case: CaseItem }>(`/api/cases/${id}/portal/refresh`, { method: 'POST', body: {} }),
    onSuccess: (r) => {
      setNotice(r.case.portal.syncError ? { tone: 'warn', text: r.case.portal.syncError } : { tone: 'good', text: 'Checked the K Line portal.' });
      refresh();
    },
    onError: (e) => setNotice({ tone: 'bad', text: errorText(e) }),
  });
  const retry = useMutation({
    mutationFn: () => api(`/api/cases/${id}/portal/retry`, { method: 'POST', body: {} }),
    onSuccess: () => { setNotice({ tone: 'good', text: 'We will try sending this case to the portal again.' }); refresh(); },
    onError: (e) => setNotice({ tone: 'bad', text: errorText(e) }),
  });
  const removeFile = useMutation({
    mutationFn: (fid: string) => api(`/api/files/${fid}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => setNotice({ tone: 'bad', text: errorText(e) }),
  });

  // Opening a case that was sent to the K Line portal checks the portal once, so the status is current without waiting for the 10 minute sync.
  const autoChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!c || c.manufacturingMode !== 'direct' || c.portal.status !== 'pushed' || c.portal.demo) return;
    if (['shipped', 'delivered', 'cancelled'].includes(c.status) || autoChecked.current === c.id) return;
    const last = c.portal.syncedAt ? Date.parse(c.portal.syncedAt) : 0;
    if (Date.now() - last < 2 * 60 * 1000) return;
    autoChecked.current = c.id;
    api(`/api/cases/${c.id}/portal/refresh`, { method: 'POST', body: {} }).then(() => refresh()).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.id, c?.status, c?.portal.status, c?.portal.syncedAt]);

  if (q.isLoading) return <div className="page"><Spinner /></div>;
  if (q.isError || !c) {
    return (
      <div className="page">
        <Notice tone="bad" title="We could not open this case">{errorText(q.error)}</Notice>
        <div><Link to={back}>Back to cases</Link></div>
      </div>
    );
  }

  const canWrite = !staff && can('case.write');
  const canRoute = staff && can('intake.manage');
  const canStage = staff && can('stage.manual') && STAFF_STAGE_STATUSES.includes(c.status);
  const canBags = staff && (can('file.download') || can('stage.manual')) && ['ready', 'received', 'in_production', 'shipped', 'delivered'].includes(c.status);
  const direct = c.manufacturingMode === 'direct';
  const erased = !!c.purgedAt;
  const canErase = can('case.erase') && c.status !== 'draft' && !erased;

  return (
    <div className="page">
      <div><Link to={back} className="small">Back to cases</Link></div>
      <PageHeader
        title={<span className="row" style={{ gap: 12 }}>{c.ref} {staff ? <><Badge tone={statusTone(c.status)}>{statusLabel(c.status)}</Badge><Badge tone={simpleStatusTone(simpleStatusOf(c))} title="Shown to the partner">{simpleStatusLabel(simpleStatusOf(c))}</Badge></> : <Badge tone={simpleStatusTone(simpleStatusOf(c))}>{simpleStatusLabel(simpleStatusOf(c))}</Badge>}{direct ? <Badge tone="info">Direct manufacturing</Badge> : null}</span>}
        subtitle={c.caseId ? `Case ID ${c.caseId}` : undefined}
        actions={
          <>
            {canWrite && (c.status === 'draft' || c.status === 'on_hold') ? <Button variant="primary" onClick={() => setDialog('submit')}><Send size={16} aria-hidden="true" /> {c.status === 'on_hold' ? 'Submit again' : 'Submit case'}</Button> : null}
            {canRoute && c.status === 'submitted' ? <Button variant="primary" onClick={() => setDialog('route')}><RouteIcon size={16} aria-hidden="true" /> Send to a site</Button> : null}
            {canRoute && c.status === 'ready' ? <Button onClick={() => setDialog('route')}><RouteIcon size={16} aria-hidden="true" /> Change site</Button> : null}
            {canRoute && c.status === 'on_hold' ? <Button variant="primary" onClick={() => setDialog('release')}><Play size={16} aria-hidden="true" /> Release</Button> : null}
            {canRoute && (c.status === 'submitted' || c.status === 'ready') ? <Button onClick={() => setDialog('hold')}><Pause size={16} aria-hidden="true" /> Put on hold</Button> : null}
            {canStage ? <Button onClick={() => setDialog('stage')}><ClipboardList size={16} aria-hidden="true" /> Update stage</Button> : null}
            {canBags ? <a className="btn" href={`/api/cases/${c.id}/bags.csv`}><Download size={16} aria-hidden="true" /> Bag print file</a> : null}
            {can('file.download') && files.some((f) => f.state === 'ready') ? <a className="btn" href={`/api/cases/${c.id}/package.zip`}><Download size={16} aria-hidden="true" /> Production package</a> : null}
            {!staff && showClaims && can('claim.write') && CLAIMABLE_CASE_STATUSES.includes(c.status) ? <Link className="btn" to={`/portal/cases/${c.id}/claim`}><Flag size={16} aria-hidden="true" /> Report an issue</Link> : null}
            {canWrite && REPLACEABLE_CASE_STATUSES.includes(c.status) ? <Button onClick={() => setDialog('replace')}><PackagePlus size={16} aria-hidden="true" /> Order replacement</Button> : null}
            {canWrite && !c.purgedAt && OPEN_STATUSES.includes(c.status) ? <Button onClick={() => setDialog('cancel')}><XCircle size={16} aria-hidden="true" /> Cancel case</Button> : null}
            {canWrite && c.status === 'draft' ? <Button variant="danger" onClick={() => setDialog('delete')}><Trash2 size={16} aria-hidden="true" /> Delete draft</Button> : null}
            {canErase ? <Button variant="danger" onClick={() => setDialog('erase')}><Eraser size={16} aria-hidden="true" /> Erase case data</Button> : null}
          </>
        }
      />
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      {erased ? <Notice tone="info" title="The data of this case was removed">The files, the patient name, the instructions and the text people typed were removed on {formatDate(c.purgedAt!)}. Only the production record is kept: the reference, status, dates, counts and history.</Notice> : null}
      {c.status === 'on_hold' ? (
        <Notice
          tone="warn"
          title="This case is on hold"
          action={canWrite ? <Button size="sm" variant="primary" onClick={() => setDialog('submit')}>Submit again</Button> : undefined}
        >
          {c.holdReason ?? 'K Line needs something before work can start.'}
          {canWrite ? <div className="small" style={{ marginTop: 4 }}>Fix the files or details, then submit the case again. K Line will look at it as soon as you do.</div> : null}
        </Notice>
      ) : null}
      <Card title="Progress">
        <Stepper steps={c.stepper ?? fallbackStepper(c)} cancelled={c.status === 'cancelled'} cancelledAt={c.cancelledAt} />
        {c.expectedShipDate && !['shipped', 'delivered', 'cancelled'].includes(c.status) ? <p className="small muted">Expected to ship on {formatDate(c.expectedShipDate)}.</p> : null}
      </Card>
      {c.carrier || c.trackingNumber || c.shippedAt ? (
        <Card title="Shipping">
          <dl className="facts">
            <dt>Carrier</dt><dd>{c.carrier ?? 'Not given'}</dd>
            <dt>Tracking number</dt><dd>{c.trackingNumber ? <span className="mono">{c.trackingNumber}</span> : 'Not given'}</dd>
            <dt>Aligners shipped</dt><dd>{formatNumber(c.counts.shipped)}</dd>
            <dt>Shipped</dt><dd>{c.shippedAt ? formatDate(c.shippedAt) : 'Not yet'}</dd>
            {c.deliveredAt ? <><dt>Delivered</dt><dd>{formatDate(c.deliveredAt)}</dd></> : null}
          </dl>
        </Card>
      ) : null}
      {!staff && c.status === 'draft' ? <Notice tone="info">This case is a draft. K Line will not start work until you submit it.</Notice> : null}

      {direct ? (
        <Card title="Customer portal">
          <div className="row">
            <Badge tone={portalTone(c.portal.status, c.portal.demo)}>{portalLabel(c.portal.status, c.portal.demo)}</Badge>
            {c.portal.status === 'pushing' && c.portal.step ? <span className="muted small">Step {c.portal.step} of {c.portal.steps ?? 3}: {['', 'Creating the case', 'Sending the files, this can take a few minutes', 'Submitting the case'][c.portal.step] ?? 'Working'}</span> : null}
            {c.portal.attempts ? <span className="muted small">{formatNumber(c.portal.attempts)} {c.portal.attempts === 1 ? 'attempt' : 'attempts'}</span> : null}
            {c.portal.status === 'failed' && canWrite && !c.purgedAt ? <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()}><RefreshCw size={14} aria-hidden="true" /> Try again</Button> : null}
          </div>
          {c.portal.status === 'failed' && c.portal.lastError ? (
            <Notice tone="bad" title="Last error" action={/case address/i.test(c.portal.lastError) && canWrite ? <Link className="btn btn-sm" to="/portal/company#case-address">Open case address</Link> : undefined}>{c.portal.lastError}</Notice>
          ) : null}
          {c.portal.demo && c.portal.status === 'pushed' ? <p className="small muted">This company has no K Line portal connection, so a demo copy was used. Add the address, key and user ID in the portal settings to send real cases.</p> : null}
          {c.portal.status === 'pushed' && !c.portal.demo ? (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="small">
                Status at the K Line portal: <strong>{c.portal.portalStatusLabel ?? 'Not checked yet'}</strong>
                {c.portal.syncedAt ? <span className="muted"> (checked {formatDateTime(c.portal.syncedAt)})</span> : null}
              </span>
              {!['shipped', 'delivered', 'cancelled'].includes(c.status) ? (
                <Button size="sm" loading={refreshPortal.isPending} onClick={() => refreshPortal.mutate()}><RefreshCw size={14} aria-hidden="true" /> Refresh from portal</Button>
              ) : null}
            </div>
          ) : null}
          {c.portal.status === 'pushed' && !c.portal.demo && c.portal.syncError ? <p className="small muted" role="status">The last check did not work: {c.portal.syncError}</p> : null}
        </Card>
      ) : null}

      <RelatedCard c={c} kids={data!.children} claims={showClaims ? data!.claims : []} staff={staff} />

      <div className="grid-2">
        <Card title="Checks">
          {c.checks.errors.length === 0 && c.checks.warnings.length === 0 ? <Notice tone="good">All checks passed.</Notice> : null}
          {c.checks.errors.length ? <><h3>Errors</h3><p className="small muted">These are for your information. They do not stop the case from being submitted.</p><IssueList tone="bad" items={c.checks.errors} /></> : null}
          {c.checks.warnings.length ? <><h3>Warnings</h3><p className="small muted">They do not stop the case from being submitted or produced.</p><IssueList tone="warn" items={c.checks.warnings} /></> : null}
        </Card>
        <FactsCard c={c} staff={staff} routing={routing} />
      </div>

      <Card title="Aligners" actions={filesEditable ? <AddFilesButtons caseId={c.id} onDone={refresh} /> : null}>
        {rows.length === 0 && unmapped.length === 0 ? <p className="muted">No models yet.{filesEditable ? ' Add files to get started.' : ''}</p> : null}
        {rows.length ? (
          <>
            {(['upper', 'lower'] as const).map((arch) => {
              const list = rows.filter((r) => r.arch === arch);
              if (!list.length) return null;
              return (
                <div key={arch} className="stack-sm">
                  <h3>{archLabel(arch)} arch, {formatNumber(list.filter((r) => !r.template).length)} steps</h3>
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr><th>Step</th><th>Model</th><th>Trim line</th></tr></thead>
                      <tbody>
                        {list.map((r) => (
                          <tr key={r.key}>
                            <td className="nowrap"><strong>{stepLabel(r.step, r.template)}</strong></td>
                            <td><FileCell f={r.model} c={c} missing="Missing" onEdit={filesEditable ? setMapFile : undefined} /></td>
                            <td><FileCell f={r.pts} c={c} missing={r.model ? 'Missing' : 'None'} warnMissing={!!r.model} onEdit={filesEditable ? setMapFile : undefined} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </>
        ) : null}
        {unmapped.length ? (
          <div className="stack-sm">
            <h3>Files without an arch or step</h3>
            <IssueList tone="bad" items={[{ message: 'Say which arch and step each of these belongs to before you submit.' }]} />
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {unmapped.map((f) => (
                    <tr key={f.id}>
                      <td><FileCell f={f} c={c} missing="" onEdit={filesEditable ? setMapFile : undefined} showName /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </Card>

      {others.length ? (
        <Card title="Other files">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>State</th><th className="num">Size</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {others.map((f) => {
                  const iss = issuesFor(f, c);
                  return (
                    <tr key={f.id}>
                      <td>{f.name}{iss.errors.length || iss.warnings.length ? <div><IssueList tone={iss.errors.length ? 'bad' : 'warn'} items={[...iss.errors, ...iss.warnings]} /></div> : null}</td>
                      <td><Badge tone={fileTone(f.state)}>{fileStateLabel(f.state)}</Badge></td>
                      <td className="num nowrap">{formatBytes(f.size)}</td>
                      <td className="right">
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                          {can('file.download') && f.state === 'ready' ? <a className="btn btn-sm" href={`/api/files/${f.id}/download`} aria-label={`Download ${f.name}`}><Download size={14} aria-hidden="true" /></a> : null}
                          {filesEditable ? <Button size="sm" onClick={() => removeFile.mutate(f.id)} aria-label={`Remove ${f.name}`}><Trash2 size={14} aria-hidden="true" /></Button> : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <div className="grid-2">
        <InstructionsCard c={c} onSaved={refresh} canWrite={canWrite} staff={staff} showSpec={showSpec} />
        <Card title="Timeline">
          {data!.events.length === 0 ? <p className="muted">Nothing has happened yet.</p> : (
            <ol className="timeline">
              {mergeCheckedEvents([...data!.events].sort((a, b) => new Date(b.at ?? b.createdAt ?? 0).getTime() - new Date(a.at ?? a.createdAt ?? 0).getTime())).map(({ e, n }, i) => (
                <li key={e.id ?? i}>
                  <strong>{isPortalEvent(e) ? 'Status changed' : eventLabel(e.type)}{n > 1 ? ` (${n} times)` : ''}{eventStage(e) ? `: ${eventStage(e)}` : ''}</strong>
                  <div className="muted small">{formatDateTime(e.at ?? e.createdAt)}{eventWho(e) ? `, ${eventWho(e)}` : ''}</div>
                  {e.type === 'on_hold' && typeof eventData(e).reason === 'string' ? <div className="small">{String(eventData(e).reason)}</div> : null}
                  {isPortalEvent(e) && typeof eventData(e).message === 'string' ? <div className="small">{String(eventData(e).message)}</div> : null}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <SubmitDialog open={dialog === 'submit'} c={c} onClose={() => setDialog(null)} onDone={(text) => { setDialog(null); setNotice({ tone: 'good', text }); refresh(); }} />
      <Dialog open={dialog === 'cancel'} title="Cancel this case?" onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Keep the case</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel case</Button></>}>
        <p>K Line will not produce a cancelled case. You cannot undo this.</p>
      </Dialog>
      <Dialog open={dialog === 'delete'} title="Delete this draft?" onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Keep the draft</Button><Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>Delete draft</Button></>}>
        <p>The draft and all of its files will be removed. You cannot undo this.</p>
      </Dialog>
      {staff ? (
        <>
          <RouteDialog c={c} routing={routing} open={dialog === 'route'} onClose={() => setDialog(null)} onDone={(text) => { setDialog(null); setNotice({ tone: 'good', text }); refresh(); }} />
          <HoldDialog c={c} open={dialog === 'hold'} onClose={() => setDialog(null)} onDone={(text) => { setDialog(null); setNotice({ tone: 'good', text }); refresh(); }} />
          <ReleaseDialog c={c} open={dialog === 'release'} onClose={() => setDialog(null)} onDone={(text) => { setDialog(null); setNotice({ tone: 'good', text }); refresh(); }} />
          <StageDialog c={c} open={dialog === 'stage'} onClose={() => setDialog(null)} onDone={(text, tone) => { setDialog(null); setNotice({ tone, text }); refresh(); }} />
        </>
      ) : null}
      <EraseDialog open={dialog === 'erase'} c={c} followUps={data!.children?.length ?? 0} onClose={() => setDialog(null)} onDone={(text) => { setDialog(null); setNotice({ tone: 'good', text }); refresh(); }} />
      <ReplacementDialog showClaimHint={showClaims && can('claim.write')} open={dialog === 'replace'} c={c} files={files} onClose={() => setDialog(null)} onDone={(newId) => { setDialog(null); refresh(); nav(`/portal/cases/${newId}`); }} />
      <MapDialog file={mapFile} onClose={() => setMapFile(null)} onDone={() => { setMapFile(null); refresh(); }} />
    </div>
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

function FileCell({ f, c, missing, warnMissing, onEdit, showName }: { f?: CaseFile; c: CaseItem; missing: string; warnMissing?: boolean; onEdit?: (f: CaseFile) => void; showName?: boolean }) {
  const { can } = useAuth();
  if (!f) return missing ? <Badge tone={warnMissing ? 'warn' : 'neutral'}>{missing}</Badge> : null;
  const iss = issuesFor(f, c);
  return (
    <div className="stack-sm">
      <div className="row" style={{ gap: 6 }}>
        {showName ? <span>{f.name}</span> : null}
        <Badge tone={fileTone(f.state)}>{fileStateLabel(f.state)}</Badge>
        <span className="muted small">{formatBytes(f.size)}</span>
        {can('file.download') && f.state === 'ready' ? <a className="small" href={`/api/files/${f.id}/download`} aria-label={`Download ${f.name}`}>Download</a> : null}
        {onEdit ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => onEdit(f)} aria-label={`Change the arch and step of ${f.name}`}>Edit</button> : null}
      </div>
      {iss.errors.length || iss.warnings.length ? <IssueList tone={iss.errors.length ? 'bad' : 'warn'} items={[...iss.errors, ...iss.warnings]} /> : null}
    </div>
  );
}

function FactsCard({ c, staff, routing }: { c: CaseItem; staff: boolean; routing: Routing | null }) {
  const { can } = useAuth();
  const [name, setName] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const reveal = useMutation({
    mutationFn: () => api<{ patientName?: string; firstName?: string; lastName?: string }>(`/api/cases/${c.id}/reveal-name`, { method: 'POST', body: {} }),
    onSuccess: (r) => {
      setErr(null);
      setName(r.firstName || r.lastName ? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() : (r.patientName ?? ''));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setName(null), 60_000);
    },
    onError: (e) => setErr(errorText(e)),
  });
  return (
    <Card title="Case details">
      <dl className="facts">
        <dt>Reference</dt><dd>{c.ref}</dd>
        {staff ? <><dt>Partner</dt><dd>{c.orgName ?? 'Unknown'}{c.orgCode ? <span className="muted"> ({c.orgCode})</span> : null}</dd></> : null}
        <dt>Case ID</dt><dd>{c.caseId ?? 'None'}</dd>
        <dt>Patient</dt>
        <dd>
          {name !== null ? (
            <span className="row"><strong>{name || 'No name stored'}</strong> <Button size="sm" onClick={() => setName(null)}>Hide</Button></span>
          ) : c.hasPatientName ? (
            <span className="row"><span className="masked">{c.patientMasked}</span>{can('case.reveal_name') ? <Button size="sm" loading={reveal.isPending} onClick={() => reveal.mutate()}><Eye size={14} aria-hidden="true" /> Show name</Button> : null}</span>
          ) : <span className="muted">Not given</span>}
          {err ? <div className="field-error">{err}</div> : null}
          {c.hasPatientName && can('case.reveal_name') && name === null ? <div className="hint">{staff ? 'Showing the name is recorded. The partner sees it in their access log.' : 'Showing the name is recorded in your access log.'}</div> : null}
        </dd>
        <dt>Type</dt><dd>{humanise(c.kind)}{c.manufacturingMode === 'direct' ? ', direct manufacturing' : ''}</dd>
        <dt>Priority</dt><dd>{c.priority === 'rush' ? 'Rush' : 'Normal'}</dd>
        <dt>Site</dt><dd>{c.siteCode ?? 'Not chosen yet'}</dd>
        {staff && routing ? <><dt>Partner sites</dt><dd>{routing.sites.length ? routing.sites.map((s) => (s.allowed ? s.code : `${s.code} (blocked)`)).join(', ') : 'None'}{routing.partnerCountry ? <div className="hint">Partner country {routing.partnerCountry}. Standard Contractual Clauses {routing.sccOnFile ? 'are on file' : 'are not on file'}.</div> : null}</dd></> : null}
        {staff && routing?.mesCaseId ? <><dt>Factory case ID</dt><dd className="mono">{routing.mesCaseId}</dd></> : null}
        <dt>Stage</dt><dd>{c.stageLabel ?? (c.stage ? stageLabel(c.stage) : 'Not started')}</dd>
        <dt>Due date</dt><dd>{c.dueDate ? formatDate(c.dueDate) : 'Not set'}</dd>
        <dt>Created</dt><dd>{formatDateTime(c.createdAt)}</dd>
        <dt>Submitted</dt><dd>{c.submittedAt ? formatDateTime(c.submittedAt) : 'Not yet'}</dd>
        {c.expectedShipDate ? <><dt>Expected to ship</dt><dd>{formatDate(c.expectedShipDate)}</dd></> : null}
        {c.receivedAt ? <><dt>Received at factory</dt><dd>{formatDateTime(c.receivedAt)}</dd></> : null}
      </dl>
    </Card>
  );
}

function InstructionsCard({ c, canWrite, onSaved, staff, showSpec }: { c: CaseItem; canWrite: boolean; onSaved: () => void; staff: boolean; showSpec: boolean }) {
  const editable = canWrite && OPEN_STATUSES.includes(c.status);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const known = c.instructions !== undefined;

  const save = useMutation({
    mutationFn: () => api(`/api/cases/${c.id}`, { method: 'PATCH', body: { instructions: text } }),
    onSuccess: () => { setEditing(false); setMsg(null); setError(null); onSaved(); },
    onError: (e) => setError(e instanceof ApiError && e.code === 'instructions_locked' ? 'Instructions can no longer be changed because production has started.' : errorText(e)),
  });

  async function loadFile(f: File | undefined) {
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const r = readInstructionBytes(f.name, bytes);
    if (r.text) setText(r.text);
    setMsg(r.message);
  }

  return (
    <Card title="Instructions" actions={editable && !editing ? <Button size="sm" onClick={() => { setText(c.instructions ?? ''); setEditing(true); setMsg(null); setError(null); }}>Edit</Button> : null}>
      {editing ? (
        <div className="stack">
          {error ? <Notice tone="bad">{error}</Notice> : null}
          {msg ? <Notice tone="warn">{msg}</Notice> : null}
          {!known ? <Notice tone="warn">The current instructions are not shown here. Saving will replace them.</Notice> : null}
          <Field label="Instructions for K Line" hint={`${formatNumber(text.length)} of ${formatNumber(INSTRUCTIONS_MAX)} characters. Instructions are stored encrypted.`}>
            {(p) => <textarea {...p} value={text} maxLength={INSTRUCTIONS_MAX} onChange={(e) => setText(e.target.value)} rows={8} />}
          </Field>
          <div className="row">
            <input ref={fileInput} type="file" accept=".txt,.md,.rtf,.docx,.doc" hidden onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ''; }} aria-label="Choose a text or Word file" />
            <Button size="sm" onClick={() => fileInput.current?.click()}><Upload size={14} aria-hidden="true" /> Load from a text or Word file</Button>
          </div>
          <div className="row-end">
            <Button onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save instructions</Button>
          </div>
        </div>
      ) : known ? (
        c.instructions ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.instructions}</p> : <p className="muted">No instructions were added.</p>
      ) : <p className="muted">Instructions are stored encrypted. Choose Edit to add or replace them.</p>}
      <p className="small muted">
        Production specification:{' '}
        {c.specVersion && !showSpec ? <span>Version {formatNumber(c.specVersion)}</span> : c.specVersion ? (
          <Link to={c.specId ? (staff ? `/console/specs/${c.orgId}/${c.specId}` : `/portal/spec/${c.specId}`) : (staff ? `/console/specs/${c.orgId}` : '/portal/spec')}>Version {formatNumber(c.specVersion)}</Link>
        ) : <span>no version recorded for this case</span>}
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
function EraseDialog({ open, c, followUps, onClose, onDone }: { open: boolean; c: CaseItem; followUps: number; onClose: () => void; onDone: (text: string) => void }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setTyped(''); setError(null); } }, [open]);
  // The portal keeps a copy only when the case really reached it. A direct case whose push failed has no copy there and no factory work.
  const direct = c.manufacturingMode === 'direct' && c.portal.status === 'pushed';
  const inFactory = ['ready', 'received', 'in_production'].includes(c.status) && (c.manufacturingMode !== 'direct' || c.portal.status === 'pushed');
  const m = useMutation({
    mutationFn: () => api<{ message: string; portalCopyRemains: boolean }>(`/api/cases/${c.id}/erase`, { method: 'POST', body: { confirmRef: typed.trim() } }),
    onSuccess: (r) => onDone(r.message),
    onError: (e) => setError(e instanceof ApiError && e.code === 'step_up_cancelled' ? 'The erasure was cancelled. Nothing was removed.' : errorText(e)),
  });
  const matches = typed.trim().toLowerCase() === c.ref.toLowerCase();
  return (
    <Dialog
      open={open}
      title="Erase case data"
      wide
      onClose={onClose}
      footer={<><Button onClick={onClose}>Keep the case data</Button><Button variant="danger" loading={m.isPending} disabled={!matches} onClick={() => { setError(null); m.mutate(); }}>Erase case data now</Button></>}
    >
      <div className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <p>This removes the data of case <strong>{c.ref}</strong> now, before the retention period ends. <strong>You cannot undo this.</strong></p>
        <div>
          <h3>What is removed</h3>
          <ul>
            <li>All files of the case: models, trim lines, documents and photos. They can no longer be downloaded.</li>
            <li>The patient name and the instructions.</li>
            <li>The case ID{c.caseId ? ` (${c.caseId})` : ''}{direct ? ', which is the patient ID of a direct manufacturing case' : ''}.</li>
            <li>Text people typed around the case: hold reasons, the notes of quality claims on the case, and the case ID in webhook records.</li>
          </ul>
        </div>
        <div>
          <h3>What stays</h3>
          <ul>
            <li>The production record: the reference {c.ref}, status, stage, site, dates, aligner counts, carrier and tracking number.</li>
            <li>File counts and measurements, check results and the history of the case without free text.</li>
            <li>Claim numbers, decisions and dates, and the entries in your access log. The log records who erased the case and when.</li>
          </ul>
        </div>
        {direct ? <Notice tone="warn" title="The customer portal">The K Line portal keeps its own copy. Ask K Line to remove it there.</Notice> : null}
        {inFactory ? <Notice tone="warn">K Line is already working on this case. It will be told that the data was erased, and production cannot continue without the files.</Notice> : null}
        {followUps > 0 ? <Notice tone="info">This case has {followUps === 1 ? 'a follow up case' : `${followUps} follow up cases`} (a replacement or rework). {followUps === 1 ? 'It keeps' : 'They keep'} {followUps === 1 ? 'its' : 'their'} own copy of the data. Erase {followUps === 1 ? 'it' : 'them'} separately if needed.</Notice> : null}
        <Field label={`Type ${c.ref} to confirm`} hint="You will be asked for your authenticator code.">
          {(p) => <input {...p} value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

function SubmitDialog({ open, c, onClose, onDone }: { open: boolean; c: CaseItem; onClose: () => void; onDone: (text: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) setError(null); }, [open]);
  const hasErrors = c.checks.errors.length > 0;
  const hasWarnings = c.checks.warnings.length > 0;
  const m = useMutation({
    mutationFn: () => api(`/api/cases/${c.id}/submit`, { method: 'POST', body: { acknowledgeWarnings: hasWarnings } }),
    onSuccess: () => onDone(c.manufacturingMode === 'direct' ? 'The case was submitted. We are sending it to the customer portal.' : 'The case was submitted.'),
    onError: (e) => setError(e instanceof ApiError && e.code === 'org_not_approved' ? 'Uploads and submissions are locked until K Line approves your account.' : e instanceof ApiError && e.code === 'transfer_blocked' ? 'This case cannot be produced at any site allowed for your organisation. Contact K Line.' : errorText(e)),
  });
  return (
    <Dialog
      open={open}
      title="Submit this case"
      onClose={onClose}
      wide
      footer={<><Button onClick={onClose}>Not yet</Button><Button variant="primary" loading={m.isPending} onClick={() => { setError(null); m.mutate(); }}>Submit case</Button></>}
    >
      <div className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        {hasErrors ? <><Notice tone="bad" title="The checks found these errors" /><IssueList tone="bad" items={c.checks.errors} /></> : null}
        {hasWarnings ? <><Notice tone="warn" title="The checks found these warnings" /><IssueList tone="warn" items={c.checks.warnings} /></> : null}
        {!hasErrors && !hasWarnings ? <p>All checks passed. Once submitted, K Line can start work on this case.</p> : null}
      </div>
    </Dialog>
  );
}

function MapDialog({ file, onClose, onDone }: { file: CaseFile | null; onClose: () => void; onDone: () => void }) {
  const [arch, setArch] = useState<'upper' | 'lower' | ''>('');
  const [step, setStep] = useState('');
  const [template, setTemplate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forId, setForId] = useState<string | null>(null);
  if (file && forId !== file.id) { setForId(file.id); setArch(file.arch ?? ''); setStep(file.step === null ? '' : String(file.step)); setTemplate(file.template); setError(null); }
  const m = useMutation({
    mutationFn: () => api(`/api/files/${file!.id}`, { method: 'PATCH', body: { arch, step: Number(step), template } }),
    onSuccess: () => { setForId(null); onDone(); },
    onError: (e) => setError(errorText(e)),
  });
  const close = () => { setForId(null); onClose(); };
  return (
    <Dialog open={!!file} title="Arch and step" onClose={close}>
      <div className="stack">
        {file ? <p className="muted small">{file.name}</p> : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Arch">{(p) => <select {...p} value={arch} onChange={(e) => setArch(e.target.value as 'upper' | 'lower' | '')}><option value="">Choose</option><option value="upper">Upper</option><option value="lower">Lower</option></select>}</Field>
        <Field label="Step">{(p) => <input {...p} type="number" min={0} max={999} value={step} onChange={(e) => setStep(e.target.value)} />}</Field>
        <Toggle checked={template} onChange={setTemplate} label="This is a template" />
        <div className="row-end">
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={!arch || step === ''} onClick={() => m.mutate()}>Save</Button>
        </div>
      </div>
    </Dialog>
  );
}

function AddFilesButtons({ caseId, onDone }: { caseId: string; onDone: () => void }) {
  const filesRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Record<string, FileStatus>>({});
  const [notes, setNotes] = useState<string[]>([]);

  async function run(list: FileList | null) {
    if (!list || !list.length) return;
    setBusy(true);
    setNotes([]);
    setStatus({});
    const read = await readFileList(list);
    const specs: UploadSpec[] = [];
    let skipped = 0;
    for (const f of read.files) {
      const segs = f.path.split('/');
      const name = segs[segs.length - 1]!;
      const parsed = parseFileName(f.path, segs.slice(1, -1));
      if (!isUploadable(parsed)) { skipped++; continue; }
      specs.push({ key: f.path, name, source: f.source, arch: parsed.arch, step: parsed.step, template: parsed.template });
    }
    const n = [...read.notes];
    if (skipped) n.push(`${formatNumber(skipped)} ${skipped === 1 ? 'file was' : 'files were'} skipped because the type is not accepted.`);
    setNotes(n);
    try {
      await uploadCaseFiles(caseId, specs, { onFile: (k, s) => setStatus((prev) => ({ ...prev, [k]: s })) });
    } finally {
      setBusy(false);
      onDone();
    }
  }
  const entries = Object.entries(status);
  return (
    <div className="stack-sm" style={{ justifyItems: 'end' }}>
      <div className="row">
        <input ref={filesRef} type="file" multiple hidden aria-label="Choose files to add" onChange={(e) => { void run(e.target.files); e.target.value = ''; }} />
        <input ref={dirRef} type="file" hidden aria-label="Choose a folder to add" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(e) => { void run(e.target.files); e.target.value = ''; }} />
        <Button size="sm" disabled={busy} onClick={() => filesRef.current?.click()}><FilePlus2 size={14} aria-hidden="true" /> Add files</Button>
        <Button size="sm" disabled={busy} onClick={() => dirRef.current?.click()}><FolderPlus size={14} aria-hidden="true" /> Add a folder</Button>
      </div>
      {notes.map((n) => <p key={n} className="small muted">{n}</p>)}
      {entries.length ? (
        <div className="stack-sm" style={{ width: 'min(360px, 80vw)' }} aria-live="polite">
          <p className="small muted">{formatNumber(entries.filter(([, s]) => s.phase === 'ready').length)} of {formatNumber(entries.length)} files done</p>
          <ProgressBar label="Upload progress" value={entries.reduce((a, [, s]) => a + (s.phase === 'ready' || s.phase === 'rejected' || s.phase === 'processing' ? 1 : s.total ? s.sent / s.total : 0), 0) / entries.length} />
          {entries.filter(([, s]) => s.phase === 'error' || s.phase === 'rejected').slice(0, 5).map(([k, s]) => <p key={k} className="field-error">{k.split('/').pop()}: {s.error}</p>)}
        </div>
      ) : null}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { new: 'New case', replacement: 'Replacement case', rework: 'Rework case' };

/** Parent and child cases, requested aligners and the claims on this case. */
function RelatedCard({ c, kids: children, claims, staff }: { c: CaseItem; kids?: CaseChild[]; claims?: CaseClaimRef[]; staff: boolean }) {
  const base = staff ? '/console/cases' : '/portal/cases';
  const claimBase = staff ? '/console/claims' : '/portal/claims';
  const kids = children ?? [];
  const requested = c.requestedItems ?? [];
  const list = claims ?? [];
  if (!c.parentId && !kids.length && !requested.length && !list.length) return null;
  return (
    <Card title="Related cases and claims">
      <dl className="facts">
        {c.parentId ? <><dt>Original case</dt><dd><Link to={`${base}/${c.parentId}`}>{c.parentRef ?? 'Open the original case'}</Link> <span className="muted small">(this is a {(KIND_LABEL[c.kind] ?? humanise(c.kind)).toLowerCase()})</span></dd></> : null}
        {kids.length ? <><dt>Follow up cases</dt><dd className="stack-sm">{kids.map((k) => <span key={k.id} className="row" style={{ gap: 8 }}><Link to={`${base}/${k.id}`}>{k.ref}</Link><span className="muted small">{KIND_LABEL[k.kind] ?? humanise(k.kind)}</span><Badge tone={statusTone(k.status)}>{statusLabel(k.status)}</Badge></span>)}</dd></> : null}
        {requested.length ? <><dt>Aligners requested</dt><dd>{requested.map((i) => alignerName(i as { arch: 'upper' | 'lower'; step: number; template?: boolean })).join(', ')}</dd></> : null}
        {list.length ? <><dt>Claims</dt><dd className="stack-sm">{list.map((k) => <span key={k.id} className="row" style={{ gap: 8 }}><Link to={`${claimBase}/${k.id}`}>{k.number || 'Claim'}</Link><Badge tone={claimStatusTone(k.status)}>{claimStatusLabel(k.status, staff ? 'kline' : 'partner')}</Badge><span className="muted small">{k.summary}</span></span>)}</dd></> : null}
      </dl>
    </Card>
  );
}

function ReplacementDialog({ open, c, files, onClose, onDone, showClaimHint }: { showClaimHint: boolean; open: boolean; c: CaseItem; files: CaseFile[]; onClose: () => void; onDone: (newCaseId: string) => void }) {
  const aligners = useMemo(() => alignersOf(files), [files]);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setPick(new Set()); setReason(''); setError(null); } }, [open]);
  const m = useMutation({
    mutationFn: () => api<{ case?: { id: string }; id?: string }>(`/api/cases/${c.id}/replacement`, {
      method: 'POST',
      body: { items: aligners.filter((a) => pick.has(a.key)).map((a) => ({ arch: a.arch, step: a.step, template: a.template })), ...(reason.trim() ? { reason: reason.trim() } : {}) },
    }),
    onSuccess: (r) => onDone(r?.case?.id ?? r?.id ?? c.id),
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog open={open} title="Order replacement aligners" wide onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!pick.size} onClick={() => { setError(null); m.mutate(); }}>Order {pick.size ? formatNumber(pick.size) : ''} {pick.size === 1 ? 'aligner' : 'aligners'}</Button></>}>
      <div className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <p>This creates a new case linked to {c.ref}. K Line reuses the files it already has, so you do not upload anything again. The new case goes to K Line as a normal order.</p>
        <AlignerPicker
          legend="Which aligners do you need again?"
          aligners={aligners}
          selected={pick}
          onToggle={(k) => setPick((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
          onSetMany={(keys, on) => setPick((p) => { const n = new Set(p); keys.forEach((k) => (on ? n.add(k) : n.delete(k))); return n; })}
        />
        <Field label="Reason (optional)" hint="Do not type patient names.">
          {(p) => <textarea {...p} value={reason} maxLength={500} rows={3} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {showClaimHint ? <p className="small muted">If the aligners arrived faulty, report an issue instead. That lets K Line remake them as a rush order.</p> : null}
      </div>
    </Dialog>
  );
}
