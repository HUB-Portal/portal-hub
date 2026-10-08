import { createSignal, For, Show } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { createQuery, keepPreviousData } from '@tanstack/solid-query';
import { api, errorText, qs } from '../../lib/api';
import { formatDate, formatDateTime, formatNumber, statusLabel, statusTone } from '../../lib/format';
import type { CaseItem } from '../../lib/types';
import { Badge, Button, Card, Empty, Notice, PageHeader, Pagination, Spinner } from '../../ui/Common';
import { CaseChecks } from '../partner/Cases';
import { HoldDialog, ReleaseDialog, RouteDialog, useInvalidateCases } from './caseActions';

type Tab = 'review' | 'hold' | 'ready';
const TABS: { id: Tab; label: string; empty: string }[] = [
  { id: 'review', label: 'To review', empty: 'No submitted cases are waiting for review.' },
  { id: 'hold', label: 'On hold', empty: 'No cases are on hold.' },
  { id: 'ready', label: 'Ready', empty: 'No cases are waiting for the factory.' },
];

interface IntakeResponse { tab: Tab; items: CaseItem[]; total: number; page: number; pageSize: number }

type Action = { kind: 'route' | 'hold' | 'release'; c: CaseItem };

export default function Intake() {
  const [params, setParams] = useSearchParams();
  const tab = (): Tab => (['review', 'hold', 'ready'] as const).includes(params.tab as Tab) ? (params.tab as Tab) : 'review';
  const page = () => Math.max(1, Number(params.page ?? 1) || 1);
  const q = createQuery(() => ({ queryKey: ['intake', tab(), page()], queryFn: () => api<IntakeResponse>(`/api/intake${qs({ tab: tab(), page: page(), pageSize: 25 })}`), refetchInterval: 60_000, placeholderData: keepPreviousData }));
  const invalidate = useInvalidateCases();
  const [action, setAction] = createSignal<Action | null>(null);
  const [notice, setNotice] = createSignal<{ tone: 'good' | 'warn'; text: string } | null>(null);

  const items = () => q.data?.items ?? [];
  const done = (text: string) => { setAction(null); setNotice({ tone: 'good', text }); invalidate(); };

  return (
    <div class="page">
      <PageHeader title="Intake" subtitle="Check new cases, send them to a site, or put them on hold." />
      <Show when={notice()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show>
      <Card>
        <div class="tabs" role="group" aria-label="Intake lists">
          <For each={TABS}>
            {(t) => (
              <button type="button" class="tab" aria-pressed={tab() === t.id} onClick={() => { setParams({ tab: t.id }); setNotice(null); }}>
                {t.label}{q.data && q.data.tab === t.id ? ` (${formatNumber(q.data.total)})` : ''}
              </button>
            )}
          </For>
        </div>
        <Show when={q.isError}><Notice tone="bad" action={<Button size="sm" onClick={() => q.refetch()}>Try again</Button>}>{errorText(q.error)}</Notice></Show>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.data && items().length === 0}><Empty title="All clear">{TABS.find((t) => t.id === tab())!.empty}</Empty></Show>
        <Show when={items().length}>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Reference</th><th>Partner</th><th>Case ID</th><th class="num">Upper</th><th class="num">Lower</th><th>Checks</th>
                  <th>{tab() === 'hold' ? 'Reason' : tab() === 'ready' ? 'Site' : 'Submitted'}</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                <For each={items()}>
                  {(c) => (
                    <tr>
                      <td class="link-cell nowrap">
                        <A href={`/console/cases/${c.id}`}>{c.ref}</A>
                        <div class="row" style={{ gap: '4px' }}>
                          {c.priority === 'rush' ? <Badge tone="warn">Rush</Badge> : null}
                          {c.manufacturingMode === 'direct' ? <Badge tone="info">Direct</Badge> : null}
                        </div>
                      </td>
                      <td>{c.orgName ?? ''}</td>
                      <td>{c.caseId ?? <span class="muted">None</span>}</td>
                      <td class="num">{formatNumber(c.counts.upper)}</td>
                      <td class="num">{formatNumber(c.counts.lower)}</td>
                      <td><CaseChecks c={c} /></td>
                      <td>
                        {tab() === 'hold' ? <span>{c.holdReason ?? ''}</span>
                          : tab() === 'ready' ? <span>{c.siteCode ?? ''}<div class="muted small">{c.readyAt ? `Ready ${formatDateTime(c.readyAt)}` : ''}{c.dueDate ? ` Due ${formatDate(c.dueDate)}` : ''}</div></span>
                          : <span class="nowrap">{formatDateTime(c.submittedAt)}</span>}
                      </td>
                      <td>
                        <div class="row" style={{ gap: '6px', 'justify-content': 'flex-end' }}>
                          {c.status === 'submitted' ? <Button size="sm" variant="primary" onClick={() => setAction({ kind: 'route', c })} aria-label={`Send ${c.ref} to a site`}>Route</Button> : null}
                          {c.status === 'ready' ? <Button size="sm" onClick={() => setAction({ kind: 'route', c })} aria-label={`Change the site of ${c.ref}`}>Change site</Button> : null}
                          {c.status === 'submitted' || c.status === 'ready' ? <Button size="sm" onClick={() => setAction({ kind: 'hold', c })} aria-label={`Put ${c.ref} on hold`}>Hold</Button> : null}
                          {c.status === 'on_hold' ? <Button size="sm" onClick={() => setAction({ kind: 'release', c })} aria-label={`Release ${c.ref}`}>Release</Button> : null}
                          {tab() === 'ready' ? <Badge tone={statusTone(c.status)}>{statusLabel(c.status)}</Badge> : null}
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <Show when={q.data}>{(d) => <Pagination page={d().page} pageSize={d().pageSize} total={d().total} onPage={(p) => setParams({ page: String(p) })} />}</Show>
        </Show>
      </Card>
      <Show when={action()}>
        {(a) => (
          <>
            <RouteDialog c={a().c} open={a().kind === 'route'} onClose={() => setAction(null)} onDone={done} />
            <HoldDialog c={a().c} open={a().kind === 'hold'} onClose={() => setAction(null)} onDone={done} />
            <ReleaseDialog c={a().c} open={a().kind === 'release'} onClose={() => setAction(null)} onDone={done} />
          </>
        )}
      </Show>
    </div>
  );
}
