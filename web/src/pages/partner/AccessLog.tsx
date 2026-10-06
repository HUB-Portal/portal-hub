import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
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
  const [action, setAction] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', action],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api<{ entries: AuditEntry[]; nextBefore: number | null }>(`/api/audit${qs({ limit: 50, before: pageParam, action })}`),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <div className="page">
      <PageHeader title="Access log" subtitle="Who signed in, changed settings, showed a patient name or opened your files. This includes K Line staff." />
      <Card>
        <div className="toolbar">
          <div className="field">
            <label htmlFor="audit-filter">Show</label>
            <select id="audit-filter" value={action} onChange={(e) => setAction(e.target.value)}>
              {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
        </div>
        {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
        {q.isLoading ? <Spinner /> : null}
        {q.data && rows.length === 0 ? <Empty title="Nothing to show yet" /> : null}
        {rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>Who</th><th>What</th><th>Address</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.seq}>
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
