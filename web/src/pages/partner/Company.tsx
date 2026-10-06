import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, ImagePlus, Trash2, XCircle } from 'lucide-react';
import { api, ApiError, errorText } from '../../lib/api';
import { MENU_KEYS, type MenuKey, type MenuSetting } from '@shared/menu';
import { useAuth } from '../../lib/auth';
import { MAX_PATTERN_LENGTH, MAX_SAMPLE_LENGTH, readPattern, testSamples } from '../../lib/caseId';
import { CASE_ADDRESS_FIELDS, CASE_ADDRESS_INTRO, caseAddressBody, emptyCaseAddress, serverCaseAddressProblems, validateCaseAddress, type CaseAddress, type CaseAddressField, type CaseAddressProblems } from '../../lib/caseAddress';
import { formatBytes, formatDate, formatNumber } from '../../lib/format';
import { LOGO_RULES, checkLogoFile, type LogoCheck } from '../../lib/logoCheck';
import {
  CONTACT_KEYS, CONTACT_LABEL, DOCUMENT_KINDS, agreementLabel, documentKindLabel, isNotApproved, normalizeAgreements, normalizeBrands, normalizeDocuments,
  normalizeProfile, normalizeSites, profileBody, useOrgLogo, USER_CASE_ADDRESS_KEY, type Brand, type OrgDocument, type Profile,
} from '../../lib/orgApi';
import { COUNTRIES, countryName } from '../../lib/signup';
import { blobSource } from '../../lib/source';
import { uploadCaseFiles, type FileStatus, type UploadSpec } from '../../lib/upload';
import { AttachmentPicker, uploadPending, usePending } from '../../ui/Attachments';
import { Badge, Button, Card, Dialog, Empty, Field, Notice, PageHeader, Spinner, Toggle } from '../../ui/Common';
import { CaseAddressFields } from '../../ui/CaseAddressFields';
import { LockedNotice } from '../../ui/Locked';
import { OrgLogoImage } from '../../ui/OrgLogo';

const LOGO_EXTS = ['png', 'jpg', 'jpeg', 'svg'];
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const DOC_EXTS = ['pdf', 'jpg', 'jpeg', 'png'];
const MAX_DOC_BYTES = 50 * 1024 * 1024;
const PROFILE_FILE_LIMIT = 10;

type Msg = { tone: 'good' | 'bad'; text: string } | null;

function fieldMessages(e: unknown): string[] {
  if (!(e instanceof ApiError) || !Array.isArray(e.extra.fields)) return [];
  return (e.extra.fields as { message?: string }[]).map((f) => f.message ?? '').filter(Boolean).slice(0, 5);
}

function Feedback({ msg }: { msg: Msg }) {
  return msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null;
}

function extOf(name: string): string { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); }

export default function Company() {
  const { me, can } = useAuth();
  const canEdit = can('org.edit');
  const canLogo = can('org.logo');
  const onboarding = me?.org?.status === 'onboarding';
  const q = useQuery({ queryKey: ['org-profile'], queryFn: async () => normalizeProfile(await api('/api/org/profile')) });
  const loc = useLocation();
  const logoState = useOrgLogo(true);

  // The links "#logo" and "#case-address" scroll to their card once the page has loaded.
  useEffect(() => {
    if (!q.data || (loc.hash !== '#logo' && loc.hash !== '#case-address')) return;
    const el = document.getElementById(loc.hash.slice(1));
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  }, [loc.hash, q.data, logoState.hasLogo]); // the logo banner can appear after the profile, so scroll again then

  return (
    <div className="page">
      <PageHeader title="Company profile" subtitle="The details K Line uses for agreements, shipping and quality. Keep them up to date." />
      {onboarding ? (
        <Notice tone="info" title="Your company is waiting for K Line to approve it" action={<Link className="btn btn-sm" to="/portal#getting-started">Getting started</Link>}>
          You can finish your profile now. Sending cases, inviting people and sending materials unlock after approval.
        </Notice>
      ) : null}
      {!canEdit ? (
        <Notice tone="info">
          {canLogo
            ? 'You can change the company logo. Ask an administrator in your company to change anything else on this page.'
            : 'You can look at this page but not change it. Ask an administrator in your company to make changes.'}
        </Notice>
      ) : null}
      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
      {q.data ? (
        <>
          <DetailsCard profile={q.data} canEdit={canEdit} />
          <div id="case-address" tabIndex={-1} className="anchor"><CaseAddressCard profile={q.data} canEdit={canEdit} /></div>
          <div id="logo" tabIndex={-1} className="anchor"><LogoCard profile={q.data} canEdit={canLogo} onboarding={onboarding} /></div>
          <ContactsCard profile={q.data} canEdit={canEdit} />
          <CaseIdCard profile={q.data} canEdit={canEdit} />
          {canEdit ? <MenuCard /> : null}
          <BrandsCard profile={q.data} canEdit={canEdit} onboarding={onboarding} />
          <DocumentsCard profile={q.data} canEdit={canEdit} onboarding={onboarding} />
          <AgreementsCard />
          <SitesCard />
        </>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------ saving profile

function useSaveProfile(base: Profile, onDone: (m: Msg) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Profile>) => api('/api/org/profile', { method: 'PUT', body: profileBody({ ...base, ...patch }) }),
    onSuccess: () => {
      onDone({ tone: 'good', text: 'Saved.' });
      qc.invalidateQueries({ queryKey: ['org-profile'] });
      qc.invalidateQueries({ queryKey: ['org'] });
      qc.invalidateQueries({ queryKey: ['onboarding'] });
    },
    onError: (e) => {
      const extra = fieldMessages(e);
      onDone({ tone: 'bad', text: extra.length ? `${errorText(e)} ${extra.join(' ')}` : errorText(e) });
    },
  });
}

// ---------------------------------------------------------------------------------------------------------- details

function DetailsCard({ profile, canEdit }: { profile: Profile; canEdit: boolean }) {
  const [msg, setMsg] = useState<Msg>(null);
  const [name, setName] = useState(profile.name);
  const [legalName, setLegalName] = useState(profile.legalName);
  const [country, setCountry] = useState(profile.country);
  const [vatId, setVatId] = useState(profile.vatId);
  const [street, setStreet] = useState(profile.address.street);
  const [city, setCity] = useState(profile.address.city);
  const [postalCode, setPostalCode] = useState(profile.address.postalCode);
  const [addrCountry, setAddrCountry] = useState(profile.address.country || profile.country);
  useEffect(() => {
    setName(profile.name); setLegalName(profile.legalName); setCountry(profile.country); setVatId(profile.vatId);
    setStreet(profile.address.street); setCity(profile.address.city); setPostalCode(profile.address.postalCode); setAddrCountry(profile.address.country || profile.country);
  }, [profile]);
  const save = useSaveProfile(profile, setMsg);
  function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    save.mutate({ name, legalName, country, vatId, address: { street, city, postalCode, country: addrCountry } });
  }
  return (
    <Card title="Company details">
      <form onSubmit={submit} className="stack">
        <Feedback msg={msg} />
        <fieldset className="plain-fieldset stack" disabled={!canEdit}>
          <div className="form-grid">
            <Field label="Company name" hint="The name your team sees in the Hub.">{(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />}</Field>
            <Field label="Legal name" hint="As it appears in your contracts.">{(p) => <input {...p} value={legalName} onChange={(e) => setLegalName(e.target.value)} maxLength={160} autoComplete="organization" />}</Field>
            <Field label="Country" hint={profile.countryLocked ? 'Only K Line can change this after approval, because it decides where your cases may be made.' : undefined}>
              {(p) => (
                <select {...p} value={country} onChange={(e) => setCountry(e.target.value)} disabled={profile.countryLocked}>
                  <option value="">Choose a country</option>
                  {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </select>
              )}
            </Field>
            <Field label="VAT ID" hint={profile.vatRequired ? 'Needed for companies in the EU.' : 'If you have one.'}>{(p) => <input {...p} value={vatId} onChange={(e) => setVatId(e.target.value)} maxLength={24} autoComplete="off" />}</Field>
          </div>
          <div className="form-grid">
            <Field label="Street and number">{(p) => <input {...p} value={street} onChange={(e) => setStreet(e.target.value)} maxLength={160} autoComplete="street-address" />}</Field>
            <Field label="Postcode">{(p) => <input {...p} value={postalCode} onChange={(e) => setPostalCode(e.target.value)} maxLength={20} autoComplete="postal-code" />}</Field>
            <Field label="City">{(p) => <input {...p} value={city} onChange={(e) => setCity(e.target.value)} maxLength={100} autoComplete="address-level2" />}</Field>
            <Field label="Address country">
              {(p) => (
                <select {...p} value={addrCountry} onChange={(e) => setAddrCountry(e.target.value)} autoComplete="country">
                  <option value="">Choose a country</option>
                  {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </select>
              )}
            </Field>
          </div>
        </fieldset>
        {canEdit ? <div><Button type="submit" variant="primary" loading={save.isPending}>Save details</Button></div> : null}
      </form>
    </Card>
  );
}

// --------------------------------------------------------------------------------------------------------- contacts

function ContactsCard({ profile, canEdit }: { profile: Profile; canEdit: boolean }) {
  const [msg, setMsg] = useState<Msg>(null);
  const [contacts, setContacts] = useState(profile.contacts);
  useEffect(() => setContacts(profile.contacts), [profile]);
  const save = useSaveProfile(profile, setMsg);
  const set = (k: (typeof CONTACT_KEYS)[number], f: 'name' | 'email' | 'phone', v: string) => setContacts((c) => ({ ...c, [k]: { ...c[k], [f]: v } }));
  function submit(e: FormEvent) { e.preventDefault(); setMsg(null); save.mutate({ contacts }); }
  return (
    <Card title="Contacts" >
      <form onSubmit={submit} className="stack">
        <p className="muted">Tell us who to talk to about each topic. Add at least one contact.</p>
        <Feedback msg={msg} />
        <fieldset className="plain-fieldset stack-lg" disabled={!canEdit}>
          {CONTACT_KEYS.map((k) => (
            <fieldset key={k} className="plain-fieldset stack-sm">
              <legend className="label">{CONTACT_LABEL[k]}</legend>
              <div className="form-grid">
                <Field label={`${CONTACT_LABEL[k]} contact name`}>{(p) => <input {...p} value={contacts[k].name} onChange={(e) => set(k, 'name', e.target.value)} maxLength={120} autoComplete="off" />}</Field>
                <Field label={`${CONTACT_LABEL[k]} email`}>{(p) => <input {...p} type="email" value={contacts[k].email} onChange={(e) => set(k, 'email', e.target.value)} maxLength={200} autoComplete="off" />}</Field>
                <Field label={`${CONTACT_LABEL[k]} phone`}>{(p) => <input {...p} type="tel" value={contacts[k].phone} onChange={(e) => set(k, 'phone', e.target.value)} maxLength={40} autoComplete="off" />}</Field>
              </div>
            </fieldset>
          ))}
        </fieldset>
        {canEdit ? <div><Button type="submit" variant="primary" loading={save.isPending}>Save contacts</Button></div> : null}
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ case ID pattern

const EXAMPLE_IDS = 'ABC-12345\n55813\nCase 7\nabc_001';

function CaseIdCard({ profile, canEdit }: { profile: Profile; canEdit: boolean }) {
  const [msg, setMsg] = useState<Msg>(null);
  const [pattern, setPattern] = useState(profile.settings.caseIdRegex);
  const [requirePts, setRequirePts] = useState(profile.settings.requirePts);
  const [samples, setSamples] = useState(EXAMPLE_IDS);
  useEffect(() => { setPattern(profile.settings.caseIdRegex); setRequirePts(profile.settings.requirePts); }, [profile]);
  const save = useSaveProfile(profile, setMsg);
  const state = useMemo(() => readPattern(pattern), [pattern]);
  const results = useMemo(() => {
    if (!state.ok || !state.regex) return [];
    return testSamples(state.regex, samples.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30));
  }, [state, samples]);
  function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!state.ok) return;
    save.mutate({ settings: { caseIdRegex: pattern.trim(), requirePts } });
  }
  return (
    <Card title="Case IDs and trim lines">
      <form onSubmit={submit} className="stack">
        <Feedback msg={msg} />
        <fieldset className="plain-fieldset stack" disabled={!canEdit}>
          <Field
            label="Case ID pattern (optional)"
            hint={`A pattern that your case IDs should follow, for example ^[A-Z]{3}-[0-9]{5}$. Start with ^ and end with $ to match the whole ID. Leave it empty to accept any ID. At most ${MAX_PATTERN_LENGTH} characters.`}
            error={!state.ok ? state.message : null}
          >
            {(p) => <input {...p} className="mono" value={pattern} onChange={(e) => setPattern(e.target.value)} maxLength={MAX_PATTERN_LENGTH} spellCheck={false} autoComplete="off" />}
          </Field>
          <Toggle checked={requirePts} onChange={setRequirePts} label="Ask for a trim line for every aligner" hint="Without one you get a warning to confirm before you submit." />
        </fieldset>

        <div className="stack-sm">
          <Field label="Try it out" hint={`Type or paste case IDs, one on each line. Nothing is sent anywhere. Each ID can have at most ${MAX_SAMPLE_LENGTH} characters.`}>
            {(p) => <textarea {...p} className="textarea-mono" rows={4} value={samples} onChange={(e) => setSamples(e.target.value)} spellCheck={false} />}
          </Field>
          {state.ok && !state.regex ? <p className="muted small">There is no pattern, so every ID is accepted.</p> : null}
          {results.length ? (
            <ul className="attach-list" aria-label="Test results">
              {results.map((r, i) => (
                <li key={`${i}-${r.text}`} className="attach-item">
                  {r.match ? <CheckCircle2 size={18} className="ok-icon" aria-hidden="true" /> : <XCircle size={18} className="bad-icon" aria-hidden="true" />}
                  <span className="attach-meta"><span className="mono attach-name">{r.text}</span></span>
                  <Badge tone={r.match ? 'good' : 'bad'}>{r.match ? 'Matches' : r.tooLong ? 'Too long' : 'Does not match'}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {canEdit ? <div><Button type="submit" variant="primary" loading={save.isPending} disabled={!state.ok}>Save</Button></div> : null}
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------------------- menu

const MENU_CHOICES: { key: MenuKey; label: string; hint: string }[] = [
  { key: 'claims', label: 'Show Quality claims to everyone in the company', hint: 'The Quality claims page, the Report an issue button on cases and the claims listed on a case.' },
  { key: 'spec', label: 'Show Production spec to everyone in the company', hint: 'The Production spec page and the links to it.' },
  { key: 'materials', label: 'Show Materials to everyone in the company', hint: 'The Materials page.' },
];

/** Which optional menu items the rest of the company sees. Visibility only: the server's permissions do not change. */
function MenuCard() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<Msg>(null);
  const q = useQuery({ queryKey: ['org-menu'], queryFn: () => api<MenuSetting>('/api/org/menu') });
  const [on, setOn] = useState<Record<MenuKey, boolean>>({ claims: false, spec: false, materials: false });
  useEffect(() => {
    if (q.data) setOn({ claims: q.data.claims === 'everyone', spec: q.data.spec === 'everyone', materials: q.data.materials === 'everyone' });
  }, [q.data]);
  const dirty = !!q.data && MENU_KEYS.some((k) => (q.data[k] === 'everyone') !== on[k]);
  const save = useMutation({
    mutationFn: () => api<MenuSetting>('/api/org/menu', { method: 'PUT', body: { claims: on.claims ? 'everyone' : 'admins', spec: on.spec ? 'everyone' : 'admins', materials: on.materials ? 'everyone' : 'admins' } }),
    onSuccess: (r) => {
      qc.setQueryData(['org-menu'], r);
      qc.invalidateQueries({ queryKey: ['org'] });
      setMsg({ tone: 'good', text: 'Saved. The menu has been updated.' });
    },
    onError: (e) => setMsg({ tone: 'bad', text: errorText(e) }),
  });
  return (
    <Card title="Menu">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setMsg(null); save.mutate(); }}>
        <p className="muted">Choose which optional menu items the other people in your company see. They are hidden from everyone except administrators until you switch them on.</p>
        <Feedback msg={msg} />
        {q.isLoading ? <Spinner /> : null}
        {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
        {q.data ? (
          <fieldset className="plain-fieldset stack">
            {MENU_CHOICES.map((m) => (
              <Toggle key={m.key} checked={on[m.key]} onChange={(v) => { setMsg(null); setOn((p) => ({ ...p, [m.key]: v })); }} label={m.label} hint={m.hint} />
            ))}
          </fieldset>
        ) : null}
        <p className="small muted">Admins always see these. This only changes what the menu shows. What each person can do still depends on their role.</p>
        {q.data ? <div><Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>Save</Button></div> : null}
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------------ case address

const caseFieldName = (f: CaseAddressField) => `case${f.charAt(0).toUpperCase()}${f.slice(1)}`;

/** What the form starts with. Without a saved address we offer the company address as a starting point. */
function initialCaseAddress(profile: Profile): CaseAddress {
  if (profile.caseAddress) return { ...emptyCaseAddress(), ...profile.caseAddress };
  return {
    ...emptyCaseAddress(),
    company: profile.legalName || profile.name,
    street: profile.address.street, city: profile.address.city, postalCode: profile.address.postalCode,
    country: profile.address.country || profile.country,
  };
}

function CaseAddressCard({ profile, canEdit }: { profile: Profile; canEdit: boolean }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<Msg>(null);
  const [value, setValue] = useState<CaseAddress>(() => initialCaseAddress(profile));
  const [errors, setErrors] = useState<CaseAddressProblems>({});
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { setValue(initialCaseAddress(profile)); setErrors({}); }, [profile]);

  const save = useMutation({
    mutationFn: (a: CaseAddress) => api('/api/org/profile', { method: 'PUT', body: { caseAddress: caseAddressBody(a) } }),
    onSuccess: () => {
      setMsg({ tone: 'good', text: 'Your case address is saved.' });
      qc.invalidateQueries({ queryKey: ['org-profile'] });
      qc.invalidateQueries({ queryKey: ['onboarding'] });
      qc.invalidateQueries({ queryKey: USER_CASE_ADDRESS_KEY });
    },
    onError: (e) => {
      const fields = e instanceof ApiError && Array.isArray(e.extra.fields) ? (e.extra.fields as { path: string; message: string }[]) : [];
      const next = serverCaseAddressProblems(fields);
      setErrors(next);
      setMsg({ tone: 'bad', text: Object.keys(next).length ? 'Please check the highlighted fields.' : errorText(e) });
    },
  });

  function submit(ev: FormEvent) {
    ev.preventDefault();
    setMsg(null);
    const p = validateCaseAddress(value);
    setErrors(p);
    const first = CASE_ADDRESS_FIELDS.find((f) => p[f]);
    if (first) { form.current?.querySelector<HTMLElement>(`[name="${caseFieldName(first)}"]`)?.focus(); return; }
    save.mutate(value);
  }

  const complete = profile.caseAddressComplete;
  return (
    <Card title="Company case address" actions={complete === undefined ? undefined : <Badge tone={complete ? 'good' : 'warn'}>{complete ? 'Complete' : 'Needed'}</Badge>}>
      <form ref={form} onSubmit={submit} className="stack" noValidate>
        <p className="muted">{CASE_ADDRESS_INTRO} It goes on the label of every case you send with Direct manufacturing, so the carrier knows who receives it. A case that has already been sent keeps the address it was sent with.</p>
        <p className="muted">This is the default for your company. It is used when a person has no case address of their own. Everyone can add their own in <Link to="/portal/account#case-address">Account</Link>.</p>
        {complete === false ? (
          <Notice tone="warn" title="Add your case address">
            Direct manufacturing stays blocked until you save a complete case address.{!profile.caseAddress ? ' We started with your company address. Check it, add the missing details and save.' : ''}
          </Notice>
        ) : null}
        <Feedback msg={msg} />
        <fieldset className="plain-fieldset stack" disabled={!canEdit}>
          <legend className="sr-only">Company case address</legend>
          <CaseAddressFields value={value} errors={errors} onChange={(f, v) => setValue((a) => ({ ...a, [f]: v }))} fields={CASE_ADDRESS_FIELDS} />
        </fieldset>
        {canEdit ? <div><Button type="submit" variant="primary" loading={save.isPending}>Save case address</Button></div> : null}
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------------------- logo

function BarPreview({ name, src, version, phone, empty }: { name: string; src?: string; version?: string; phone?: boolean; empty?: boolean }) {
  return (
    <div className={`bar-preview${phone ? ' bar-preview-phone' : ''}`}>
      {empty ? <span className="muted small">No logo yet</span> : <OrgLogoImage name={name} src={src} version={version} />}
      <span className="topbar-title">{name}</span>
    </div>
  );
}

interface Staged { file: File; check: Extract<LogoCheck, { ok: true }>; url: string }

function LogoCard({ profile, canEdit, onboarding }: { profile: Profile; canEdit: boolean; onboarding: boolean }) {
  const qc = useQueryClient();
  const logo = useOrgLogo(true);
  const [msg, setMsg] = useState<Msg>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bust, setBust] = useState(0);
  const [removing, setRemoving] = useState(false);
  const [locked, setLocked] = useState(false);
  const hasLogo = logo.hasLogo ?? profile.hasLogo;
  const name = profile.name || 'Your company';

  useEffect(() => () => { if (staged) URL.revokeObjectURL(staged.url); }, [staged]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['org'] });
    qc.invalidateQueries({ queryKey: ['org-profile'] });
    qc.invalidateQueries({ queryKey: ['onboarding'] });
  };

  async function choose(file: File) {
    setMsg(null);
    setProblem(null);
    setChecking(true);
    try {
      const r = await checkLogoFile(file);
      if (!r.ok) { setStaged(null); setProblem(r.message); return; }
      setStaged({ file, check: r, url: URL.createObjectURL(file) });
    } finally {
      setChecking(false);
    }
  }

  async function saveStaged() {
    if (!staged) return;
    setBusy(true);
    setMsg(null);
    try {
      const fileId = await uploadLogoFile(staged.file);
      await api('/api/org/logo', { method: 'POST', body: { fileId } });
      setStaged(null);
      setBust(Date.now());
      refresh();
      setMsg({ tone: 'good', text: 'Your logo is saved. It now shows in the top bar for everyone in your company.' });
    } catch (e) {
      if (isNotApproved(e)) setLocked(true);
      setMsg({ tone: 'bad', text: e instanceof ApiError ? errorText(e) : (e as Error).message || 'The logo could not be saved.' });
    } finally {
      setBusy(false);
    }
  }

  const remove = useMutation({
    mutationFn: () => api('/api/org/logo', { method: 'DELETE' }),
    onSuccess: () => { setRemoving(false); setStaged(null); setBust(Date.now()); refresh(); setMsg({ tone: 'good', text: 'The logo is removed. Please add a new one, because a logo is required.' }); },
    onError: (e) => { setRemoving(false); setMsg({ tone: 'bad', text: errorText(e) }); },
  });

  const version = `${logo.version}-${bust}`;
  return (
    <Card title={<>Company logo {hasLogo === undefined ? null : <Badge tone={hasLogo ? 'good' : 'warn'}>{hasLogo ? 'Added' : 'Required'}</Badge>}</>}>
      <div className="stack">
        <p className="muted">Your logo is required. It shows in the top bar for everyone in your company, so your team and K Line can recognise your account. Every team member except viewers can change it, and the access log records who did.</p>
        {profileFilesNote(profile, onboarding)}
        <Feedback msg={msg} />
        {locked ? <LockedNotice what="add more files" /> : null}

        <div className="logo-grid">
          <section className="logo-rules" aria-labelledby="logo-rules-title">
            <h3 id="logo-rules-title">What makes a good logo</h3>
            <ul>
              <li><strong>Format.</strong> PNG is best, with a transparent background. SVG and JPG also work.</li>
              <li><strong>Size in pixels.</strong> We recommend {LOGO_RULES.recommendedWidth} x {LOGO_RULES.recommendedHeight} pixels, wider than tall (about 3 to 1), so it stays sharp on high resolution screens. The smallest we accept is {LOGO_RULES.minWidth} x {LOGO_RULES.minHeight} pixels and the largest is {formatNumber(LOGO_RULES.maxWidth)} x {formatNumber(LOGO_RULES.maxHeight)} pixels.</li>
              <li><strong>Shape.</strong> The width must be between 1 and 6 times the height. Square or wider than tall is fine. An SVG needs a viewBox, or a width and a height, with the same shape.</li>
              <li><strong>File size.</strong> At most 2 MB.</li>
              <li><strong>Margin.</strong> Leave about 10 percent of empty space around the artwork.</li>
              <li><strong>Background.</strong> Use a transparent background. The top bar is white, so the logo must be easy to read on white. Pale or white artwork will not show.</li>
            </ul>
          </section>

          <div className="stack">
            <h3>How it will look</h3>
            <figure className="logo-figure">
              <BarPreview name={name} src={staged?.url} version={version} empty={!staged && hasLogo === false} />
              <figcaption className="small muted">Top bar on a computer, on a white background.</figcaption>
            </figure>
            <figure className="logo-figure" aria-hidden="true">
              <BarPreview name={name} src={staged?.url} version={version} empty={!staged && hasLogo === false} phone />
              <figcaption className="small muted">Top bar on a phone.</figcaption>
            </figure>

            {checking ? <Spinner label="Checking your image" /> : null}
            {problem ? <Notice tone="bad" title="This image cannot be used">{problem}</Notice> : null}
            {staged ? (
              <div className="stack-sm">
                <Notice tone="info" title="Check the preview, then save">
                  {staged.file.name}: {staged.check.format === 'svg' ? `SVG, shape ${staged.check.width} x ${staged.check.height}` : `${staged.check.format.toUpperCase()}, ${staged.check.width} x ${staged.check.height} pixels`}, {formatBytes(staged.check.bytes)}.
                  {staged.check.note ? ` ${staged.check.note}` : ''}
                </Notice>
                {canEdit ? (
                  <div className="row">
                    <Button variant="primary" loading={busy} onClick={() => { void saveStaged(); }}>Use this logo</Button>
                    <LogoPicker label="Choose another file" busy={checking || busy} onFile={(f) => { void choose(f); }} />
                    <Button onClick={() => { setStaged(null); setProblem(null); }} disabled={busy}>Cancel</Button>
                  </div>
                ) : null}
              </div>
            ) : canEdit ? (
              <div className="row">
                <LogoPicker label={hasLogo ? 'Replace logo' : 'Choose logo'} busy={checking} onFile={(f) => { void choose(f); }} />
                {hasLogo ? <Button size="sm" variant="danger" onClick={() => setRemoving(true)}><Trash2 size={14} aria-hidden="true" /> Remove logo</Button> : null}
              </div>
            ) : <p className="muted small">Viewers cannot change the logo. Ask a colleague who works in the portal, or an administrator.</p>}
          </div>
        </div>
      </div>
      <Dialog
        open={removing}
        title="Remove your logo?"
        onClose={() => setRemoving(false)}
        footer={<><Button onClick={() => setRemoving(false)}>Keep it</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Remove</Button></>}
      >
        <p>A company logo is required. Without one, everyone in your company sees a reminder on every page, and K Line cannot approve a new company. You can add a new logo straight away.</p>
      </Dialog>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------ logo and brands

/** Uploads an image with the normal upload protocol and waits for the checks. Returns the file ID. */
async function uploadLogoFile(file: File): Promise<string> {
  const ext = extOf(file.name);
  if (!LOGO_EXTS.includes(ext)) throw new Error('Use a PNG, JPG or SVG image.');
  if (file.size === 0) throw new Error('This file is empty.');
  if (file.size > MAX_LOGO_BYTES) throw new Error(`The image can be at most ${formatBytes(MAX_LOGO_BYTES)}.`);
  const spec: UploadSpec = { key: 'logo', name: file.name, source: blobSource(file), arch: null, step: null, template: false };
  const res = await uploadCaseFiles({ purpose: 'logo' }, [spec], { timeoutMs: 2 * 60_000 });
  const st: FileStatus | undefined = res.files.get('logo');
  if (!st || st.phase !== 'ready' || !st.fileId) throw new Error(st?.error ?? 'The image did not pass the checks.');
  return st.fileId;
}

function LogoPicker({ label, busy, onFile }: { label: string; busy: boolean; onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" hidden accept=".png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml" aria-label={label} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      <Button size="sm" loading={busy} onClick={() => ref.current?.click()}><ImagePlus size={14} aria-hidden="true" /> {label}</Button>
    </>
  );
}

function LogoImage({ src, alt, show }: { src: string; alt: string; show: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <span className="logo-box">
      {show && !failed ? <img src={src} alt={alt} onError={() => setFailed(true)} /> : <span className="muted small" aria-label={`${alt}: none yet`}>No logo</span>}
    </span>
  );
}

function BrandsCard({ profile, canEdit, onboarding }: { profile: Profile; canEdit: boolean; onboarding: boolean }) {
  const qc = useQueryClient();
  const brands = useQuery({ queryKey: ['org-brands'], queryFn: async () => normalizeBrands(await api('/api/org/brands')) });
  const [msg, setMsg] = useState<Msg>(null);
  const [version, setVersion] = useState<Record<string, number>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<Brand | null>(null);
  const [removing, setRemoving] = useState<Brand | null>(null);
  const [locked, setLocked] = useState(false);

  async function setLogo(key: string, file: File, attach: (fileId: string) => Promise<unknown>) {
    setMsg(null);
    setBusyKey(key);
    try {
      const fileId = await uploadLogoFile(file);
      await attach(fileId);
      setVersion((v) => ({ ...v, [key]: Date.now() }));
      qc.invalidateQueries({ queryKey: ['org-brands'] });
      qc.invalidateQueries({ queryKey: ['org-profile'] });
      setMsg({ tone: 'good', text: 'The logo is saved.' });
    } catch (e) {
      if (isNotApproved(e)) setLocked(true);
      setMsg({ tone: 'bad', text: e instanceof ApiError ? errorText(e) : (e as Error).message || 'The logo could not be saved.' });
    } finally {
      setBusyKey(null);
    }
  }

  const add = useMutation({
    mutationFn: () => api('/api/org/brands', { method: 'POST', body: { name: newName.trim() } }),
    onSuccess: () => { setNewName(''); setMsg({ tone: 'good', text: 'Brand added.' }); qc.invalidateQueries({ queryKey: ['org-brands'] }); },
    onError: (e) => setMsg({ tone: 'bad', text: errorText(e) }),
  });
  const del = useMutation({
    mutationFn: (b: Brand) => api(`/api/org/brands/${b.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoving(null); setMsg({ tone: 'good', text: 'Brand removed.' }); qc.invalidateQueries({ queryKey: ['org-brands'] }); },
    onError: (e) => { setRemoving(null); setMsg({ tone: 'bad', text: errorText(e) }); },
  });

  return (
    <Card title="Brands">
      <div className="stack">
        <p className="muted">Add the brands you send cases for. Each brand can have its own logo as a PNG, JPG or SVG image, up to {formatBytes(MAX_LOGO_BYTES)}. We check every image before we keep it.</p>
        {profileFilesNote(profile, onboarding)}
        <Feedback msg={msg} />
        {locked ? <LockedNotice what="add more files" /> : null}

        {brands.isLoading ? <Spinner /> : null}
        {brands.isError ? <Notice tone="bad">{errorText(brands.error)}</Notice> : null}
        {brands.data && brands.data.length === 0 ? <p className="muted">No brands yet. Add one if you send cases under more than one name.</p> : null}
        {brands.data && brands.data.length ? (
          <ul className="attach-list">
            {brands.data.map((b) => (
              <li key={b.id} className="attach-item">
                <LogoImage src={`/api/org/brands/${b.id}/logo?v=${version[b.id] ?? 0}`} alt={`Logo of ${b.name}`} show={b.hasLogo !== false} />
                <span className="attach-meta"><span className="attach-name">{b.name}</span></span>
                {canEdit ? (
                  <span className="row" style={{ gap: 6 }}>
                    <LogoPicker label={`Upload logo for ${b.name}`} busy={busyKey === b.id} onFile={(f) => setLogo(b.id, f, (fileId) => api(`/api/org/brands/${b.id}/logo`, { method: 'POST', body: { fileId } }))} />
                    <Button size="sm" onClick={() => setRenaming(b)} aria-label={`Rename ${b.name}`}>Rename</Button>
                    <Button size="sm" variant="danger" onClick={() => setRemoving(b)} aria-label={`Remove ${b.name}`}>Remove</Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {canEdit ? (
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) add.mutate(); }}>
            <Field label="New brand name" className="grow">{(p) => <input {...p} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} autoComplete="off" />}</Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!newName.trim()}>Add brand</Button>
          </form>
        ) : null}
      </div>

      <RenameBrand brand={renaming} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); setMsg({ tone: 'good', text: 'Brand renamed.' }); qc.invalidateQueries({ queryKey: ['org-brands'] }); }} />
      <Dialog
        open={!!removing}
        title="Remove this brand?"
        onClose={() => setRemoving(null)}
        footer={<><Button onClick={() => setRemoving(null)}>Keep it</Button><Button variant="danger" loading={del.isPending} onClick={() => removing && del.mutate(removing)}>Remove</Button></>}
      >
        <p>{removing?.name} and its logo will be removed. Cases that already use this brand keep working.</p>
      </Dialog>
    </Card>
  );
}

function RenameBrand({ brand, onClose, onDone }: { brand: Brand | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [forId, setForId] = useState<string | null>(null);
  if (brand && forId !== brand.id) { setForId(brand.id); setName(brand.name); setError(null); }
  const m = useMutation({
    mutationFn: () => api(`/api/org/brands/${brand!.id}`, { method: 'PATCH', body: { name: name.trim() } }),
    onSuccess: () => { setForId(null); onDone(); },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog open={!!brand} title="Rename brand" onClose={() => { setForId(null); onClose(); }}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Brand name">{(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />}</Field>
        <div className="row-end">
          <Button onClick={() => { setForId(null); onClose(); }}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!name.trim()}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

// -------------------------------------------------------------------------------------------------------- documents

function profileFilesNote(profile: Profile, onboarding: boolean) {
  const max = profile.profileFiles?.max ?? (onboarding ? PROFILE_FILE_LIMIT : null);
  if (!max) return null;
  const used = profile.profileFiles?.count;
  return (
    <p className="small muted">
      Until K Line approves your company you can keep at most {formatNumber(max)} files on this page, logos and documents together.
      {typeof used === 'number' ? ` You have stored ${formatNumber(used)}.` : ''}
    </p>
  );
}

function DocumentsCard({ profile, canEdit, onboarding }: { profile: Profile; canEdit: boolean; onboarding: boolean }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const docs = useQuery({ queryKey: ['org-documents'], queryFn: async () => normalizeDocuments(await api('/api/org/documents')) });
  const [kind, setKind] = useState<'qc_criteria' | 'packaging' | 'other'>('qc_criteria');
  const [status, setStatus] = useState<Record<string, FileStatus>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [removing, setRemoving] = useState<OrgDocument | null>(null);
  const [locked, setLocked] = useState(false);
  const pend = usePending({ exts: DOC_EXTS, maxFiles: 20, maxBytes: () => MAX_DOC_BYTES });

  async function send() {
    setBusy(true);
    setMsg(null);
    setStatus({});
    try {
      const last: Record<string, FileStatus> = {};
      const ok = await uploadPending({ purpose: 'document', kind }, pend.pending, (k, s) => { last[k] = s; setStatus((p) => ({ ...p, [k]: s })); });
      qc.invalidateQueries({ queryKey: ['org-documents'] });
      qc.invalidateQueries({ queryKey: ['org-profile'] });
      qc.invalidateQueries({ queryKey: ['onboarding'] });
      if (ok) { pend.clear(); setStatus({}); setMsg({ tone: 'good', text: 'Your documents are saved.' }); }
      else {
        // Keep only the files that did not go through, so they can be tried again.
        for (const [k, s] of Object.entries(last)) if (s.phase === 'ready') pend.remove(k);
        setMsg({ tone: 'bad', text: 'Some files were not saved. See the messages below.' });
      }
    } catch (e) {
      setMsg({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  // Show the locked notice when a file was refused because the company is not approved.
  useEffect(() => {
    if (Object.values(status).some((s) => s.error?.startsWith('Uploads are locked'))) setLocked(true);
  }, [status]);

  const del = useMutation({
    mutationFn: (d: OrgDocument) => api(`/api/org/documents/${d.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoving(null); setMsg({ tone: 'good', text: 'Document removed.' }); qc.invalidateQueries({ queryKey: ['org-documents'] }); qc.invalidateQueries({ queryKey: ['org-profile'] }); },
    onError: (e) => { setRemoving(null); setMsg({ tone: 'bad', text: errorText(e) }); },
  });

  return (
    <Card title="Documents">
      <div className="stack">
        <p className="muted">Share quality control criteria, packaging instructions and similar documents with K Line. PDF, JPG and PNG files, up to {formatBytes(MAX_DOC_BYTES)} each.</p>
        {profileFilesNote(profile, onboarding)}
        <Feedback msg={msg} />
        {locked ? <LockedNotice what="add more files" /> : null}

        {docs.isLoading ? <Spinner /> : null}
        {docs.isError ? <Notice tone="bad">{errorText(docs.error)}</Notice> : null}
        {docs.data && docs.data.length === 0 ? <Empty title="No documents yet">Files you add appear here.</Empty> : null}
        {docs.data && docs.data.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Document</th><th>Type</th><th className="num">Size</th><th>Added</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {docs.data.map((d) => (
                  <tr key={d.id}>
                    <td><strong>{d.name}</strong>{d.state !== 'ready' ? <div><Badge tone={d.state === 'rejected' ? 'bad' : 'info'}>{d.state === 'rejected' ? 'Not accepted' : 'Checking'}</Badge>{d.problem ? <div className="small muted">{d.problem}</div> : null}</div> : null}</td>
                    <td>{documentKindLabel(d.kind)}</td>
                    <td className="num nowrap">{formatBytes(d.size)}</td>
                    <td className="nowrap">{d.createdAt ? formatDate(d.createdAt) : ''}</td>
                    <td>
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        {can('file.download') && d.state === 'ready' ? <a className="btn btn-sm" href={`/api/files/${d.id}/download`} aria-label={`Download ${d.name}`}><Download size={14} aria-hidden="true" /> Download</a> : null}
                        {canEdit ? <Button size="sm" variant="danger" onClick={() => setRemoving(d)} aria-label={`Delete ${d.name}`}><Trash2 size={14} aria-hidden="true" /> Delete</Button> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {canEdit ? (
          <div className="stack">
            <h3>Add documents</h3>
            <Field label="What are these documents?">
              {(p) => <select {...p} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} disabled={busy}>{DOCUMENT_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>}
            </Field>
            <AttachmentPicker
              pending={pend.pending}
              problems={pend.problems}
              status={status}
              onAdd={pend.add}
              onRemove={pend.remove}
              busy={busy}
              accept=".pdf,.jpg,.jpeg,.png"
              label="Drop documents here or choose files"
              hint="PDF, JPG or PNG"
            />
            {pend.pending.length ? (
              <div className="row-end">
                <Button onClick={() => { pend.clear(); setStatus({}); }} disabled={busy}>Clear</Button>
                <Button variant="primary" loading={busy} onClick={send}>Upload {formatNumber(pend.pending.length)} {pend.pending.length === 1 ? 'file' : 'files'}</Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <Dialog
        open={!!removing}
        title="Delete this document?"
        onClose={() => setRemoving(null)}
        footer={<><Button onClick={() => setRemoving(null)}>Keep it</Button><Button variant="danger" loading={del.isPending} onClick={() => removing && del.mutate(removing)}>Delete</Button></>}
      >
        <p>{removing?.name} will be deleted. K Line will no longer see it.</p>
      </Dialog>
    </Card>
  );
}

// ------------------------------------------------------------------------------------- agreements and sites (read)

function AgreementsCard() {
  const q = useQuery({ queryKey: ['org-agreements'], queryFn: async () => normalizeAgreements(await api('/api/org/agreements')) });
  return (
    <Card title="Agreements on file">
      <p className="muted">K Line records signed agreements with you. You cannot change them here.</p>
      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
      {q.data && q.data.length === 0 ? <Empty title="Nothing recorded yet">Your data processing agreement appears here once K Line has recorded it.</Empty> : null}
      {q.data && q.data.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Agreement</th><th>Signed</th><th>Expires</th><th>Reference</th></tr></thead>
            <tbody>
              {q.data.map((a) => (
                <tr key={a.id}>
                  <td><strong>{agreementLabel(a.kind)}</strong></td>
                  <td className="nowrap">{a.signedAt ? formatDate(a.signedAt) : 'Not set'}</td>
                  <td className="nowrap">{a.expiresAt ? formatDate(a.expiresAt) : 'No end date'}</td>
                  <td>{a.reference ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function SitesCard() {
  const q = useQuery({ queryKey: ['org-sites'], queryFn: async () => normalizeSites(await api('/api/org/sites')) });
  return (
    <Card title="Sites where your cases are made">
      <p className="muted">K Line decides which sites can make your cases. Ask your account team if you need a change.</p>
      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
      {q.data && q.data.length === 0 ? <Empty title="No sites yet">K Line adds sites when they approve your company.</Empty> : null}
      {q.data && q.data.length ? (
        <ul className="attach-list">
          {q.data.map((s) => (
            <li key={s.code} className="attach-item">
              <span className="attach-meta">
                <span className="attach-name">{s.name} <span className="muted small">{s.code}</span> {s.isDefault ? <Badge tone="info">Default</Badge> : null}</span>
                <span className="muted small">{[s.city, countryName(s.country)].filter(Boolean).join(', ')}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
