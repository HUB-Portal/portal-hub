import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, errorText, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilterOptions } from '../../lib/console';
import { formatDate, formatNumber } from '../../lib/format';
import { CLAIM_STATUSES, claimStatusLabel, claimStatusTone, normalizeClaimList, type Claim, type ClaimList } from '../../lib/quality';
import { Badge, Button, Card, Empty, Notice, PageHeader, Pagination, Spinner } from '../../ui/Common';

async function fetchClaims(staff: boolean, p: { status: string; orgId: string; page: number }): Promise<ClaimList> {
  const base = staff ? '/api/console/claims' : '/api/claims';
  return normalizeClaimList(await api(`${base}${qs({ status: p.status, orgId: p.orgId, page: p.page })}`));
}

export function ClaimRows({ items, staff }: { items: Claim[]; staff: boolean }) {
  const side = staff ? 'kline' : 'partner';
  const base = staff ? '/console/claims' : '/portal/claims';
  const caseBase = staff ? '/console/cases' : '/portal/cases';
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Claim</th>{staff ? <th>Partner</th> : null}<th>Case</th><th>Summary</th><th>Status</th><th>Opened</th></tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td className="link-cell nowrap"><Link to={`${base}/${c.id}`}>{c.number || 'Claim'}</Link></td>
              {staff ? <td>{c.orgName ?? ''}</td> : null}
              <td className="link-cell nowrap">{c.caseId ? <Link to={`${caseBase}/${c.caseId}`}>{c.caseRef ?? 'Case'}</Link> : (c.caseRef ?? '')}</td>
              <td style={{ minWidth: 200 }}>{c.summary}{c.itemCount ? <div className="muted small">{formatNumber(c.itemCount)} {c.itemCount === 1 ? 'aligner' : 'aligners'}</div> : null}</td>
              <td><Badge tone={claimStatusTone(c.status)}>{claimStatusLabel(c.status, side)}</Badge></td>
              <td className="nowrap">{formatDate(c.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PartnerSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const opts = useFilterOptions();
  return (
    <div className="field" style={{ minWidth: 160, flexBasis: 200 }}>
      <label htmlFor={id}>Partner</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All partners</option>
        {opts.partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  );
}

const filtersFor = (side: 'partner' | 'kline'): { id: string; label: string }[] => [
  { id: '', label: 'All claims' },
  { id: 'active', label: 'Not decided yet' },
  ...CLAIM_STATUSES.map((s) => ({ id: s, label: claimStatusLabel(s, side) })),
];

/** Claims list for partners, and for K Line staff when `staff` is set. */
export function ClaimsList({ staff }: { staff: boolean }) {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const orgId = staff ? (params.get('orgId') ?? '') : '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const q = useQuery({
    queryKey: [staff ? 'console-claims' : 'claims', { status, orgId, page }],
    queryFn: () => fetchClaims(staff, { status, orgId, page }),
    placeholderData: keepPreviousData,
  });

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.delete('page');
    setParams(next);
  }

  return (
    <div className="page">
      <PageHeader
        title="Quality claims"
        subtitle={staff ? 'Claims from every partner. Triage them, talk to the partner and decide.' : 'Problems you found with aligners from K Line, and how they were resolved.'}
        actions={!staff && can('case.read') ? <Link className="btn" to="/portal/cases">Open a case to report an issue</Link> : undefined}
      />
      <Card>
        <div className="toolbar">
          {staff ? <PartnerSelect id="cl-partner" value={orgId} onChange={(v) => setParam('orgId', v)} /> : null}
        </div>
        <div className="tabs" role="group" aria-label="Filter by status">
          {filtersFor(staff ? 'kline' : 'partner').map((f) => (
            <button key={f.id} type="button" className="tab" aria-pressed={status === f.id} onClick={() => setParam('status', f.id)}>{f.label}</button>
          ))}
        </div>
        {q.isError ? <Notice tone="bad" action={<Button size="sm" onClick={() => q.refetch()}>Try again</Button>}>{errorText(q.error)}</Notice> : null}
        {q.isLoading ? <Spinner /> : null}
        {q.data && q.data.items.length === 0 ? (
          <Empty title="No claims found">{status || orgId ? 'Try a different filter.' : staff ? 'Claims from partners will appear here.' : 'When you report an issue with a case it will appear here. Open a shipped case and choose Report an issue.'}</Empty>
        ) : null}
        {q.data && q.data.items.length ? (
          <>
            <p className="muted small" role="status">{formatNumber(q.data.total)} {q.data.total === 1 ? 'claim' : 'claims'}</p>
            <ClaimRows items={q.data.items} staff={staff} />
            <Pagination page={page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => { const next = new URLSearchParams(params); next.set('page', String(p)); setParams(next); }} />
          </>
        ) : null}
      </Card>
    </div>
  );
}

export default function Claims() {
  return <ClaimsList staff={false} />;
}
