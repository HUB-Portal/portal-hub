import { For, Show } from 'solid-js';
import { A, useParams } from '@solidjs/router';
import { createQuery } from '@tanstack/solid-query';
import { api, errorText } from '../../lib/api';
import { Badge, Card, Empty, Notice, PageHeader, Spinner } from '../../ui/Common';
import { PortalForm } from '../partner/PortalSettings';
import { PartnerStatus } from './Partners';

interface Row { id: string; name: string; code: string; status: string; configured: boolean; baseUrl: string | null }

/** Every partner and whether it has a K Line portal connection. K Line administrators open one to set or test it. */
export default function PortalConnections() {
  const q = createQuery(() => ({ queryKey: ['portal-connections'], queryFn: () => api<{ items: Row[] }>('/api/partners/portal-connections') }));
  const rows = () => q.data?.items ?? [];
  return (
    <div class="page">
      <PageHeader title="Portal connection" subtitle="The K Line customer portal credentials of each partner. Partners use them to send direct manufacturing cases." />
      <Card>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.data && rows().length === 0}><Empty title="No partners yet">Partners appear here after they register, or when you add one.</Empty></Show>
        <Show when={rows().length}>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Partner</th><th>Status</th><th>Connection</th><th>Portal address</th></tr></thead>
              <tbody>
                <For each={rows()}>
                  {(p) => (
                    <tr>
                      <td class="link-cell"><A href={`/console/portal/${p.id}`}>{p.name}</A> <span class="muted small">{p.code}</span></td>
                      <td><PartnerStatus status={p.status} /></td>
                      <td>{p.configured ? <Badge tone="good">Saved</Badge> : <Badge tone="warn">Not set</Badge>}</td>
                      <td class="muted small">{p.baseUrl ?? ''}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Card>
    </div>
  );
}

/** The portal connection of one partner, set by K Line staff. */
export function PortalConnectionPartner() {
  const params = useParams();
  const id = () => params.id ?? '';
  const meta = createQuery(() => ({ queryKey: ['portal-api-staff', id()], queryFn: () => api<{ name: string; code: string; status: string }>(`/api/partners/${id()}/portal-api`) }));
  return (
    <div class="page page-narrow">
      <div><A href="/console/portal" class="small">Back to portal connections</A></div>
      <PageHeader
        title={<span class="row" style={{ gap: '12px' }}>{meta.data?.name ?? 'Portal connection'} {meta.data ? <PartnerStatus status={meta.data.status} /> : null}</span>}
        subtitle={meta.data ? `${meta.data.code}. The K Line portal credentials this partner uses to send direct manufacturing cases.` : undefined}
      />
      <Notice tone="warn" title="You are changing this for the partner">
        The partner can see and change the same settings on its own Portal connection page. Every change you make is recorded in the access log of the partner.
      </Notice>
      <PortalForm path={`/api/partners/${id()}/portal-api`} queryKey={['portal-api-staff', id()]} who={meta.data?.name ?? 'This partner'} />
    </div>
  );
}
