import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
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

interface VerifyResult { ok: boolean; checked?: number; firstBadSeq?: number | null; message?: string }

export default function Audit() {
  const { me, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const orgId = params.get('orgId') ?? '';
  const [action, setAction] = useState('');
  const opts = useFilterOptions();
  const canPickOrg = can('admin.partners');
  const isAdmin = !!me?.user.roles.includes('kl_admin');

  const q = useInfiniteQuery({
    queryKey: ['console-audit', action, orgId],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api<{ entries: AuditEntry[]; nextBefore: number | null }>(`/api/audit${qs({ limit: 50, before: pageParam, action, orgId: canPickOrg ? orgId : '' })}`),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.entries) ?? [];

  const verify = useMutation({ mutationFn: () => api<VerifyResult>('/api/audit/verify') });

  return (
    <div className="page">
      <PageHeader
        title="Audit log"
        subtitle="Every security relevant action, in a chain that cannot be changed afterwards."
        actions={isAdmin ? <Button onClick={() => verify.mutate()} loading={verify.isPending}><ShieldCheck size={16} aria-hidden="true" /> Verify chain</Button> : undefined}
      />
      {verify.isError ? <Notice tone="bad">{errorText(verify.error)}</Notice> : null}
      {verify.data ? (
        verify.data.ok
          ? <Notice tone="good" title="The audit chain is intact">{verify.data.checked !== undefined ? `${formatNumber(Number(verify.data.checked))} entries were checked. None were changed or removed.` : 'No entry was changed or removed.'}</Notice>
          : <Notice tone="bad" title="The audit chain is broken">{verify.data.firstBadSeq ? `The chain breaks at entry ${formatNumber(Number(verify.data.firstBadSeq))}. ` : ''}{verify.data.message ?? 'Tell the security lead straight away.'}</Notice>
      ) : null}
      <Card>
        <div className="toolbar">
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="au-filter">Show</label>
            <select id="au-filter" value={action} onChange={(e) => setAction(e.target.value)}>
              {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
          {canPickOrg ? (
            <div className="field" style={{ maxWidth: 300 }}>
              <label htmlFor="au-org">Organisation</label>
              <select id="au-org" value={orgId} onChange={(e) => { const next = new URLSearchParams(params); if (e.target.value) next.set('orgId', e.target.value); else next.delete('orgId'); setParams(next); }}>
                <option value="">K Line staff</option>
                {opts.partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          ) : null}
        </div>
        {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
        {q.isLoading ? <Spinner /> : null}
        {q.data && rows.length === 0 ? <Empty title="Nothing to show" /> : null}
        {rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>#</th><th>When</th><th>Who</th><th>What</th><th>Address</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.seq}>
                    <td className="num muted small">{r.seq}</td>
                    <td className="nowrap">{formatDateTime(r.at)}</td>
                    <td>{r.actorLabel}</td>
                    <td>{actionLabel(r.action)}{detailText(r.details) ? <div className="muted small">{detailText(r.details)}</div> : null}</td>
                    <td className="mono small">{r.ip ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {q.hasNextPage ? <div><Button loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Show older entries</Button></div> : null}
      </Card>
    </div>
  );
}
