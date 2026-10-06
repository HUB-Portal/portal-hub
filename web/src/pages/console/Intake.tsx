import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
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
  const tab: Tab = (['review', 'hold', 'ready'] as const).includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'review';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const q = useQuery({ queryKey: ['intake', tab, page], queryFn: () => api<IntakeResponse>(`/api/intake${qs({ tab, page, pageSize: 25 })}`), refetchInterval: 60_000, placeholderData: keepPreviousData });
  const invalidate = useInvalidateCases();
  const [action, setAction] = useState<Action | null>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null);

  const items = q.data?.items ?? [];
  const done = (text: string) => { setAction(null); setNotice({ tone: 'good', text }); invalidate(); };

  return (
    <div className="page">
      <PageHeader title="Intake" subtitle="Check new cases, send them to a site, or put them on hold." />
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <Card>
        <div className="tabs" role="group" aria-label="Intake lists">
          {TABS.map((t) => (
            <button key={t.id} type="button" className="tab" aria-pressed={tab === t.id} onClick={() => { setParams({ tab: t.id }); setNotice(null); }}>
              {t.label}{q.data && q.data.tab === t.id ? ` (${formatNumber(q.data.total)})` : ''}
            </button>
          ))}
        </div>
        {q.isError ? <Notice tone="bad" action={<Button size="sm" onClick={() => q.refetch()}>Try again</Button>}>{errorText(q.error)}</Notice> : null}
        {q.isLoading ? <Spinner /> : null}
        {q.data && items.length === 0 ? <Empty title="All clear">{TABS.find((t) => t.id === tab)!.empty}</Empty> : null}
        {items.length ? (
          <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th><th>Partner</th><th>Case ID</th><th className="num">Upper</th><th className="num">Lower</th><th>Checks</th>
                  <th>{tab === 'hold' ? 'Reason' : tab === 'ready' ? 'Site' : 'Submitted'}</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td className="link-cell nowrap">
                      <Link to={`/console/cases/${c.id}`}>{c.ref}</Link>
                      <div className="row" style={{ gap: 4 }}>
                        {c.priority === 'rush' ? <Badge tone="warn">Rush</Badge> : null}
                        {c.manufacturingMode === 'direct' ? <Badge tone="info">Direct</Badge> : null}
                      </div>
                    </td>
                    <td>{c.orgName ?? ''}</td>
                    <td>{c.caseId ?? <span className="muted">None</span>}</td>
                    <td className="num">{formatNumber(c.counts.upper)}</td>
                    <td className="num">{formatNumber(c.counts.lower)}</td>
                    <td><CaseChecks c={c} /></td>
                    <td>
                      {tab === 'hold' ? <span>{c.holdReason ?? ''}</span>
                        : tab === 'ready' ? <span>{c.siteCode ?? ''}<div className="muted small">{c.readyAt ? `Ready ${formatDateTime(c.readyAt)}` : ''}{c.dueDate ? ` Due ${formatDate(c.dueDate)}` : ''}</div></span>
                        : <span className="nowrap">{formatDateTime(c.submittedAt)}</span>}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        {c.status === 'submitted' ? <Button size="sm" variant="primary" onClick={() => setAction({ kind: 'route', c })} aria-label={`Send ${c.ref} to a site`}>Route</Button> : null}
                        {c.status === 'ready' ? <Button size="sm" onClick={() => setAction({ kind: 'route', c })} aria-label={`Change the site of ${c.ref}`}>Change site</Button> : null}
                        {c.status === 'submitted' || c.status === 'ready' ? <Button size="sm" onClick={() => setAction({ kind: 'hold', c })} aria-label={`Put ${c.ref} on hold`}>Hold</Button> : null}
                        {c.status === 'on_hold' ? <Button size="sm" onClick={() => setAction({ kind: 'release', c })} aria-label={`Release ${c.ref}`}>Release</Button> : null}
                        {tab === 'ready' ? <Badge tone={statusTone(c.status)}>{statusLabel(c.status)}</Badge> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {q.data ? <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => { const next = new URLSearchParams(params); next.set('page', String(p)); setParams(next); }} /> : null}
          </>
        ) : null}
      </Card>
      {action ? (
        <>
          <RouteDialog c={action.c} open={action.kind === 'route'} onClose={() => setAction(null)} onDone={done} />
          <HoldDialog c={action.c} open={action.kind === 'hold'} onClose={() => setAction(null)} onDone={done} />
          <ReleaseDialog c={action.c} open={action.kind === 'release'} onClose={() => setAction(null)} onDone={done} />
        </>
      ) : null}
    </div>
  );
}
