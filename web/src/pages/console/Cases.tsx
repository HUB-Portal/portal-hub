import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, errorText, qs } from '../../lib/api';
import { useFilterOptions, type ConsoleCaseList } from '../../lib/console';
import { formatDate, formatNumber, isLate, statusLabel } from '../../lib/format';
import { Badge, Button, Card, Empty, Notice, PageHeader, Pagination, Spinner } from '../../ui/Common';
import { StatusBadge } from '../../ui/StatusBadge';
import { CaseChecks, KindBadge } from '../partner/Cases';

const SIMPLE_FILTERS: { id: string; label: string }[] = [
  { id: 'simple_submitted', label: 'Submitted (progress bar)' },
  { id: 'simple_production', label: 'Production (progress bar)' },
  { id: 'simple_shipped', label: 'Shipped (progress bar)' },
];
const STATUSES = ['draft', 'submitted', 'on_hold', 'ready', 'received', 'in_production', 'shipped', 'delivered', 'cancelled'];

export default function ConsoleCases() {
  const [params, setParams] = useSearchParams();
  const orgId = params.get('orgId') ?? '';
  const siteCode = params.get('siteCode') ?? '';
  const status = params.get('status') ?? '';
  const mode = params.get('mode') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const urlSearch = params.get('search') ?? '';
  const [text, setText] = useState(urlSearch);
  const opts = useFilterOptions();

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
    queryKey: ['console-cases', { orgId, siteCode, status, mode, page, search: urlSearch }],
    queryFn: () => api<ConsoleCaseList>(`/api/console/cases${qs({ search: urlSearch, status, orgId, siteCode, mode, page, pageSize: 25 })}`),
    placeholderData: keepPreviousData,
  });

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.delete('page');
    setParams(next);
  }
  const filtered = !!(orgId || siteCode || status || mode || urlSearch);

  return (
    <div className="page">
      <PageHeader title="Cases" subtitle="Every case from every partner." />
      <Card>
        <div className="toolbar">
          <div className="field">
            <label htmlFor="c-search">Search</label>
            <input id="c-search" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Reference, case ID or exact patient name" autoComplete="off" />
          </div>
          <div className="field" style={{ minWidth: 160, flexBasis: 170 }}>
            <label htmlFor="c-partner">Partner</label>
            <select id="c-partner" value={orgId} onChange={(e) => setParam('orgId', e.target.value)}>
              <option value="">All partners</option>
              {opts.partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 130, flexBasis: 140 }}>
            <label htmlFor="c-site">Site</label>
            <select id="c-site" value={siteCode} onChange={(e) => setParam('siteCode', e.target.value)}>
              <option value="">All sites</option>
              {opts.siteCodes.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 150, flexBasis: 160 }}>
            <label htmlFor="c-status">Status</label>
            <select id="c-status" value={status} onChange={(e) => setParam('status', e.target.value)}>
              <option value="">Any status</option>
              {SIMPLE_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 150, flexBasis: 160 }}>
            <label htmlFor="c-mode">Mode</label>
            <select id="c-mode" value={mode} onChange={(e) => setParam('mode', e.target.value)}>
              <option value="">Any mode</option>
              <option value="standard">Standard</option>
              <option value="direct">Direct manufacturing</option>
            </select>
          </div>
          {filtered ? <Button onClick={() => { setText(''); setParams({}); }}>Clear filters</Button> : null}
        </div>
        {q.isError ? <Notice tone="bad" action={<Button size="sm" onClick={() => q.refetch()}>Try again</Button>}>{errorText(q.error)}</Notice> : null}
        {q.isLoading ? <Spinner /> : null}
        {q.data && q.data.items.length === 0 ? <Empty title="No cases found">{filtered ? 'Try a different search or filter.' : 'Cases from partners will appear here.'}</Empty> : null}
        {q.data && q.data.items.length ? (
          <>
            <p className="muted small" role="status">{formatNumber(q.data.total)} {q.data.total === 1 ? 'case' : 'cases'}</p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Reference</th><th>Partner</th><th>Case ID</th><th>Patient</th><th>Status</th><th>Site</th><th>Due</th><th>Checks</th></tr>
                </thead>
                <tbody>
                  {q.data.items.map((c) => (
                    <tr key={c.id}>
                      <td className="link-cell nowrap">
                        <Link to={`/console/cases/${c.id}`}>{c.ref}</Link>
                        {c.manufacturingMode === 'direct' ? <div><Badge tone="info">Direct</Badge></div> : null}
                        <KindBadge c={c} />
                      </td>
                      <td>{c.orgName ?? ''}</td>
                      <td>{c.caseId ?? <span className="muted">None</span>}</td>
                      <td>{c.patientMasked ? <span className="masked">{c.patientMasked}</span> : <span className="muted">Not given</span>}</td>
                      <td><StatusBadge c={c} staff /></td>
                      <td>{c.siteCode ?? <span className="muted">None</span>}</td>
                      <td className="nowrap">{c.dueDate ? <span className={isLate(c.dueDate, c.status) ? 'late' : undefined}>{formatDate(c.dueDate)}{isLate(c.dueDate, c.status) ? ' (late)' : ''}</span> : <span className="muted">Not set</span>}</td>
                      <td><CaseChecks c={c} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => { const next = new URLSearchParams(params); next.set('page', String(p)); setParams(next); }} />
          </>
        ) : null}
      </Card>
    </div>
  );
}
