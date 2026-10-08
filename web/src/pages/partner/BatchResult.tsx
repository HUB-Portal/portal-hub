import { createMemo, createSignal, For, Show } from 'solid-js';
import { A, useParams } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { RefreshCw } from 'lucide-solid';
import { api, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatNumber } from '../../lib/format';
import type { BatchResult as BatchData } from '../../lib/types';
import { Button, Card, Notice, PageHeader, Spinner } from '../../ui/Common';
import { CaseStatusCell } from './Cases';

export default function BatchResult() {
  const params = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [msg, setMsg] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const q = createQuery(() => ({
    queryKey: ['batch', params.id ?? ''],
    queryFn: () => api<BatchData>(`/api/bulk/batches/${params.id ?? ''}`),
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      return d.cases.some((c) => c.status !== 'draft' && c.status !== 'cancelled' && (c.portal.status === 'pending' || c.portal.status === 'pushing')) ? 3000 : false;
    },
  }));
  const retry = createMutation(() => ({
    mutationFn: (caseId: string) => api(`/api/cases/${caseId}/portal/retry`, { method: 'POST', body: {} }),
    onSuccess: () => { setMsg({ tone: 'good', text: 'We will try sending that case again.' }); qc.invalidateQueries({ queryKey: ['batch', params.id ?? ''] }); },
    onError: (e: unknown) => setMsg({ tone: 'bad', text: errorText(e) }),
  }));

  const cases = createMemo(() => q.data?.cases ?? []);
  const count = (f: (c: ReturnType<typeof cases>[number]) => boolean) => cases().filter(f).length;
  // A failed hand over is K Line's to fix and is tried again by itself. The partner can only help when the case address is missing.
  const failed = createMemo(() => cases().filter((c) => c.portal.status === 'failed' && c.portal.actionNeeded === 'case_address'));
  const delayed = () => count((c) => c.portal.status === 'failed' && c.portal.actionNeeded !== 'case_address');

  async function retryAll() {
    for (const c of failed()) await retry.mutateAsync(c.id).catch(() => undefined);
  }

  return (
    <div class="page">
      <div><A href="/portal" class="small">Back to direct manufacturing</A></div>
      <PageHeader title="Batch result" subtitle="Where each case in this batch has got to." />
      <Show when={msg()}>{(m) => <Notice tone={m().tone}>{m().text}</Notice>}</Show>
      <Show when={q.isLoading}><Spinner /></Show>
      <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
      <Show when={q.data}>
        <div class="tiles">
          <div class="tile"><span class="num">{formatNumber(cases().length)}</span><span class="lbl">Cases</span></div>
          <div class="tile"><span class="num">{formatNumber(count((c) => c.portal.status === 'pushed'))}</span><span class="lbl">Received by K Line</span></div>
          <div class="tile"><span class="num">{formatNumber(count((c) => c.status !== 'draft' && c.status !== 'cancelled' && (c.portal.status === 'pending' || c.portal.status === 'pushing')))}</span><span class="lbl">Waiting to send</span></div>
          <div class={`tile${failed().length ? ' tile-warn' : ''}`}><span class="num">{formatNumber(failed().length + delayed())}</span><span class="lbl">{failed().length ? 'Waiting for your shipping address' : 'Problem on our side'}</span></div>
          <div class={`tile${count((c) => c.status === 'draft') ? ' tile-warn' : ''}`}><span class="num">{formatNumber(count((c) => c.status === 'draft'))}</span><span class="lbl">Drafts to review</span></div>
        </div>
        <Card title="Cases" actions={failed().length && can('case.write') ? <Button size="sm" loading={retry.isPending} onClick={() => { void retryAll(); }}><RefreshCw size={14} aria-hidden="true" /> Try all failed again</Button> : null}>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Reference</th><th>Status and next step</th><th><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                <For each={cases()}>
                  {(c) => (
                    <tr>
                      <td class="link-cell nowrap"><A href={`/portal/cases/${c.id}`}>{c.ref}</A></td>
                      <td><CaseStatusCell c={c} /></td>
                      <td class="right">
                        <Show when={c.portal.status === 'failed' && c.portal.actionNeeded === 'case_address' && can('case.write')}><Button size="sm" onClick={() => retry.mutate(c.id)} aria-label={`Try sending ${c.ref} again`}>Try again</Button></Show>
                        <Show when={c.status === 'draft'}><A class="btn btn-sm" href={`/portal/cases/${c.id}`}>Review</A></Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Card>
      </Show>
    </div>
  );
}
