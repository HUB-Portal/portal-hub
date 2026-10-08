import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api, errorText, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { caseStatus, formatDate, formatNumber } from '../../lib/format';
import { useCaseCounts } from '../../lib/orgApi';
import type { CaseItem, CaseList } from '../../lib/types';
import { Badge, Button, Card, Empty, Notice, PageHeader, Pagination, Spinner } from '../../ui/Common';
import { AddDocuments } from '../../ui/AddDocuments';

export const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'All cases' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'draft', label: 'Draft' },
  { id: 'simple_submitted', label: 'Submitted' },
  { id: 'simple_production', label: 'Production' },
  { id: 'simple_shipped', label: 'Shipped' },
];

/** Marks replacement and rework cases and says which case they came from. */
export function KindBadge({ c }: { c: CaseItem }) {
  if (!c.kind || c.kind === 'new') return null;
  return <div><Badge tone="info">{c.kind === 'rework' ? 'Rework' : c.kind === 'replacement' ? 'Replacement' : c.kind}</Badge>{c.parentRef ? <span className="muted small"> of {c.parentRef}</span> : null}</div>;
}

export function CaseChecks({ c }: { c: CaseItem }) {
  const e = c.checks.errors.length;
  const w = c.checks.warnings.length;
  if (!e && !w) return <Badge tone="good">Clean</Badge>;
  return (
    <span className="row" style={{ gap: 6 }}>
      {e ? <Badge tone="bad">{formatNumber(e)} {e === 1 ? 'error' : 'errors'}</Badge> : null}
      {w ? <Badge tone="warn">{formatNumber(w)} {w === 1 ? 'warning' : 'warnings'}</Badge> : null}
    </span>
  );
}

/** One plain status per case, in words, with what to do next (review of 8 Oct 2026, A2). */
export function CaseStatusCell({ c }: { c: CaseItem }) {
  const st = caseStatus(c);
  return (
    <>
      <Badge tone={st.tone}>{st.text}</Badge>
      {st.next ? <div className="small muted">{st.next}</div> : null}
    </>
  );
}

export function CaseRows({ items, onChanged }: { items: CaseItem[]; onChanged?: () => void }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Reference</th><th>Case ID</th><th>Patient</th><th>Status and next step</th><th className="num">Upper</th><th className="num">Lower</th><th>Created</th><th><span className="sr-only">Add documents</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td className="link-cell nowrap"><Link to={`/portal/cases/${c.id}`}>{c.ref}</Link><KindBadge c={c} /></td>
              <td>{c.caseId ?? <span className="muted">Not set</span>}</td>
              <td>{c.patientName ?? c.patientMasked ?? <span className="muted">Not set</span>}</td>
              <td><CaseStatusCell c={c} /></td>
              <td className="num">{formatNumber(c.counts.upper)}</td>
              <td className="num">{formatNumber(c.counts.lower)}</td>
              <td className="nowrap">{formatDate(c.createdAt)}</td>
              <td className="right">{!c.purgedAt && c.status !== 'cancelled' ? <AddDocuments caseId={c.id} status={c.status} compact onDone={onChanged} /> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Cases() {
  const { can } = useAuth();
  const counts = useCaseCounts(true);
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const urlSearch = params.get('search') ?? '';
  const [text, setText] = useState(urlSearch);

  useEffect(() => {
    if (text === urlSearch) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (text) next.set('search', text); else next.delete('search');
      next.delete('page');
      setParams(next, { replace: true });
    }, 350);
    return () => clearTimeout(t);
  }, [text, urlSearch, params, setParams]);

  const q = useQuery({
    queryKey: ['cases', { status, page, search: urlSearch }],
    queryFn: () => api<CaseList>(`/api/cases${qs({ status, page, pageSize: 25, search: urlSearch })}`),
    placeholderData: keepPreviousData,
  });

  function setFilter(id: string) {
    const next = new URLSearchParams(params);
    if (id) next.set('status', id); else next.delete('status');
    next.delete('page');
    setParams(next);
  }
  function setPage(p: number) {
    const next = new URLSearchParams(params);
    next.set('page', String(p));
    setParams(next);
  }

  return (
    <div className="page">
      <PageHeader
        title="Cases"
        subtitle="Every case your organisation has sent to K Line."
        actions={can('case.write') ? <Link className="btn btn-primary" to="/portal">Send cases</Link> : undefined}
      />
      <Card>
        <div className="toolbar">
          <div className="field">
            <label htmlFor="case-search">Search</label>
            <input id="case-search" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Case ID, reference or exact patient name" autoComplete="off" />
          </div>
        </div>
        <div className="tabs" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map((f) => {
            // Counts on the chips (review of 8 Oct 2026, A3): drafts that need work no longer sit unnoticed.
            const n = f.id === 'attention' ? counts.data?.attention : f.id === 'draft' ? counts.data?.drafts : f.id === '' ? counts.data?.all : undefined;
            return (
              <button key={f.id} type="button" className="tab" aria-pressed={status === f.id} onClick={() => setFilter(f.id)}>
                {f.label}{n !== undefined ? <span className={`chip-count${f.id === 'attention' && n > 0 ? ' chip-count-alert' : ''}`}>{formatNumber(n)}</span> : null}
              </button>
            );
          })}
        </div>
        {q.isError ? <Notice tone="bad" action={<Button size="sm" onClick={() => q.refetch()}>Try again</Button>}>{errorText(q.error)}</Notice> : null}
        {q.isLoading ? <Spinner /> : null}
        {q.data && q.data.items.length === 0 ? (
          <Empty title="No cases found" action={can('case.write') ? <Link className="btn" to="/portal">Send your first cases</Link> : undefined}>
            {urlSearch || status ? 'Try a different search or filter.' : 'Cases you send will appear here.'}
          </Empty>
        ) : null}
        {q.data && q.data.items.length ? (
          <>
            <p className="muted small" role="status">{formatNumber(q.data.total)} {q.data.total === 1 ? 'case' : 'cases'}</p>
            <CaseRows items={q.data.items} onChanged={() => { void q.refetch(); void counts.refetch(); }} />
            <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
          </>
        ) : null}
      </Card>
    </div>
  );
}
