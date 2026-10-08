import { For, mergeProps, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { CheckCircle2, XCircle } from 'lucide-solid';
import { errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useOverview } from '../../lib/console';
import { formatDateTime, formatNumber, greeting, relativeAge } from '../../lib/format';
import { Badge, Card, Empty, Notice, PageHeader, Spinner } from '../../ui/Common';

interface TileDef { label: string; value: number; to?: string; warn?: boolean; note?: string }

function Tile(props: { t: TileDef }) {
  const body = () => (
    <>
      <span class="num">{formatNumber(props.t.value)}</span>
      <span class="lbl">{props.t.label}</span>
      {props.t.note ? <span class="small muted">{props.t.note}</span> : null}
    </>
  );
  const cls = () => `tile${props.t.warn && props.t.value > 0 ? ' tile-warn' : ''}`;
  return <Show when={props.t.to} fallback={<div class={`${cls()} tile-static`}>{body()}</div>}>{(to) => <A class={cls()} href={to()}>{body()}</A>}</Show>;
}

export default function Console() {
  const { me, can } = useAuth();
  const q = useOverview();

  const tiles = (): TileDef[] => {
    const o = q.data;
    return o
      ? [
          { label: 'Waiting for intake', value: o.intakeWaiting, to: can('intake.manage') ? '/console/intake' : undefined, warn: true },
          { label: 'Ready for the factory', value: o.readyForMes.count, to: can('intake.manage') ? '/console/intake?tab=ready' : '/console/cases?status=ready', note: o.readyForMes.waitingOver4h ? `${formatNumber(o.readyForMes.waitingOver4h)} waiting more than 4 hours` : undefined, warn: o.readyForMes.waitingOver4h > 0 },
          { label: 'In production', value: o.inProduction, to: '/console/cases?status=in_production' },
          { label: 'Shipped in the last 7 days', value: o.shippedLast7Days, to: '/console/cases?status=shipped' },
          { label: 'Late cases', value: o.lateCases, to: '/console/cases?status=in_production', warn: true, note: 'Due date passed, not shipped' },
          { label: 'Open claims', value: o.openClaims, to: can('claim.read') ? '/console/claims?status=active' : undefined, warn: true },
          { label: 'New sign ups', value: o.newSignups, to: can('admin.partners') ? '/console/partners?tab=review' : undefined, warn: true, note: 'Waiting for review' },
        ]
      : [];
  };

  return (
    <div class="page">
      <PageHeader title={greeting(me()?.user.name ?? '')} subtitle="K Line staff console" />
      <Show when={q.isLoading}><Spinner /></Show>
      <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
      <Show when={q.data && q.data.newSignups > 0 ? q.data : undefined}>
        {(o) => (
          <Notice
            tone="warn"
            title={o().newSignups === 1 ? 'A new company is waiting for review' : `${formatNumber(o().newSignups)} new companies are waiting for review`}
            action={can('admin.partners') ? <A class="btn btn-sm" href="/console/partners?tab=review">Review now</A> : undefined}
          >
            They have confirmed their email address. Check their details and approve or decline them.
          </Notice>
        )}
      </Show>
      <Show when={q.data}>
        {(o) => (
          <>
            <div class="tiles"><For each={tiles()}>{(t) => <Tile t={t} />}</For></div>

            <div class="grid-2">
              <Card title="Load per site">
                {o().siteLoad.length === 0 ? <Empty title="No cases at any site">Cases appear here once they are sent to a site.</Empty> : (
                  <div class="table-wrap">
                    <table class="table">
                      <thead><tr><th>Site</th><th class="num">Ready</th><th class="num">In production</th></tr></thead>
                      <tbody>
                        <For each={o().siteLoad}>
                          {(s) => (
                            <tr>
                              <td><strong>{s.siteCode}</strong>{s.name ? <div class="muted small">{s.name}</div> : null}</td>
                              <td class="num">{formatNumber(s.ready)}</td>
                              <td class="num">{formatNumber(s.inProduction)}</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <div class="stack">
                <Card title="Factory link (MES)" actions={can('admin.mes') ? <A href="/console/mes">Open</A> : undefined}>
                  <dl class="facts">
                    <dt>Last event</dt><dd>{o().mesHealth.lastEventAt ? `${formatDateTime(o().mesHealth.lastEventAt)} (${relativeAge(o().mesHealth.lastEventAt)})` : 'No events yet'}</dd>
                    <dt>Events in 24 hours</dt><dd>{formatNumber(o().mesHealth.events24h)}</dd>
                    <dt>Errors in 24 hours</dt><dd>{o().mesHealth.errors24h > 0 ? <Badge tone="bad">{formatNumber(o().mesHealth.errors24h)}</Badge> : <Badge tone="good">None</Badge>}</dd>
                  </dl>
                </Card>
                <Card title="Security in the last 24 hours">
                  <dl class="facts">
                    <dt>Failed sign ins</dt><dd>{o().security.failedSignIns24h > 0 ? <Badge tone="warn">{formatNumber(o().security.failedSignIns24h)}</Badge> : <Badge tone="good">None</Badge>}</dd>
                    <dt>Files with malware</dt><dd>{o().security.malwareFiles24h > 0 ? <Badge tone="bad">{formatNumber(o().security.malwareFiles24h)}</Badge> : <Badge tone="good">None</Badge>}</dd>
                  </dl>
                </Card>
              </div>
            </div>

            <Card title="Partners and their agreements" actions={can('admin.partners') ? <A href="/console/partners">All partners</A> : undefined}>
              {o().partners.length === 0 ? <Empty title="No partners yet" /> : (
                <div class="table-wrap">
                  <table class="table">
                    <thead><tr><th>Partner</th><th>Status</th><th>DPA</th><th>SCC</th><th class="num">Sites</th></tr></thead>
                    <tbody>
                      <For each={o().partners}>
                        {(p) => (
                          <tr>
                            <td class="link-cell">{can('admin.partners') ? <A href={`/console/partners/${p.id}`}>{p.name}</A> : <strong>{p.name}</strong>} <span class="muted small">{p.code}</span></td>
                            <td><Badge tone={p.status === 'active' ? 'good' : p.status === 'suspended' ? 'bad' : 'warn'}>{({ active: 'Active', suspended: 'Suspended', onboarding: 'Onboarding' } as Record<string, string>)[p.status] ?? p.status}</Badge></td>
                            <td><Gate ok={p.dpaOnFile} /></td>
                            <td><Gate ok={p.sccOnFile} /></td>
                            <td class="num">{formatNumber(p.siteCodes.length)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </Show>
    </div>
  );
}

export function Gate(props: { ok: boolean; yes?: string; no?: string }) {
  const p = mergeProps({ yes: 'On file', no: 'Missing' }, props);
  return (
    <Show
      when={p.ok}
      fallback={<span class="row" style={{ gap: '4px', color: 'var(--muted)' }}><XCircle size={16} aria-hidden="true" /> {p.no}</span>}
    >
      <span class="row" style={{ gap: '4px', color: 'var(--good)' }}><CheckCircle2 size={16} aria-hidden="true" /> {p.yes}</span>
    </Show>
  );
}
