import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { useAuth, useMenu } from '../../lib/auth';
import { formatNumber, greeting } from '../../lib/format';
import type { CaseList, OrgInfo } from '../../lib/types';
import { ONBOARDING_HELP, type Onboarding } from '../../lib/orgApi';
import { Card, Empty, Notice, PageHeader, Spinner } from '../../ui/Common';
import { LockedNotice } from '../../ui/Locked';
import { CaseRows } from './Cases';

const TILES: { id: string; label: string; tone?: 'warn' }[] = [
  { id: 'attention', label: 'Need attention', tone: 'warn' },
  { id: 'draft', label: 'Draft' },
  { id: 'simple_submitted', label: 'Submitted' },
  { id: 'simple_production', label: 'Production' },
  { id: 'simple_shipped', label: 'Shipped' },
];

export default function Overview() {
  const { me, can } = useAuth();
  const menu = useMenu();
  const canRead = can('case.read');
  const counts = useQuery({
    queryKey: ['overview-counts'],
    enabled: canRead,
    queryFn: async () => {
      const out: Record<string, number> = {};
      await Promise.all(TILES.map(async (t) => { out[t.id] = (await api<CaseList>(`/api/cases${qs({ status: t.id, pageSize: 1 })}`)).total; }));
      return out;
    },
  });
  const latest = useQuery({ queryKey: ['overview-latest'], enabled: canRead, queryFn: () => api<CaseList>(`/api/cases${qs({ pageSize: 5 })}`) });
  const org = useQuery({ queryKey: ['org'], enabled: can('org.read'), queryFn: () => api<OrgInfo>('/api/org') });

  const ob = useQuery({ queryKey: ['onboarding'], enabled: can('org.read'), queryFn: () => api<Onboarding>('/api/org/onboarding'), retry: false });
  const loc = useLocation();

  const total = latest.data?.total ?? 0;
  const notApproved = ob.data ? !ob.data.approved : me?.org?.status === 'onboarding';
  const locked = notApproved || (org.data ? !org.data.uploadsUnlocked : false);
  // Phase 8: the company logo and the case address. Unknown (undefined) when the server does not say.
  const logoDone = org.data?.logo?.hasLogo ?? ob.data?.items.find((i) => i.id === 'logo')?.done;
  // One case address for the whole company, kept by the administrators.
  const addressDone = ob.data?.items.find((i) => i.id === 'case_address')?.done;
  const onboarding = me?.org?.status === 'onboarding' || locked || (latest.data && total === 0) || logoDone === false || addressDone === false;

  useEffect(() => {
    if (loc.hash === '#getting-started' && ob.data) document.getElementById('getting-started')?.scrollIntoView({ block: 'start' });
  }, [loc.hash, ob.data]);

  const steps: { done: boolean; label: string; hint?: string; to?: string; optional?: boolean }[] = [
    { done: true, label: 'Create your account' },
    { done: !!me?.user.mfaEnabled, label: 'Set up your authenticator app' },
    ...(logoDone === undefined ? [] : [{ done: logoDone, label: 'Company logo', to: '/portal/company#logo', hint: ONBOARDING_HELP.logo!.hint }]),
    ...(addressDone === undefined ? [] : [{ done: addressDone, label: 'Case address', to: '/portal/company#case-address', hint: ONBOARDING_HELP.case_address!.hint }]),
    { done: !!org.data?.dpaOnFile, label: 'Data processing agreement recorded by K Line', hint: 'K Line records this with you. Uploads stay locked until it is done.' },
    { done: !!org.data && org.data.uploadsUnlocked, label: 'K Line approves your account', hint: 'This usually takes one working day.' },
    { done: total > 0, label: 'Send your first cases with Direct manufacturing', to: can('case.write') ? '/portal/send/bulk' : undefined },
    { done: false, label: 'Invite your team', to: can('team.manage') ? '/portal/team' : undefined, optional: true },
  ];

  return (
    <div className="page">
      <PageHeader title={greeting(me?.user.name ?? '')} subtitle={me?.org?.name} actions={can('case.write') ? <Link className="btn btn-primary" to="/portal/send/bulk">Send cases</Link> : undefined} />

      {locked ? <LockedNotice what="send cases, invite people or send materials" /> : null}

      {ob.data && !ob.data.approved ? (
        <div id="getting-started" tabIndex={-1}>
          <Card title="Getting started" actions={<Link to="/portal/getting-started">See all the steps</Link>}>
            <p className="muted">Finish these steps and K Line can approve your company. Most companies are approved within one working day.</p>
            <ul className="checklist">
              {ob.data.items.map((s) => {
                const help = ONBOARDING_HELP[s.id];
                return (
                  <li key={s.id}>
                    {s.done ? <CheckCircle2 className="done" size={20} aria-label="Done" /> : <Circle className="todo" size={20} aria-label="Not done yet" />}
                    <div>
                      {help?.to && !s.done && !(help.to === '/portal/spec' && !menu.spec) ? <Link to={help.to}>{s.label}</Link> : s.label}
                      {help?.hint && !s.done ? <div className="muted small">{help.hint}</div> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      ) : null}

      {!(ob.data && !ob.data.approved) && onboarding && org.data ? (
        <Card title="Getting started" actions={<Link to="/portal/getting-started">See all the steps</Link>}>
          <ul className="checklist">
            {steps.map((s) => (
              <li key={s.label}>
                {s.done ? <CheckCircle2 className="done" size={20} aria-label="Done" /> : <Circle className="todo" size={20} aria-label="Not done yet" />}
                <div>
                  {s.to ? <Link to={s.to}>{s.label}</Link> : s.label}
                  {s.optional ? <span className="muted small"> (optional)</span> : null}
                  {s.hint && !s.done ? <div className="muted small">{s.hint}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {canRead ? (
        <>
          <div className="tiles">
            {TILES.map((t) => (
              <Link key={t.id} className={`tile${t.tone === 'warn' && (counts.data?.[t.id] ?? 0) > 0 ? ' tile-warn' : ''}`} to={`/portal/cases?status=${t.id}`}>
                <span className="num">{counts.data ? formatNumber(counts.data[t.id] ?? 0) : '...'}</span>
                <span className="lbl">{t.label}</span>
              </Link>
            ))}
          </div>
          <Card title="Latest cases" actions={<Link to="/portal/cases">See all cases</Link>}>
            {latest.isLoading ? <Spinner /> : null}
            {latest.data && latest.data.items.length === 0 ? <Empty title="No cases yet">Send your first cases with Direct manufacturing and they will show up here.</Empty> : null}
            {latest.data && latest.data.items.length ? <CaseRows items={latest.data.items} /> : null}
          </Card>
        </>
      ) : (
        <Notice tone="info">Your role does not include viewing cases.</Notice>
      )}
    </div>
  );
}
