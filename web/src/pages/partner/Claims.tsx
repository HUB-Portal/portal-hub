import { For, Show } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { createQuery, keepPreviousData } from '@tanstack/solid-query';
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

export function ClaimRows(props: { items: Claim[]; staff: boolean }) {
  const side = () => (props.staff ? 'kline' : 'partner');
  const base = () => (props.staff ? '/console/claims' : '/portal/claims');
  const caseBase = () => (props.staff ? '/console/cases' : '/portal/cases');
  return (
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>Claim</th><Show when={props.staff}><th>Partner</th></Show><th>Case</th><th>Summary</th><th>Status</th><th>Opened</th></tr>
        </thead>
        <tbody>
          <For each={props.items}>
            {(c) => (
              <tr>
                <td class="link-cell nowrap"><A href={`${base()}/${c.id}`}>{c.number || 'Claim'}</A></td>
                <Show when={props.staff}><td>{c.orgName ?? ''}</td></Show>
                <td class="link-cell nowrap">{c.caseId ? <A href={`${caseBase()}/${c.caseId}`}>{c.caseRef ?? 'Case'}</A> : (c.caseRef ?? '')}</td>
                <td style={{ 'min-width': '200px' }}>{c.summary}{c.itemCount ? <div class="muted small">{formatNumber(c.itemCount)} {c.itemCount === 1 ? 'aligner' : 'aligners'}</div> : null}</td>
                <td><Badge tone={claimStatusTone(c.status)}>{claimStatusLabel(c.status, side())}</Badge></td>
                <td class="nowrap">{formatDate(c.createdAt)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

export function PartnerSelect(props: { id: string; value: string; onChange: (v: string) => void }) {
  const opts = useFilterOptions();
  return (
    <div class="field" style={{ 'min-width': '160px', 'flex-basis': '200px' }}>
      <label for={props.id}>Partner</label>
      <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
        <option value="">All partners</option>
        <For each={opts.partners}>{(p) => <option value={p.id}>{p.name}</option>}</For>
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
export function ClaimsList(props: { staff: boolean }) {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
  const status = () => one(params.status);
  const orgId = () => (props.staff ? one(params.orgId) : '');
  const page = () => Math.max(1, Number(one(params.page) || 1) || 1);
  const q = createQuery(() => ({
    queryKey: [props.staff ? 'console-claims' : 'claims', { status: status(), orgId: orgId(), page: page() }],
    queryFn: () => fetchClaims(props.staff, { status: status(), orgId: orgId(), page: page() }),
    placeholderData: keepPreviousData,
  }));

  /** Sets one filter in the address and goes back to the first page. An empty value removes the filter. */
  function setParam(key: string, value: string) {
    setParams({ [key]: value || undefined, page: undefined });
  }

  return (
    <div class="page">
      <PageHeader
        title="Quality claims"
        subtitle={props.staff ? 'Claims from every partner. Triage them, talk to the partner and decide.' : 'Problems you found with aligners from K Line, and how they were resolved.'}
        actions={!props.staff && can('case.read') ? <A class="btn" href="/portal/cases">Open a case to report an issue</A> : undefined}
      />
      <Card>
        <div class="toolbar">
          <Show when={props.staff}><PartnerSelect id="cl-partner" value={orgId()} onChange={(v) => setParam('orgId', v)} /></Show>
        </div>
        <div class="tabs" role="group" aria-label="Filter by status">
          <For each={filtersFor(props.staff ? 'kline' : 'partner')}>
            {(f) => <button type="button" class="tab" aria-pressed={status() === f.id} onClick={() => setParam('status', f.id)}>{f.label}</button>}
          </For>
        </div>
        <Show when={q.isError}><Notice tone="bad" action={<Button size="sm" onClick={() => q.refetch()}>Try again</Button>}>{errorText(q.error)}</Notice></Show>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.data && q.data.items.length === 0}>
          <Empty title="No claims found">{status() || orgId() ? 'Try a different filter.' : props.staff ? 'Claims from partners will appear here.' : 'When you report an issue with a case it will appear here. Open a shipped case and choose Report an issue.'}</Empty>
        </Show>
        <Show when={q.data && q.data.items.length ? q.data : null}>
          {(d) => (
            <>
              <p class="muted small" role="status">{formatNumber(d().total)} {d().total === 1 ? 'claim' : 'claims'}</p>
              <ClaimRows items={d().items} staff={props.staff} />
              <Pagination page={page()} pageSize={d().pageSize} total={d().total} onPage={(p) => setParams({ page: String(p) })} />
            </>
          )}
        </Show>
      </Card>
    </div>
  );
}

export default function Claims() {
  return <ClaimsList staff={false} />;
}
