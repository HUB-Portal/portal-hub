import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../../lib/api';
import { useSites } from '../../lib/console';
import { formatDate, formatNumber } from '../../lib/format';
import { COUNTRIES, codeProblem, countryName, suggestCompanyCode } from '../../lib/signup';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, PageHeader, Spinner } from '../../ui/Common';
import { Gate } from './Console';
import { IfMfa } from '../../ui/IfMfa';

export interface PartnerRow {
  id: string;
  name: string;
  code: string;
  status: string;
  country?: string | null;
  dpaOnFile: boolean;
  sccOnFile: boolean;
  siteCodes: string[];
  usersCount: number;
  openCases: number;
  /** Phase 5: self registration flags. */
  newSignup?: boolean;
  emailNotConfirmed?: boolean;
  declined?: boolean;
  signupAt?: string | null;
  freeEmail?: boolean;
  volume?: string | null;
  deletesAt?: string | null;
}

interface PartnerList { items: PartnerRow[]; counts?: { all: number; review: number; declined: number } }

export const PARTNER_STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' }> = {
  active: { label: 'Active', tone: 'good' },
  onboarding: { label: 'Onboarding', tone: 'warn' },
  suspended: { label: 'Suspended', tone: 'bad' },
};

export function PartnerStatus({ status, declined }: { status: string; declined?: boolean }) {
  if (declined) return <Badge tone="bad">Declined</Badge>;
  const s = PARTNER_STATUS[status] ?? { label: status, tone: 'warn' as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Badges for companies that registered themselves. */
export function SignupBadges({ p }: { p: Pick<PartnerRow, 'newSignup' | 'emailNotConfirmed' | 'declined' | 'freeEmail'> }) {
  if (!p.newSignup && !p.emailNotConfirmed && !p.declined && !p.freeEmail) return null;
  return (
    <span className="badge-row">
      {p.newSignup && !p.declined ? <Badge tone="info">New sign up</Badge> : null}
      {p.emailNotConfirmed && !p.declined ? <Badge tone="warn">Email not confirmed</Badge> : null}
      {p.declined ? <Badge tone="bad">Declined</Badge> : null}
      {p.freeEmail ? <Badge tone="neutral" title="They registered with a personal mailbox, not a company address">Personal email</Badge> : null}
    </span>
  );
}

type Tab = 'all' | 'review' | 'declined';
const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'review', label: 'Waiting for review' },
  { id: 'declined', label: 'Declined' },
];

const EMPTY: Record<Tab, { title: string; text: string }> = {
  all: { title: 'No partners yet', text: 'Partners appear here after they register, or when you add one.' },
  review: { title: 'Nothing is waiting for review', text: 'New companies that register themselves show up here.' },
  declined: { title: 'No declined registrations', text: 'Declined registrations stay here for 30 days and are then deleted.' },
};

export default function Partners() {
  const [params, setParams] = useSearchParams();
  const loc = useLocation();
  const tabParam = params.get('tab');
  const tab: Tab = tabParam === 'review' || tabParam === 'declined' ? tabParam : 'all';
  const [text, setText] = useState(params.get('search') ?? '');
  const [search, setSearch] = useState(text);
  const [adding, setAdding] = useState(false);
  const flash = (loc.state as { notice?: string } | null)?.notice ?? null;

  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const q = useQuery({
    queryKey: ['partners', tab, search],
    queryFn: () => api<PartnerList>(`/api/partners?tab=${tab}${search ? `&search=${encodeURIComponent(search)}` : ''}`),
  });
  const rows = q.data?.items ?? [];
  const showRegistered = rows.some((r) => r.signupAt);
  const showDeletes = tab === 'declined' && rows.some((r) => r.deletesAt);

  function pick(t: Tab) {
    const next = new URLSearchParams(params);
    if (t === 'all') next.delete('tab'); else next.set('tab', t);
    setParams(next, { replace: true });
  }

  return (
    <div className="page">
      <PageHeader
        title="Partners"
        subtitle="Partner organisations, their agreements and where their cases may be made."
        actions={<Button variant="primary" onClick={() => setAdding(true)}>Add partner</Button>}
      />
      {flash ? <Notice tone="good">{flash}</Notice> : null}
      <Card>
        <div className="toolbar">
          <div className="tabs" role="group" aria-label="Show">
            {TABS.map((t) => (
              <button key={t.id} type="button" className="tab" aria-pressed={tab === t.id} onClick={() => pick(t.id)}>
                {t.label}
                {q.data?.counts && q.data.counts[t.id] > 0 ? <span className="tab-count">{formatNumber(q.data.counts[t.id])}</span> : null}
              </button>
            ))}
          </div>
          <Field label="Search partners" className="grow">
            {(p) => <input {...p} type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or code" autoComplete="off" />}
          </Field>
        </div>
        {q.isLoading ? <Spinner /> : null}
        {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
        {q.data && rows.length === 0 ? <Empty title={search ? 'No partners match your search' : EMPTY[tab].title}>{search ? 'Try a different name or code.' : EMPTY[tab].text}</Empty> : null}
        {rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Partner</th><th>Status</th><th>Country</th>
                  {showRegistered ? <th>Registered</th> : null}
                  {showDeletes ? <th>Deleted on</th> : null}
                  <th>DPA</th><th>SCC</th><th className="num">Sites</th><th className="num">People</th><th className="num">Open cases</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="link-cell">
                      <Link to={`/console/partners/${p.id}`}>{p.name}</Link> <span className="muted small">{p.code}</span>
                      <SignupBadges p={p} />
                    </td>
                    <td><PartnerStatus status={p.status} declined={p.declined} /></td>
                    <td>{countryName(p.country)}</td>
                    {showRegistered ? <td className="nowrap">{p.signupAt ? formatDate(p.signupAt) : ''}</td> : null}
                    {showDeletes ? <td className="nowrap">{p.deletesAt ? formatDate(p.deletesAt) : ''}</td> : null}
                    <td><Gate ok={p.dpaOnFile} /></td>
                    <td><Gate ok={p.sccOnFile} /></td>
                    <td className="num">{formatNumber(p.siteCodes.length)}</td>
                    <td className="num">{formatNumber(p.usersCount)}</td>
                    <td className="num">{formatNumber(p.openCases)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <AddPartnerDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function AddPartnerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const sites = useSites();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeEdited, setCodeEdited] = useState(false);
  const [country, setCountry] = useState('');
  const [legalName, setLegalName] = useState('');
  const [retention, setRetention] = useState('');
  const [siteCodes, setSiteCodes] = useState<string[]>([]);
  const [defaultSite, setDefaultSite] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setName(''); setCode(''); setCodeEdited(false); setCountry(''); setLegalName(''); setRetention(''); setSiteCodes([]); setDefaultSite(''); setError(null); }
  }, [open]);

  const cProblem = code ? codeProblem(code) : null;
  const r = Number(retention);
  const retentionOk = !retention || (Number.isInteger(r) && r >= 1 && r <= 180);
  const valid = name.trim().length >= 2 && !!code && !cProblem && !!country && retentionOk;

  const m = useMutation({
    mutationFn: () => api<{ id?: string; partner?: { id: string } }>('/api/partners', {
      method: 'POST',
      body: {
        name: name.trim(), code, country,
        ...(legalName.trim() ? { legalName: legalName.trim() } : {}),
        ...(retention ? { retentionMonths: r } : {}),
        siteCodes,
        ...(defaultSite && siteCodes.includes(defaultSite) ? { defaultSiteCode: defaultSite } : {}),
      },
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['partners'] });
      qc.invalidateQueries({ queryKey: ['console-overview'] });
      const id = res?.id ?? res?.partner?.id;
      onClose();
      if (id) nav(`/console/partners/${id}`);
    },
    onError: (e) => setError(errorText(e)),
  });

  const list = sites.data?.sites.filter((s) => s.active) ?? [];
  return (
    <Dialog open={open} title="Add a partner" onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        <p className="muted">Use this for a company that did not register itself. It starts in onboarding. Invite its first user from the partner page afterwards.</p>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="form-grid">
          <Field label="Company name">
            {(p) => <input {...p} value={name} maxLength={120} required autoComplete="off" onChange={(e) => { setName(e.target.value); if (!codeEdited) setCode(suggestCompanyCode(e.target.value)); }} />}
          </Field>
          <Field label="Code" hint="2 to 8 capital letters or digits. It starts every case reference." error={cProblem}>
            {(p) => <input {...p} className="mono" value={code} maxLength={8} required autoComplete="off" onChange={(e) => { setCodeEdited(true); setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); }} />}
          </Field>
          <Field label="Country">
            {(p) => (
              <select {...p} value={country} required onChange={(e) => setCountry(e.target.value)}>
                <option value="">Choose a country</option>
                {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Legal name (optional)">
            {(p) => <input {...p} value={legalName} maxLength={160} autoComplete="off" onChange={(e) => setLegalName(e.target.value)} />}
          </Field>
          <Field label="Keep files after shipping, in months (optional)" hint="Between 1 and 180. Leave empty for the standard time." error={retentionOk ? null : 'Enter a whole number from 1 to 180.'}>
            {(p) => <input {...p} type="number" min={1} max={180} value={retention} onChange={(e) => setRetention(e.target.value)} />}
          </Field>
        </div>
        {list.length ? (
          <div className="stack">
            <fieldset className="check-group">
              <legend>Sites where this partner's cases may be made (optional)</legend>
              {list.map((s) => (
                <div className="check" key={s.code}>
                  <input id={`add-site-${s.code}`} type="checkbox" checked={siteCodes.includes(s.code)} onChange={(e) => setSiteCodes(e.target.checked ? [...siteCodes, s.code] : siteCodes.filter((x) => x !== s.code))} />
                  <label htmlFor={`add-site-${s.code}`}>{s.code}, {s.name}</label>
                </div>
              ))}
            </fieldset>
            {siteCodes.length ? (
              <Field label="Default site">
                {(p) => (
                  <select {...p} value={defaultSite} onChange={(e) => setDefaultSite(e.target.value)}>
                    <option value="">None</option>
                    {siteCodes.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
              </Field>
            ) : null}
          </div>
        ) : null}
        <IfMfa><p className="small muted">You will be asked for your authenticator code.</p></IfMfa>
        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!valid}>Add partner</Button>
        </div>
      </form>
    </Dialog>
  );
}
