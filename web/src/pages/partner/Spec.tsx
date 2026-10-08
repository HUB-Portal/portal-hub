import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitCompare, Pencil, Plus, ShieldCheck, ShieldAlert, Trash2 } from 'lucide-react';
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
export function HashCheck({ spec }: { spec: Spec }) {
  const [h, setH] = useState<HashState>({ state: 'checking' });
  useEffect(() => {
    let live = true;
    setH({ state: 'checking' });
    hashContent(spec.content).then(
      (computed) => { if (live) setH(!spec.contentHash ? { state: 'none' } : { state: computed === spec.contentHash.toLowerCase() ? 'match' : 'mismatch', computed }); },
      (e: unknown) => { if (live) setH({ state: 'error', message: e instanceof Error ? e.message : 'The check could not run.' }); },
    );
    return () => { live = false; };
  }, [spec]);

  if (h.state === 'checking') return <Badge>Checking the hash</Badge>;
  if (h.state === 'error') return <Notice tone="warn" title="The hash check could not run">{h.message}</Notice>;
  if (h.state === 'none') return <Badge title="The server has not stored a hash for this version">No hash stored</Badge>;
  return (
    <div className="stack-sm">
      {h.state === 'match' ? (
        <span className="row" style={{ gap: 6 }}><Badge tone="good"><ShieldCheck size={13} aria-hidden="true" /> Hash matches</Badge><span className="small muted">Your browser worked out the same fingerprint as the one stored with the signatures.</span></span>
      ) : (
        <Notice tone="bad" title="The hash does not match">This text is not the text that was hashed. Do not rely on this version. Tell K Line right away.</Notice>
      )}
      <details className="small">
        <summary>Show the fingerprints</summary>
        <dl className="facts" style={{ marginTop: 6 }}>
          <dt>Stored</dt><dd className="mono">{spec.contentHash}</dd>
          <dt>Worked out here</dt><dd className="mono">{h.computed}</dd>
        </dl>
      </details>
    </div>
  );
}

function SignatureRow({ label, sig }: { label: string; sig: Signature | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{sig ? <span>Signed by <strong>{sig.name}</strong>{sig.at ? `, ${formatDateTime(sig.at)}` : ''}</span> : <span className="muted">Not signed yet</span>}</dd>
    </>
  );
}

function ClauseList({ clauses }: { clauses: Clause[] }) {
  if (!clauses.length) return <p className="muted small">No clauses in this section.</p>;
  return (
    <ul className="clause-list">
      {clauses.map((c) => (
        <li key={c.id} id={`clause-${c.id}`}>
          <div className="row" style={{ gap: 8 }}><Badge>{c.id}</Badge><strong>{c.title}</strong></div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{c.text}</p>
        </li>
      ))}
    </ul>
  );
}

function SpecView({ content }: { content: SpecContent }) {
  const bag = content.bag ?? null;
  return (
    <div className="stack">
      {SPEC_SECTIONS.map((s) => (
        <Card key={s.id} title={s.title}>
          <p className="muted small">{s.about}</p>
          <ClauseList clauses={sectionClauses(content, s.id)} />
        </Card>
      ))}
      <div className="stack-sm">
        <h2>Bag layout</h2>
        {bag ? <BagEditor layout={bag} readOnly /> : <Notice tone="info">This version has no bag layout.</Notice>}
      </div>
    </div>
  );
}

function DiffView({ from, to }: { from: Spec; to: Spec }) {
  const sections = useMemo(() => diffSpecs(from.content, to.content).sections.filter((x) => x.added.length || x.removed.length || x.changed.length), [from, to]);
  const bag = useMemo(() => diffBag(from.content.bag, to.content.bag), [from, to]);
  return (
    <Card title={`Changes from version ${formatNumber(from.version)} to version ${formatNumber(to.version)}`}>
      {!sections.length && !bag.length ? <p className="muted">There are no differences between these two versions.</p> : null}
      {sections.map((x) => (
        <div key={x.section} className="stack-sm">
          <h3>{x.label}</h3>
          <ul className="clause-list">
            {x.added.map((c) => <li key={`a-${c.id}`} className="diff-add"><Badge tone="good">Added</Badge> <Badge>{c.id}</Badge> <strong>{c.title}</strong><p>{c.text}</p></li>)}
            {x.removed.map((c) => <li key={`r-${c.id}`} className="diff-remove"><Badge tone="bad">Removed</Badge> <Badge>{c.id}</Badge> <strong>{c.title}</strong><p>{c.text}</p></li>)}
            {x.changed.map((c) => (
              <li key={`c-${c.id}`} className="diff-change">
                <Badge tone="warn">Changed</Badge> <Badge>{c.id}</Badge>
                <div className="diff-pair">
                  <div><span className="small muted">Before</span><p><strong>{c.before.title}</strong></p><p>{c.before.text}</p></div>
                  <div><span className="small muted">After</span><p><strong>{c.after.title}</strong></p><p>{c.after.text}</p></div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {bag.length ? (
        <div className="stack-sm">
          <h3>Bag layout</h3>
          <div className="table-wrap"><table className="table"><thead><tr><th>Setting</th><th>Before</th><th>After</th></tr></thead><tbody>
            {bag.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.before}</td><td>{b.after}</td></tr>)}
          </tbody></table></div>
        </div>
      ) : null}
    </Card>
  );
}

function SpecEditor({ spec, staff, base, onCancel, onSaved }: { spec: Spec; staff: boolean; base: string; onCancel: () => void; onSaved: () => void }) {
  const [content, setContent] = useState<SpecContent>(() => spec.content);
  const [note, setNote] = useState(spec.changeNote);
  const [error, setError] = useState<string | null>(null);
  const problems = useMemo(() => contentProblems(content), [content]);

  function setClauses(section: string, clauses: Clause[]) { setContent((c) => ({ ...c, [section]: { clauses } })); }
  function patch(section: string, id: string, p: Partial<Clause>) { setClauses(section, sectionClauses(content, section).map((c) => (c.id === id ? { ...c, ...p } : c))); }

  const save = useMutation({
    mutationFn: () => api(`${base}/${spec.id}`, { method: 'PUT', body: { content, changeNote: note.trim() } }),
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof ApiError ? e.message : errorText(e)),
  });

  return (
    <div className="stack">
      <Notice tone="info" title={`Editing draft version ${formatNumber(spec.version)}`}>
        Changes are saved to the draft only. Nothing is binding until both sides have signed.{staff ? '' : ' K Line will see the draft only after you propose it.'}
      </Notice>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <Card title="What changed">
        <Field label="Change note" hint="Say in a sentence why this version exists.">
          {(p) => <input {...p} value={note} maxLength={SPEC_LIMITS.changeNoteMax} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </Card>
      {SPEC_SECTIONS.map((s) => {
        const clauses = sectionClauses(content, s.id);
        return (
          <Card key={s.id} title={s.title} actions={<Button size="sm" disabled={clauses.length >= SPEC_LIMITS.maxClausesPerSection} onClick={() => setClauses(s.id, [...clauses, { id: nextClauseId(s.prefix, clauses), title: '', text: '' }])}><Plus size={14} aria-hidden="true" /> Add a clause</Button>}>
            <p className="muted small">{s.about}</p>
            {clauses.length === 0 ? <p className="muted small">No clauses yet.</p> : null}
            {clauses.map((c) => (
              <div key={c.id} className="clause-edit">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <Badge>{c.id}</Badge>
                  <Button size="sm" onClick={() => setClauses(s.id, clauses.filter((x) => x.id !== c.id))} aria-label={`Remove clause ${c.id}`}><Trash2 size={14} aria-hidden="true" /> Remove</Button>
                </div>
                <Field label={`Title of ${c.id}`}>{(p) => <input {...p} value={c.title} maxLength={SPEC_LIMITS.titleMax} onChange={(e) => patch(s.id, c.id, { title: e.target.value })} />}</Field>
                <Field label={`Text of ${c.id}`}>{(p) => <textarea {...p} value={c.text} maxLength={SPEC_LIMITS.textMax} rows={3} onChange={(e) => patch(s.id, c.id, { text: e.target.value })} />}</Field>
              </div>
            ))}
          </Card>
        );
      })}
      <div className="stack-sm">
        <h2>Bag layout</h2>
        <BagEditor layout={content.bag} onChange={(l) => setContent((c) => ({ ...c, bag: l }))} />
      </div>
      {problems.length ? <Notice tone="warn" title="Fix this before saving"><ul style={{ margin: 0, paddingLeft: 18 }}>{problems.slice(0, 8).map((p) => <li key={p}>{p}</li>)}</ul></Notice> : null}
      <div className="row-end sticky-actions">
        <Button onClick={onCancel}>Discard changes</Button>
        <Button variant="primary" loading={save.isPending} disabled={problems.length > 0} onClick={() => { setError(null); save.mutate(); }}>Save the draft</Button>
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
export function SpecWorkspace({ staff, orgId }: { staff: boolean; orgId?: string }) {
  const { id: routeId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const base = staff ? '/api/console/specs' : '/api/specs';
  const root = staff ? `/console/specs/${orgId}` : '/portal/spec';

  const [filter, setFilter] = useState('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState('');
  const [dialog, setDialog] = useState<'propose' | 'sign' | 'reject' | 'delete' | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);

  const listQ = useQuery({
    queryKey: ['specs', staff, orgId ?? ''],
    queryFn: async () => normalizeSpecList(await api(`${base}${qs({ orgId })}`)),
  });
  const versions = useMemo(() => [...(listQ.data ?? [])].sort((a, b) => b.version - a.version), [listQ.data]);
  const active = versions.find((v) => v.status === 'active');
  const selectedId = routeId ?? active?.id ?? versions[0]?.id;

  const detailQ = useQuery({
    queryKey: ['spec', staff, selectedId],
    enabled: !!selectedId,
    queryFn: async () => normalizeSpec(await api(`${base}/${selectedId}${qs({ orgId })}`)),
  });
  const spec = detailQ.data;

  const compareQ = useQuery({
    queryKey: ['spec', staff, compareId],
    enabled: !!compareId,
    queryFn: async () => normalizeSpec(await api(`${base}/${compareId}${qs({ orgId })}`)),
  });

  useEffect(() => { setCompareId(''); setNotice(null); }, [selectedId]);
  const editing = !!spec && editingId === spec.id;

  const canCreate = can('spec.edit') || (staff && (can('admin.partners') || can('claim.decide')));
  const refresh = () => { for (const k of ['specs', 'spec', 'spec-partners', 'case', 'console-case', 'bag-layout']) qc.invalidateQueries({ queryKey: [k] }); };
  const go = (id: string) => nav(`${root}/${id}`);

  const create = useMutation({
    mutationFn: async () => normalizeSpec(await api(base, { method: 'POST', body: staff ? { orgId } : {} })),
    onSuccess: (s) => { refresh(); if (s.id) { go(s.id); setEditingId(s.id); } },
    onError: (e) => setNotice({ tone: 'bad', text: errorText(e) }),
  });
  const propose = useMutation({
    mutationFn: () => api(`${base}/${spec!.id}/propose`, { method: 'POST', body: {} }),
    onSuccess: () => { setDialog(null); setNotice({ tone: 'good', text: 'The version was proposed. Proposing does not sign it. Sign it now to add your signature, then the other side must sign too.' }); refresh(); },
    onError: (e) => { setDialog(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  });
  const sign = useMutation({
    // The hash of the text on screen is sent along, so the signature only counts if it is the text the person saw.
    mutationFn: async () => api(`${base}/${spec!.id}/sign`, { method: 'POST', body: { contentHash: await hashContent(spec!.content) } }),
    onSuccess: () => { setDialog(null); setNotice({ tone: 'good', text: 'You signed this version. It becomes active when the other side has signed too.' }); refresh(); },
    onError: (e) => { setDialog(null); setNotice({ tone: 'bad', text: signError(e) }); },
  });
  const reject = useMutation({
    mutationFn: () => api(`${base}/${spec!.id}/reject`, { method: 'POST', body: { note: rejectNote.trim() } }),
    onSuccess: () => { setDialog(null); setRejectNote(''); setNotice({ tone: 'good', text: 'The version was rejected. The person who proposed it is told.' }); refresh(); },
    onError: (e) => { setDialog(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  });
  const del = useMutation({
    mutationFn: () => api(`${base}/${spec!.id}${qs({ orgId })}`, { method: 'DELETE' }),
    onSuccess: () => { setDialog(null); refresh(); nav(root, { replace: true }); },
    onError: (e) => { setDialog(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  });

  if (listQ.isLoading) return <div className="page"><Spinner /></div>;

  const mySig = spec ? (staff ? spec.klineSignature : spec.partnerSignature) : null;
  const act = spec?.actions ?? null;
  const canEditNow = !!spec && spec.status === 'draft' && (act ? act.edit : canCreate);
  const canProposeNow = !!spec && spec.status === 'draft' && (act ? act.propose : canCreate);
  const canDeleteNow = !!spec && spec.status === 'draft' && (act ? act.delete : canCreate);
  const canSignNow = !!spec && spec.status === 'proposed' && (act ? act.sign : can('spec.sign') && !mySig);
  const canRejectNow = !!spec && spec.status === 'proposed' && (act ? act.reject : can('spec.sign'));
  const shown = versions.filter((v) => FILTERS.find((f) => f.id === filter)!.test(v));
  const hasDraft = versions.some((v) => v.status === 'draft');
  const compareSpec = compareQ.data && spec ? (compareQ.data.version < spec.version ? { from: compareQ.data, to: spec } : { from: spec, to: compareQ.data }) : null;

  return (
    <div className="page">
      {staff ? <div><Link to="/console/specs" className="small">Back to partners</Link></div> : null}
      <PageHeader
        title={staff ? <>Production specification: <PartnerName orgId={orgId} fallback={versions[0]?.orgName ?? null} /></> : 'Production specification'}
        subtitle="The agreed way K Line makes your aligners. Both sides sign each version, and every case records the version it was made under."
        actions={canCreate ? <Button variant="primary" loading={create.isPending} disabled={hasDraft} onClick={() => create.mutate()} title={hasDraft ? 'Finish or delete the current draft first' : undefined}><Plus size={16} aria-hidden="true" /> New draft</Button> : undefined}
      />
      {listQ.isError ? <Notice tone="bad" action={<Button size="sm" onClick={() => listQ.refetch()}>Try again</Button>}>{errorText(listQ.error)}</Notice> : null}
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      {!listQ.isError && versions.length === 0 ? (
        <Card>
          <Empty title="No specification yet" action={canCreate ? <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Start from the K Line defaults</Button> : undefined}>
            {canCreate ? 'Start a draft from the standard K Line text, edit it, propose it and sign it together.' : 'Nothing has been drafted or signed yet.'}
          </Empty>
        </Card>
      ) : null}
      {!active && versions.length > 0 ? <Notice tone="warn" title="No specification is active yet">A version becomes active once both sides have signed it.</Notice> : null}

      {versions.length > 0 ? (
        <div className="spec-layout">
          <Card title="Versions" className="spec-versions">
            <div className="tabs" role="group" aria-label="Filter versions">
              {FILTERS.map((f) => <button key={f.id} type="button" className="tab" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
            </div>
            <ul className="version-list">
              {shown.map((v) => (
                <li key={v.id}>
                  <Link to={`${root}/${v.id}`} aria-current={v.id === selectedId ? 'true' : undefined} className={v.id === selectedId ? 'version-on' : undefined}>
                    <span className="row" style={{ gap: 8 }}><strong>Version {formatNumber(v.version)}</strong><Badge tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status]}</Badge></span>
                    <span className="small muted">{versionDate(v)}</span>
                    {v.changeNote ? <span className="small">{v.changeNote}</span> : null}
                  </Link>
                </li>
              ))}
              {shown.length === 0 ? <li className="muted small">No versions in this view.</li> : null}
            </ul>
          </Card>

          <div className="stack">
            {detailQ.isLoading ? <Spinner /> : null}
            {detailQ.isError ? <Notice tone="bad">{errorText(detailQ.error)}</Notice> : null}
            {spec ? (
              <>
                <Card
                  title={<span className="row" style={{ gap: 10 }}>Version {formatNumber(spec.version)} <Badge tone={STATUS_TONE[spec.status]}>{STATUS_LABEL[spec.status]}</Badge></span>}
                  actions={
                    <>
                      {canEditNow && !editing ? <Button size="sm" onClick={() => setEditingId(spec.id)}><Pencil size={14} aria-hidden="true" /> Edit</Button> : null}
                      {canProposeNow && !editing ? <Button size="sm" variant="primary" onClick={() => setDialog('propose')}>Propose</Button> : null}
                      {canDeleteNow && !editing ? <Button size="sm" onClick={() => setDialog('delete')}><Trash2 size={14} aria-hidden="true" /> Delete</Button> : null}
                      {canSignNow ? <Button size="sm" variant="primary" onClick={() => setDialog('sign')}>Sign</Button> : null}
                      {canRejectNow ? <Button size="sm" onClick={() => setDialog('reject')}>Reject</Button> : null}
                    </>
                  }
                >
                  <dl className="facts">
                    <dt>Change note</dt><dd>{spec.changeNote || <span className="muted">None</span>}</dd>
                    {spec.createdSide ? <><dt>Drafted by</dt><dd>{spec.createdSide === 'kline' ? 'K Line' : 'The partner'}</dd></> : null}
                    <SignatureRow label="Partner signature" sig={spec.partnerSignature} />
                    <SignatureRow label="K Line signature" sig={spec.klineSignature} />
                    {spec.activatedAt ? <><dt>Active since</dt><dd>{formatDateTime(spec.activatedAt)}</dd></> : null}
                    {spec.rejectionNote ? <><dt>Rejected because</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{spec.rejectionNote}</dd></> : null}
                  </dl>
                  {spec.status === 'proposed' && !canSignNow ? (
                    <p className="small muted">
                      {mySig ? 'Your side has signed. Waiting for the other side.' : !can('spec.sign') ? 'You do not have permission to sign.' : 'Your side has not signed yet. If you signed for the other side, a different person must sign for this one.'}
                    </p>
                  ) : null}
                  {!editing ? <HashCheck spec={spec} /> : null}
                </Card>

                {!editing && versions.length > 1 ? (
                  <Card>
                    <div className="row">
                      <GitCompare size={18} aria-hidden="true" />
                      <div className="field" style={{ minWidth: 220 }}>
                        <label htmlFor="cmp">Compare with another version</label>
                        <select id="cmp" value={compareId} onChange={(e) => setCompareId(e.target.value)}>
                          <option value="">Do not compare</option>
                          {versions.filter((v) => v.id !== spec.id).map((v) => <option key={v.id} value={v.id}>Version {v.version}, {STATUS_LABEL[v.status]}</option>)}
                        </select>
                      </div>
                    </div>
                    {compareQ.isLoading ? <Spinner /> : null}
                    {compareQ.isError ? <Notice tone="bad">{errorText(compareQ.error)}</Notice> : null}
                  </Card>
                ) : null}
                {!editing && compareSpec ? <DiffView from={compareSpec.from} to={compareSpec.to} /> : null}

                {editing ? (
                  <SpecEditor spec={spec} staff={staff} base={base} onCancel={() => setEditingId(null)} onSaved={() => { setEditingId(null); setNotice({ tone: 'good', text: 'The draft was saved.' }); refresh(); }} />
                ) : <SpecView content={spec.content} />}
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <Dialog open={dialog === 'propose'} title="Propose this version?" onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Not yet</Button><Button variant="primary" loading={propose.isPending} onClick={() => propose.mutate()}>Propose</Button></>}>
        <div className="stack-sm">
          <p>The draft can no longer be edited once it is proposed. The other side can then read it, sign it or reject it.</p>
          <p><IfMfa>You will be asked for a fresh code from your authenticator app. </IfMfa>Proposing does not sign. You still need to sign for your side.</p>
        </div>
      </Dialog>
      <Dialog open={dialog === 'sign'} title={`Sign version ${spec?.version ?? ''}?`} onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Not yet</Button><Button variant="primary" loading={sign.isPending} onClick={() => sign.mutate()}>Sign</Button></>}>
        <div className="stack-sm">
          <p>Your name and the time are recorded as the {staff ? 'K Line' : 'partner'} signature. When both sides have signed, this version becomes the active specification and replaces the current one.</p>
          <IfMfa><p>You will be asked for a fresh code from your authenticator app.</p></IfMfa>
        </div>
      </Dialog>
      <Dialog open={dialog === 'reject'} title="Reject this version" onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" loading={reject.isPending} disabled={!rejectNote.trim()} onClick={() => reject.mutate()}>Reject the version</Button></>}>
        <Field label="Why are you rejecting it?" hint="The person who proposed it will read this.">
          {(p) => <textarea {...p} value={rejectNote} maxLength={1000} rows={4} onChange={(e) => setRejectNote(e.target.value)} />}
        </Field>
      </Dialog>
      <Dialog open={dialog === 'delete'} title="Delete this draft?" onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Keep the draft</Button><Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>Delete the draft</Button></>}>
        <p>The draft is removed for good. Signed versions are never removed.</p>
      </Dialog>
    </div>
  );
}

function PartnerName({ orgId, fallback }: { orgId?: string; fallback: string | null }) {
  const partners = useSpecPartners().data ?? [];
  return <>{partners.find((p) => p.orgId === orgId)?.name ?? fallback ?? 'partner'}</>;
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
