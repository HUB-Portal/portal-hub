import { For, Show } from 'solid-js';
import { A, useParams } from '@solidjs/router';
import { errorText } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useSpecPartners } from '../../lib/specApi';
import { Badge, Button, Card, Empty, Notice, PageHeader, Spinner } from '../../ui/Common';
import { SpecWorkspace } from '../partner/Spec';

/** List of partners with the state of their production specification. */
export default function Specs() {
  const q = useSpecPartners();
  return (
    <div class="page">
      <PageHeader title="Partner specifications" subtitle="Each partner has one production specification that both sides sign. Open a partner to read it, draft a change, propose it or sign for K Line." />
      <Card>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.isError}><Notice tone="bad" action={<Button size="sm" onClick={() => q.refetch()}>Try again</Button>}>{errorText(q.error)}</Notice></Show>
        <Show when={q.data && q.data.length === 0}><Empty title="No partners yet">Partners appear here once they exist.</Empty></Show>
        <Show when={q.data && q.data.length}>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Partner</th><th>Active version</th><th>Waiting for signatures</th><th>K Line drafts</th><th><span class="sr-only">Open</span></th></tr></thead>
              <tbody>
                <For each={q.data}>
                  {(p) => (
                    <tr>
                      <td class="link-cell"><A href={`/console/specs/${p.orgId}`}>{p.name}</A> <span class="muted small">{p.code}</span></td>
                      <td>{p.activeVersion ? <span>Version {p.activeVersion}<div class="muted small">since {formatDate(p.activatedAt)}</div></span> : <Badge tone="warn">None yet</Badge>}</td>
                      <td>
                        <Show when={p.proposed} fallback={<span class="muted">Nothing waiting</span>}>
                          {(pr) => (
                            <span>
                              <A href={`/console/specs/${p.orgId}/${pr().id}`}>Version {pr().version}</A>
                              <div class="small">{pr().needsKlineSignature ? <Badge tone="warn">Needs K Line</Badge> : null} {pr().needsPartnerSignature ? <Badge tone="info">Needs partner</Badge> : null}</div>
                            </span>
                          )}
                        </Show>
                      </td>
                      <td>{p.klineDrafts ? p.klineDrafts : <span class="muted">None</span>}</td>
                      <td class="right"><A class="btn btn-sm" href={`/console/specs/${p.orgId}`}>Open</A></td>
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

/** One partner's specification, for K Line staff. */
export function PartnerSpec() {
  const params = useParams();
  return <SpecWorkspace staff orgId={params.orgId ?? ''} />;
}
