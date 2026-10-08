import { createEffect, createSignal, For, Match, on, Show, Switch } from 'solid-js';
import { A, useParams } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { CheckCircle2, ExternalLink, Send, XCircle } from 'lucide-solid';
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
export default function ClaimDetail(props: { staff?: boolean }) {
  const params = useParams();
  const id = () => params.id ?? '';
  const staff = () => props.staff ?? false;
  const qc = useQueryClient();
  const { can } = useAuth();
  const side = () => (staff() ? 'kline' : 'partner');
  const q = createQuery(() => ({
    queryKey: ['claim', staff(), id()],
    queryFn: async (): Promise<ClaimDetailData> => normalizeClaimDetail(await api(staff() ? `/api/console/claims/${id()}` : `/api/claims/${id()}`)),
    refetchInterval: (query: { state: { data: ClaimDetailData | undefined } }) => {
      const d = query.state.data;
      if (!d) return false;
      if (d.evidence.some((f) => f.state === 'uploading' || f.state === 'processing')) return 3000;
      return ACTIVE_CLAIM_STATUSES.includes(d.claim.status) ? 30_000 : false;
    },
  }));
  const [notice, setNotice] = createSignal<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const [dialog, setDialog] = createSignal<'decide' | 'close' | null>(null);

  const refresh = () => { for (const k of ['claim', 'claims', 'console-claims', 'console-overview', 'case', 'console-case']) qc.invalidateQueries({ queryKey: [k] }); };

  const setStatus = createMutation(() => ({
    mutationFn: (status: 'in_review' | 'awaiting_partner') => api(`/api/claims/${id()}/status`, { method: 'POST', body: { status } }),
    onSuccess: (_r: unknown, status: 'in_review' | 'awaiting_partner') => { setNotice({ tone: 'good', text: status === 'in_review' ? 'The claim is in review.' : 'The partner has been asked for more information.' }); refresh(); },
    onError: (e: unknown) => setNotice({ tone: 'bad', text: errorText(e) }),
  }));
  const close = createMutation(() => ({
    mutationFn: () => api(`/api/claims/${id()}/close`, { method: 'POST', body: {} }),
    onSuccess: () => { setDialog(null); setNotice({ tone: 'good', text: 'The claim was closed.' }); refresh(); },
    onError: (e: unknown) => { setDialog(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  }));

  const back = () => (staff() ? '/console/claims' : '/portal/claims');
  const caseBase = () => (staff() ? '/console/cases' : '/portal/cases');

  return (
    <Switch>
      <Match when={q.isLoading}><div class="page"><Spinner /></div></Match>
      <Match when={q.isError || !q.data}>
        <div class="page">
          <Notice tone="bad" title="We could not open this claim">{errorText(q.error)}</Notice>
          <div><A href={back()}>Back to claims</A></div>
        </div>
      </Match>
      <Match when={q.data}>
        {(data) => {
          const claim = () => data().claim;
          const active = () => ACTIVE_CLAIM_STATUSES.includes(claim().status);
          const canDecide = () => staff() && can('claim.decide');
          const canTriage = () => staff() && can('claim.write');
          const canEvidence = () => !staff() && can('claim.write') && active();
          const decided = () => claim().status === 'accepted' || claim().status === 'rejected';
          const canMessage = () => can('claim.write') && claim().status !== 'closed';

          return (
            <div class="page">
              <div><A href={back()} class="small">Back to claims</A></div>
              <PageHeader
                title={<span class="row" style={{ gap: '12px' }}>{claim().number || 'Claim'} <Badge tone={claimStatusTone(claim().status)}>{claimStatusLabel(claim().status, side())}</Badge></span>}
                subtitle={<>{claim().orgName ? `${claim().orgName}, ` : ''}case {claim().caseId ? <A href={`${caseBase()}/${claim().caseId}`}>{claim().caseRef ?? 'open case'}</A> : claim().caseRef}. Opened {formatDate(claim().createdAt)}.</>}
                actions={
                  <>
                    {canTriage() && claim().status === 'open' ? <Button variant="primary" loading={setStatus.isPending} onClick={() => setStatus.mutate('in_review')}>Start review</Button> : null}
                    {canTriage() && claim().status === 'awaiting_partner' ? <Button loading={setStatus.isPending} onClick={() => setStatus.mutate('in_review')}>Back to review</Button> : null}
                    {canTriage() && (claim().status === 'open' || claim().status === 'in_review') ? <Button loading={setStatus.isPending} onClick={() => setStatus.mutate('awaiting_partner')}>Ask the partner for more</Button> : null}
                    {canDecide() && active() ? <Button variant="primary" onClick={() => setDialog('decide')}>Decide</Button> : null}
                    {canDecide() && decided() ? <Button onClick={() => setDialog('close')}>Close the claim</Button> : null}
                  </>
                }
              />
              <Show when={notice()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show>
              <Show when={!staff() && claim().status === 'awaiting_partner'}><Notice tone="warn" title="K Line needs something from you">Read the messages below and reply. You can add photos or videos too.</Notice></Show>

              <div class="grid-2">
                <div class="stack">
                  <Card title="What was reported">
                    <dl class="facts">
                      <dt>Summary</dt><dd>{claim().summary}</dd>
                      {claim().description ? <><dt>Detail</dt><dd style={{ 'white-space': 'pre-wrap' }}>{claim().description}</dd></> : null}
                      {claim().openedByName ? <><dt>Opened by</dt><dd>{claim().openedByName}</dd></> : null}
                      {claim().specClauseIds.length ? <><dt>Specification</dt><dd class="stack-sm"><For each={claim().specClauseIds}>{(cid) => <span class="row" style={{ gap: '6px' }}><Badge>{cid}</Badge>{data().specClauses.find((x) => x.id === cid)?.title ?? ''}</span>}</For></dd></> : null}
                    </dl>
                    <div class="table-wrap">
                      <table class="table">
                        <thead><tr><th>Aligner</th><th>Defect</th><th>Note</th></tr></thead>
                        <tbody>
                          <For each={data().items}>
                            {(i) => (
                              <tr>
                                <td class="nowrap"><strong>{alignerName(i)}</strong></td>
                                <td>{defectLabel(i.defectCode)}</td>
                                <td>{i.note ?? <span class="muted">None</span>}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Card>

                  <Show when={decided() || claim().status === 'closed'}>
                    <Card title="Outcome">
                      <dl class="facts">
                        <dt>Decision</dt><dd><Badge tone={claimStatusTone(claim().status)}>{claimStatusLabel(claim().status, side())}</Badge></dd>
                        {claim().resolution ? <><dt>Resolution</dt><dd>{resolutionLabel(claim().resolution!)}</dd></> : null}
                        {claim().decisionNote ? <><dt>Note from K Line</dt><dd style={{ 'white-space': 'pre-wrap' }}>{claim().decisionNote}</dd></> : null}
                        {claim().rootCause ? <><dt>Root cause</dt><dd style={{ 'white-space': 'pre-wrap' }}>{claim().rootCause}</dd></> : null}
                        {claim().correctiveAction ? <><dt>Corrective action</dt><dd style={{ 'white-space': 'pre-wrap' }}>{claim().correctiveAction}</dd></> : null}
                        {claim().decidedAt ? <><dt>Decided</dt><dd>{formatDateTime(claim().decidedAt!)}</dd></> : null}
                        {claim().closedAt ? <><dt>Closed</dt><dd>{formatDateTime(claim().closedAt!)}</dd></> : null}
                        {claim().reworkCaseId ? <><dt>Rework case</dt><dd><A href={`${caseBase()}/${claim().reworkCaseId}`}>{claim().reworkCaseRef ?? 'Open the rework case'} <ExternalLink size={13} aria-hidden="true" /></A></dd></> : null}
                      </dl>
                    </Card>
                  </Show>

                  <EvidenceCard claimId={id()} files={data().evidence} canAdd={canEvidence()} onDone={refresh} />
                </div>

                <Card title="Messages" class="sticky-card">
                  <MessageThread messages={data().messages} side={side()} />
                  <Show
                    when={canMessage()}
                    fallback={<p class="muted small">{claim().status === 'closed' ? 'This claim is closed, so no more messages can be added.' : 'You can read the messages but you cannot reply. Ask someone with claim access.'}</p>}
                  >
                    <Composer claimId={id()} staff={staff()} onSent={refresh} />
                  </Show>
                </Card>
              </div>

              <Show when={canDecide()}><DecisionDialog open={dialog() === 'decide'} claimId={id()} onClose={() => setDialog(null)} onDone={(text) => { setDialog(null); setNotice({ tone: 'good', text }); refresh(); }} /></Show>
              <Dialog
                open={dialog() === 'close'}
                title="Close this claim?"
                onClose={() => setDialog(null)}
                footer={<><Button onClick={() => setDialog(null)}>Not yet</Button><Button variant="primary" loading={close.isPending} onClick={() => close.mutate()}>Close the claim</Button></>}
              >
                <p>The partner is told the claim is closed. No more messages can be added.</p>
              </Dialog>
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}

function MessageThread(props: { messages: ClaimMessage[]; side: 'partner' | 'kline' }) {
  let end: HTMLDivElement | undefined;
  createEffect(on(() => props.messages.length, () => { end?.scrollIntoView({ block: 'nearest' }); }));
  return (
    <Show when={props.messages.length} fallback={<p class="muted">No messages yet.</p>}>
      <ol class="thread" aria-label="Messages" aria-live="polite">
        <For each={props.messages}>
          {(m) => {
            const mine = () => m.side === props.side;
            const who = () => (m.side === 'system' ? 'System' : m.side === 'kline' ? 'K Line' : props.side === 'partner' ? 'Your team' : 'Partner');
            return (
              <li class={`msg msg-${m.side}${mine() ? ' msg-mine' : ''}`}>
                <div class="msg-head"><strong>{m.authorName && m.side !== 'system' ? m.authorName : who()}</strong>{m.authorName && m.side !== 'system' && m.authorName !== who() ? <span class="muted small"> ({who()})</span> : null} <span class="muted small">{formatDateTime(m.createdAt)}</span></div>
                <p class="msg-body">{m.body}</p>
              </li>
            );
          }}
        </For>
        <div ref={end} />
      </ol>
    </Show>
  );
}

function Composer(props: { claimId: string; staff: boolean; onSent: () => void }) {
  const [text, setText] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const send = createMutation(() => ({
    mutationFn: () => api(`/api/claims/${props.claimId}/messages`, { method: 'POST', body: { body: text().trim() } }),
    onSuccess: () => { setText(''); setError(null); props.onSent(); },
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <form class="stack-sm" onSubmit={(e) => { e.preventDefault(); if (text().trim()) send.mutate(); }}>
      <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
      <Field label={props.staff ? 'Reply to the partner' : 'Write to K Line'} hint={`${NAME_WARNING} ${formatNumber(text().length)} of ${formatNumber(MESSAGE_MAX)} characters.`}>
        {(p) => <textarea {...p} value={text()} maxLength={MESSAGE_MAX} rows={4} onInput={(e) => setText(e.currentTarget.value)} />}
      </Field>
      <div class="row-end"><Button type="submit" variant="primary" loading={send.isPending} disabled={!text().trim()}><Send size={16} aria-hidden="true" /> Send message</Button></div>
    </form>
  );
}

function EvidenceCard(props: { claimId: string; files: ClaimDetailData['evidence']; canAdd: boolean; onDone: () => void }) {
  const ev = usePending({ exts: EVIDENCE_EXTS, maxFiles: MAX_EVIDENCE_FILES, get existing() { return props.files.length; }, maxBytes: (ext) => (mediaKind(ext) === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES) });
  const [status, setStatus] = createSignal<Record<string, FileStatus>>({});
  const [busy, setBusy] = createSignal(false);
  const [msg, setMsg] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);

  async function send() {
    setBusy(true);
    setMsg(null);
    try {
      const ok = await uploadPending({ purpose: 'claim', claimId: props.claimId }, ev.pending, (k, s) => setStatus((p) => ({ ...p, [k]: s })));
      setMsg(ok ? { tone: 'good', text: 'Your files were added to the claim.' } : { tone: 'bad', text: 'Some files could not be added. Check the list and try again.' });
      if (ok) { ev.clear(); setStatus({}); }
      props.onDone();
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'The upload failed. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Photos and videos (${formatNumber(props.files.length)})`}>
      <EvidenceGallery files={props.files} />
      <Show when={props.canAdd}>
        <Show when={msg()}>{(m) => <Notice tone={m().tone}>{m().text}</Notice>}</Show>
        <AttachmentPicker
          pending={ev.pending}
          problems={ev.problems}
          status={status()}
          onAdd={(l) => { setStatus({}); ev.add(l); }}
          onRemove={ev.remove}
          busy={busy()}
          accept=".jpg,.jpeg,.png,.mp4,.mov,.m4v,.pdf"
          label="Add more photos or videos"
          hint={`Up to ${MAX_EVIDENCE_FILES} files in total. Keep faces and names out of the pictures.`}
        />
        <Show when={ev.pending.length}><div class="row-end"><Button variant="primary" loading={busy()} onClick={() => void send()}>Upload {formatNumber(ev.pending.length)} {ev.pending.length === 1 ? 'file' : 'files'}</Button></div></Show>
      </Show>
    </Card>
  );
}

function DecisionDialog(props: { open: boolean; claimId: string; onClose: () => void; onDone: (text: string) => void }) {
  const [decision, setDecision] = createSignal<'accepted' | 'rejected'>('accepted');
  const [resolution, setResolution] = createSignal('remake');
  const [rootCause, setRootCause] = createSignal('');
  const [action, setAction] = createSignal('');
  const [note, setNote] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) { setDecision('accepted'); setResolution('remake'); setRootCause(''); setAction(''); setNote(''); setError(null); } }));

  const m = createMutation(() => ({
    mutationFn: () => api(`/api/claims/${props.claimId}/decision`, {
      method: 'POST',
      body: decision() === 'accepted'
        ? { decision: decision(), resolution: resolution(), ...(rootCause().trim() ? { rootCause: rootCause().trim() } : {}), ...(action().trim() ? { correctiveAction: action().trim() } : {}), ...(note().trim() ? { note: note().trim() } : {}) }
        : { decision: decision(), note: note().trim(), ...(rootCause().trim() ? { rootCause: rootCause().trim() } : {}), ...(action().trim() ? { correctiveAction: action().trim() } : {}) },
    }),
    onSuccess: () => props.onDone(decision() === 'accepted' ? (resolution() === 'remake' ? 'The claim was accepted. A rush rework case was created.' : 'The claim was accepted.') : 'The claim was rejected and the partner was told.'),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  const valid = () => (decision() === 'accepted' ? !!resolution() : note().trim().length > 0);
  const help = () => RESOLUTIONS.find((r) => r.id === resolution())?.help;

  return (
    <Dialog
      open={props.open}
      title="Decide on this claim"
      wide
      onClose={props.onClose}
      footer={<><Button onClick={props.onClose}>Cancel</Button><Button variant={decision() === 'rejected' ? 'danger' : 'primary'} loading={m.isPending} disabled={!valid()} onClick={() => { setError(null); m.mutate(); }}>{decision() === 'accepted' ? 'Accept the claim' : 'Reject the claim'}</Button></>}
    >
      <div class="stack">
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <fieldset class="check-group">
          <legend>Decision</legend>
          <div class="row">
            <label class="radio"><input type="radio" name="decision" checked={decision() === 'accepted'} onChange={() => setDecision('accepted')} /> <CheckCircle2 size={16} aria-hidden="true" /> Accept</label>
            <label class="radio"><input type="radio" name="decision" checked={decision() === 'rejected'} onChange={() => setDecision('rejected')} /> <XCircle size={16} aria-hidden="true" /> Reject</label>
          </div>
        </fieldset>
        <Show when={decision() === 'accepted'}>
          <Field label="Resolution" hint={help()}>
            {(p) => <select {...p} value={resolution()} onChange={(e) => setResolution(e.currentTarget.value)}><For each={RESOLUTIONS}>{(r) => <option value={r.id}>{r.label}</option>}</For></select>}
          </Field>
        </Show>
        <Field label={decision() === 'rejected' ? 'Note for the partner (required)' : 'Note for the partner (optional)'} hint="Explain the decision in plain words. No patient names.">
          {(p) => <textarea {...p} value={note()} maxLength={2000} rows={3} onInput={(e) => setNote(e.currentTarget.value)} />}
        </Field>
        <Field label="Root cause (optional)" hint="Kept for quality records.">
          {(p) => <textarea {...p} value={rootCause()} maxLength={2000} rows={2} onInput={(e) => setRootCause(e.currentTarget.value)} />}
        </Field>
        <Field label="Corrective action (optional)">
          {(p) => <textarea {...p} value={action()} maxLength={2000} rows={2} onInput={(e) => setAction(e.currentTarget.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
