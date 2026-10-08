import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { createQuery, keepPreviousData } from '@tanstack/solid-query';
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
export function KindBadge(props: { c: CaseItem }) {
  return (
    <Show when={props.c.kind && props.c.kind !== 'new'}>
      <div><Badge tone="info">{props.c.kind === 'rework' ? 'Rework' : props.c.kind === 'replacement' ? 'Replacement' : props.c.kind}</Badge><Show when={props.c.parentRef}><span class="muted small"> of {props.c.parentRef}</span></Show></div>
    </Show>
  );
}

export function CaseChecks(props: { c: CaseItem }) {
  const e = () => props.c.checks.errors.length;
  const w = () => props.c.checks.warnings.length;
  return (
    <Show when={e() || w()} fallback={<Badge tone="good">Clean</Badge>}>
      <span class="row" style={{ gap: '6px' }}>
        <Show when={e()}><Badge tone="bad">{formatNumber(e())} {e() === 1 ? 'error' : 'errors'}</Badge></Show>
        <Show when={w()}><Badge tone="warn">{formatNumber(w())} {w() === 1 ? 'warning' : 'warnings'}</Badge></Show>
      </span>
    </Show>
  );
}

/** One plain status per case, in words, with what to do next (review of 8 Oct 2026, A2). */
export function CaseStatusCell(props: { c: CaseItem }) {
  const st = () => caseStatus(props.c);
  return (
    <>
      <Badge tone={st().tone}>{st().text}</Badge>
      <Show when={st().next}><div class="small muted">{st().next}</div></Show>
    </>
  );
}

export function CaseRows(props: { items: CaseItem[]; onChanged?: () => void }) {
  return (
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Reference</th><th>Case ID</th><th>Patient</th><th>Status and next step</th><th class="num">Upper</th><th class="num">Lower</th><th>Created</th><th><span class="sr-only">Add documents</span></th>
          </tr>
        </thead>
        <tbody>
          <For each={props.items}>
            {(c) => (
              <tr>
                <td class="link-cell nowrap"><A href={`/portal/cases/${c.id}`}>{c.ref}</A><KindBadge c={c} /></td>
                <td>{c.caseId ?? <span class="muted">Not set</span>}</td>
                <td>{c.patientName ?? c.patientMasked ?? <span class="muted">Not set</span>}</td>
                <td><CaseStatusCell c={c} /></td>
                <td class="num">{formatNumber(c.counts.upper)}</td>
                <td class="num">{formatNumber(c.counts.lower)}</td>
                <td class="nowrap">{formatDate(c.createdAt)}</td>
                <td class="right"><Show when={!c.purgedAt && c.status !== 'cancelled'}><AddDocuments caseId={c.id} status={c.status} compact onDone={props.onChanged} /></Show></td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

export default function Cases() {
  const { can } = useAuth();
  const counts = useCaseCounts(() => true);
  const [params, setParams] = useSearchParams();
  // A query value is a string, or a list when the address repeats the name: take the first.
  const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const status = () => param(params.status);
  const page = () => Math.max(1, Number(param(params.page) || 1) || 1);
  const urlSearch = () => param(params.search);
  const [text, setText] = createSignal(urlSearch());

  createEffect(() => {
    const typed = text();
    if (typed === urlSearch()) return;
    const t = setTimeout(() => {
      setParams({ search: typed || undefined, page: undefined }, { replace: true });
    }, 350);
    onCleanup(() => clearTimeout(t));
  });

  const q = createQuery(() => ({
    queryKey: ['cases', { status: status(), page: page(), search: urlSearch() }],
    queryFn: () => api<CaseList>(`/api/cases${qs({ status: status(), page: page(), pageSize: 25, search: urlSearch() })}`),
    placeholderData: keepPreviousData,
  }));

  function setFilter(id: string) {
    setParams({ status: id || undefined, page: undefined });
  }
  function setPage(p: number) {
    setParams({ page: String(p) });
  }

  return (
    <div class="page">
      <PageHeader
        title="Cases"
        subtitle="Every case your organisation has sent to K Line."
        actions={can('case.write') ? <A class="btn btn-primary" href="/portal">Send cases</A> : undefined}
      />
      <Card>
        <div class="toolbar">
          <div class="field">
            <label for="case-search">Search</label>
            <input id="case-search" type="search" value={text()} onInput={(e) => setText(e.currentTarget.value)} placeholder="Case ID, reference or exact patient name" autocomplete="off" />
          </div>
        </div>
        <div class="tabs" role="group" aria-label="Filter by status">
          <For each={STATUS_FILTERS}>
            {(f) => {
              // Counts on the chips (review of 8 Oct 2026, A3): drafts that need work no longer sit unnoticed.
              const n = () => (f.id === 'attention' ? counts.data?.attention : f.id === 'draft' ? counts.data?.drafts : f.id === '' ? counts.data?.all : undefined);
              return (
                <button type="button" class="tab" aria-pressed={status() === f.id} onClick={() => setFilter(f.id)}>
                  {f.label}<Show when={n() !== undefined}><span class={`chip-count${f.id === 'attention' && n()! > 0 ? ' chip-count-alert' : ''}`}>{formatNumber(n()!)}</span></Show>
                </button>
              );
            }}
          </For>
        </div>
        <Show when={q.isError}><Notice tone="bad" action={<Button size="sm" onClick={() => q.refetch()}>Try again</Button>}>{errorText(q.error)}</Notice></Show>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.data && q.data.items.length === 0}>
          <Empty title="No cases found" action={can('case.write') ? <A class="btn" href="/portal">Send your first cases</A> : undefined}>
            {urlSearch() || status() ? 'Try a different search or filter.' : 'Cases you send will appear here.'}
          </Empty>
        </Show>
        <Show when={q.data && q.data.items.length ? q.data : undefined}>
          {(d) => (
            <>
              <p class="muted small" role="status">{formatNumber(d().total)} {d().total === 1 ? 'case' : 'cases'}</p>
              <CaseRows items={d().items} onChanged={() => { void q.refetch(); void counts.refetch(); }} />
              <Pagination page={d().page} pageSize={d().pageSize} total={d().total} onPage={setPage} />
            </>
          )}
        </Show>
      </Card>
    </div>
  );
}
