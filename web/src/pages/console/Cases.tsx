import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { createQuery, keepPreviousData } from '@tanstack/solid-query';
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

/** A search parameter as plain text: empty when it is missing. */
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

export default function ConsoleCases() {
  const [params, setParams] = useSearchParams();
  const orgId = () => one(params.orgId);
  const siteCode = () => one(params.siteCode);
  const status = () => one(params.status);
  const mode = () => one(params.mode);
  const page = () => Math.max(1, Number(params.page ?? 1) || 1);
  const urlSearch = () => one(params.search);
  const [text, setText] = createSignal(urlSearch());
  const opts = useFilterOptions();

  createEffect(() => {
    const t = text();
    if (t === urlSearch()) return;
    const h = setTimeout(() => {
      setParams({ search: t || undefined, page: undefined }, { replace: true });
    }, 350);
    onCleanup(() => clearTimeout(h));
  });

  const q = createQuery(() => ({
    queryKey: ['console-cases', { orgId: orgId(), siteCode: siteCode(), status: status(), mode: mode(), page: page(), search: urlSearch() }],
    queryFn: () => api<ConsoleCaseList>(`/api/console/cases${qs({ search: urlSearch(), status: status(), orgId: orgId(), siteCode: siteCode(), mode: mode(), page: page(), pageSize: 25 })}`),
    placeholderData: keepPreviousData,
  }));

  function setParam(key: string, value: string) {
    setParams({ [key]: value || undefined, page: undefined });
  }
  const filtered = () => !!(orgId() || siteCode() || status() || mode() || urlSearch());

  return (
    <div class="page">
      <PageHeader title="Cases" subtitle="Every case from every partner." />
      <Card>
        <div class="toolbar">
          <div class="field">
            <label for="c-search">Search</label>
            <input id="c-search" type="search" value={text()} onInput={(e) => setText(e.currentTarget.value)} placeholder="Reference, case ID or exact patient name" autocomplete="off" />
          </div>
          <div class="field" style={{ 'min-width': '160px', 'flex-basis': '170px' }}>
            <label for="c-partner">Partner</label>
            <select id="c-partner" value={orgId()} onChange={(e) => setParam('orgId', e.currentTarget.value)}>
              <option value="" selected={orgId() === ''}>All partners</option>
              <For each={opts.partners}>{(p) => <option value={p.id} selected={p.id === orgId()}>{p.name}</option>}</For>
            </select>
          </div>
          <div class="field" style={{ 'min-width': '130px', 'flex-basis': '140px' }}>
            <label for="c-site">Site</label>
            <select id="c-site" value={siteCode()} onChange={(e) => setParam('siteCode', e.currentTarget.value)}>
              <option value="" selected={siteCode() === ''}>All sites</option>
              <For each={opts.siteCodes}>{(s) => <option value={s} selected={s === siteCode()}>{s}</option>}</For>
            </select>
          </div>
          <div class="field" style={{ 'min-width': '150px', 'flex-basis': '160px' }}>
            <label for="c-status">Status</label>
            <select id="c-status" value={status()} onChange={(e) => setParam('status', e.currentTarget.value)}>
              <option value="" selected={status() === ''}>Any status</option>
              <For each={SIMPLE_FILTERS}>{(f) => <option value={f.id} selected={f.id === status()}>{f.label}</option>}</For>
              <For each={STATUSES}>{(s) => <option value={s} selected={s === status()}>{statusLabel(s)}</option>}</For>
            </select>
          </div>
          <div class="field" style={{ 'min-width': '150px', 'flex-basis': '160px' }}>
            <label for="c-mode">Mode</label>
            <select id="c-mode" value={mode()} onChange={(e) => setParam('mode', e.currentTarget.value)}>
              <option value="" selected={mode() === ''}>Any mode</option>
              <option value="standard" selected={mode() === 'standard'}>Standard</option>
              <option value="direct" selected={mode() === 'direct'}>Direct manufacturing</option>
            </select>
          </div>
          <Show when={filtered()}>
            <Button onClick={() => { setText(''); setParams({ orgId: undefined, siteCode: undefined, status: undefined, mode: undefined, page: undefined, search: undefined }); }}>Clear filters</Button>
          </Show>
        </div>
        <Show when={q.isError}><Notice tone="bad" action={<Button size="sm" onClick={() => q.refetch()}>Try again</Button>}>{errorText(q.error)}</Notice></Show>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.data && q.data.items.length === 0}><Empty title="No cases found">{filtered() ? 'Try a different search or filter.' : 'Cases from partners will appear here.'}</Empty></Show>
        <Show when={q.data}>
          {(d) => (
            <Show when={d().items.length}>
              <p class="muted small" role="status">{formatNumber(d().total)} {d().total === 1 ? 'case' : 'cases'}</p>
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr><th>Reference</th><th>Partner</th><th>Case ID</th><th>Patient</th><th>Status</th><th>Site</th><th>Due</th><th>Checks</th></tr>
                  </thead>
                  <tbody>
                    <For each={d().items}>
                      {(c) => (
                        <tr>
                          <td class="link-cell nowrap">
                            <A href={`/console/cases/${c.id}`}>{c.ref}</A>
                            {c.manufacturingMode === 'direct' ? <div><Badge tone="info">Direct</Badge></div> : null}
                            <KindBadge c={c} />
                          </td>
                          <td>{c.orgName ?? ''}</td>
                          <td>{c.caseId ?? <span class="muted">None</span>}</td>
                          <td>{c.patientMasked ? <span class="masked">{c.patientMasked}</span> : <span class="muted">Not given</span>}</td>
                          <td><StatusBadge c={c} staff /></td>
                          <td>{c.siteCode ?? <span class="muted">None</span>}</td>
                          <td class="nowrap">{c.dueDate ? <span class={isLate(c.dueDate, c.status) ? 'late' : undefined}>{formatDate(c.dueDate)}{isLate(c.dueDate, c.status) ? ' (late)' : ''}</span> : <span class="muted">Not set</span>}</td>
                          <td><CaseChecks c={c} /></td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <Pagination page={d().page} pageSize={d().pageSize} total={d().total} onPage={(p) => setParams({ page: String(p) })} />
            </Show>
          )}
        </Show>
      </Card>
    </div>
  );
}
