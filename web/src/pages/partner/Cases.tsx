import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api, errorText, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, formatNumber, portalLabel, portalTone } from '../../lib/format';
import type { CaseItem, CaseList } from '../../lib/types';
import { Badge, Button, Card, Empty, Notice, PageHeader, Pagination, Spinner } from '../../ui/Common';
import { StatusBadge } from '../../ui/StatusBadge';

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

export function CaseRows({ items }: { items: CaseItem[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Reference</th><th>Case ID</th><th>Patient</th><th>Status</th><th className="num">Upper</th><th className="num">Lower</th><th>Checks</th><th>Created</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td className="link-cell nowrap"><Link to={`/portal/cases/${c.id}`}>{c.ref}</Link><KindBadge c={c} /></td>
              <td>
                {c.caseId ?? <span className="muted">None</span>}
                {c.manufacturingMode === 'direct' ? (
                  <div><Badge tone={portalTone(c.portal.status, c.portal.demo)} title="Direct manufacturing case">{c.portal.demo && c.portal.status === 'pushed' ? portalLabel(c.portal.status, true) : `Portal: ${portalLabel(c.portal.status)}`}</Badge></div>
                ) : null}
              </td>
              <td>{c.patientMasked ? <span className="masked">{c.patientMasked}</span> : <span className="muted">Not given</span>}</td>
              <td><StatusBadge c={c} /></td>
              <td className="num">{formatNumber(c.counts.upper)}</td>
              <td className="num">{formatNumber(c.counts.lower)}</td>
              <td><CaseChecks c={c} /></td>
              <td className="nowrap">{formatDate(c.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Cases() {
  const { can } = useAuth();
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
          {STATUS_FILTERS.map((f) => (
            <button key={f.id} type="button" className="tab" aria-pressed={status === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
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
            <CaseRows items={q.data.items} />
            <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
          </>
        ) : null}
      </Card>
    </div>
  );
}
