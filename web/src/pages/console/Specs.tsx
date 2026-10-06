import { Link, useParams } from 'react-router-dom';
import { errorText } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useSpecPartners } from '../../lib/specApi';
import { Badge, Button, Card, Empty, Notice, PageHeader, Spinner } from '../../ui/Common';
import { SpecWorkspace } from '../partner/Spec';

/** List of partners with the state of their production specification. */
export default function Specs() {
  const q = useSpecPartners();
  return (
    <div className="page">
      <PageHeader title="Partner specifications" subtitle="Each partner has one production specification that both sides sign. Open a partner to read it, draft a change, propose it or sign for K Line." />
      <Card>
        {q.isLoading ? <Spinner /> : null}
        {q.isError ? <Notice tone="bad" action={<Button size="sm" onClick={() => q.refetch()}>Try again</Button>}>{errorText(q.error)}</Notice> : null}
        {q.data && q.data.length === 0 ? <Empty title="No partners yet">Partners appear here once they exist.</Empty> : null}
        {q.data && q.data.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Partner</th><th>Active version</th><th>Waiting for signatures</th><th>K Line drafts</th><th><span className="sr-only">Open</span></th></tr></thead>
              <tbody>
                {q.data.map((p) => (
                  <tr key={p.orgId}>
                    <td className="link-cell"><Link to={`/console/specs/${p.orgId}`}>{p.name}</Link> <span className="muted small">{p.code}</span></td>
                    <td>{p.activeVersion ? <span>Version {p.activeVersion}<div className="muted small">since {formatDate(p.activatedAt)}</div></span> : <Badge tone="warn">None yet</Badge>}</td>
                    <td>
                      {p.proposed ? (
                        <span>
                          <Link to={`/console/specs/${p.orgId}/${p.proposed.id}`}>Version {p.proposed.version}</Link>
                          <div className="small">{p.proposed.needsKlineSignature ? <Badge tone="warn">Needs K Line</Badge> : null} {p.proposed.needsPartnerSignature ? <Badge tone="info">Needs partner</Badge> : null}</div>
                        </span>
                      ) : <span className="muted">Nothing waiting</span>}
                    </td>
                    <td>{p.klineDrafts ? p.klineDrafts : <span className="muted">None</span>}</td>
                    <td className="right"><Link className="btn btn-sm" to={`/console/specs/${p.orgId}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

/** One partner's specification, for K Line staff. */
export function PartnerSpec() {
  const { orgId = '' } = useParams();
  return <SpecWorkspace staff orgId={orgId} />;
}
