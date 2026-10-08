import { createSignal, For, Show } from 'solid-js';
import { createInfiniteQuery } from '@tanstack/solid-query';
import { api, errorText, qs } from '../../lib/api';
import { actionLabel, detailText, formatDateTime } from '../../lib/format';
import type { AuditEntry } from '../../lib/types';
import { Button, Card, Empty, Notice, PageHeader, Spinner } from '../../ui/Common';

const FILTERS = [
  { id: '', label: 'Everything' },
  { id: 'auth.', label: 'Sign in and security' },
  { id: 'team.', label: 'Team changes' },
  { id: 'case.', label: 'Cases' },
  { id: 'file.', label: 'Files' },
];

export default function AccessLog() {
  const [action, setAction] = createSignal('');
  const q = createInfiniteQuery(() => ({
    queryKey: ['audit', action()],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api<{ entries: AuditEntry[]; nextBefore: number | null }>(`/api/audit${qs({ limit: 50, before: pageParam, action: action() })}`),
    getNextPageParam: (last: { entries: AuditEntry[]; nextBefore: number | null }) => last.nextBefore ?? undefined,
  }));
  const rows = () => q.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <div class="page">
      <PageHeader title="Access log" subtitle="Who signed in, changed settings, showed a patient name or opened your files. This includes K Line staff." />
      <Card>
        <div class="toolbar">
          <div class="field">
            <label for="audit-filter">Show</label>
            <select id="audit-filter" value={action()} onChange={(e) => setAction(e.currentTarget.value)}>
              <For each={FILTERS}>{(f) => <option value={f.id} selected={action() === f.id}>{f.label}</option>}</For>
            </select>
          </div>
        </div>
        <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.data && rows().length === 0}><Empty title="Nothing to show yet" /></Show>
        <Show when={rows().length}>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>When</th><th>Who</th><th>What</th><th>Address</th></tr></thead>
              <tbody>
                <For each={rows()}>
                  {(r) => (
                    <tr>
                      <td class="nowrap">{formatDateTime(r.at)}</td>
                      <td>{r.actorLabel}</td>
                      <td>{actionLabel(r.action)}<Show when={detailText(r.details)}><div class="muted small">{detailText(r.details)}</div></Show></td>
                      <td class="mono small">{r.ip ?? ''}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
        <Show when={q.hasNextPage}><div><Button loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Show older entries</Button></div></Show>
      </Card>
    </div>
  );
}
