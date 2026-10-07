import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MinusCircle, XCircle } from 'lucide-react';
import { isEea } from '@shared/geo';
import { api, errorText } from '../../lib/api';
import { useSites } from '../../lib/console';
import { formatDate, formatNumber } from '../../lib/format';
import { caseAddressLine, readCaseAddress } from '../../lib/caseAddress';
import { AGREEMENT_KINDS, agreementLabel } from '../../lib/orgApi';
import { codeProblem, countryName, volumeLabel } from '../../lib/signup';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, PageHeader, Spinner, Toggle } from '../../ui/Common';
import { RolePicker } from '../partner/Team';
import { PartnerStatus, SignupBadges } from './Partners';
import { Gate } from './Console';

export { AGREEMENT_KINDS };
const kindLabel = agreementLabel;

interface Agreement { id: string; kind: string; signedAt: string | null; expiresAt: string | null; reference: string | null; notes: string | null; signedBy?: string | null; revoked: boolean }

/** What the registrant typed and what happened to the registration. Staff only. */
interface SignupInfo {
  name: string;
  email: string;
  website: string;
  volume: string | null;
  freeEmail: boolean;
  privacyVersion: string;
  at: string | null;
  confirmedAt: string | null;
  approvedAt: string | null;
  declinedAt: string | null;
  declineReason: string;
  deletesAt: string | null;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const d = (...v: unknown[]): string | null => { for (const x of v) if (typeof x === 'string' && x) return x; return null; };

function readSignup(raw: any): SignupInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    name: s(raw.registrantName) || s(raw.name) || s(raw.personName),
    email: s(raw.email),
    website: s(raw.website),
    volume: d(raw.volume),
    freeEmail: !!(raw.freeEmail ?? raw.free_email),
    privacyVersion: s(raw.privacyVersion) || s(raw.privacy_version),
    at: d(raw.registeredAt, raw.at, raw.signupAt),
    confirmedAt: d(raw.confirmedAt, raw.verifiedAt, raw.verified_at),
    approvedAt: d(raw.approvedAt, raw.approved_at),
    declinedAt: d(raw.declinedAt, raw.declined_at),
    declineReason: s(raw.declineReason) || s(raw.decline_reason),
    deletesAt: d(raw.deletesAt),
  };
}

interface PartnerData {
  id: string;
  name: string;
  legalName: string | null;
  code: string;
  country: string | null;
  vatId: string | null;
  status: string;
  retentionMonths: number;
  defaultSiteCode: string | null;
  settings: { requirePts: boolean; manualReview: boolean; slaDays: number };
  gates: {
    dpaOnFile: boolean; sccOnFile: boolean; hasSite: boolean; canActivate: boolean;
    qaaOnFile?: boolean; msaOnFile?: boolean; sccRequired?: boolean; sccMissing?: boolean;
    blockers?: { code: string; message: string }[];
  };
  address?: string | null;
  addressDetails?: { street: string; city: string; postalCode: string; country: string };
  contacts?: Record<string, { name: string; email: string; phone: string }>;
  hasLogo?: boolean;
  /** Phase 8: the address K Line sends cases back to, as the partner saved it. */
  caseAddress?: unknown;
  caseAddressComplete?: boolean;
  caseIdRegex?: string | null;
  usersCount: number;
  activeUsersCount?: number;
  casesCount: number;
  openCases: number;
  sites: { code: string; name: string; country: string; allowed: boolean; reason: string | null }[];
  agreements: Agreement[];
  signup: SignupInfo | null;
  declined: boolean;
  newSignup: boolean;
  emailNotConfirmed: boolean;
}

async function loadPartner(id: string): Promise<PartnerData> {
  const raw = await api<any>(`/api/partners/${id}`);
  const signup = readSignup(raw.signup);
  return {
    ...raw,
    signup,
    declined: !!raw.declined || !!signup?.declinedAt,
    newSignup: !!signup && !signup.approvedAt && !signup.declinedAt && raw.status === 'onboarding',
    emailNotConfirmed: !!signup && !signup.confirmedAt,
  };
}

const today = () => new Date().toISOString().slice(0, 10);
const inForce = (a: Agreement) => !a.revoked && (!a.expiresAt || a.expiresAt >= today());

/** Plain reasons why the Activate button is off. Empty means it can be used. */
function activationBlockers(p: PartnerData): string[] {
  // The server knows best. Its reasons are already plain text.
  if (Array.isArray(p.gates.blockers)) return p.gates.blockers.map((b) => b.message);
  const r: string[] = [];
  if (p.declined) r.push('This registration was declined.');
  if (p.signup && !p.signup.confirmedAt) r.push('The registrant has not confirmed their email address yet.');
  if (!p.gates.dpaOnFile) r.push('Record the signed data processing agreement (DPA) first. Uploads stay locked without it.');
  if (!p.gates.hasSite) r.push('Allow at least one site for this partner.');
  if (p.hasLogo === false) r.push('Company logo is required. The partner adds it on their company profile page.');
  if (!r.length && p.gates.canActivate === false) r.push('The system says this partner cannot be activated yet. Check the gates below.');
  return r;
}

function addDays(iso: string, days: number): string {
  const t = new Date(iso);
  t.setDate(t.getDate() + days);
  return t.toISOString();
}

export default function PartnerDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['partner', id], queryFn: () => loadPartner(id) });
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<'activate' | 'suspend' | null>(null);
  const [declining, setDeclining] = useState(false);
  const [changingCode, setChangingCode] = useState(false);
  const [inviting, setInviting] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['partner', id] }); qc.invalidateQueries({ queryKey: ['partners'] }); qc.invalidateQueries({ queryKey: ['console-overview'] }); };
  const p = q.data;

  const state = useMutation({
    mutationFn: (action: 'activate' | 'suspend') => api(`/api/partners/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: (_d, action) => {
      setConfirm(null);
      setNotice({
        tone: 'good',
        text: action === 'suspend'
          ? 'The partner is suspended. They cannot send new cases.'
          : p?.signup ? 'The company is approved and active. We have emailed its administrator a link to sign in.' : 'The partner is active. They can now send cases.',
      });
      refresh();
    },
    onError: (e) => { setConfirm(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  });

  if (q.isLoading) return <div className="page"><Spinner /></div>;
  if (q.isError || !p) return <div className="page"><Notice tone="bad" title="We could not open this partner">{errorText(q.error)}</Notice><div><Link to="/console/partners">Back to partners</Link></div></div>;

  const blockers = activationBlockers(p);
  const canActivate = blockers.length === 0;
  const selfReg = !!p.signup;
  const waiting = selfReg && p.status !== 'active' && !p.declined;
  const canDecline = waiting && p.status === 'onboarding';
  const onDone = (text: string) => { setNotice({ tone: 'good', text }); refresh(); };
  const onError = (text: string) => setNotice({ tone: 'bad', text });

  return (
    <div className="page">
      <div><Link to="/console/partners" className="small">Back to partners</Link></div>
      <PageHeader
        title={<span className="row" style={{ gap: 12 }}>{p.name} <PartnerStatus status={p.status} declined={p.declined} /> <SignupBadges p={{ newSignup: p.newSignup && !p.declined && p.status !== 'active', emailNotConfirmed: p.emailNotConfirmed && p.status !== 'active', declined: false, freeEmail: p.signup?.freeEmail }} /></span>}
        subtitle={`${p.code}${p.country ? `, ${countryName(p.country)}` : ''}`}
        actions={
          <>
            <Link className="btn" to={`/console/cases?orgId=${p.id}`}>See cases</Link>
            <Link className="btn" to={`/console/audit?orgId=${p.id}`}>Access log</Link>
            {p.status !== 'active' && !p.declined ? (
              <Button variant="primary" disabled={!canActivate} aria-describedby={!canActivate ? 'activate-reasons' : undefined} onClick={() => setConfirm('activate')}>{waiting ? 'Approve and activate' : 'Activate'}</Button>
            ) : null}
            {canDecline ? <Button variant="danger" onClick={() => setDeclining(true)}>Decline</Button> : null}
            {p.status === 'active' ? <Button variant="danger" onClick={() => setConfirm('suspend')}>Suspend</Button> : null}
          </>
        }
      />
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

      {p.declined ? (
        <Notice tone="bad" title="This registration was declined">
          {p.signup?.declinedAt ? <>Declined on {formatDate(p.signup.declinedAt)}. Everything about it is deleted on {formatDate(p.signup.deletesAt ?? addDays(p.signup.declinedAt, 30))}. </> : null}
          {p.signup?.declineReason ? <>Reason (internal only): {p.signup.declineReason}</> : null}
        </Notice>
      ) : null}
      {waiting && p.emailNotConfirmed ? (
        <Notice tone="warn" title="Email address not confirmed">
          The registrant has not confirmed their email address yet. Unconfirmed registrations are deleted 7 days after they were made{p.signup?.at ? `, so this one goes on ${formatDate(addDays(p.signup.at, 7))}` : ''}.
        </Notice>
      ) : null}
      {p.status !== 'active' && !p.declined && blockers.length ? (
        <div id="activate-reasons">
          <Notice tone="warn" title="You cannot activate this partner yet">
            <ul className="reason-list">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </Notice>
        </div>
      ) : null}

      {p.signup ? <RegistrationCard p={p} signup={p.signup} /> : null}
      <ProfileCard p={p} />

      <div className="grid-2">
        <Card title="Compliance gates">
          <GatesPanel p={p} />
        </Card>
        <div className="stack">
          <Card title="Facts">
            <dl className="facts">
              <dt>Name</dt><dd>{p.name}</dd>
              <dt>Legal name</dt><dd>{p.legalName ?? 'Not given'}</dd>
              <dt>Code</dt>
              <dd>
                <span className="row" style={{ gap: 8 }}>
                  <span className="code-tag">{p.code}</span>
                  <Button size="sm" onClick={() => setChangingCode(true)} disabled={p.casesCount > 0} aria-describedby={p.casesCount > 0 ? 'code-locked' : undefined}>Change code</Button>
                </span>
                {p.casesCount > 0 ? <div className="muted small" id="code-locked">The code cannot change once a partner has cases.</div> : null}
              </dd>
              <dt>Country</dt><dd>{p.country ? countryName(p.country) : 'Not given'}</dd>
              <dt>VAT ID</dt><dd>{p.vatId ?? 'Not given'}</dd>
              <dt>People</dt><dd>{formatNumber(p.usersCount)}{typeof p.activeUsersCount === 'number' ? ` (${formatNumber(p.activeUsersCount)} active)` : ''}</dd>
              <dt>Cases</dt><dd>{formatNumber(p.casesCount)} ({formatNumber(p.openCases)} open)</dd>
              <dt>DPA</dt><dd><Gate ok={p.gates.dpaOnFile} /></dd>
              <dt>SCC</dt><dd><Gate ok={p.gates.sccOnFile} /></dd>
            </dl>
          </Card>
          {!p.declined ? (
            <Card title="People" actions={<Button size="sm" variant="primary" onClick={() => setInviting(true)}>Invite a user</Button>}>
              <p className="muted">
                {p.usersCount === 0
                  ? 'This partner has no users yet. Invite the first administrator so they can sign in.'
                  : 'Invite another person to this partner. They get the normal invitation email with a link to choose a password.'}
              </p>
            </Card>
          ) : null}
        </div>
      </div>

      <SettingsCard p={p} onDone={onDone} onError={onError} />
      <SitesCard p={p} onDone={onDone} onError={onError} />
      <AgreementsCard p={p} onDone={onDone} onError={onError} />

      <Dialog
        open={confirm !== null}
        title={confirm === 'activate' ? `Activate ${p.name}?` : `Suspend ${p.name}?`}
        onClose={() => setConfirm(null)}
        footer={<><Button onClick={() => setConfirm(null)}>Cancel</Button><Button variant={confirm === 'suspend' ? 'danger' : 'primary'} loading={state.isPending} onClick={() => confirm && state.mutate(confirm)}>{confirm === 'activate' ? (waiting ? 'Approve and activate' : 'Activate') : 'Suspend'}</Button></>}
      >
        <p>
          {confirm === 'activate'
            ? waiting
              ? 'The company is approved. Its administrator gets an email with a link to sign in, and the company can send cases straight away.'
              : 'The partner can send cases straight away.'
            : 'The partner keeps read access to their cases but cannot upload or submit new ones until you activate them again.'}
        </p>
      </Dialog>

      <DeclineDialog
        open={declining}
        partner={p}
        onClose={() => setDeclining(false)}
        onDone={(text) => { setDeclining(false); qc.invalidateQueries({ queryKey: ['partners'] }); qc.invalidateQueries({ queryKey: ['console-overview'] }); nav('/console/partners?tab=declined', { replace: true, state: { notice: text } }); }}
      />
      <ChangeCodeDialog open={changingCode} partner={p} onClose={() => setChangingCode(false)} onDone={() => { setChangingCode(false); onDone('The code is changed.'); }} />
      <InviteUserDialog open={inviting} partner={p} onClose={() => setInviting(false)} onDone={(email) => { setInviting(false); onDone(`Invitation sent to ${email}.`); }} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- registration

function RegistrationCard({ p, signup }: { p: PartnerData; signup: SignupInfo }) {
  return (
    <Card title="Registration details">
      <p className="muted small">The registrant typed these details into the public form. K Line staff can see them here only.</p>
      <dl className="facts">
        <dt>Registered by</dt><dd>{signup.name || 'Not given'}</dd>
        <dt>Email address</dt><dd>{signup.email || 'Not given'} {signup.freeEmail ? <Badge tone="warn" title="A personal mailbox, not a company address">Personal mailbox</Badge> : null}</dd>
        <dt>Website</dt><dd>{signup.website || 'Not given'}</dd>
        <dt>Expected volume</dt><dd>{volumeLabel(signup.volume)}</dd>
        <dt>Registered on</dt><dd>{signup.at ? formatDate(signup.at) : 'Not known'}</dd>
        <dt>Email confirmed</dt><dd>{signup.confirmedAt ? formatDate(signup.confirmedAt) : <Badge tone="warn">Not yet</Badge>}</dd>
        <dt>Privacy notice</dt><dd>{signup.privacyVersion ? `Accepted, version ${signup.privacyVersion}` : 'Accepted'}</dd>
        {signup.approvedAt ? <><dt>Approved on</dt><dd>{formatDate(signup.approvedAt)}</dd></> : null}
        {p.declined && signup.declinedAt ? <><dt>Declined on</dt><dd>{formatDate(signup.declinedAt)}</dd></> : null}
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------- profile

const CONTACT_TITLES: Record<string, string> = { operations: 'Operations' };

/** What the partner has filled in on their company profile page. */
function ProfileCard({ p }: { p: PartnerData }) {
  const a = p.addressDetails;
  const addressLine = a ? [a.street, [a.postalCode, a.city].filter(Boolean).join(' '), countryName(a.country)].filter(Boolean).join(', ') : '';
  const contacts = Object.entries(p.contacts ?? {}).filter(([, c]) => c.name || c.email || c.phone);
  const [logoFailed, setLogoFailed] = useState(false);
  const ca = readCaseAddress(p.caseAddress);
  return (
    <Card title="Company profile">
      <p className="muted small">Filled in by the partner on their company profile page.</p>
      <dl className="facts">
        <dt>Address</dt><dd>{addressLine || 'Not given'}</dd>
        <dt>Contacts</dt>
        <dd>
          {contacts.length === 0 ? 'Not given' : (
            <ul className="reason-list" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
              {contacts.map(([k, c]) => (
                <li key={k}><strong>{CONTACT_TITLES[k] ?? k}:</strong> {[c.name, c.email, c.phone].filter(Boolean).join(', ')}</li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Case address</dt>
        <dd>
          {ca ? (
            <>
              <div>{[ca.fullName, ca.company].filter(Boolean).join(', ')}</div>
              <div>{caseAddressLine(ca, countryName)}</div>
              <div className="muted small">{[ca.phone, ca.email].filter(Boolean).join(', ')}</div>
              {p.caseAddressComplete === false ? <Badge tone="warn">Incomplete</Badge> : null}
            </>
          ) : <><Badge tone="warn">Not given</Badge> <span className="muted small">The partner cannot send direct manufacturing cases without it.</span></>}
        </dd>
        <dt>Case ID pattern</dt><dd>{p.caseIdRegex ? <span className="code-tag">{p.caseIdRegex}</span> : 'None'}</dd>
        <dt>Logo</dt>
        <dd>
          {p.hasLogo && !logoFailed ? <span className="logo-box"><img src={`/api/partners/${p.id}/logo`} alt={`Logo of ${p.name}`} onError={() => setLogoFailed(true)} /></span> : <><Badge tone="warn">None</Badge> <span className="muted small">A company logo is required before K Line can approve the company.</span></>}
        </dd>
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------- gates

function GateRow({ state, title, children }: { state: 'ok' | 'missing' | 'soft'; title: string; children?: ReactNode }) {
  const label = state === 'ok' ? 'Done' : state === 'missing' ? 'Not done yet' : 'Not required now';
  return (
    <li>
      {state === 'ok' ? <CheckCircle2 className="gate-ok" size={20} aria-label={label} /> : state === 'missing' ? <XCircle className="gate-no" size={20} aria-label={label} /> : <MinusCircle className="gate-soft" size={20} aria-label={label} />}
      <div>
        <strong>{title}</strong>
        {children ? <div className="muted small">{children}</div> : null}
      </div>
    </li>
  );
}

function GatesPanel({ p }: { p: PartnerData }) {
  const eea = isEea(p.country);
  const blocked = p.sites.filter((x) => !x.allowed);
  const qaa = p.gates.qaaOnFile ?? p.agreements.some((a) => a.kind === 'qaa' && inForce(a));
  const msa = p.gates.msaOnFile ?? p.agreements.some((a) => a.kind === 'msa' && inForce(a));
  const sccMissing = p.gates.sccMissing ?? (eea && blocked.length > 0);
  const sccState: 'ok' | 'missing' | 'soft' = sccMissing ? 'missing' : p.gates.sccRequired && p.gates.sccOnFile ? 'ok' : !eea ? 'soft' : p.gates.sccOnFile ? 'ok' : 'soft';
  return (
    <ul className="gate-list">
      {p.signup ? (
        <GateRow state={p.signup.confirmedAt ? 'ok' : 'missing'} title="Email address confirmed (needed to activate)">
          {p.signup.confirmedAt ? `Confirmed on ${formatDate(p.signup.confirmedAt)}.` : 'The registrant has to open the link in their email.'}
        </GateRow>
      ) : null}
      <GateRow state={p.gates.dpaOnFile ? 'ok' : 'missing'} title="Data processing agreement on file (needed to activate)">
        {p.gates.dpaOnFile ? 'Uploads can be unlocked.' : 'Record the signed DPA under Agreements below. Uploads stay locked until this is done.'}
      </GateRow>
      {p.hasLogo !== undefined ? (
        <GateRow state={p.hasLogo ? 'ok' : 'missing'} title="Company logo (needed to activate)">
          {p.hasLogo ? 'The logo is on file.' : 'Company logo is required. The partner adds it on their company profile page.'}
        </GateRow>
      ) : null}
      <GateRow state={p.gates.hasSite ? 'ok' : 'missing'} title="At least one site allowed (needed to activate)">
        {p.gates.hasSite ? undefined : 'Choose the sites that may make this partner\'s cases.'}
      </GateRow>
      <GateRow state={sccState} title="Standard contractual clauses (SCC)">
        {!eea
          ? 'Not needed: this partner is outside the EEA.'
          : sccMissing
            ? `Needed before cases can be made at ${blocked.length ? blocked.map((x) => x.code).join(', ') : 'sites outside the EEA'}. These sites are outside the EEA without an adequacy decision. It does not stop you activating the partner.`
            : p.gates.sccOnFile ? 'On file.' : 'Not needed for the current sites.'}
      </GateRow>
      <GateRow state={qaa ? 'ok' : 'soft'} title="Quality assurance agreement (QAA)">{qaa ? 'On file.' : 'Recommended. Not needed to activate.'}</GateRow>
      <GateRow state={msa ? 'ok' : 'soft'} title="Master service agreement (MSA)">{msa ? 'On file.' : 'Recommended. Not needed to activate.'}</GateRow>
    </ul>
  );
}

// --------------------------------------------------------------------------------------------------------- dialogs

function DeclineDialog({ open, partner, onClose, onDone }: { open: boolean; partner: PartnerData; onClose: () => void; onDone: (text: string) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(''); setError(null); } }, [open]);
  const confirmed = !!partner.signup?.confirmedAt;
  const m = useMutation({
    mutationFn: () => api<{ status: string; deleted?: boolean; deletesAt?: string | null }>(`/api/partners/${partner.id}/decline`, { method: 'POST', body: reason.trim() ? { reason: reason.trim() } : {} }),
    onSuccess: (r) => onDone(r?.deleted ? 'The registration is deleted.' : `The registration is declined.${r?.deletesAt ? ` It is deleted on ${formatDate(r.deletesAt)}.` : ''}`),
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog open={open} title={`Decline ${partner.name}?`} onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        {confirmed ? (
          <div className="stack-sm">
            <p><strong>What happens next</strong></p>
            <ul className="reason-list">
              <li>The registrant gets a short email saying the registration was not approved.</li>
              <li>Their access ends now and they are signed out.</li>
              <li>You can still see the registration under Declined for 30 days.</li>
              <li>After 30 days the company, the user and all registration details are deleted.</li>
            </ul>
          </div>
        ) : (
          <Notice tone="warn" title="This registration is deleted at once">
            The registrant never confirmed their email address. The company, the user, their tokens and the draft specification are deleted straight away. This cannot be undone. Only the code and a note in the audit log remain.
          </Notice>
        )}
        <Field label="Reason (optional)" hint="For your team only. It is stored internally and is not sent to the registrant.">
          {(f) => <textarea {...f} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <p className="small muted">You will be asked for your authenticator code.</p>
        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={m.isPending}>{confirmed ? 'Decline registration' : 'Decline and delete'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ChangeCodeDialog({ open, partner, onClose, onDone }: { open: boolean; partner: PartnerData; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setCode(partner.code); setError(null); } }, [open, partner.code]);
  const problem = code && code !== partner.code ? codeProblem(code) : null;
  const m = useMutation({
    mutationFn: () => api(`/api/partners/${partner.id}/code`, { method: 'PATCH', body: { code } }),
    onSuccess: onDone,
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog open={open} title="Change the code" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <p className="muted">The code starts every case reference for this partner. You can change it only while the partner has no cases.</p>
        <Field label="Code" hint="2 to 8 capital letters or digits." error={problem}>
          {(f) => <input {...f} className="mono" value={code} maxLength={8} required autoFocus autoComplete="off" onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />}
        </Field>
        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!code || code === partner.code || !!problem}>Change code</Button>
        </div>
      </form>
    </Dialog>
  );
}

function InviteUserDialog({ open, partner, onClose, onDone }: { open: boolean; partner: PartnerData; onClose: () => void; onDone: (email: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<string[]>(['admin']);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(''); setEmail(''); setRoles(partner.usersCount === 0 ? ['admin'] : ['uploader']); setError(null); } }, [open, partner.usersCount]);
  const m = useMutation({
    mutationFn: () => api(`/api/partners/${partner.id}/users/invite`, { method: 'POST', body: { email: email.trim(), name: name.trim(), roles } }),
    onSuccess: () => onDone(email.trim()),
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog open={open} title={`Invite a user to ${partner.name}`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Full name">{(f) => <input {...f} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="off" />}</Field>
        <Field label="Email address" hint="We send them a link to choose a password.">{(f) => <input {...f} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />}</Field>
        <RolePicker value={roles} onChange={setRoles} />
        <p className="small muted">You will be asked for your authenticator code.</p>
        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!email || !name || roles.length === 0}>Send invitation</Button>
        </div>
      </form>
    </Dialog>
  );
}

interface CardProps { p: PartnerData; onDone: (t: string) => void; onError: (t: string) => void }

function SettingsCard({ p, onDone, onError }: CardProps) {
  const [retention, setRetention] = useState(String(p.retentionMonths));
  const [sla, setSla] = useState(String(p.settings.slaDays));
  const [requirePts, setRequirePts] = useState(p.settings.requirePts);
  const [manual, setManual] = useState(p.settings.manualReview);
  useEffect(() => {
    setRetention(String(p.retentionMonths)); setSla(String(p.settings.slaDays)); setRequirePts(p.settings.requirePts); setManual(p.settings.manualReview);
  }, [p]);
  const r = Number(retention);
  const s = Number(sla);
  const valid = Number.isInteger(r) && r >= 1 && r <= 180 && Number.isInteger(s) && s >= 1 && s <= 30;
  const m = useMutation({
    mutationFn: () => api(`/api/partners/${p.id}/settings`, { method: 'PATCH', body: { retentionMonths: r, slaDays: s, requirePts, manualReview: manual } }),
    onSuccess: () => onDone('Settings saved.'),
    onError: (e) => onError(errorText(e)),
  });
  function submit(e: FormEvent) { e.preventDefault(); m.mutate(); }
  return (
    <Card title="Settings">
      <form onSubmit={submit} className="stack">
        <div className="form-grid">
          <Field label="Keep files after shipping (months)" hint="Between 1 and 180. Files and patient names are removed after this time.">
            {(f) => <input {...f} type="number" min={1} max={180} value={retention} onChange={(e) => setRetention(e.target.value)} required />}
          </Field>
          <Field label="Days to ship (business days)" hint="Counted from when the case is ready. Sets the due date.">
            {(f) => <input {...f} type="number" min={1} max={30} value={sla} onChange={(e) => setSla(e.target.value)} required />}
          </Field>
        </div>
        <Toggle checked={requirePts} onChange={setRequirePts} label="Require a trim line for every aligner" hint="Without one the partner gets a warning to confirm." />
        <Toggle checked={manual} onChange={setManual} label="Review every case before it goes to a site" hint="Cases wait in the intake queue until staff send them on." />
        <div><Button type="submit" variant="primary" loading={m.isPending} disabled={!valid}>Save settings</Button></div>
      </form>
    </Card>
  );
}

function SitesCard({ p, onDone, onError }: CardProps) {
  const all = useSites();
  const gate = new Map(p.sites.map((s) => [s.code, s]));
  const [codes, setCodes] = useState<string[]>(p.sites.map((s) => s.code));
  const [def, setDef] = useState(p.defaultSiteCode ?? '');
  useEffect(() => { setCodes(p.sites.map((s) => s.code)); setDef(p.defaultSiteCode ?? ''); }, [p]);
  const m = useMutation({
    mutationFn: () => api(`/api/partners/${p.id}/sites`, { method: 'PUT', body: { siteCodes: codes, defaultSiteCode: def && codes.includes(def) ? def : null } }),
    onSuccess: () => onDone('Sites saved.'),
    onError: (e) => onError(errorText(e)),
  });
  const list = all.data?.sites ?? [];
  return (
    <Card title="Sites">
      {all.isLoading ? <Spinner /> : null}
      {all.isError ? <Notice tone="bad">{errorText(all.error)}</Notice> : null}
      {list.length ? (
        <div className="stack">
          <fieldset className="check-group">
            <legend>Sites where this partner's cases may be made</legend>
            {list.map((s) => (
              <div className="check" key={s.code}>
                <input id={`ps-${s.code}`} type="checkbox" checked={codes.includes(s.code)} onChange={(e) => setCodes(e.target.checked ? [...codes, s.code] : codes.filter((x) => x !== s.code))} />
                <label htmlFor={`ps-${s.code}`}>{s.code}, {s.name} {!s.active ? <Badge tone="bad">Inactive</Badge> : null}</label>
                <p className="hint">{s.country}{s.inEea ? ', EEA' : s.hasAdequacy ? ', adequacy decision' : ', needs SCC for EEA partners'}{gate.get(s.code)?.allowed === false ? `. Blocked for this partner: ${gate.get(s.code)?.reason ?? 'transfer gate'}` : ''}</p>
              </div>
            ))}
          </fieldset>
          <Field label="Default site" hint="Used when the case does not need a manual review.">
            {(f) => (
              <select {...f} value={def} onChange={(e) => setDef(e.target.value)}>
                <option value="">None</option>
                {codes.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </Field>
          <div><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Save sites</Button></div>
        </div>
      ) : null}
    </Card>
  );
}

function AgreementsCard({ p, onDone, onError }: CardProps) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Agreement | null>(null);
  const del = useMutation({
    mutationFn: (a: Agreement) => api(`/api/partners/${p.id}/agreements/${a.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoving(null); onDone('Agreement removed.'); },
    onError: (e) => { setRemoving(null); onError(errorText(e)); },
  });
  return (
    <Card title="Agreements" actions={<Button size="sm" variant="primary" onClick={() => setAdding(true)}>Add an agreement</Button>}>
      {p.agreements.filter((a) => !a.revoked).length === 0 && p.agreements.length === 0 ? <Empty title="No agreements recorded">Record the signed DPA here to unlock uploads.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Agreement</th><th>Signed</th><th>Expires</th><th>Reference</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {p.agreements.map((a) => (
                <tr key={a.id}>
                  <td><strong>{kindLabel(a.kind)}</strong> {a.revoked ? <Badge tone="neutral">Removed</Badge> : null}{a.notes ? <div className="muted small">{a.notes}</div> : null}</td>
                  <td className="nowrap">{a.signedAt ? formatDate(a.signedAt) : 'Not set'}</td>
                  <td className="nowrap">{a.expiresAt ? formatDate(a.expiresAt) : 'No end date'}</td>
                  <td>{a.reference ?? ''}</td>
                  <td className="right">{a.revoked ? null : <Button size="sm" onClick={() => setRemoving(a)} aria-label={`Remove the ${kindLabel(a.kind)}`}>Remove</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AddAgreement partnerId={p.id} open={adding} onClose={() => setAdding(false)} onDone={() => { setAdding(false); onDone('Agreement recorded.'); }} />
      <Dialog
        open={!!removing}
        title="Remove this agreement?"
        onClose={() => setRemoving(null)}
        footer={<><Button onClick={() => setRemoving(null)}>Keep it</Button><Button variant="danger" loading={del.isPending} onClick={() => removing && del.mutate(removing)}>Remove</Button></>}
      >
        <p>{removing ? kindLabel(removing.kind) : ''}. If this is the only one of its kind, uploads or transfers that depend on it stop working. The record stays in the audit log. You will be asked for your authenticator code.</p>
      </Dialog>
    </Card>
  );
}

function AddAgreement({ partnerId, open, onClose, onDone }: { partnerId: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState('dpa');
  const [signedAt, setSignedAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setKind('dpa'); setSignedAt(''); setExpiresAt(''); setReference(''); setNotes(''); setError(null); } }, [open]);
  const m = useMutation({
    mutationFn: () => api(`/api/partners/${partnerId}/agreements`, {
      method: 'POST',
      body: { kind, signedAt, ...(expiresAt ? { expiresAt } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) },
    }),
    onSuccess: onDone,
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog open={open} title="Add an agreement" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Kind">{(f) => <select {...f} value={kind} onChange={(e) => setKind(e.target.value)}>{AGREEMENT_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>}</Field>
        <div className="form-grid">
          <Field label="Signed on">{(f) => <input {...f} type="date" value={signedAt} onChange={(e) => setSignedAt(e.target.value)} required />}</Field>
          <Field label="Expires on (optional)">{(f) => <input {...f} type="date" value={expiresAt} min={signedAt || undefined} onChange={(e) => setExpiresAt(e.target.value)} />}</Field>
        </div>
        <Field label="Reference (optional)" hint="Contract number or document name.">{(f) => <input {...f} value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} />}</Field>
        <Field label="Notes (optional)">{(f) => <textarea {...f} rows={3} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />}</Field>
        <p className="small muted">You will be asked for your authenticator code.</p>
        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!signedAt}>Record agreement</Button>
        </div>
      </form>
    </Dialog>
  );
}
