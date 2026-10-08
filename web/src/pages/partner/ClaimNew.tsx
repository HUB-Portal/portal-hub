import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { A, useNavigate, useParams } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { Plus, Trash2 } from 'lucide-solid';
import { api, ApiError, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DEFECT_CODES, defectLabel } from '../../lib/defects';
import { formatNumber } from '../../lib/format';
import { EVIDENCE_EXTS, MAX_EVIDENCE_FILES, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, CLAIMABLE_CASE_STATUSES, alignerKey, alignerName, alignersOf, normalizeClaim, mediaKind, type AlignerRef, type ClaimItem } from '../../lib/quality';
import { allClauses, normalizeSpec } from '../../lib/specModel';
import type { CaseDetail } from '../../lib/types';
import type { FileStatus } from '../../lib/upload';
import { AttachmentPicker, uploadPending, usePending } from '../../ui/Attachments';
import { Badge, Button, Card, Field, Notice, PageHeader, Spinner } from '../../ui/Common';

export const NAME_WARNING = 'Do not type patient names anywhere in a claim. Use the case reference and aligner codes, and keep faces and names out of photos.';

function claimError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'case_not_claimable': return 'Claims can only be opened for cases that K Line has received, is producing, or has shipped.';
      case 'unknown_aligner': return 'One of the aligners you chose is not part of this case. Remove it and try again.';
      case 'unknown_clause': return 'One of the clauses you chose is not in the specification for this case. Remove it and try again.';
      default: return e.message;
    }
  }
  return errorText(e);
}

/** Aligner chips: choose several aligners at once. */
export function AlignerPicker(props: { aligners: AlignerRef[]; selected: Set<string>; onToggle: (key: string) => void; onSetMany: (keys: string[], on: boolean) => void; legend: string }) {
  const [arch, setArch] = createSignal<'all' | 'upper' | 'lower'>('all');
  const shown = createMemo(() => props.aligners.filter((a) => arch() === 'all' || a.arch === arch()));
  const allOn = () => shown().length > 0 && shown().every((a) => props.selected.has(a.key));
  return (
    <fieldset class="check-group">
      <legend>{props.legend}</legend>
      <div class="row">
        <div class="tabs" role="group" aria-label="Show aligners of">
          <For each={['all', 'upper', 'lower'] as const}>
            {(a) => (
              <button type="button" class="tab" aria-pressed={arch() === a} onClick={() => setArch(a)}>{a === 'all' ? 'Both arches' : a === 'upper' ? 'Upper' : 'Lower'}</button>
            )}
          </For>
        </div>
        <Button size="sm" onClick={() => props.onSetMany(shown().map((a) => a.key), !allOn())} disabled={!shown().length}>{allOn() ? 'Clear these' : 'Select all of these'}</Button>
        <span class="muted small" aria-live="polite">{formatNumber(props.selected.size)} selected</span>
      </div>
      <div class="chip-grid">
        <For each={shown()}>
          {(a) => (
            <label class={`chip${props.selected.has(a.key) ? ' chip-on' : ''}`}>
              <input type="checkbox" checked={props.selected.has(a.key)} onChange={() => props.onToggle(a.key)} />
              <span>{a.code}</span>
            </label>
          )}
        </For>
      </div>
      <Show when={!shown().length}><p class="muted small">There are no aligners to choose from.</p></Show>
    </fieldset>
  );
}

export default function ClaimNew() {
  const params = useParams();
  const id = () => params.id ?? '';
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const caseQ = createQuery(() => ({ queryKey: ['case', id()], queryFn: () => api<CaseDetail>(`/api/cases/${id()}`) }));
  const c = () => caseQ.data?.case;
  const aligners = createMemo(() => alignersOf(caseQ.data?.files ?? []));

  const specQ = createQuery(() => ({
    queryKey: ['claim-spec', c()?.id, c()?.specId ?? 'active'],
    enabled: !!c() && can('spec.read'),
    retry: false,
    queryFn: async () => {
      const cc = c()!;
      try { return normalizeSpec(await api(cc.specId ? `/api/specs/${cc.specId}` : '/api/specs/active')); } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
        throw e;
      }
    },
  }));
  const clauses = createMemo(() => (specQ.data ? allClauses(specQ.data.content) : []));

  const [summary, setSummary] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [items, setItems] = createSignal<ClaimItem[]>([]);
  const [pick, setPick] = createSignal<Set<string>>(new Set());
  const [defect, setDefect] = createSignal('');
  const [note, setNote] = createSignal('');
  const [clauseIds, setClauseIds] = createSignal<Set<string>>(new Set());
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<Record<string, FileStatus>>({});
  const [uploading, setUploading] = createSignal(false);
  const [created, setCreated] = createSignal<{ id: string; failed: boolean } | null>(null);
  const ev = usePending({ exts: EVIDENCE_EXTS, maxFiles: MAX_EVIDENCE_FILES, maxBytes: (ext) => (mediaKind(ext) === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES) });

  function addItems() {
    if (!pick().size || !defect()) return;
    setItems((prev) => {
      const next = [...prev];
      for (const a of aligners()) {
        if (!pick().has(a.key)) continue;
        if (next.some((i) => alignerKey(i) === a.key && i.defectCode === defect())) continue;
        next.push({ arch: a.arch, step: a.step, template: a.template, defectCode: defect(), note: note().trim() || null });
      }
      return next;
    });
    setPick(new Set<string>());
    setNote('');
  }

  const create = createMutation(() => ({
    mutationFn: async () => {
      const res = await api<unknown>('/api/claims', {
        method: 'POST',
        body: {
          caseId: id(),
          summary: summary().trim(),
          ...(description().trim() ? { description: description().trim() } : {}),
          ...(clauseIds().size ? { specClauseIds: [...clauseIds()] } : {}),
          items: items().map((i) => ({ arch: i.arch, step: i.step, template: i.template, defectCode: i.defectCode, ...(i.note ? { note: i.note } : {}) })),
        },
      });
      const claim = normalizeClaim(res);
      let failed = false;
      if (ev.pending.length) {
        setUploading(true);
        try {
          const ok = await uploadPending({ purpose: 'claim', claimId: claim.id }, ev.pending, (k, s) => setStatus((p) => ({ ...p, [k]: s })));
          failed = !ok;
        } catch { failed = true; } finally { setUploading(false); }
      }
      return { id: claim.id, failed };
    },
    onSuccess: (r: { id: string; failed: boolean }) => {
      for (const k of ['claims', 'case', 'cases', 'case-claims']) qc.invalidateQueries({ queryKey: [k] });
      if (r.failed) setCreated(r); else nav(`/portal/claims/${r.id}`);
    },
    onError: (e: unknown) => setError(claimError(e)),
  }));

  const canSend = () => summary().trim().length >= 3 && items().length > 0 && !create.isPending;

  return (
    <Switch>
      <Match when={caseQ.isLoading}><div class="page"><Spinner /></div></Match>
      <Match when={caseQ.isError || !c()}>
        <div class="page"><Notice tone="bad" title="We could not open this case">{errorText(caseQ.error)}</Notice><div><A href="/portal/cases">Back to cases</A></div></div>
      </Match>
      <Match when={c()}>
        {(cc) => (
          <Switch>
            <Match when={!CLAIMABLE_CASE_STATUSES.includes(cc().status)}>
              <div class="page page-narrow">
                <PageHeader title="Report an issue" subtitle={cc().ref} />
                <Notice tone="warn" title="This case cannot have a claim yet">Claims can be opened once K Line has received the case. This case is not there yet.</Notice>
                <div><A href={`/portal/cases/${cc().id}`}>Back to the case</A></div>
              </div>
            </Match>
            <Match when={!can('claim.write')}>
              <div class="page page-narrow">
                <PageHeader title="Report an issue" subtitle={cc().ref} />
                <Notice tone="warn" title="You cannot open claims">Ask an administrator or a quality person in your organisation to report this issue.</Notice>
                <div><A href={`/portal/cases/${cc().id}`}>Back to the case</A></div>
              </div>
            </Match>
            <Match when={created()}>
              {(cr) => (
                <div class="page page-narrow">
                  <PageHeader title="Claim opened" subtitle={cc().ref} />
                  <Notice tone="warn" title="Some files did not upload">Your claim was opened, but not every photo or video went through. Open the claim to add them again.</Notice>
                  <div><A class="btn btn-primary" href={`/portal/claims/${cr().id}`}>Open the claim</A></div>
                </div>
              )}
            </Match>
            <Match when={true}>
              <div class="page page-narrow">
                <div><A href={`/portal/cases/${cc().id}`} class="small">Back to the case</A></div>
                <PageHeader title="Report an issue" subtitle={`Case ${cc().ref}${cc().caseId ? `, ${cc().caseId}` : ''}`} />
                <Notice tone="info" title="Keep patients private">{NAME_WARNING}</Notice>
                <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>

                <Card title="1. What is wrong">
                  <Field label="Short summary" hint="One sentence. For example: sharp edges on several lower aligners.">
                    {(p) => <input {...p} value={summary()} maxLength={200} onInput={(e) => setSummary(e.currentTarget.value)} required />}
                  </Field>
                  <Field label="More detail (optional)" hint={`${formatNumber(description().length)} of ${formatNumber(4000)} characters.`}>
                    {(p) => <textarea {...p} value={description()} maxLength={4000} rows={4} onInput={(e) => setDescription(e.currentTarget.value)} />}
                  </Field>
                </Card>

                <Card title="2. Which aligners and what defect">
                  <Show when={aligners().length > 0} fallback={<Notice tone="warn">This case has no aligner models, so there is nothing to choose from.</Notice>}>
                    <AlignerPicker
                      legend="Choose the aligners with this defect"
                      aligners={aligners()}
                      selected={pick()}
                      onToggle={(k) => setPick((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                      onSetMany={(keys, on) => setPick((s) => { const n = new Set(s); keys.forEach((k) => (on ? n.add(k) : n.delete(k))); return n; })}
                    />
                    <div class="form-grid">
                      <Field label="Defect">
                        {(p) => (
                          <select {...p} value={defect()} onChange={(e) => setDefect(e.currentTarget.value)}>
                            <option value="">Choose a defect</option>
                            <For each={DEFECT_CODES}>{(d) => <option value={d}>{defectLabel(d)}</option>}</For>
                          </select>
                        )}
                      </Field>
                      <Field label="Note (optional)" hint="No patient names.">
                        {(p) => <input {...p} value={note()} maxLength={300} onInput={(e) => setNote(e.currentTarget.value)} />}
                      </Field>
                    </div>
                    <div><Button variant="primary" disabled={!pick().size || !defect()} onClick={addItems}><Plus size={16} aria-hidden="true" /> Add to the claim</Button></div>
                  </Show>
                  <Show when={items().length} fallback={<p class="muted small">Nothing added yet. Choose aligners and a defect, then add them.</p>}>
                    <div class="table-wrap">
                      <table class="table">
                        <thead><tr><th>Aligner</th><th>Defect</th><th>Note</th><th><span class="sr-only">Remove</span></th></tr></thead>
                        <tbody>
                          <For each={items()}>
                            {(i) => (
                              <tr>
                                <td class="nowrap"><strong>{alignerName(i)}</strong></td>
                                <td>{defectLabel(i.defectCode)}</td>
                                <td>{i.note ?? <span class="muted">None</span>}</td>
                                <td class="right"><Button size="sm" onClick={() => setItems((p) => p.filter((x) => x !== i))} aria-label={`Remove ${alignerName(i)}, ${defectLabel(i.defectCode)}`}><Trash2 size={14} aria-hidden="true" /></Button></td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>
                </Card>

                <Show when={clauses().length}>
                  <Card title="3. Specification clauses (optional)">
                    <p class="muted small">Tick the clauses of your production specification, version {specQ.data?.version}, that the aligners do not meet.</p>
                    <fieldset class="check-group">
                      <legend class="sr-only">Specification clauses</legend>
                      <For each={clauses()}>
                        {(cl) => (
                          <div class="check">
                            <input id={`cl-${cl.id}`} type="checkbox" checked={clauseIds().has(cl.id)} onChange={() => setClauseIds((s) => { const n = new Set(s); if (n.has(cl.id)) n.delete(cl.id); else n.add(cl.id); return n; })} />
                            <label for={`cl-${cl.id}`}><Badge>{cl.id}</Badge> {cl.title}</label>
                            <p class="hint">{cl.text}</p>
                          </div>
                        )}
                      </For>
                    </fieldset>
                  </Card>
                </Show>

                <Card title={`${clauses().length ? '4' : '3'}. Photos and videos`}>
                  <AttachmentPicker
                    pending={ev.pending}
                    problems={ev.problems}
                    status={status()}
                    onAdd={ev.add}
                    onRemove={ev.remove}
                    busy={uploading()}
                    accept=".jpg,.jpeg,.png,.mp4,.mov,.m4v,.pdf"
                    label="Add photos or videos"
                    hint={`JPEG or PNG photos up to 50 MB, MP4, MOV or M4V videos up to 512 MB, or PDF. Up to ${MAX_EVIDENCE_FILES} files. Clear photos help K Line decide faster.`}
                  />
                  <p class="small muted">The files are sent after the claim is opened. You can add more later.</p>
                </Card>

                <div class="row-end sticky-actions">
                  <A class="btn" href={`/portal/cases/${cc().id}`}>Cancel</A>
                  <Button variant="primary" loading={create.isPending} disabled={!canSend()} onClick={() => { setError(null); create.mutate(); }}>Open the claim</Button>
                </div>
                <Show when={!items().length}><p class="small muted" style={{ 'text-align': 'right' }}>Add at least one aligner and defect to open the claim.</p></Show>
              </div>
            </Match>
          </Switch>
        )}
      </Match>
    </Switch>
  );
}
