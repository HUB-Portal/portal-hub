import { createEffect, createMemo, createSignal, For, type JSX, Match, on, Show, Switch } from 'solid-js';
import { A, useNavigate, useParams } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { CheckCircle2, MinusCircle, XCircle } from 'lucide-solid';
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
import { IfMfa } from '../../ui/IfMfa';

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
  const params = useParams();
  const id = () => params.id ?? '';
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = createQuery(() => ({ queryKey: ['partner', id()], queryFn: () => loadPartner(id()) }));
  const [notice, setNotice] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [confirm, setConfirm] = createSignal<'activate' | 'suspend' | null>(null);
  const [declining, setDeclining] = createSignal(false);
  const [changingCode, setChangingCode] = createSignal(false);
  const [inviting, setInviting] = createSignal(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['partner', id()] }); qc.invalidateQueries({ queryKey: ['partners'] }); qc.invalidateQueries({ queryKey: ['console-overview'] }); };

  const state = createMutation(() => ({
    mutationFn: (action: 'activate' | 'suspend') => api(`/api/partners/${id()}/${action}`, { method: 'POST', body: {} }),
    onSuccess: (_d: unknown, action: 'activate' | 'suspend') => {
      setConfirm(null);
      setNotice({
        tone: 'good',
        text: action === 'suspend'
          ? 'The partner is suspended. They cannot send new cases.'
          : q.data?.signup ? 'The company is approved and active. We have emailed its administrator a link to sign in.' : 'The partner is active. They can now send cases.',
      });
      refresh();
    },
    onError: (e: unknown) => { setConfirm(null); setNotice({ tone: 'bad', text: errorText(e) }); },
  }));

  return (
    <Switch>
      <Match when={q.isLoading}><div class="page"><Spinner /></div></Match>
      <Match when={q.isError || !q.data}>
        <div class="page"><Notice tone="bad" title="We could not open this partner">{errorText(q.error)}</Notice><div><A href="/console/partners">Back to partners</A></div></div>
      </Match>
      <Match when={q.data}>
        {(p) => {
          const blockers = () => activationBlockers(p());
          const canActivate = () => blockers().length === 0;
          const selfReg = () => !!p().signup;
          const waiting = () => selfReg() && p().status !== 'active' && !p().declined;
          const canDecline = () => waiting() && p().status === 'onboarding';
          const onDone = (text: string) => { setNotice({ tone: 'good', text }); refresh(); };
          const onError = (text: string) => setNotice({ tone: 'bad', text });

          return (
            <div class="page">
              <div><A href="/console/partners" class="small">Back to partners</A></div>
              <PageHeader
                title={<span class="row" style={{ gap: '12px' }}>{p().name} <PartnerStatus status={p().status} declined={p().declined} /> <SignupBadges p={{ newSignup: p().newSignup && !p().declined && p().status !== 'active', emailNotConfirmed: p().emailNotConfirmed && p().status !== 'active', declined: false, freeEmail: p().signup?.freeEmail }} /></span>}
                subtitle={`${p().code}${p().country ? `, ${countryName(p().country)}` : ''}`}
                actions={
                  <>
                    <A class="btn" href={`/console/cases?orgId=${p().id}`}>See cases</A>
                    <A class="btn" href={`/console/audit?orgId=${p().id}`}>Access log</A>
                    {p().status !== 'active' && !p().declined ? (
                      <Button variant="primary" disabled={!canActivate()} aria-describedby={!canActivate() ? 'activate-reasons' : undefined} onClick={() => setConfirm('activate')}>{waiting() ? 'Approve and activate' : 'Activate'}</Button>
                    ) : null}
                    {canDecline() ? <Button variant="danger" onClick={() => setDeclining(true)}>Decline</Button> : null}
                    {p().status === 'active' ? <Button variant="danger" onClick={() => setConfirm('suspend')}>Suspend</Button> : null}
                  </>
                }
              />
              <Show when={notice()}>{(n) => <Notice tone={n().tone}>{n().text}</Notice>}</Show>

              <Show when={p().declined}>
                <Notice tone="bad" title="This registration was declined">
                  {p().signup?.declinedAt ? <>Declined on {formatDate(p().signup!.declinedAt)}. Everything about it is deleted on {formatDate(p().signup!.deletesAt ?? addDays(p().signup!.declinedAt!, 30))}. </> : null}
                  {p().signup?.declineReason ? <>Reason (internal only): {p().signup!.declineReason}</> : null}
                </Notice>
              </Show>
              <Show when={waiting() && p().emailNotConfirmed}>
                <Notice tone="warn" title="Email address not confirmed">
                  The registrant has not confirmed their email address yet. Unconfirmed registrations are deleted 7 days after they were made{p().signup?.at ? `, so this one goes on ${formatDate(addDays(p().signup!.at!, 7))}` : ''}.
                </Notice>
              </Show>
              <Show when={p().status !== 'active' && !p().declined && blockers().length}>
                <div id="activate-reasons">
                  <Notice tone="warn" title="You cannot activate this partner yet">
                    <ul class="reason-list"><For each={blockers()}>{(b) => <li>{b}</li>}</For></ul>
                  </Notice>
                </div>
              </Show>

              <Show when={p().signup}>{(signup) => <RegistrationCard p={p()} signup={signup()} />}</Show>
              <ProfileCard p={p()} />

              <div class="grid-2">
                <Card title="Compliance gates">
                  <GatesPanel p={p()} />
                </Card>
                <div class="stack">
                  <Card title="Facts">
                    <dl class="facts">
                      <dt>Name</dt><dd>{p().name}</dd>
                      <dt>Legal name</dt><dd>{p().legalName ?? 'Not given'}</dd>
                      <dt>Code</dt>
                      <dd>
                        <span class="row" style={{ gap: '8px' }}>
                          <span class="code-tag">{p().code}</span>
                          <Button size="sm" onClick={() => setChangingCode(true)} disabled={p().casesCount > 0} aria-describedby={p().casesCount > 0 ? 'code-locked' : undefined}>Change code</Button>
                        </span>
                        {p().casesCount > 0 ? <div class="muted small" id="code-locked">The code cannot change once a partner has cases.</div> : null}
                      </dd>
                      <dt>Country</dt><dd>{p().country ? countryName(p().country) : 'Not given'}</dd>
                      <dt>VAT ID</dt><dd>{p().vatId ?? 'Not given'}</dd>
                      <dt>People</dt><dd>{formatNumber(p().usersCount)}{typeof p().activeUsersCount === 'number' ? ` (${formatNumber(p().activeUsersCount!)} active)` : ''}</dd>
                      <dt>Cases</dt><dd>{formatNumber(p().casesCount)} ({formatNumber(p().openCases)} open)</dd>
                      <dt>DPA</dt><dd><Gate ok={p().gates.dpaOnFile} /></dd>
                      <dt>SCC</dt><dd><Gate ok={p().gates.sccOnFile} /></dd>
                    </dl>
                  </Card>
                  <Show when={!p().declined}>
                    <Card title="People" actions={<Button size="sm" variant="primary" onClick={() => setInviting(true)}>Invite a user</Button>}>
                      <p class="muted">
                        {p().usersCount === 0
                          ? 'This partner has no users yet. Invite the first administrator so they can sign in.'
                          : 'Invite another person to this partner. They get the normal invitation email with a link to choose a password.'}
                      </p>
                    </Card>
                  </Show>
                </div>
              </div>

              <SettingsCard p={p()} onDone={onDone} onError={onError} />
              <SitesCard p={p()} onDone={onDone} onError={onError} />
              <AgreementsCard p={p()} onDone={onDone} onError={onError} />

              <Dialog
                open={confirm() !== null}
                title={confirm() === 'activate' ? `Activate ${p().name}?` : `Suspend ${p().name}?`}
                onClose={() => setConfirm(null)}
                footer={<><Button onClick={() => setConfirm(null)}>Cancel</Button><Button variant={confirm() === 'suspend' ? 'danger' : 'primary'} loading={state.isPending} onClick={() => { const c = confirm(); if (c) state.mutate(c); }}>{confirm() === 'activate' ? (waiting() ? 'Approve and activate' : 'Activate') : 'Suspend'}</Button></>}
              >
                <p>
                  {confirm() === 'activate'
                    ? waiting()
                      ? 'The company is approved. Its administrator gets an email with a link to sign in, and the company can send cases straight away.'
                      : 'The partner can send cases straight away.'
                    : 'The partner keeps read access to their cases but cannot upload or submit new ones until you activate them again.'}
                </p>
              </Dialog>

              <DeclineDialog
                open={declining()}
                partner={p()}
                onClose={() => setDeclining(false)}
                onDone={(text) => { setDeclining(false); qc.invalidateQueries({ queryKey: ['partners'] }); qc.invalidateQueries({ queryKey: ['console-overview'] }); nav('/console/partners?tab=declined', { replace: true, state: { notice: text } }); }}
              />
              <ChangeCodeDialog open={changingCode()} partner={p()} onClose={() => setChangingCode(false)} onDone={() => { setChangingCode(false); onDone('The code is changed.'); }} />
              <InviteUserDialog open={inviting()} partner={p()} onClose={() => setInviting(false)} onDone={(email) => { setInviting(false); onDone(`Invitation sent to ${email}.`); }} />
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}

// ---------------------------------------------------------------------------------------------------- registration

function RegistrationCard(props: { p: PartnerData; signup: SignupInfo }) {
  return (
    <Card title="Registration details">
      <p class="muted small">The registrant typed these details into the public form. K Line staff can see them here only.</p>
      <dl class="facts">
        <dt>Registered by</dt><dd>{props.signup.name || 'Not given'}</dd>
        <dt>Email address</dt><dd>{props.signup.email || 'Not given'} {props.signup.freeEmail ? <Badge tone="warn" title="A personal mailbox, not a company address">Personal mailbox</Badge> : null}</dd>
        <dt>Website</dt><dd>{props.signup.website || 'Not given'}</dd>
        <dt>Expected volume</dt><dd>{volumeLabel(props.signup.volume)}</dd>
        <dt>Registered on</dt><dd>{props.signup.at ? formatDate(props.signup.at) : 'Not known'}</dd>
        <dt>Email confirmed</dt><dd>{props.signup.confirmedAt ? formatDate(props.signup.confirmedAt) : <Badge tone="warn">Not yet</Badge>}</dd>
        <dt>Privacy notice</dt><dd>{props.signup.privacyVersion ? `Accepted, version ${props.signup.privacyVersion}` : 'Accepted'}</dd>
        {props.signup.approvedAt ? <><dt>Approved on</dt><dd>{formatDate(props.signup.approvedAt)}</dd></> : null}
        {props.p.declined && props.signup.declinedAt ? <><dt>Declined on</dt><dd>{formatDate(props.signup.declinedAt)}</dd></> : null}
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------- profile

const CONTACT_TITLES: Record<string, string> = { operations: 'Operations', quality: 'Quality', finance: 'Finance', it: 'IT' };

/** What the partner has filled in on their company profile page. */
function ProfileCard(props: { p: PartnerData }) {
  const addressLine = () => {
    const a = props.p.addressDetails;
    return a ? [a.street, [a.postalCode, a.city].filter(Boolean).join(' '), countryName(a.country)].filter(Boolean).join(', ') : '';
  };
  const contacts = () => Object.entries(props.p.contacts ?? {}).filter(([, c]) => c.name || c.email || c.phone);
  const [logoFailed, setLogoFailed] = createSignal(false);
  const ca = () => readCaseAddress(props.p.caseAddress);
  return (
    <Card title="Company profile">
      <p class="muted small">Filled in by the partner on their company profile page.</p>
      <dl class="facts">
        <dt>Address</dt><dd>{addressLine() || 'Not given'}</dd>
        <dt>Contacts</dt>
        <dd>
          <Show when={contacts().length > 0} fallback="Not given">
            <ul class="reason-list" style={{ margin: '0', 'padding-left': '0', 'list-style': 'none' }}>
              <For each={contacts()}>
                {([k, c]) => (
                  <li><strong>{CONTACT_TITLES[k] ?? k}:</strong> {[c.name, c.email, c.phone].filter(Boolean).join(', ')}</li>
                )}
              </For>
            </ul>
          </Show>
        </dd>
        <dt>Case address</dt>
        <dd>
          <Show when={ca()} fallback={<><Badge tone="warn">Not given</Badge> <span class="muted small">The partner cannot send direct manufacturing cases without it.</span></>}>
            {(a) => (
              <>
                <div>{[a().fullName, a().company].filter(Boolean).join(', ')}</div>
                <div>{caseAddressLine(a(), countryName)}</div>
                <div class="muted small">{[a().phone, a().email].filter(Boolean).join(', ')}</div>
                {props.p.caseAddressComplete === false ? <Badge tone="warn">Incomplete</Badge> : null}
              </>
            )}
          </Show>
        </dd>
        <dt>Case ID pattern</dt><dd>{props.p.caseIdRegex ? <span class="code-tag">{props.p.caseIdRegex}</span> : 'None'}</dd>
        <dt>Logo</dt>
        <dd>
          {props.p.hasLogo && !logoFailed() ? <span class="logo-box"><img src={`/api/partners/${props.p.id}/logo`} alt={`Logo of ${props.p.name}`} onError={() => setLogoFailed(true)} /></span> : <><Badge tone="warn">None</Badge> <span class="muted small">A company logo is required before K Line can approve the company.</span></>}
        </dd>
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------- gates

function GateRow(props: { state: 'ok' | 'missing' | 'soft'; title: string; children?: JSX.Element }) {
  const label = () => (props.state === 'ok' ? 'Done' : props.state === 'missing' ? 'Not done yet' : 'Not required now');
  return (
    <li>
      <Switch>
        <Match when={props.state === 'ok'}><CheckCircle2 class="gate-ok" size={20} aria-label={label()} /></Match>
        <Match when={props.state === 'missing'}><XCircle class="gate-no" size={20} aria-label={label()} /></Match>
        <Match when={props.state === 'soft'}><MinusCircle class="gate-soft" size={20} aria-label={label()} /></Match>
      </Switch>
      <div>
        <strong>{props.title}</strong>
        <Show when={props.children}><div class="muted small">{props.children}</div></Show>
      </div>
    </li>
  );
}

function GatesPanel(props: { p: PartnerData }) {
  const eea = () => isEea(props.p.country);
  const blocked = () => props.p.sites.filter((x) => !x.allowed);
  const qaa = () => props.p.gates.qaaOnFile ?? props.p.agreements.some((a) => a.kind === 'qaa' && inForce(a));
  const msa = () => props.p.gates.msaOnFile ?? props.p.agreements.some((a) => a.kind === 'msa' && inForce(a));
  const sccMissing = () => props.p.gates.sccMissing ?? (eea() && blocked().length > 0);
  const sccState = (): 'ok' | 'missing' | 'soft' => (sccMissing() ? 'missing' : props.p.gates.sccRequired && props.p.gates.sccOnFile ? 'ok' : !eea() ? 'soft' : props.p.gates.sccOnFile ? 'ok' : 'soft');
  return (
    <ul class="gate-list">
      <Show when={props.p.signup}>
        {(signup) => (
          <GateRow state={signup().confirmedAt ? 'ok' : 'missing'} title="Email address confirmed (needed to activate)">
            {signup().confirmedAt ? `Confirmed on ${formatDate(signup().confirmedAt)}.` : 'The registrant has to open the link in their email.'}
          </GateRow>
        )}
      </Show>
      <GateRow state={props.p.gates.dpaOnFile ? 'ok' : 'missing'} title="Data processing agreement on file (needed to activate)">
        {props.p.gates.dpaOnFile ? 'Uploads can be unlocked.' : 'Record the signed DPA under Agreements below. Uploads stay locked until this is done.'}
      </GateRow>
      <Show when={props.p.hasLogo !== undefined}>
        <GateRow state={props.p.hasLogo ? 'ok' : 'missing'} title="Company logo (needed to activate)">
          {props.p.hasLogo ? 'The logo is on file.' : 'Company logo is required. The partner adds it on their company profile page.'}
        </GateRow>
      </Show>
      <GateRow state={props.p.gates.hasSite ? 'ok' : 'missing'} title="At least one site allowed (needed to activate)">
        {props.p.gates.hasSite ? undefined : 'Choose the sites that may make this partner\'s cases.'}
      </GateRow>
      <GateRow state={sccState()} title="Standard contractual clauses (SCC)">
        {!eea()
          ? 'Not needed: this partner is outside the EEA.'
          : sccMissing()
            ? `Needed before cases can be made at ${blocked().length ? blocked().map((x) => x.code).join(', ') : 'sites outside the EEA'}. These sites are outside the EEA without an adequacy decision. It does not stop you activating the partner.`
            : props.p.gates.sccOnFile ? 'On file.' : 'Not needed for the current sites.'}
      </GateRow>
      <GateRow state={qaa() ? 'ok' : 'soft'} title="Quality assurance agreement (QAA)">{qaa() ? 'On file.' : 'Recommended. Not needed to activate.'}</GateRow>
      <GateRow state={msa() ? 'ok' : 'soft'} title="Master service agreement (MSA)">{msa() ? 'On file.' : 'Recommended. Not needed to activate.'}</GateRow>
    </ul>
  );
}

// --------------------------------------------------------------------------------------------------------- dialogs

function DeclineDialog(props: { open: boolean; partner: PartnerData; onClose: () => void; onDone: (text: string) => void }) {
  const [reason, setReason] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) { setReason(''); setError(null); } }));
  const confirmed = () => !!props.partner.signup?.confirmedAt;
  const m = createMutation(() => ({
    mutationFn: () => api<{ status: string; deleted?: boolean; deletesAt?: string | null }>(`/api/partners/${props.partner.id}/decline`, { method: 'POST', body: reason().trim() ? { reason: reason().trim() } : {} }),
    onSuccess: (r: { status: string; deleted?: boolean; deletesAt?: string | null }) => props.onDone(r?.deleted ? 'The registration is deleted.' : `The registration is declined.${r?.deletesAt ? ` It is deleted on ${formatDate(r.deletesAt)}.` : ''}`),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog open={props.open} title={`Decline ${props.partner.name}?`} onClose={props.onClose} wide>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <Show
          when={confirmed()}
          fallback={
            <Notice tone="warn" title="This registration is deleted at once">
              The registrant never confirmed their email address. The company, the user, their tokens and the draft specification are deleted straight away. This cannot be undone. Only the code and a note in the audit log remain.
            </Notice>
          }
        >
          <div class="stack-sm">
            <p><strong>What happens next</strong></p>
            <ul class="reason-list">
              <li>The registrant gets a short email saying the registration was not approved.</li>
              <li>Their access ends now and they are signed out.</li>
              <li>You can still see the registration under Declined for 30 days.</li>
              <li>After 30 days the company, the user and all registration details are deleted.</li>
            </ul>
          </div>
        </Show>
        <Field label="Reason (optional)" hint="For your team only. It is stored internally and is not sent to the registrant.">
          {(f) => <textarea {...f} rows={3} maxLength={500} value={reason()} onInput={(e) => setReason(e.currentTarget.value)} />}
        </Field>
        <IfMfa><p class="small muted">You will be asked for your authenticator code.</p></IfMfa>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={m.isPending}>{confirmed() ? 'Decline registration' : 'Decline and delete'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ChangeCodeDialog(props: { open: boolean; partner: PartnerData; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  createEffect(() => { if (props.open) { setCode(props.partner.code); setError(null); } });
  const problem = () => (code() && code() !== props.partner.code ? codeProblem(code()) : null);
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/partners/${props.partner.id}/code`, { method: 'PATCH', body: { code: code() } }),
    onSuccess: () => props.onDone(),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog open={props.open} title="Change the code" onClose={props.onClose}>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <p class="muted">The code starts every case reference for this partner. You can change it only while the partner has no cases.</p>
        <Field label="Code" hint="2 to 8 capital letters or digits." error={problem()}>
          {(f) => <input {...f} class="mono" value={code()} maxLength={8} required autofocus autocomplete="off" onInput={(e) => setCode(e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />}
        </Field>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!code() || code() === props.partner.code || !!problem()}>Change code</Button>
        </div>
      </form>
    </Dialog>
  );
}

function InviteUserDialog(props: { open: boolean; partner: PartnerData; onClose: () => void; onDone: (email: string) => void }) {
  const [name, setName] = createSignal('');
  const [email, setEmail] = createSignal('');
  const [roles, setRoles] = createSignal<string[]>(['admin']);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(() => { if (props.open) { setName(''); setEmail(''); setRoles(props.partner.usersCount === 0 ? ['admin'] : ['uploader']); setError(null); } });
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/partners/${props.partner.id}/users/invite`, { method: 'POST', body: { email: email().trim(), name: name().trim(), roles: roles() } }),
    onSuccess: () => props.onDone(email().trim()),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog open={props.open} title={`Invite a user to ${props.partner.name}`} onClose={props.onClose}>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <Field label="Full name">{(f) => <input {...f} value={name()} onInput={(e) => setName(e.currentTarget.value)} required maxLength={120} autocomplete="off" />}</Field>
        <Field label="Email address" hint="We send them a link to choose a password.">{(f) => <input {...f} type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} required autocomplete="off" />}</Field>
        <RolePicker value={roles()} onChange={(v) => setRoles(v)} />
        <IfMfa><p class="small muted">You will be asked for your authenticator code.</p></IfMfa>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!email() || !name() || roles().length === 0}>Send invitation</Button>
        </div>
      </form>
    </Dialog>
  );
}

interface CardProps { p: PartnerData; onDone: (t: string) => void; onError: (t: string) => void }

function SettingsCard(props: CardProps) {
  const [retention, setRetention] = createSignal(String(props.p.retentionMonths));
  const [sla, setSla] = createSignal(String(props.p.settings.slaDays));
  const [requirePts, setRequirePts] = createSignal(props.p.settings.requirePts);
  const [manual, setManual] = createSignal(props.p.settings.manualReview);
  createEffect(() => {
    const p = props.p;
    setRetention(String(p.retentionMonths)); setSla(String(p.settings.slaDays)); setRequirePts(p.settings.requirePts); setManual(p.settings.manualReview);
  });
  const r = () => Number(retention());
  const sd = () => Number(sla());
  const valid = () => Number.isInteger(r()) && r() >= 1 && r() <= 180 && Number.isInteger(sd()) && sd() >= 1 && sd() <= 30;
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/partners/${props.p.id}/settings`, { method: 'PATCH', body: { retentionMonths: r(), slaDays: sd(), requirePts: requirePts(), manualReview: manual() } }),
    onSuccess: () => props.onDone('Settings saved.'),
    onError: (e: unknown) => props.onError(errorText(e)),
  }));
  return (
    <Card title="Settings">
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} class="stack">
        <div class="form-grid">
          <Field label="Keep files after shipping (months)" hint="Between 1 and 180. Files and patient names are removed after this time.">
            {(f) => <input {...f} type="number" min={1} max={180} value={retention()} onInput={(e) => setRetention(e.currentTarget.value)} required />}
          </Field>
          <Field label="Days to ship (business days)" hint="Counted from when the case is ready. Sets the due date.">
            {(f) => <input {...f} type="number" min={1} max={30} value={sla()} onInput={(e) => setSla(e.currentTarget.value)} required />}
          </Field>
        </div>
        <Toggle checked={requirePts()} onChange={(v) => setRequirePts(v)} label="Require a trim line for every aligner" hint="Without one the partner gets a warning to confirm." />
        <Toggle checked={manual()} onChange={(v) => setManual(v)} label="Review every case before it goes to a site" hint="Cases wait in the intake queue until staff send them on." />
        <div><Button type="submit" variant="primary" loading={m.isPending} disabled={!valid()}>Save settings</Button></div>
      </form>
    </Card>
  );
}

function SitesCard(props: CardProps) {
  const all = useSites();
  const gate = createMemo(() => new Map(props.p.sites.map((s) => [s.code, s])));
  const [codes, setCodes] = createSignal<string[]>(props.p.sites.map((s) => s.code));
  const [def, setDef] = createSignal(props.p.defaultSiteCode ?? '');
  createEffect(() => { setCodes(props.p.sites.map((s) => s.code)); setDef(props.p.defaultSiteCode ?? ''); });
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/partners/${props.p.id}/sites`, { method: 'PUT', body: { siteCodes: codes(), defaultSiteCode: def() && codes().includes(def()) ? def() : null } }),
    onSuccess: () => props.onDone('Sites saved.'),
    onError: (e: unknown) => props.onError(errorText(e)),
  }));
  const list = () => all.data?.sites ?? [];
  return (
    <Card title="Sites">
      <Show when={all.isLoading}><Spinner /></Show>
      <Show when={all.isError}><Notice tone="bad">{errorText(all.error)}</Notice></Show>
      <Show when={list().length}>
        <div class="stack">
          <fieldset class="check-group">
            <legend>Sites where this partner's cases may be made</legend>
            <For each={list()}>
              {(s) => (
                <div class="check">
                  <input id={`ps-${s.code}`} type="checkbox" checked={codes().includes(s.code)} onChange={(e) => setCodes(e.currentTarget.checked ? [...codes(), s.code] : codes().filter((x) => x !== s.code))} />
                  <label for={`ps-${s.code}`}>{s.code}, {s.name} {!s.active ? <Badge tone="bad">Inactive</Badge> : null}</label>
                  <p class="hint">{s.country}{s.inEea ? ', EEA' : s.hasAdequacy ? ', adequacy decision' : ', needs SCC for EEA partners'}{gate().get(s.code)?.allowed === false ? `. Blocked for this partner: ${gate().get(s.code)?.reason ?? 'transfer gate'}` : ''}</p>
                </div>
              )}
            </For>
          </fieldset>
          <Field label="Default site" hint="Used when the case does not need a manual review.">
            {(f) => (
              <select {...f} value={def()} onChange={(e) => setDef(e.currentTarget.value)}>
                <option value="" selected={def() === ''}>None</option>
                <For each={codes()}>{(c) => <option value={c} selected={c === def()}>{c}</option>}</For>
              </select>
            )}
          </Field>
          <div><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Save sites</Button></div>
        </div>
      </Show>
    </Card>
  );
}

function AgreementsCard(props: CardProps) {
  const [adding, setAdding] = createSignal(false);
  const [removing, setRemoving] = createSignal<Agreement | null>(null);
  const del = createMutation(() => ({
    mutationFn: (a: Agreement) => api(`/api/partners/${props.p.id}/agreements/${a.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoving(null); props.onDone('Agreement removed.'); },
    onError: (e: unknown) => { setRemoving(null); props.onError(errorText(e)); },
  }));
  return (
    <Card title="Agreements" actions={<Button size="sm" variant="primary" onClick={() => setAdding(true)}>Add an agreement</Button>}>
      <Show
        when={!(props.p.agreements.filter((a) => !a.revoked).length === 0 && props.p.agreements.length === 0)}
        fallback={<Empty title="No agreements recorded">Record the signed DPA here to unlock uploads.</Empty>}
      >
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Agreement</th><th>Signed</th><th>Expires</th><th>Reference</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              <For each={props.p.agreements}>
                {(a) => (
                  <tr>
                    <td><strong>{kindLabel(a.kind)}</strong> {a.revoked ? <Badge tone="neutral">Removed</Badge> : null}{a.notes ? <div class="muted small">{a.notes}</div> : null}</td>
                    <td class="nowrap">{a.signedAt ? formatDate(a.signedAt) : 'Not set'}</td>
                    <td class="nowrap">{a.expiresAt ? formatDate(a.expiresAt) : 'No end date'}</td>
                    <td>{a.reference ?? ''}</td>
                    <td class="right">{a.revoked ? null : <Button size="sm" onClick={() => setRemoving(a)} aria-label={`Remove the ${kindLabel(a.kind)}`}>Remove</Button>}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
      <AddAgreement partnerId={props.p.id} open={adding()} onClose={() => setAdding(false)} onDone={() => { setAdding(false); props.onDone('Agreement recorded.'); }} />
      <Dialog
        open={!!removing()}
        title="Remove this agreement?"
        onClose={() => setRemoving(null)}
        footer={<><Button onClick={() => setRemoving(null)}>Keep it</Button><Button variant="danger" loading={del.isPending} onClick={() => { const a = removing(); if (a) del.mutate(a); }}>Remove</Button></>}
      >
        <p>{removing() ? kindLabel(removing()!.kind) : ''}. If this is the only one of its kind, uploads or transfers that depend on it stop working. The record stays in the audit log.<IfMfa> You will be asked for your authenticator code.</IfMfa></p>
      </Dialog>
    </Card>
  );
}

function AddAgreement(props: { partnerId: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = createSignal('dpa');
  const [signedAt, setSignedAt] = createSignal('');
  const [expiresAt, setExpiresAt] = createSignal('');
  const [reference, setReference] = createSignal('');
  const [notes, setNotes] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  createEffect(on(() => props.open, (open) => { if (open) { setKind('dpa'); setSignedAt(''); setExpiresAt(''); setReference(''); setNotes(''); setError(null); } }));
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/partners/${props.partnerId}/agreements`, {
      method: 'POST',
      body: { kind: kind(), signedAt: signedAt(), ...(expiresAt() ? { expiresAt: expiresAt() } : {}), ...(reference().trim() ? { reference: reference().trim() } : {}), ...(notes().trim() ? { notes: notes().trim() } : {}) },
    }),
    onSuccess: () => props.onDone(),
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog open={props.open} title="Add an agreement" onClose={props.onClose}>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <Field label="Kind">
          {(f) => (
            <select {...f} value={kind()} onChange={(e) => setKind(e.currentTarget.value)}>
              <For each={AGREEMENT_KINDS}>{(k) => <option value={k.id} selected={k.id === kind()}>{k.label}</option>}</For>
            </select>
          )}
        </Field>
        <div class="form-grid">
          <Field label="Signed on">{(f) => <input {...f} type="date" value={signedAt()} onInput={(e) => setSignedAt(e.currentTarget.value)} required />}</Field>
          <Field label="Expires on (optional)">{(f) => <input {...f} type="date" value={expiresAt()} min={signedAt() || undefined} onInput={(e) => setExpiresAt(e.currentTarget.value)} />}</Field>
        </div>
        <Field label="Reference (optional)" hint="Contract number or document name.">{(f) => <input {...f} value={reference()} maxLength={120} onInput={(e) => setReference(e.currentTarget.value)} />}</Field>
        <Field label="Notes (optional)">{(f) => <textarea {...f} rows={3} value={notes()} maxLength={500} onInput={(e) => setNotes(e.currentTarget.value)} />}</Field>
        <IfMfa><p class="small muted">You will be asked for your authenticator code.</p></IfMfa>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!signedAt()}>Record agreement</Button>
        </div>
      </form>
    </Dialog>
  );
}
