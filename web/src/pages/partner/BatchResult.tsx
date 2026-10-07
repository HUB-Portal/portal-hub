import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatNumber, portalLabel, portalTone } from '../../lib/format';
import type { BatchResult as BatchData } from '../../lib/types';
import { Badge, Button, Card, Notice, PageHeader, Spinner } from '../../ui/Common';
import { StatusBadge } from '../../ui/StatusBadge';
import { CaseChecks } from './Cases';

export default function BatchResult() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const q = useQuery({
    queryKey: ['batch', id],
    queryFn: () => api<BatchData>(`/api/bulk/batches/${id}`),
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      return d.cases.some((c) => c.status !== 'draft' && c.status !== 'cancelled' && (c.portal.status === 'pending' || c.portal.status === 'pushing')) ? 3000 : false;
    },
  });
  const retry = useMutation({
    mutationFn: (caseId: string) => api(`/api/cases/${caseId}/portal/retry`, { method: 'POST', body: {} }),
    onSuccess: () => { setMsg({ tone: 'good', text: 'We will try sending that case again.' }); qc.invalidateQueries({ queryKey: ['batch', id] }); },
    onError: (e) => setMsg({ tone: 'bad', text: errorText(e) }),
  });

  const cases = q.data?.cases ?? [];
  const count = (f: (c: (typeof cases)[number]) => boolean) => cases.filter(f).length;
  const failed = cases.filter((c) => c.portal.status === 'failed');

  async function retryAll() {
    for (const c of failed) await retry.mutateAsync(c.id).catch(() => undefined);
  }

  return (
    <div className="page">
      <div><Link to="/portal/send/bulk" className="small">Back to direct manufacturing</Link></div>
      <PageHeader title="Batch result" subtitle="Where each case in this batch has got to." />
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
      {q.data ? (
        <>
          <div className="tiles">
            <div className="tile"><span className="num">{formatNumber(cases.length)}</span><span className="lbl">Cases</span></div>
            <div className="tile"><span className="num">{formatNumber(count((c) => c.portal.status === 'pushed'))}</span><span className="lbl">Sent to the portal</span></div>
            <div className="tile"><span className="num">{formatNumber(count((c) => c.status !== 'draft' && c.status !== 'cancelled' && (c.portal.status === 'pending' || c.portal.status === 'pushing')))}</span><span className="lbl">Waiting to send</span></div>
            <div className={`tile${failed.length ? ' tile-warn' : ''}`}><span className="num">{formatNumber(failed.length)}</span><span className="lbl">Failed to send</span></div>
            <div className={`tile${count((c) => c.status === 'draft') ? ' tile-warn' : ''}`}><span className="num">{formatNumber(count((c) => c.status === 'draft'))}</span><span className="lbl">Drafts to review</span></div>
          </div>
          <Card title="Cases" actions={failed.length && can('case.write') ? <Button size="sm" loading={retry.isPending} onClick={() => { void retryAll(); }}><RefreshCw size={14} aria-hidden="true" /> Try all failed again</Button> : null}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Reference</th><th>Case status</th><th>Checks</th><th>Customer portal</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {cases.map((c) => (
                    <tr key={c.id}>
                      <td className="link-cell nowrap"><Link to={`/portal/cases/${c.id}`}>{c.ref}</Link></td>
                      <td><StatusBadge c={c} /></td>
                      <td><CaseChecks c={c} /></td>
                      <td>
                        <Badge tone={portalTone(c.portal.status, c.portal.demo)}>{c.status === 'draft' ? 'Not submitted' : portalLabel(c.portal.status, c.portal.demo)}</Badge>
                        {c.portal.status === 'failed' && c.portal.lastError ? <div className="small muted" style={{ maxWidth: 300 }}>{c.portal.lastError}</div> : null}
                      </td>
                      <td className="right">
                        {c.portal.status === 'failed' && can('case.write') ? <Button size="sm" onClick={() => retry.mutate(c.id)} aria-label={`Try sending ${c.ref} again`}>Try again</Button> : null}
                        {c.status === 'draft' ? <Link className="btn btn-sm" to={`/portal/cases/${c.id}`}>Review</Link> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
