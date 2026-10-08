import { createSignal, For, Show } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { createInfiniteQuery, createMutation } from '@tanstack/solid-query';
import { ShieldCheck } from 'lucide-solid';
import { api, errorText, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilterOptions } from '../../lib/console';
import { actionLabel, detailText, formatDateTime, formatNumber } from '../../lib/format';
import type { AuditEntry } from '../../lib/types';
import { Button, Card, Empty, Notice, PageHeader, Spinner } from '../../ui/Common';

const FILTERS = [
  { id: '', label: 'Everything' },
  { id: 'auth.', label: 'Sign in and security' },
  { id: 'team.', label: 'Staff and team changes' },
  { id: 'case.', label: 'Cases' },
  { id: 'file.', label: 'Files' },
  { id: 'org.', label: 'Organisation settings' },
  { id: 'mes.', label: 'Factory link' },
  { id: 'audit.', label: 'Audit checks' },
  { id: 'partner.', label: 'Partner administration' },
  { id: 'site.', label: 'Sites' },
  { id: 'service_key.', label: 'Service keys' },
];

/** A search parameter as plain text: empty when it is missing. */
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

interface VerifyResult { ok: boolean; checked?: number; firstBadSeq?: number | null; message?: string }

export default function Audit() {
  const { me, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const orgId = () => one(params.orgId);
  const [action, setAction] = createSignal('');
  const opts = useFilterOptions();
  const canPickOrg = () => can('admin.partners');
  const isAdmin = () => !!me()?.user.roles.includes('kl_admin');

  const q = createInfiniteQuery(() => ({
    queryKey: ['console-audit', action(), orgId()],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api<{ entries: AuditEntry[]; nextBefore: number | null }>(`/api/audit${qs({ limit: 50, before: pageParam, action: action(), orgId: canPickOrg() ? orgId() : '' })}`),
    getNextPageParam: (last: { entries: AuditEntry[]; nextBefore: number | null }) => last.nextBefore ?? undefined,
  }));
  const rows = () => q.data?.pages.flatMap((p) => p.entries) ?? [];

  const verify = createMutation(() => ({ mutationFn: () => api<VerifyResult>('/api/audit/verify') }));

  return (
    <div class="page">
      <PageHeader
        title="Audit log"
        subtitle="Every security relevant action, in a chain that cannot be changed afterwards."
        actions={isAdmin() ? <Button onClick={() => verify.mutate()} loading={verify.isPending}><ShieldCheck size={16} aria-hidden="true" /> Verify chain</Button> : undefined}
      />
      <Show when={verify.isError}><Notice tone="bad">{errorText(verify.error)}</Notice></Show>
      <Show when={verify.data}>
        {(v) => (
          v().ok
            ? <Notice tone="good" title="The audit chain is intact">{v().checked !== undefined ? `${formatNumber(Number(v().checked))} entries were checked. None were changed or removed.` : 'No entry was changed or removed.'}</Notice>
            : <Notice tone="bad" title="The audit chain is broken">{v().firstBadSeq ? `The chain breaks at entry ${formatNumber(Number(v().firstBadSeq))}. ` : ''}{v().message ?? 'Tell the security lead straight away.'}</Notice>
        )}
      </Show>
      <Card>
        <div class="toolbar">
          <div class="field" style={{ 'max-width': '260px' }}>
            <label for="au-filter">Show</label>
            <select id="au-filter" value={action()} onChange={(e) => setAction(e.currentTarget.value)}>
              <For each={FILTERS}>{(f) => <option value={f.id} selected={f.id === action()}>{f.label}</option>}</For>
            </select>
          </div>
          <Show when={canPickOrg()}>
            <div class="field" style={{ 'max-width': '300px' }}>
              <label for="au-org">Organisation</label>
              <select id="au-org" value={orgId()} onChange={(e) => setParams({ orgId: e.currentTarget.value || undefined })}>
                <option value="" selected={orgId() === ''}>K Line staff</option>
                <For each={opts.partners}>{(p) => <option value={p.id} selected={p.id === orgId()}>{p.name}</option>}</For>
              </select>
            </div>
          </Show>
        </div>
        <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.data && rows().length === 0}><Empty title="Nothing to show" /></Show>
        <Show when={rows().length}>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>#</th><th>When</th><th>Who</th><th>What</th><th>Address</th></tr></thead>
              <tbody>
                <For each={rows()}>
                  {(r) => (
                    <tr>
                      <td class="num muted small">{r.seq}</td>
                      <td class="nowrap">{formatDateTime(r.at)}</td>
                      <td>{r.actorLabel}</td>
                      <td>{actionLabel(r.action)}{detailText(r.details) ? <div class="muted small">{detailText(r.details)}</div> : null}</td>
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
