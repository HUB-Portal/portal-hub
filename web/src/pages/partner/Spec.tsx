import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import { A, useNavigate, useParams } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { GitCompare, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-solid';
import { api, ApiError, errorText, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { hashContent } from '../../lib/canonical';
import { useSpecPartners } from '../../lib/specApi';
import { formatDate, formatDateTime, formatNumber } from '../../lib/format';
import {
  SPEC_LIMITS, SPEC_SECTIONS, STATUS_LABEL, STATUS_TONE, contentProblems, diffBag, diffSpecs, nextClauseId, normalizeSpec, normalizeSpecList, sectionClauses,
  type Clause, type Signature, type Spec, type SpecContent, type SpecSummary,
} from '../../lib/specModel';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, PageHeader, Spinner } from '../../ui/Common';
import { BagEditor } from './BagLayout';
import { IfMfa } from '../../ui/IfMfa';

type HashState = { state: 'checking' } | { state: 'none' } | { state: 'error'; message: string } | { state: 'match' | 'mismatch'; computed: string };

/** Recomputes SHA-256 of the canonical JSON in the browser and compares it with the hash the server stored. */
export function HashCheck(props: { spec: Spec }) {
  const [h, setH] = createSignal<HashState>({ state: 'checking' });
  createEffect(() => {
    // Reading the whole content here makes the check start again when any part of the version changes.
    const spec = props.spec;
    JSON.stringify(spec.content);
    const stored = spec.contentHash;
    let live = true;
    onCleanup(() => { live = false; });
    setH({ state: 'checking' });
    hashContent(spec.content).then(
      (computed) => { if (live) setH(!stored ? { state: 'none' } : { state: computed === stored.toLowerCase() ? 'match' : 'mismatch', computed }); },
      (e: unknown) => { if (live) setH({ state: 'error', message: e instanceof Error ? e.message : 'The check could not run.' }); },
    );
  });

  const computed = () => { const s = h(); return s.state === 'match' || s.state === 'mismatch' ? s.computed : ''; };
  return (
    <Switch>
      <Match when={h().state === 'checking'}><Badge>Checking the hash</Badge></Match>
      <Match when={h().state === 'error'}><Notice tone="warn" title="The hash check could not run">{(h() as { message: string }).message}</Notice></Match>
      <Match when={h().state === 'none'}><Badge title="The server has not stored a hash for this version">No hash stored</Badge></Match>
      <Match when={h().state === 'match' || h().state === 'mismatch'}>
        <div class="stack-sm">
          <Show
            when={h().state === 'match'}
            fallback={<Notice tone="bad" title="The hash does not match">This text is not the text that was hashed. Do not rely on this version. Tell K Line right away.</Notice>}
          >
            <span class="row" style={{ gap: '6px' }}><Badge tone="good"><ShieldCheck size={13} aria-hidden="true" /> Hash matches</Badge><span class="small muted">Your browser worked out the same fingerprint as the one stored with the signatures.</span></span>
          </Show>
          <details class="small">
            <summary>Show the fingerprints</summary>
            <dl class="facts" style={{ 'margin-top': '6px' }}>
              <dt>Stored</dt><dd class="mono">{props.spec.contentHash}</dd>
              <dt>Worked out here</dt><dd class="mono">{computed()}</dd>
            </dl>
          </details>
        </div>
      </Match>
    </Switch>
  );
}

function SignatureRow(props: { label: string; sig: Signature | null }) {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>{props.sig ? <span>Signed by <strong>{props.sig.name}</strong>{props.sig.at ? `, ${formatDateTime(props.sig.at)}` : ''}</span> : <span class="muted">Not signed yet</span>}</dd>
    </>
  );
}

function ClauseList(props: { clauses: Clause[] }) {
  return (
    <Show when={props.clauses.length} fallback={<p class="muted small">No clauses in this section.</p>}>
      <ul class="clause-list">
        <For each={props.clauses}>
          {(c) => (
            <li id={`clause-${c.id}`}>
              <div class="row" style={{ gap: '8px' }}><Badge>{c.id}</Badge><strong>{c.title}</strong></div>
              <p style={{ 'white-space': 'pre-wrap' }}>{c.text}</p>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

function SpecView(props: { content: SpecContent }) {
  return (
    <div class="stack">
      <For each={SPEC_SECTIONS}>
        {(s) => (
          <Card title={s.title}>
            <p class="muted small">{s.about}</p>
            <ClauseList clauses={sectionClauses(props.content, s.id)} />
          </Card>
        )}
      </For>
      <div class="stack-sm">
        <h2>Bag layout</h2>
        <Show when={props.content.bag ?? null} fallback={<Notice tone="info">This version has no bag layout.</Notice>}>
          {(bag) => <BagEditor layout={bag()} readOnly />}
        </Show>
      </div>
    </div>
  );
}

function DiffView(props: { from: Spec; to: Spec }) {
  const sections = createMemo(() => diffSpecs(props.from.content, props.to.content).sections.filter((x) => x.added.length || x.removed.length || x.changed.length));
  const bag = createMemo(() => diffBag(props.from.content.bag, props.to.content.bag));
  return (
    <Card title={`Changes from version ${formatNumber(props.from.version)} to version ${formatNumber(props.to.version)}`}>
      <Show when={!sections().length && !bag().length}><p class="muted">There are no differences between these two versions.</p></Show>
      <For each={sections()}>
        {(x) => (
          <div class="stack-sm">
            <h3>{x.label}</h3>
            <ul class="clause-list">
              <For each={x.added}>{(c) => <li class="diff-add"><Badge tone="good">Added</Badge> <Badge>{c.id}</Badge> <strong>{c.title}</strong><p>{c.text}</p></li>}</For>
              <For each={x.removed}>{(c) => <li class="diff-remove"><Badge tone="bad">Removed</Badge> <Badge>{c.id}</Badge> <strong>{c.title}</strong><p>{c.text}</p></li>}</For>
              <For each={x.changed}>
                {(c) => (
                  <li class="diff-change">
                    <Badge tone="warn">Changed</Badge> <Badge>{c.id}</Badge>
                    <div class="diff-pair">
                      <div><span class="small muted">Before</span><p><strong>{c.before.title}</strong></p><p>{c.before.text}</p></div>
                      <div><span class="small muted">After</span><p><strong>{c.after.title}</strong></p><p>{c.after.text}</p></div>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </div>
        )}
      </For>
      <Show when={bag().length}>
        <div class="stack-sm">
          <h3>Bag layout</h3>
          <div class="table-wrap"><table class="table"><thead><tr><th>Setting</th><th>Before</th><th>After</th></tr></thead><tbody>
            <For each={bag()}>{(b) => <tr><td>{b.label}</td><td>{b.before}</td><td>{b.after}</td></tr>}</For>
          </tbody></table></div>
        </div>
      </Show>
    </Card>
  );
}

function SpecEditor(props: { spec: Spec; staff: boolean; base: string; onCancel: () => void; onSaved: () => void }) {
  // A copy of the version's text that the fields edit. It starts from the version once and is not replaced when the version reloads.
  const [content, setContent] = createStore<SpecContent>(JSON.parse(JSON.stringify(props.spec.content)));
  const [note, setNote] = createSignal(props.spec.changeNote);
  const [error, setError] = createSignal<string | null>(null);
  const problems = createMemo(() => { JSON.stringify(content); return contentProblems(content); });

  function addClause(section: string, prefix: string) {
    setContent(produce((c) => {
      const all = c as unknown as Record<string, { clauses?: Clause[] } | undefined>;
      const sec = (all[section] ??= { clauses: [] });
      const list = (sec.clauses ??= []);
      list.push({ id: nextClauseId(prefix, list), title: '', text: '' });
    }));
  }
  function removeClause(section: string, id: string) {
    setContent(produce((c) => {
      const sec = (c as unknown as Record<string, { clauses?: Clause[] } | undefined>)[section];
      if (sec?.clauses) sec.clauses = sec.clauses.filter((x) => x.id !== id);
    }));
  }
  function patch(section: string, id: string, p: Partial<Clause>) {
    setContent(produce((c) => {
      const cl = sectionClauses(c, section).find((x) => x.id === id);
      if (cl) Object.assign(cl, p);
    }));
  }

  const save = createMutation(() => ({
    mutationFn: () => api(`${props.base}/${props.spec.id}`, { method: 'PUT', body: { content, changeNote: note().trim() } }),
    onSuccess: () => props.onSaved(),
    onError: (e: unknown) => setError(e instanceof ApiError ? e.message : errorText(e)),
  }));

  return (
    <div class="stack">
      <Notice tone="info" title={`Editing draft version ${formatNumber(props.spec.version)}`}>
        Changes are saved to the draft only. Nothing is binding until both sides have signed.{props.staff ? '' : ' K Line will see the draft only after you propose it.'}
      </Notice>
      <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
      <Card title="What changed">
        <Field label="Change note" hint="Say in a sentence why this version exists.">
          {(p) => <input {...p} value={note()} maxLength={SPEC_LIMITS.changeNoteMax} onInput={(e) => setNote(e.currentTarget.value)} />}
        </Field>
      </Card>
      <For each={SPEC_SECTIONS}>
        {(s) => {
          const clauses = () => sectionClauses(content, s.id);
          return (
            <Card title={s.title} actions={<Button size="sm" disabled={clauses().length >= SPEC_LIMITS.maxClausesPerSection} onClick={() => addClause(s.id, s.prefix)}><Plus size={14} aria-hidden="true" /> Add a clause</Button>}>
              <p class="muted small">{s.about}</p>
              <Show when={clauses().length === 0}><p class="muted small">No clauses yet.</p></Show>
              <For each={clauses()}>
                {(c) => (
                  <div class="clause-edit">
                    <div class="row" style={{ 'justify-content': 'space-between' }}>
                      <Badge>{c.id}</Badge>
                      <Button size="sm" onClick={() => removeClause(s.id, c.id)} aria-label={`Remove clause ${c.id}`}><Trash2 size={14} aria-hidden="true" /> Remove</Button>
                    </div>
                    <Field label={`Title of ${c.id}`}>{(p) => <input {...p} value={c.title} maxLength={SPEC_LIMITS.titleMax} onInput={(e) => patch(s.id, c.id, { title: e.currentTarget.value })} />}</Field>
                    <Field label={`Text of ${c.id}`}>{(p) => <textarea {...p} value={c.text} maxLength={SPEC_LIMITS.textMax} rows={3} onInput={(e) => patch(s.id, c.id, { text: e.currentTarget.value })} />}</Field>
                  </div>
                )}
              </For>
            </Card>
          );
        }}
      </For>
      <div class="stack-sm">
        <h2>Bag layout</h2>
        <BagEditor layout={content.bag} onChange={(l) => setContent('bag', reconcile(l))} />
      </div>
      <Show when={problems().length}>
        <Notice tone="warn" title="Fix this before saving"><ul style={{ margin: 0, 'padding-left': '18px' }}><For each={problems().slice(0, 8)}>{(p) => <li>{p}</li>}</For></ul></Notice>
      </Show>
      <div class="row-end sticky-actions">
        <Button onClick={props.onCancel}>Discard changes</Button>
        <Button variant="primary" loading={save.isPending} disabled={problems().length > 0} onClick={() => { setError(null); save.mutate(); }}>Save the draft</Button>
      </div>
    </div>
  );
}

function versionDate(s: SpecSummary): string {
  return formatDate(s.activatedAt ?? s.updatedAt ?? s.createdAt);
}

const FILTERS: { id: string; label: string; test: (s: SpecSummary) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'open', label: 'Drafts and proposals', test: (s) => s.status === 'draft' || s.status === 'proposed' },
  { id: 'history', label: 'History', test: (s) => s.status === 'superseded' || s.status === 'rejected' || s.status === 'active' },
];

/** Production specification for a partner (their own), or for K Line staff looking at one partner (`orgId`). */
export function SpecWorkspace(props: { staff: boolean; orgId?: string }) {
  const params = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const base = () => (props.staff ? '/api/console/specs' : '/api/specs');
  const root = () => (props.staff ? `/console/specs/${props.orgId}` : '/portal/spec');

  const [filter, setFilter] = createSignal('all');
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [compareId, setCompareId] = createSignal('');
  const [dialog, setDialog] = createSignal<'propose' | 'sign' | 'reject' | 'delete' | null>(null);
  const [rejectNote, setRejectNote] = createSignal('');
  const [notice, setNotice] = createSignal<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);

  const listQ = createQuery(() => ({
    queryKey: ['specs', props.staff, props.orgId ?? ''],
    queryFn: async () => normalizeSpecList(await api(`${base()}${qs({ orgId: props.orgId })}`)),
  }));
  const versions = createMemo(() => [...(listQ.data ?? [])].sort((a, b) => b.version - a.version));
  const active = () => versions().find((v) => v.status === 'active');
  const selectedId = () => params.id ?? active()?.id ?? versions()[0]?.id;

  const detailQ = createQuery(() => ({
    queryKey: ['spec', props.staff, selectedId()],
    enabled: !!selectedId(),
    queryFn: async () => normalizeSpec(await api(`${base()}/${selectedId()}${qs({ orgId: props.orgId })}`)),
  }));
  const spec = () => detailQ.data;

  const compareQ = createQuery(() => ({
    queryKey: ['spec', props.staff, compareId()],
    enabled: !!compareId(),
    queryFn: async () => normalizeSpec(await api(`${base()}/${compareId()}${qs({ orgId: props.orgId })}`)),
  }));

  createEffect(on(selectedId, () => { setCompareId(''); setNotice(null); }));
  const editing = () => !!spec() && editingId() === spec()!.id;

  const canCreate = () => can('spec.edit') || (props.staff && (can('admin.partners') || can('claim.decide')));
  const refresh = () => { for (const k of ['specs', 'spec', 'spec-partners', 'case', 'console-case', 'bag-layout']) qc.invalidateQueries({ queryKey: [k] }); };
  const go = (id: string) => nav(`${root()}/${id}`);

  const create = createMutation(() => ({
    mutationFn: async () => normalizeSpec(await api(base(), { method: 'POST', body: props.staff ? { orgId: props.orgId } : {} })),
    onSuccess: (s: Spec) => { refresh(); if (s.id) { go(s.id); setEditingId(s.id); } },
    onError: (e: unknown) => setNotice({ tone: 'bad', text: errorText(e) }),
  }));
  const propose = createMutation(() => ({
    mutationFn: () => api(`${base()}/${spec()!.id}/propose`, { method: 'POST', body: {} }),
    onSuccess: () => { setDialog(null); setNotice({ tone: 'good', text: 'The version was proposed. Proposing does not sign it. Sign it now to add your signature, then the other side must sign too.' }); refresh(); },
    onError: (e: unknown) => { setDialog(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  }));
  const sign = createMutation(() => ({
    // The hash of the text on screen is sent along, so the signature only counts if it is the text the person saw.
    mutationFn: async () => api(`${base()}/${spec()!.id}/sign`, { method: 'POST', body: { contentHash: await hashContent(spec()!.content) } }),
    onSuccess: () => { setDialog(null); setNotice({ tone: 'good', text: 'You signed this version. It becomes active when the other side has signed too.' }); refresh(); },
    onError: (e: unknown) => { setDialog(null); setNotice({ tone: 'bad', text: signError(e) }); },
  }));
  const reject = createMutation(() => ({
    mutationFn: () => api(`${base()}/${spec()!.id}/reject`, { method: 'POST', body: { note: rejectNote().trim() } }),
    onSuccess: () => { setDialog(null); setRejectNote(''); setNotice({ tone: 'good', text: 'The version was rejected. The person who proposed it is told.' }); refresh(); },
    onError: (e: unknown) => { setDialog(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  }));
  const del = createMutation(() => ({
    mutationFn: () => api(`${base()}/${spec()!.id}${qs({ orgId: props.orgId })}`, { method: 'DELETE' }),
    onSuccess: () => { setDialog(null); refresh(); nav(root(), { replace: true }); },
    onError: (e: unknown) => { setDialog(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  }));

  const mySig = () => { const s = spec(); return s ? (props.staff ? s.klineSignature : s.partnerSignature) : null; };
  const act = () => spec()?.actions ?? null;
  const canEditNow = () => { const s = spec(); const a = act(); return !!s && s.status === 'draft' && (a ? a.edit : canCreate()); };
  const canProposeNow = () => { const s = spec(); const a = act(); return !!s && s.status === 'draft' && (a ? a.propose : canCreate()); };
  const canDeleteNow = () => { const s = spec(); const a = act(); return !!s && s.status === 'draft' && (a ? a.delete : canCreate()); };
  const canSignNow = () => { const s = spec(); const a = act(); return !!s && s.status === 'proposed' && (a ? a.sign : can('spec.sign') && !mySig()); };
  const canRejectNow = () => { const s = spec(); const a = act(); return !!s && s.status === 'proposed' && (a ? a.reject : can('spec.sign')); };
  const shown = () => versions().filter((v) => FILTERS.find((f) => f.id === filter())!.test(v));
  const hasDraft = () => versions().some((v) => v.status === 'draft');
  const compareSpec = () => {
    const c = compareQ.data;
    const s = spec();
    return c && s ? (c.version < s.version ? { from: c, to: s } : { from: s, to: c }) : null;
  };

  return (
    <Show when={!listQ.isLoading} fallback={<div class="page"><Spinner /></div>}>
      <div class="page">
        <Show when={props.staff}><div><A href="/console/specs" class="small">Back to partners</A></div></Show>
        <PageHeader
          title={props.staff ? <>Production specification: <PartnerName orgId={props.orgId} fallback={versions()[0]?.orgName ?? null} /></> : 'Production specification'}
          subtitle="The agreed way K Line makes your aligners. Both sides sign each version, and every case records the version it was made under."
          actions={canCreate() ? <Button variant="primary" loading={create.isPending} disabled={hasDraft()} onClick={() => create.mutate()} title={hasDraft() ? 'Finish or delete the current draft first' : undefined}><Plus size={16} aria-hidden="true" /> New draft</Button> : undefined}
        />
        <Show when={listQ.isError}><Notice tone="bad" action={<Button size="sm" onClick={() => listQ.refetch()}>Try again</Button>}>{errorText(listQ.error)}</Notice></Show>
        <Show when={notice()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show>
        <Show when={!listQ.isError && versions().length === 0}>
          <Card>
            <Empty title="No specification yet" action={canCreate() ? <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Start from the K Line defaults</Button> : undefined}>
              {canCreate() ? 'Start a draft from the standard K Line text, edit it, propose it and sign it together.' : 'Nothing has been drafted or signed yet.'}
            </Empty>
          </Card>
        </Show>
        <Show when={!active() && versions().length > 0}><Notice tone="warn" title="No specification is active yet">A version becomes active once both sides have signed it.</Notice></Show>

        <Show when={versions().length > 0}>
          <div class="spec-layout">
            <Card title="Versions" class="spec-versions">
              <div class="tabs" role="group" aria-label="Filter versions">
                <For each={FILTERS}>{(f) => <button type="button" class="tab" aria-pressed={filter() === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>}</For>
              </div>
              <ul class="version-list">
                <For each={shown()}>
                  {(v) => (
                    <li>
                      <A href={`${root()}/${v.id}`} aria-current={v.id === selectedId() ? 'true' : undefined} class={v.id === selectedId() ? 'version-on' : undefined}>
                        <span class="row" style={{ gap: '8px' }}><strong>Version {formatNumber(v.version)}</strong><Badge tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status]}</Badge></span>
                        <span class="small muted">{versionDate(v)}</span>
                        {v.changeNote ? <span class="small">{v.changeNote}</span> : null}
                      </A>
                    </li>
                  )}
                </For>
                <Show when={shown().length === 0}><li class="muted small">No versions in this view.</li></Show>
              </ul>
            </Card>

            <div class="stack">
              <Show when={detailQ.isLoading}><Spinner /></Show>
              <Show when={detailQ.isError}><Notice tone="bad">{errorText(detailQ.error)}</Notice></Show>
              <Show when={spec()}>
                {(sp) => (
                  <>
                    <Card
                      title={<span class="row" style={{ gap: '10px' }}>Version {formatNumber(sp().version)} <Badge tone={STATUS_TONE[sp().status]}>{STATUS_LABEL[sp().status]}</Badge></span>}
                      actions={
                        <>
                          {canEditNow() && !editing() ? <Button size="sm" onClick={() => setEditingId(sp().id)}><Pencil size={14} aria-hidden="true" /> Edit</Button> : null}
                          {canProposeNow() && !editing() ? <Button size="sm" variant="primary" onClick={() => setDialog('propose')}>Propose</Button> : null}
                          {canDeleteNow() && !editing() ? <Button size="sm" onClick={() => setDialog('delete')}><Trash2 size={14} aria-hidden="true" /> Delete</Button> : null}
                          {canSignNow() ? <Button size="sm" variant="primary" onClick={() => setDialog('sign')}>Sign</Button> : null}
                          {canRejectNow() ? <Button size="sm" onClick={() => setDialog('reject')}>Reject</Button> : null}
                        </>
                      }
                    >
                      <dl class="facts">
                        <dt>Change note</dt><dd>{sp().changeNote || <span class="muted">None</span>}</dd>
                        {sp().createdSide ? <><dt>Drafted by</dt><dd>{sp().createdSide === 'kline' ? 'K Line' : 'The partner'}</dd></> : null}
                        <SignatureRow label="Partner signature" sig={sp().partnerSignature} />
                        <SignatureRow label="K Line signature" sig={sp().klineSignature} />
                        {sp().activatedAt ? <><dt>Active since</dt><dd>{formatDateTime(sp().activatedAt!)}</dd></> : null}
                        {sp().rejectionNote ? <><dt>Rejected because</dt><dd style={{ 'white-space': 'pre-wrap' }}>{sp().rejectionNote}</dd></> : null}
                      </dl>
                      <Show when={sp().status === 'proposed' && !canSignNow()}>
                        <p class="small muted">
                          {mySig() ? 'Your side has signed. Waiting for the other side.' : !can('spec.sign') ? 'You do not have permission to sign.' : 'Your side has not signed yet. If you signed for the other side, a different person must sign for this one.'}
                        </p>
                      </Show>
                      <Show when={!editing()}><HashCheck spec={sp()} /></Show>
                    </Card>

                    <Show when={!editing() && versions().length > 1}>
                      <Card>
                        <div class="row">
                          <GitCompare size={18} aria-hidden="true" />
                          <div class="field" style={{ 'min-width': '220px' }}>
                            <label for="cmp">Compare with another version</label>
                            <select id="cmp" value={compareId()} onChange={(e) => setCompareId(e.currentTarget.value)}>
                              <option value="">Do not compare</option>
                              <For each={versions().filter((v) => v.id !== sp().id)}>{(v) => <option value={v.id}>Version {v.version}, {STATUS_LABEL[v.status]}</option>}</For>
                            </select>
                          </div>
                        </div>
                        <Show when={compareQ.isLoading}><Spinner /></Show>
                        <Show when={compareQ.isError}><Notice tone="bad">{errorText(compareQ.error)}</Notice></Show>
                      </Card>
                    </Show>
                    <Show when={!editing() ? compareSpec() : null}>{(c) => <DiffView from={c().from} to={c().to} />}</Show>

                    <Show when={editing()} fallback={<SpecView content={sp().content} />}>
                      <SpecEditor spec={sp()} staff={props.staff} base={base()} onCancel={() => setEditingId(null)} onSaved={() => { setEditingId(null); setNotice({ tone: 'good', text: 'The draft was saved.' }); refresh(); }} />
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </div>
        </Show>

        <Dialog open={dialog() === 'propose'} title="Propose this version?" onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Not yet</Button><Button variant="primary" loading={propose.isPending} onClick={() => propose.mutate()}>Propose</Button></>}>
          <div class="stack-sm">
            <p>The draft can no longer be edited once it is proposed. The other side can then read it, sign it or reject it.</p>
            <p><IfMfa>You will be asked for a fresh code from your authenticator app. </IfMfa>Proposing does not sign. You still need to sign for your side.</p>
          </div>
        </Dialog>
        <Dialog open={dialog() === 'sign'} title={`Sign version ${spec()?.version ?? ''}?`} onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Not yet</Button><Button variant="primary" loading={sign.isPending} onClick={() => sign.mutate()}>Sign</Button></>}>
          <div class="stack-sm">
            <p>Your name and the time are recorded as the {props.staff ? 'K Line' : 'partner'} signature. When both sides have signed, this version becomes the active specification and replaces the current one.</p>
            <IfMfa><p>You will be asked for a fresh code from your authenticator app.</p></IfMfa>
          </div>
        </Dialog>
        <Dialog open={dialog() === 'reject'} title="Reject this version" onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" loading={reject.isPending} disabled={!rejectNote().trim()} onClick={() => reject.mutate()}>Reject the version</Button></>}>
          <Field label="Why are you rejecting it?" hint="The person who proposed it will read this.">
            {(p) => <textarea {...p} value={rejectNote()} maxLength={1000} rows={4} onInput={(e) => setRejectNote(e.currentTarget.value)} />}
          </Field>
        </Dialog>
        <Dialog open={dialog() === 'delete'} title="Delete this draft?" onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Keep the draft</Button><Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>Delete the draft</Button></>}>
          <p>The draft is removed for good. Signed versions are never removed.</p>
        </Dialog>
      </div>
    </Show>
  );
}

function PartnerName(props: { orgId?: string; fallback: string | null }) {
  const partners = useSpecPartners();
  return <>{(partners.data ?? []).find((p) => p.orgId === props.orgId)?.name ?? props.fallback ?? 'partner'}</>;
}

function signError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'same_signer') return 'You already signed for the other side. A different person must sign for this side.';
    if (e.code === 'already_signed') return 'Your side has already signed this version.';
    if (e.code === 'hash_mismatch') return 'The text changed since you opened it. Reload the page, check the version again and then sign.';
    return e.message;
  }
  return errorText(e);
}

export default function Spec() {
  return <SpecWorkspace staff={false} />;
}
