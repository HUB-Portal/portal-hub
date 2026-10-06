import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Send, XCircle } from 'lucide-react';
import { api, ApiError, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { defectLabel } from '../../lib/defects';
import { formatDate, formatDateTime, formatNumber } from '../../lib/format';
import {
  ACTIVE_CLAIM_STATUSES, EVIDENCE_EXTS, MAX_EVIDENCE_FILES, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, RESOLUTIONS, alignerName, claimStatusLabel, claimStatusTone, mediaKind, normalizeClaimDetail, resolutionLabel,
  type ClaimDetailData, type ClaimMessage,
} from '../../lib/quality';
import type { FileStatus } from '../../lib/upload';
import { AttachmentPicker, EvidenceGallery, uploadPending, usePending } from '../../ui/Attachments';
import { Badge, Button, Card, Dialog, Field, Notice, PageHeader, Spinner } from '../../ui/Common';
import { NAME_WARNING } from './ClaimNew';

const MESSAGE_MAX = 4000;

/** Claim page for partners, and for K Line staff when `staff` is set (triage, decision, close). */
export default function ClaimDetail({ staff = false }: { staff?: boolean }) {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const side = staff ? 'kline' : 'partner';
  const q = useQuery({
    queryKey: ['claim', staff, id],
    queryFn: async (): Promise<ClaimDetailData> => normalizeClaimDetail(await api(staff ? `/api/console/claims/${id}` : `/api/claims/${id}`)),
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      if (d.evidence.some((f) => f.state === 'uploading' || f.state === 'processing')) return 3000;
      return ACTIVE_CLAIM_STATUSES.includes(d.claim.status) ? 30_000 : false;
    },
  });
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const [dialog, setDialog] = useState<'decide' | 'close' | null>(null);

  const refresh = () => { for (const k of ['claim', 'claims', 'console-claims', 'console-overview', 'case', 'console-case']) qc.invalidateQueries({ queryKey: [k] }); };

  const setStatus = useMutation({
    mutationFn: (status: 'in_review' | 'awaiting_partner') => api(`/api/claims/${id}/status`, { method: 'POST', body: { status } }),
    onSuccess: (_r, status) => { setNotice({ tone: 'good', text: status === 'in_review' ? 'The claim is in review.' : 'The partner has been asked for more information.' }); refresh(); },
    onError: (e) => setNotice({ tone: 'bad', text: errorText(e) }),
  });
  const close = useMutation({
    mutationFn: () => api(`/api/claims/${id}/close`, { method: 'POST', body: {} }),
    onSuccess: () => { setDialog(null); setNotice({ tone: 'good', text: 'The claim was closed.' }); refresh(); },
    onError: (e) => { setDialog(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  });

  if (q.isLoading) return <div className="page"><Spinner /></div>;
  const back = staff ? '/console/claims' : '/portal/claims';
  if (q.isError || !q.data) {
    return (
      <div className="page">
        <Notice tone="bad" title="We could not open this claim">{errorText(q.error)}</Notice>
        <div><Link to={back}>Back to claims</Link></div>
      </div>
    );
  }
  const { claim, items, messages, evidence, specClauses } = q.data;
  const caseBase = staff ? '/console/cases' : '/portal/cases';
  const active = ACTIVE_CLAIM_STATUSES.includes(claim.status);
  const canDecide = staff && can('claim.decide');
  const canTriage = staff && can('claim.write');
  const canEvidence = !staff && can('claim.write') && active;
  const decided = claim.status === 'accepted' || claim.status === 'rejected';
  const canMessage = can('claim.write') && claim.status !== 'closed';

  return (
    <div className="page">
      <div><Link to={back} className="small">Back to claims</Link></div>
      <PageHeader
        title={<span className="row" style={{ gap: 12 }}>{claim.number || 'Claim'} <Badge tone={claimStatusTone(claim.status)}>{claimStatusLabel(claim.status, side)}</Badge></span>}
        subtitle={<>{claim.orgName ? `${claim.orgName}, ` : ''}case {claim.caseId ? <Link to={`${caseBase}/${claim.caseId}`}>{claim.caseRef ?? 'open case'}</Link> : claim.caseRef}. Opened {formatDate(claim.createdAt)}.</>}
        actions={
          <>
            {canTriage && claim.status === 'open' ? <Button variant="primary" loading={setStatus.isPending} onClick={() => setStatus.mutate('in_review')}>Start review</Button> : null}
            {canTriage && claim.status === 'awaiting_partner' ? <Button loading={setStatus.isPending} onClick={() => setStatus.mutate('in_review')}>Back to review</Button> : null}
            {canTriage && (claim.status === 'open' || claim.status === 'in_review') ? <Button loading={setStatus.isPending} onClick={() => setStatus.mutate('awaiting_partner')}>Ask the partner for more</Button> : null}
            {canDecide && active ? <Button variant="primary" onClick={() => setDialog('decide')}>Decide</Button> : null}
            {canDecide && decided ? <Button onClick={() => setDialog('close')}>Close the claim</Button> : null}
          </>
        }
      />
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      {!staff && claim.status === 'awaiting_partner' ? <Notice tone="warn" title="K Line needs something from you">Read the messages below and reply. You can add photos or videos too.</Notice> : null}

      <div className="grid-2">
        <div className="stack">
          <Card title="What was reported">
            <dl className="facts">
              <dt>Summary</dt><dd>{claim.summary}</dd>
              {claim.description ? <><dt>Detail</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{claim.description}</dd></> : null}
              {claim.openedByName ? <><dt>Opened by</dt><dd>{claim.openedByName}</dd></> : null}
              {claim.specClauseIds.length ? <><dt>Specification</dt><dd className="stack-sm">{claim.specClauseIds.map((id) => <span key={id} className="row" style={{ gap: 6 }}><Badge>{id}</Badge>{specClauses.find((x) => x.id === id)?.title ?? ''}</span>)}</dd></> : null}
            </dl>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Aligner</th><th>Defect</th><th>Note</th></tr></thead>
                <tbody>
                  {items.map((i, n) => (
                    <tr key={i.id ?? n}>
                      <td className="nowrap"><strong>{alignerName(i)}</strong></td>
                      <td>{defectLabel(i.defectCode)}</td>
                      <td>{i.note ?? <span className="muted">None</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {decided || claim.status === 'closed' ? (
            <Card title="Outcome">
              <dl className="facts">
                <dt>Decision</dt><dd><Badge tone={claimStatusTone(claim.status)}>{claimStatusLabel(claim.status, side)}</Badge></dd>
                {claim.resolution ? <><dt>Resolution</dt><dd>{resolutionLabel(claim.resolution)}</dd></> : null}
                {claim.decisionNote ? <><dt>Note from K Line</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{claim.decisionNote}</dd></> : null}
                {claim.rootCause ? <><dt>Root cause</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{claim.rootCause}</dd></> : null}
                {claim.correctiveAction ? <><dt>Corrective action</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{claim.correctiveAction}</dd></> : null}
                {claim.decidedAt ? <><dt>Decided</dt><dd>{formatDateTime(claim.decidedAt)}</dd></> : null}
                {claim.closedAt ? <><dt>Closed</dt><dd>{formatDateTime(claim.closedAt)}</dd></> : null}
                {claim.reworkCaseId ? <><dt>Rework case</dt><dd><Link to={`${caseBase}/${claim.reworkCaseId}`}>{claim.reworkCaseRef ?? 'Open the rework case'} <ExternalLink size={13} aria-hidden="true" /></Link></dd></> : null}
              </dl>
            </Card>
          ) : null}

          <EvidenceCard claimId={id} files={evidence} canAdd={canEvidence} onDone={refresh} />
        </div>

        <Card title="Messages" className="sticky-card">
          <MessageThread messages={messages} side={side} />
          {canMessage ? <Composer claimId={id} staff={staff} onSent={refresh} /> : <p className="muted small">{claim.status === 'closed' ? 'This claim is closed, so no more messages can be added.' : 'You can read the messages but you cannot reply. Ask someone with claim access.'}</p>}
        </Card>
      </div>

      {canDecide ? <DecisionDialog open={dialog === 'decide'} claimId={id} onClose={() => setDialog(null)} onDone={(text) => { setDialog(null); setNotice({ tone: 'good', text }); refresh(); }} /> : null}
      <Dialog
        open={dialog === 'close'}
        title="Close this claim?"
        onClose={() => setDialog(null)}
        footer={<><Button onClick={() => setDialog(null)}>Not yet</Button><Button variant="primary" loading={close.isPending} onClick={() => close.mutate()}>Close the claim</Button></>}
      >
        <p>The partner is told the claim is closed. No more messages can be added.</p>
      </Dialog>
    </div>
  );
}

function MessageThread({ messages, side }: { messages: ClaimMessage[]; side: 'partner' | 'kline' }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [messages.length]);
  if (!messages.length) return <p className="muted">No messages yet.</p>;
  return (
    <ol className="thread" aria-label="Messages" aria-live="polite">
      {messages.map((m) => {
        const mine = m.side === side;
        const who = m.side === 'system' ? 'System' : m.side === 'kline' ? 'K Line' : side === 'partner' ? 'Your team' : 'Partner';
        return (
          <li key={m.id} className={`msg msg-${m.side}${mine ? ' msg-mine' : ''}`}>
            <div className="msg-head"><strong>{m.authorName && m.side !== 'system' ? m.authorName : who}</strong>{m.authorName && m.side !== 'system' && m.authorName !== who ? <span className="muted small"> ({who})</span> : null} <span className="muted small">{formatDateTime(m.createdAt)}</span></div>
            <p className="msg-body">{m.body}</p>
          </li>
        );
      })}
      <div ref={end} />
    </ol>
  );
}

function Composer({ claimId, staff, onSent }: { claimId: string; staff: boolean; onSent: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () => api(`/api/claims/${claimId}/messages`, { method: 'POST', body: { body: text.trim() } }),
    onSuccess: () => { setText(''); setError(null); onSent(); },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate(); }}>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <Field label={staff ? 'Reply to the partner' : 'Write to K Line'} hint={`${NAME_WARNING} ${formatNumber(text.length)} of ${formatNumber(MESSAGE_MAX)} characters.`}>
        {(p) => <textarea {...p} value={text} maxLength={MESSAGE_MAX} rows={4} onChange={(e) => setText(e.target.value)} />}
      </Field>
      <div className="row-end"><Button type="submit" variant="primary" loading={send.isPending} disabled={!text.trim()}><Send size={16} aria-hidden="true" /> Send message</Button></div>
    </form>
  );
}

function EvidenceCard({ claimId, files, canAdd, onDone }: { claimId: string; files: ClaimDetailData['evidence']; canAdd: boolean; onDone: () => void }) {
  const ev = usePending({ exts: EVIDENCE_EXTS, maxFiles: MAX_EVIDENCE_FILES, existing: files.length, maxBytes: (ext) => (mediaKind(ext) === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES) });
  const [status, setStatus] = useState<Record<string, FileStatus>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  async function send() {
    setBusy(true);
    setMsg(null);
    try {
      const ok = await uploadPending({ purpose: 'claim', claimId }, ev.pending, (k, s) => setStatus((p) => ({ ...p, [k]: s })));
      setMsg(ok ? { tone: 'good', text: 'Your files were added to the claim.' } : { tone: 'bad', text: 'Some files could not be added. Check the list and try again.' });
      if (ok) { ev.clear(); setStatus({}); }
      onDone();
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'The upload failed. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Photos and videos (${formatNumber(files.length)})`}>
      <EvidenceGallery files={files} />
      {canAdd ? (
        <>
          {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
          <AttachmentPicker
            pending={ev.pending}
            problems={ev.problems}
            status={status}
            onAdd={(l) => { setStatus({}); ev.add(l); }}
            onRemove={ev.remove}
            busy={busy}
            accept=".jpg,.jpeg,.png,.mp4,.mov,.m4v,.pdf"
            label="Add more photos or videos"
            hint={`Up to ${MAX_EVIDENCE_FILES} files in total. Keep faces and names out of the pictures.`}
          />
          {ev.pending.length ? <div className="row-end"><Button variant="primary" loading={busy} onClick={() => void send()}>Upload {formatNumber(ev.pending.length)} {ev.pending.length === 1 ? 'file' : 'files'}</Button></div> : null}
        </>
      ) : null}
    </Card>
  );
}

function DecisionDialog({ open, claimId, onClose, onDone }: { open: boolean; claimId: string; onClose: () => void; onDone: (text: string) => void }) {
  const [decision, setDecision] = useState<'accepted' | 'rejected'>('accepted');
  const [resolution, setResolution] = useState('remake');
  const [rootCause, setRootCause] = useState('');
  const [action, setAction] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setDecision('accepted'); setResolution('remake'); setRootCause(''); setAction(''); setNote(''); setError(null); } }, [open]);

  const m = useMutation({
    mutationFn: () => api(`/api/claims/${claimId}/decision`, {
      method: 'POST',
      body: decision === 'accepted'
        ? { decision, resolution, ...(rootCause.trim() ? { rootCause: rootCause.trim() } : {}), ...(action.trim() ? { correctiveAction: action.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) }
        : { decision, note: note.trim(), ...(rootCause.trim() ? { rootCause: rootCause.trim() } : {}), ...(action.trim() ? { correctiveAction: action.trim() } : {}) },
    }),
    onSuccess: () => onDone(decision === 'accepted' ? (resolution === 'remake' ? 'The claim was accepted. A rush rework case was created.' : 'The claim was accepted.') : 'The claim was rejected and the partner was told.'),
    onError: (e) => setError(errorText(e)),
  });
  const valid = decision === 'accepted' ? !!resolution : note.trim().length > 0;
  const help = RESOLUTIONS.find((r) => r.id === resolution)?.help;

  return (
    <Dialog
      open={open}
      title="Decide on this claim"
      wide
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={decision === 'rejected' ? 'danger' : 'primary'} loading={m.isPending} disabled={!valid} onClick={() => { setError(null); m.mutate(); }}>{decision === 'accepted' ? 'Accept the claim' : 'Reject the claim'}</Button></>}
    >
      <div className="stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <fieldset className="check-group">
          <legend>Decision</legend>
          <div className="row">
            <label className="radio"><input type="radio" name="decision" checked={decision === 'accepted'} onChange={() => setDecision('accepted')} /> <CheckCircle2 size={16} aria-hidden="true" /> Accept</label>
            <label className="radio"><input type="radio" name="decision" checked={decision === 'rejected'} onChange={() => setDecision('rejected')} /> <XCircle size={16} aria-hidden="true" /> Reject</label>
          </div>
        </fieldset>
        {decision === 'accepted' ? (
          <Field label="Resolution" hint={help}>
            {(p) => <select {...p} value={resolution} onChange={(e) => setResolution(e.target.value)}>{RESOLUTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>}
          </Field>
        ) : null}
        <Field label={decision === 'rejected' ? 'Note for the partner (required)' : 'Note for the partner (optional)'} hint="Explain the decision in plain words. No patient names.">
          {(p) => <textarea {...p} value={note} maxLength={2000} rows={3} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Field label="Root cause (optional)" hint="Kept for quality records.">
          {(p) => <textarea {...p} value={rootCause} maxLength={2000} rows={2} onChange={(e) => setRootCause(e.target.value)} />}
        </Field>
        <Field label="Corrective action (optional)">
          {(p) => <textarea {...p} value={action} maxLength={2000} rows={2} onChange={(e) => setAction(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
