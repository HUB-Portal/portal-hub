import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
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
export function AlignerPicker({ aligners, selected, onToggle, onSetMany, legend }: { aligners: AlignerRef[]; selected: Set<string>; onToggle: (key: string) => void; onSetMany: (keys: string[], on: boolean) => void; legend: string }) {
  const [arch, setArch] = useState<'all' | 'upper' | 'lower'>('all');
  const shown = aligners.filter((a) => arch === 'all' || a.arch === arch);
  const allOn = shown.length > 0 && shown.every((a) => selected.has(a.key));
  return (
    <fieldset className="check-group">
      <legend>{legend}</legend>
      <div className="row">
        <div className="tabs" role="group" aria-label="Show aligners of">
          {(['all', 'upper', 'lower'] as const).map((a) => (
            <button key={a} type="button" className="tab" aria-pressed={arch === a} onClick={() => setArch(a)}>{a === 'all' ? 'Both arches' : a === 'upper' ? 'Upper' : 'Lower'}</button>
          ))}
        </div>
        <Button size="sm" onClick={() => onSetMany(shown.map((a) => a.key), !allOn)} disabled={!shown.length}>{allOn ? 'Clear these' : 'Select all of these'}</Button>
        <span className="muted small" aria-live="polite">{formatNumber(selected.size)} selected</span>
      </div>
      <div className="chip-grid">
        {shown.map((a) => (
          <label key={a.key} className={`chip${selected.has(a.key) ? ' chip-on' : ''}`}>
            <input type="checkbox" checked={selected.has(a.key)} onChange={() => onToggle(a.key)} />
            <span>{a.code}</span>
          </label>
        ))}
      </div>
      {!shown.length ? <p className="muted small">There are no aligners to choose from.</p> : null}
    </fieldset>
  );
}

export default function ClaimNew() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const caseQ = useQuery({ queryKey: ['case', id], queryFn: () => api<CaseDetail>(`/api/cases/${id}`) });
  const c = caseQ.data?.case;
  const files = caseQ.data?.files;
  const aligners = useMemo(() => alignersOf(files ?? []), [files]);

  const specQ = useQuery({
    queryKey: ['claim-spec', c?.id, c?.specId ?? 'active'],
    enabled: !!c && can('spec.read'),
    retry: false,
    queryFn: async () => {
      try { return normalizeSpec(await api(c!.specId ? `/api/specs/${c!.specId}` : '/api/specs/active')); } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
        throw e;
      }
    },
  });
  const clauses = useMemo(() => (specQ.data ? allClauses(specQ.data.content) : []), [specQ.data]);

  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<ClaimItem[]>([]);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [defect, setDefect] = useState('');
  const [note, setNote] = useState('');
  const [clauseIds, setClauseIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, FileStatus>>({});
  const [uploading, setUploading] = useState(false);
  const [created, setCreated] = useState<{ id: string; failed: boolean } | null>(null);
  const ev = usePending({ exts: EVIDENCE_EXTS, maxFiles: MAX_EVIDENCE_FILES, maxBytes: (ext) => (mediaKind(ext) === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES) });

  function addItems() {
    if (!pick.size || !defect) return;
    setItems((prev) => {
      const next = [...prev];
      for (const a of aligners) {
        if (!pick.has(a.key)) continue;
        if (next.some((i) => alignerKey(i) === a.key && i.defectCode === defect)) continue;
        next.push({ arch: a.arch, step: a.step, template: a.template, defectCode: defect, note: note.trim() || null });
      }
      return next;
    });
    setPick(new Set());
    setNote('');
  }

  const create = useMutation({
    mutationFn: async () => {
      const res = await api<unknown>('/api/claims', {
        method: 'POST',
        body: {
          caseId: id,
          summary: summary.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(clauseIds.size ? { specClauseIds: [...clauseIds] } : {}),
          items: items.map((i) => ({ arch: i.arch, step: i.step, template: i.template, defectCode: i.defectCode, ...(i.note ? { note: i.note } : {}) })),
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
    onSuccess: (r) => {
      for (const k of ['claims', 'case', 'cases', 'case-claims']) qc.invalidateQueries({ queryKey: [k] });
      if (r.failed) setCreated(r); else nav(`/portal/claims/${r.id}`);
    },
    onError: (e) => setError(claimError(e)),
  });

  if (caseQ.isLoading) return <div className="page"><Spinner /></div>;
  if (caseQ.isError || !c) return <div className="page"><Notice tone="bad" title="We could not open this case">{errorText(caseQ.error)}</Notice><div><Link to="/portal/cases">Back to cases</Link></div></div>;

  if (!CLAIMABLE_CASE_STATUSES.includes(c.status)) {
    return (
      <div className="page page-narrow">
        <PageHeader title="Report an issue" subtitle={c.ref} />
        <Notice tone="warn" title="This case cannot have a claim yet">Claims can be opened once K Line has received the case. This case is not there yet.</Notice>
        <div><Link to={`/portal/cases/${c.id}`}>Back to the case</Link></div>
      </div>
    );
  }
  if (!can('claim.write')) {
    return (
      <div className="page page-narrow">
        <PageHeader title="Report an issue" subtitle={c.ref} />
        <Notice tone="warn" title="You cannot open claims">Ask an administrator or a quality person in your organisation to report this issue.</Notice>
        <div><Link to={`/portal/cases/${c.id}`}>Back to the case</Link></div>
      </div>
    );
  }

  const canSend = summary.trim().length >= 3 && items.length > 0 && !create.isPending;

  if (created) {
    return (
      <div className="page page-narrow">
        <PageHeader title="Claim opened" subtitle={c.ref} />
        <Notice tone="warn" title="Some files did not upload">Your claim was opened, but not every photo or video went through. Open the claim to add them again.</Notice>
        <div><Link className="btn btn-primary" to={`/portal/claims/${created.id}`}>Open the claim</Link></div>
      </div>
    );
  }

  return (
    <div className="page page-narrow">
      <div><Link to={`/portal/cases/${c.id}`} className="small">Back to the case</Link></div>
      <PageHeader title="Report an issue" subtitle={`Case ${c.ref}${c.caseId ? `, ${c.caseId}` : ''}`} />
      <Notice tone="info" title="Keep patients private">{NAME_WARNING}</Notice>
      {error ? <Notice tone="bad">{error}</Notice> : null}

      <Card title="1. What is wrong">
        <Field label="Short summary" hint="One sentence. For example: sharp edges on several lower aligners.">
          {(p) => <input {...p} value={summary} maxLength={200} onChange={(e) => setSummary(e.target.value)} required />}
        </Field>
        <Field label="More detail (optional)" hint={`${formatNumber(description.length)} of ${formatNumber(4000)} characters.`}>
          {(p) => <textarea {...p} value={description} maxLength={4000} rows={4} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
      </Card>

      <Card title="2. Which aligners and what defect">
        {aligners.length === 0 ? <Notice tone="warn">This case has no aligner models, so there is nothing to choose from.</Notice> : (
          <>
            <AlignerPicker
              legend="Choose the aligners with this defect"
              aligners={aligners}
              selected={pick}
              onToggle={(k) => setPick((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
              onSetMany={(keys, on) => setPick((s) => { const n = new Set(s); keys.forEach((k) => (on ? n.add(k) : n.delete(k))); return n; })}
            />
            <div className="form-grid">
              <Field label="Defect">
                {(p) => (
                  <select {...p} value={defect} onChange={(e) => setDefect(e.target.value)}>
                    <option value="">Choose a defect</option>
                    {DEFECT_CODES.map((d) => <option key={d} value={d}>{defectLabel(d)}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Note (optional)" hint="No patient names.">
                {(p) => <input {...p} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}
              </Field>
            </div>
            <div><Button variant="primary" disabled={!pick.size || !defect} onClick={addItems}><Plus size={16} aria-hidden="true" /> Add to the claim</Button></div>
          </>
        )}
        {items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Aligner</th><th>Defect</th><th>Note</th><th><span className="sr-only">Remove</span></th></tr></thead>
              <tbody>
                {items.map((i, n) => (
                  <tr key={`${alignerKey(i)}|${i.defectCode}`}>
                    <td className="nowrap"><strong>{alignerName(i)}</strong></td>
                    <td>{defectLabel(i.defectCode)}</td>
                    <td>{i.note ?? <span className="muted">None</span>}</td>
                    <td className="right"><Button size="sm" onClick={() => setItems((p) => p.filter((_x, m) => m !== n))} aria-label={`Remove ${alignerName(i)}, ${defectLabel(i.defectCode)}`}><Trash2 size={14} aria-hidden="true" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted small">Nothing added yet. Choose aligners and a defect, then add them.</p>}
      </Card>

      {clauses.length ? (
        <Card title="3. Specification clauses (optional)">
          <p className="muted small">Tick the clauses of your production specification, version {specQ.data?.version}, that the aligners do not meet.</p>
          <fieldset className="check-group">
            <legend className="sr-only">Specification clauses</legend>
            {clauses.map((cl) => (
              <div className="check" key={cl.id}>
                <input id={`cl-${cl.id}`} type="checkbox" checked={clauseIds.has(cl.id)} onChange={() => setClauseIds((s) => { const n = new Set(s); if (n.has(cl.id)) n.delete(cl.id); else n.add(cl.id); return n; })} />
                <label htmlFor={`cl-${cl.id}`}><Badge>{cl.id}</Badge> {cl.title}</label>
                <p className="hint">{cl.text}</p>
              </div>
            ))}
          </fieldset>
        </Card>
      ) : null}

      <Card title={`${clauses.length ? '4' : '3'}. Photos and videos`}>
        <AttachmentPicker
          pending={ev.pending}
          problems={ev.problems}
          status={status}
          onAdd={ev.add}
          onRemove={ev.remove}
          busy={uploading}
          accept=".jpg,.jpeg,.png,.mp4,.mov,.m4v,.pdf"
          label="Add photos or videos"
          hint={`JPEG or PNG photos up to 50 MB, MP4, MOV or M4V videos up to 512 MB, or PDF. Up to ${MAX_EVIDENCE_FILES} files. Clear photos help K Line decide faster.`}
        />
        <p className="small muted">The files are sent after the claim is opened. You can add more later.</p>
      </Card>

      <div className="row-end sticky-actions">
        <Link className="btn" to={`/portal/cases/${c.id}`}>Cancel</Link>
        <Button variant="primary" loading={create.isPending} disabled={!canSend} onClick={() => { setError(null); create.mutate(); }}>Open the claim</Button>
      </div>
      {!items.length ? <p className="small muted" style={{ textAlign: 'right' }}>Add at least one aligner and defect to open the claim.</p> : null}
    </div>
  );
}
