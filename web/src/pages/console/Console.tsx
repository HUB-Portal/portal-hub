import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import { errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useOverview } from '../../lib/console';
import { formatDateTime, formatNumber, greeting, relativeAge } from '../../lib/format';
import { Badge, Card, Empty, Notice, PageHeader, Spinner } from '../../ui/Common';

interface TileDef { label: string; value: number; to?: string; warn?: boolean; note?: string }

function Tile({ t }: { t: TileDef }) {
  const body = (
    <>
      <span className="num">{formatNumber(t.value)}</span>
      <span className="lbl">{t.label}</span>
      {t.note ? <span className="small muted">{t.note}</span> : null}
    </>
  );
  const cls = `tile${t.warn && t.value > 0 ? ' tile-warn' : ''}`;
  return t.to ? <Link className={cls} to={t.to}>{body}</Link> : <div className={`${cls} tile-static`}>{body}</div>;
}

export default function Console() {
  const { me, can } = useAuth();
  const q = useOverview();
  const o = q.data;

  const tiles: TileDef[] = o
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

  return (
    <div className="page">
      <PageHeader title={greeting(me?.user.name ?? '')} subtitle="K Line staff console" />
      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
      {o && o.newSignups > 0 ? (
        <Notice
          tone="warn"
          title={o.newSignups === 1 ? 'A new company is waiting for review' : `${formatNumber(o.newSignups)} new companies are waiting for review`}
          action={can('admin.partners') ? <Link className="btn btn-sm" to="/console/partners?tab=review">Review now</Link> : undefined}
        >
          They have confirmed their email address. Check their details and approve or decline them.
        </Notice>
      ) : null}
      {o ? (
        <>
          <div className="tiles">{tiles.map((t) => <Tile key={t.label} t={t} />)}</div>

          <div className="grid-2">
            <Card title="Load per site">
              {o.siteLoad.length === 0 ? <Empty title="No cases at any site">Cases appear here once they are sent to a site.</Empty> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Site</th><th className="num">Ready</th><th className="num">In production</th></tr></thead>
                    <tbody>
                      {o.siteLoad.map((s) => (
                        <tr key={s.siteCode}>
                          <td><strong>{s.siteCode}</strong>{s.name ? <div className="muted small">{s.name}</div> : null}</td>
                          <td className="num">{formatNumber(s.ready)}</td>
                          <td className="num">{formatNumber(s.inProduction)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <div className="stack">
              <Card title="Factory link (MES)" actions={can('admin.mes') ? <Link to="/console/mes">Open</Link> : undefined}>
                <dl className="facts">
                  <dt>Last event</dt><dd>{o.mesHealth.lastEventAt ? `${formatDateTime(o.mesHealth.lastEventAt)} (${relativeAge(o.mesHealth.lastEventAt)})` : 'No events yet'}</dd>
                  <dt>Events in 24 hours</dt><dd>{formatNumber(o.mesHealth.events24h)}</dd>
                  <dt>Errors in 24 hours</dt><dd>{o.mesHealth.errors24h > 0 ? <Badge tone="bad">{formatNumber(o.mesHealth.errors24h)}</Badge> : <Badge tone="good">None</Badge>}</dd>
                </dl>
              </Card>
              <Card title="Security in the last 24 hours">
                <dl className="facts">
                  <dt>Failed sign ins</dt><dd>{o.security.failedSignIns24h > 0 ? <Badge tone="warn">{formatNumber(o.security.failedSignIns24h)}</Badge> : <Badge tone="good">None</Badge>}</dd>
                  <dt>Files with malware</dt><dd>{o.security.malwareFiles24h > 0 ? <Badge tone="bad">{formatNumber(o.security.malwareFiles24h)}</Badge> : <Badge tone="good">None</Badge>}</dd>
                </dl>
              </Card>
            </div>
          </div>

          <Card title="Partners and their agreements" actions={can('admin.partners') ? <Link to="/console/partners">All partners</Link> : undefined}>
            {o.partners.length === 0 ? <Empty title="No partners yet" /> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Partner</th><th>Status</th><th>DPA</th><th>SCC</th><th className="num">Sites</th></tr></thead>
                  <tbody>
                    {o.partners.map((p) => (
                      <tr key={p.id}>
                        <td className="link-cell">{can('admin.partners') ? <Link to={`/console/partners/${p.id}`}>{p.name}</Link> : <strong>{p.name}</strong>} <span className="muted small">{p.code}</span></td>
                        <td><Badge tone={p.status === 'active' ? 'good' : p.status === 'suspended' ? 'bad' : 'warn'}>{({ active: 'Active', suspended: 'Suspended', onboarding: 'Onboarding' } as Record<string, string>)[p.status] ?? p.status}</Badge></td>
                        <td><Gate ok={p.dpaOnFile} /></td>
                        <td><Gate ok={p.sccOnFile} /></td>
                        <td className="num">{formatNumber(p.siteCodes.length)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}

export function Gate({ ok, yes = 'On file', no = 'Missing' }: { ok: boolean; yes?: string; no?: string }) {
  return ok
    ? <span className="row" style={{ gap: 4, color: 'var(--good)' }}><CheckCircle2 size={16} aria-hidden="true" /> {yes}</span>
    : <span className="row" style={{ gap: 4, color: 'var(--muted)' }}><XCircle size={16} aria-hidden="true" /> {no}</span>;
}
