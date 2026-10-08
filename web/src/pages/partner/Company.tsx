import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { A, useLocation } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { CheckCircle2, Download, ImagePlus, Trash2, XCircle } from 'lucide-solid';
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

function Feedback(props: { msg: Msg }) {
  return <Show when={props.msg}>{(m) => <Notice tone={m().tone}>{m().text}</Notice>}</Show>;
}

function extOf(name: string): string { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); }

export default function Company() {
  const { me, can } = useAuth();
  const canEdit = () => can('org.edit');
  const canLogo = () => can('org.logo');
  const onboarding = () => me()?.org?.status === 'onboarding';
  const q = createQuery(() => ({ queryKey: ['org-profile'], queryFn: async () => normalizeProfile(await api('/api/org/profile')) }));
  const loc = useLocation();
  const logoState = useOrgLogo(() => true);

  // The links "#logo" and "#case-address" scroll to their card once the page has loaded.
  createEffect(() => {
    const hash = loc.hash;
    const loaded = !!q.data;
    logoState.hasLogo; // the logo banner can appear after the profile, so scroll again then
    if (!loaded || (hash !== '#logo' && hash !== '#case-address')) return;
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  });

  return (
    <div class="page">
      <PageHeader title="Company profile" subtitle="The details K Line uses for agreements, shipping and quality. Keep them up to date." />
      <Show when={onboarding()}>
        <Notice tone="info" title="Your company is waiting for K Line to approve it" action={<A class="btn btn-sm" href="/portal/getting-started">Getting started</A>}>
          You can finish your profile now. Sending cases, inviting people and sending materials unlock after approval.
        </Notice>
      </Show>
      <Show when={!canEdit()}>
        <Notice tone="info">
          {canLogo()
            ? 'You can change the company logo. Ask an administrator in your company to change anything else on this page.'
            : 'You can look at this page but not change it. Ask an administrator in your company to make changes.'}
        </Notice>
      </Show>
      <Show when={q.isLoading}><Spinner /></Show>
      <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
      <Show when={q.data}>
        {(profile) => (
          <>
            <DetailsCard profile={profile()} canEdit={canEdit()} />
            <div id="case-address" tabIndex={-1} class="anchor"><CaseAddressCard profile={profile()} canEdit={canEdit()} /></div>
            <div id="logo" tabIndex={-1} class="anchor"><LogoCard profile={profile()} canEdit={canLogo()} onboarding={onboarding()} /></div>
            <ContactsCard profile={profile()} canEdit={canEdit()} />
            <CaseIdCard profile={profile()} canEdit={canEdit()} />
            <Show when={canEdit()}><MenuCard /></Show>
            <BrandsCard profile={profile()} canEdit={canEdit()} onboarding={onboarding()} />
            <DocumentsCard profile={profile()} canEdit={canEdit()} onboarding={onboarding()} />
            <AgreementsCard />
            <SitesCard />
          </>
        )}
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------ saving profile

function useSaveProfile(base: () => Profile, onDone: (m: Msg) => void) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (patch: Partial<Profile>) => api('/api/org/profile', { method: 'PUT', body: profileBody({ ...base(), ...patch }) }),
    onSuccess: () => {
      onDone({ tone: 'good', text: 'Saved.' });
      qc.invalidateQueries({ queryKey: ['org-profile'] });
      qc.invalidateQueries({ queryKey: ['org'] });
      qc.invalidateQueries({ queryKey: ['onboarding'] });
    },
    onError: (e: unknown) => {
      const extra = fieldMessages(e);
      onDone({ tone: 'bad', text: extra.length ? `${errorText(e)} ${extra.join(' ')}` : errorText(e) });
    },
  }));
}

// ---------------------------------------------------------------------------------------------------------- details

function DetailsCard(props: { profile: Profile; canEdit: boolean }) {
  const [msg, setMsg] = createSignal<Msg>(null);
  const [name, setName] = createSignal(props.profile.name);
  const [legalName, setLegalName] = createSignal(props.profile.legalName);
  const [country, setCountry] = createSignal(props.profile.country);
  const [vatId, setVatId] = createSignal(props.profile.vatId);
  const [street, setStreet] = createSignal(props.profile.address.street);
  const [city, setCity] = createSignal(props.profile.address.city);
  const [postalCode, setPostalCode] = createSignal(props.profile.address.postalCode);
  const [addrCountry, setAddrCountry] = createSignal(props.profile.address.country || props.profile.country);
  createEffect(() => {
    const p = props.profile;
    setName(p.name); setLegalName(p.legalName); setCountry(p.country); setVatId(p.vatId);
    setStreet(p.address.street); setCity(p.address.city); setPostalCode(p.address.postalCode); setAddrCountry(p.address.country || p.country);
  });
  const save = useSaveProfile(() => props.profile, setMsg);
  function submit(e: SubmitEvent) {
    e.preventDefault();
    setMsg(null);
    save.mutate({ name: name(), legalName: legalName(), country: country(), vatId: vatId(), address: { street: street(), city: city(), postalCode: postalCode(), country: addrCountry() } });
  }
  return (
    <Card title="Company details">
      <form onSubmit={submit} class="stack">
        <Feedback msg={msg()} />
        <fieldset class="plain-fieldset stack" disabled={!props.canEdit}>
          <div class="form-grid">
            <Field label="Company name" hint="The name your team sees in the Hub.">{(p) => <input {...p} value={name()} onInput={(e) => setName(e.currentTarget.value)} maxLength={120} required />}</Field>
            <Field label="Legal name" hint="As it appears in your contracts.">{(p) => <input {...p} value={legalName()} onInput={(e) => setLegalName(e.currentTarget.value)} maxLength={160} autocomplete="organization" />}</Field>
            <Field label="Country" hint={props.profile.countryLocked ? 'Only K Line can change this after approval, because it decides where your cases may be made.' : undefined}>
              {(p) => (
                <select {...p} value={country()} onChange={(e) => setCountry(e.currentTarget.value)} disabled={props.profile.countryLocked}>
                  <option value="">Choose a country</option>
                  <For each={COUNTRIES}>{(c) => <option value={c.code}>{c.name}</option>}</For>
                </select>
              )}
            </Field>
            <Field label="VAT ID" hint={props.profile.vatRequired ? 'Needed for companies in the EU.' : 'If you have one.'}>{(p) => <input {...p} value={vatId()} onInput={(e) => setVatId(e.currentTarget.value)} maxLength={24} autocomplete="off" />}</Field>
          </div>
          <div class="form-grid">
            <Field label="Street and number">{(p) => <input {...p} value={street()} onInput={(e) => setStreet(e.currentTarget.value)} maxLength={160} autocomplete="street-address" />}</Field>
            <Field label="Postcode">{(p) => <input {...p} value={postalCode()} onInput={(e) => setPostalCode(e.currentTarget.value)} maxLength={20} autocomplete="postal-code" />}</Field>
            <Field label="City">{(p) => <input {...p} value={city()} onInput={(e) => setCity(e.currentTarget.value)} maxLength={100} autocomplete="address-level2" />}</Field>
            <Field label="Address country">
              {(p) => (
                <select {...p} value={addrCountry()} onChange={(e) => setAddrCountry(e.currentTarget.value)} autocomplete="country">
                  <option value="">Choose a country</option>
                  <For each={COUNTRIES}>{(c) => <option value={c.code}>{c.name}</option>}</For>
                </select>
              )}
            </Field>
          </div>
        </fieldset>
        <Show when={props.canEdit}><div><Button type="submit" variant="primary" loading={save.isPending}>Save details</Button></div></Show>
      </form>
    </Card>
  );
}

// --------------------------------------------------------------------------------------------------------- contacts

type ContactFields = Profile['contacts'];

function ContactsCard(props: { profile: Profile; canEdit: boolean }) {
  const [msg, setMsg] = createSignal<Msg>(null);
  // A copy of the saved contacts that the fields edit. It is replaced whenever the saved profile changes.
  const copyOf = (): ContactFields => JSON.parse(JSON.stringify(props.profile.contacts));
  const [contacts, setContacts] = createStore<ContactFields>(copyOf());
  createEffect(() => setContacts(reconcile(copyOf())));
  const save = useSaveProfile(() => props.profile, setMsg);
  const set = (k: (typeof CONTACT_KEYS)[number], f: 'name' | 'email' | 'phone', v: string) => setContacts(k, f, v);
  function submit(e: SubmitEvent) { e.preventDefault(); setMsg(null); save.mutate({ contacts: JSON.parse(JSON.stringify(contacts)) }); }
  return (
    <Card title="Contacts" >
      <form onSubmit={submit} class="stack">
        <p class="muted">Tell us who to talk to about each topic. Add at least one contact.</p>
        <Feedback msg={msg()} />
        <fieldset class="plain-fieldset stack-lg" disabled={!props.canEdit}>
          <For each={CONTACT_KEYS}>
            {(k) => (
              <fieldset class="plain-fieldset stack-sm">
                <legend class="label">{CONTACT_LABEL[k]}</legend>
                <div class="form-grid">
                  <Field label={`${CONTACT_LABEL[k]} contact name`}>{(p) => <input {...p} value={contacts[k].name} onInput={(e) => set(k, 'name', e.currentTarget.value)} maxLength={120} autocomplete="off" />}</Field>
                  <Field label={`${CONTACT_LABEL[k]} email`}>{(p) => <input {...p} type="email" value={contacts[k].email} onInput={(e) => set(k, 'email', e.currentTarget.value)} maxLength={200} autocomplete="off" />}</Field>
                  <Field label={`${CONTACT_LABEL[k]} phone`}>{(p) => <input {...p} type="tel" value={contacts[k].phone} onInput={(e) => set(k, 'phone', e.currentTarget.value)} maxLength={40} autocomplete="off" />}</Field>
                </div>
              </fieldset>
            )}
          </For>
        </fieldset>
        <Show when={props.canEdit}><div><Button type="submit" variant="primary" loading={save.isPending}>Save contacts</Button></div></Show>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ case ID pattern

const EXAMPLE_IDS = 'ABC-12345\n55813\nCase 7\nabc_001';

function CaseIdCard(props: { profile: Profile; canEdit: boolean }) {
  const [msg, setMsg] = createSignal<Msg>(null);
  const [pattern, setPattern] = createSignal(props.profile.settings.caseIdRegex);
  const [requirePts, setRequirePts] = createSignal(props.profile.settings.requirePts);
  const [samples, setSamples] = createSignal(EXAMPLE_IDS);
  createEffect(() => { setPattern(props.profile.settings.caseIdRegex); setRequirePts(props.profile.settings.requirePts); });
  const save = useSaveProfile(() => props.profile, setMsg);
  const state = createMemo(() => readPattern(pattern()));
  const results = createMemo(() => {
    const s = state();
    if (!s.ok || !s.regex) return [];
    return testSamples(s.regex, samples().split(/\r?\n/).filter((l) => l.trim()).slice(0, 30));
  });
  const patternError = () => { const s = state(); return !s.ok ? s.message : null; };
  function submit(e: SubmitEvent) {
    e.preventDefault();
    setMsg(null);
    if (!state().ok) return;
    save.mutate({ settings: { caseIdRegex: pattern().trim(), requirePts: requirePts() } });
  }
  return (
    <Card title="Case IDs and trim lines">
      <form onSubmit={submit} class="stack">
        <Feedback msg={msg()} />
        <fieldset class="plain-fieldset stack" disabled={!props.canEdit}>
          <Field
            label="Case ID pattern (optional)"
            hint={`A pattern that your case IDs should follow, for example ^[A-Z]{3}-[0-9]{5}$. Start with ^ and end with $ to match the whole ID. Leave it empty to accept any ID. At most ${MAX_PATTERN_LENGTH} characters.`}
            error={patternError()}
          >
            {(p) => <input {...p} class="mono" value={pattern()} onInput={(e) => setPattern(e.currentTarget.value)} maxLength={MAX_PATTERN_LENGTH} spellcheck={false} autocomplete="off" />}
          </Field>
          <Toggle checked={requirePts()} onChange={(v) => setRequirePts(v)} label="Ask for a trim line for every aligner" hint="Without one you get a warning to confirm before you submit." />
        </fieldset>

        <div class="stack-sm">
          <Field label="Try it out" hint={`Type or paste case IDs, one on each line. Nothing is sent anywhere. Each ID can have at most ${MAX_SAMPLE_LENGTH} characters.`}>
            {(p) => <textarea {...p} class="textarea-mono" rows={4} value={samples()} onInput={(e) => setSamples(e.currentTarget.value)} spellcheck={false} />}
          </Field>
          <Show when={(() => { const s = state(); return s.ok && !s.regex; })()}><p class="muted small">There is no pattern, so every ID is accepted.</p></Show>
          <Show when={results().length}>
            <ul class="attach-list" aria-label="Test results">
              <For each={results()}>
                {(r) => (
                  <li class="attach-item">
                    {r.match ? <CheckCircle2 size={18} class="ok-icon" aria-hidden="true" /> : <XCircle size={18} class="bad-icon" aria-hidden="true" />}
                    <span class="attach-meta"><span class="mono attach-name">{r.text}</span></span>
                    <Badge tone={r.match ? 'good' : 'bad'}>{r.match ? 'Matches' : r.tooLong ? 'Too long' : 'Does not match'}</Badge>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
        <Show when={props.canEdit}><div><Button type="submit" variant="primary" loading={save.isPending} disabled={!state().ok}>Save</Button></div></Show>
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
  const [msg, setMsg] = createSignal<Msg>(null);
  const q = createQuery(() => ({ queryKey: ['org-menu'], queryFn: () => api<MenuSetting>('/api/org/menu') }));
  const [on, setOn] = createSignal<Record<MenuKey, boolean>>({ claims: false, spec: false, materials: false });
  createEffect(() => {
    const d = q.data;
    if (d) setOn({ claims: d.claims === 'everyone', spec: d.spec === 'everyone', materials: d.materials === 'everyone' });
  });
  const dirty = () => { const d = q.data; return !!d && MENU_KEYS.some((k) => (d[k] === 'everyone') !== on()[k]); };
  const save = createMutation(() => ({
    mutationFn: () => api<MenuSetting>('/api/org/menu', { method: 'PUT', body: { claims: on().claims ? 'everyone' : 'admins', spec: on().spec ? 'everyone' : 'admins', materials: on().materials ? 'everyone' : 'admins' } }),
    onSuccess: (r: MenuSetting) => {
      qc.setQueryData(['org-menu'], r);
      qc.invalidateQueries({ queryKey: ['org'] });
      setMsg({ tone: 'good', text: 'Saved. The menu has been updated.' });
    },
    onError: (e: unknown) => setMsg({ tone: 'bad', text: errorText(e) }),
  }));
  return (
    <Card title="Menu">
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setMsg(null); save.mutate(); }}>
        <p class="muted">Choose which optional menu items the other people in your company see. They are hidden from everyone except administrators until you switch them on.</p>
        <Feedback msg={msg()} />
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.data}>
          <fieldset class="plain-fieldset stack">
            <For each={MENU_CHOICES}>
              {(m) => <Toggle checked={on()[m.key]} onChange={(v) => { setMsg(null); setOn((p) => ({ ...p, [m.key]: v })); }} label={m.label} hint={m.hint} />}
            </For>
          </fieldset>
        </Show>
        <p class="small muted">Admins always see these. This only changes what the menu shows. What each person can do still depends on their role.</p>
        <Show when={q.data}><div><Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty()}>Save</Button></div></Show>
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

function CaseAddressCard(props: { profile: Profile; canEdit: boolean }) {
  const qc = useQueryClient();
  const [msg, setMsg] = createSignal<Msg>(null);
  const [value, setValue] = createSignal<CaseAddress>(initialCaseAddress(props.profile));
  const [errors, setErrors] = createSignal<CaseAddressProblems>({});
  let form!: HTMLFormElement;
  createEffect(() => { setValue(initialCaseAddress(props.profile)); setErrors({}); });

  const save = createMutation(() => ({
    mutationFn: (a: CaseAddress) => api('/api/org/profile', { method: 'PUT', body: { caseAddress: caseAddressBody(a) } }),
    onSuccess: () => {
      setMsg({ tone: 'good', text: 'Your case address is saved.' });
      qc.invalidateQueries({ queryKey: ['org-profile'] });
      qc.invalidateQueries({ queryKey: ['onboarding'] });
      qc.invalidateQueries({ queryKey: USER_CASE_ADDRESS_KEY });
    },
    onError: (e: unknown) => {
      const fields = e instanceof ApiError && Array.isArray(e.extra.fields) ? (e.extra.fields as { path: string; message: string }[]) : [];
      const next = serverCaseAddressProblems(fields);
      setErrors(next);
      setMsg({ tone: 'bad', text: Object.keys(next).length ? 'Please check the highlighted fields.' : errorText(e) });
    },
  }));

  function submit(ev: SubmitEvent) {
    ev.preventDefault();
    setMsg(null);
    const p = validateCaseAddress(value());
    setErrors(p);
    const first = CASE_ADDRESS_FIELDS.find((f) => p[f]);
    if (first) { form.querySelector<HTMLElement>(`[name="${caseFieldName(first)}"]`)?.focus(); return; }
    save.mutate(value());
  }

  const complete = () => props.profile.caseAddressComplete;
  return (
    <Card title="Company case address" actions={complete() === undefined ? undefined : <Badge tone={complete() ? 'good' : 'warn'}>{complete() ? 'Complete' : 'Needed'}</Badge>}>
      <form ref={form} onSubmit={submit} class="stack" noValidate>
        <p class="muted">{CASE_ADDRESS_INTRO} It goes on the label of every case you send with Direct manufacturing, so the carrier knows who receives it. A case that has already been sent keeps the address it was sent with.</p>
        <p class="muted">This is the default for your company. It is used when a person has no case address of their own. Everyone can add their own in <A href="/portal/account#case-address">Account</A>.</p>
        <Show when={complete() === false}>
          <Notice tone="warn" title="Add your case address">
            Direct manufacturing stays blocked until you save a complete case address.{!props.profile.caseAddress ? ' We started with your company address. Check it, add the missing details and save.' : ''}
          </Notice>
        </Show>
        <Feedback msg={msg()} />
        <fieldset class="plain-fieldset stack" disabled={!props.canEdit}>
          <legend class="sr-only">Company case address</legend>
          <CaseAddressFields value={value()} errors={errors()} onChange={(f, v) => setValue((a) => ({ ...a, [f]: v }))} fields={CASE_ADDRESS_FIELDS} />
        </fieldset>
        <Show when={props.canEdit}><div><Button type="submit" variant="primary" loading={save.isPending}>Save case address</Button></div></Show>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------------------- logo

function BarPreview(props: { name: string; src?: string; version?: string; phone?: boolean; empty?: boolean }) {
  return (
    <div class={`bar-preview${props.phone ? ' bar-preview-phone' : ''}`}>
      <Show when={props.empty} fallback={<OrgLogoImage name={props.name} src={props.src} version={props.version} />}><span class="muted small">No logo yet</span></Show>
      <span class="topbar-title">{props.name}</span>
    </div>
  );
}

interface Staged { file: File; check: Extract<LogoCheck, { ok: true }>; url: string }

function LogoCard(props: { profile: Profile; canEdit: boolean; onboarding: boolean }) {
  const qc = useQueryClient();
  const logo = useOrgLogo(() => true);
  const [msg, setMsg] = createSignal<Msg>(null);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [staged, setStaged] = createSignal<Staged | null>(null);
  const [checking, setChecking] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [bust, setBust] = createSignal(0);
  const [removing, setRemoving] = createSignal(false);
  const [locked, setLocked] = createSignal(false);
  const hasLogo = () => logo.hasLogo ?? props.profile.hasLogo;
  const name = () => props.profile.name || 'Your company';

  createEffect(() => { const s = staged(); if (s) onCleanup(() => URL.revokeObjectURL(s.url)); });

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
    const s = staged();
    if (!s) return;
    setBusy(true);
    setMsg(null);
    try {
      const fileId = await uploadLogoFile(s.file);
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

  const remove = createMutation(() => ({
    mutationFn: () => api('/api/org/logo', { method: 'DELETE' }),
    onSuccess: () => { setRemoving(false); setStaged(null); setBust(Date.now()); refresh(); setMsg({ tone: 'good', text: 'The logo is removed. Please add a new one, because a logo is required.' }); },
    onError: (e: unknown) => { setRemoving(false); setMsg({ tone: 'bad', text: errorText(e) }); },
  }));

  const version = () => `${logo.version}-${bust()}`;
  return (
    <Card title={<>Company logo <Show when={hasLogo() !== undefined}><Badge tone={hasLogo() ? 'good' : 'warn'}>{hasLogo() ? 'Added' : 'Required'}</Badge></Show></>}>
      <div class="stack">
        <p class="muted">Your logo is required. It shows in the top bar for everyone in your company, so your team and K Line can recognise your account. Every team member except viewers can change it, and the access log records who did.</p>
        {profileFilesNote(props.profile, props.onboarding)}
        <Feedback msg={msg()} />
        <Show when={locked()}><LockedNotice what="add more files" /></Show>

        <div class="logo-grid">
          <section class="logo-rules" aria-labelledby="logo-rules-title">
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

          <div class="stack">
            <h3>How it will look</h3>
            <figure class="logo-figure">
              <BarPreview name={name()} src={staged()?.url} version={version()} empty={!staged() && hasLogo() === false} />
              <figcaption class="small muted">Top bar on a computer, on a white background.</figcaption>
            </figure>
            <figure class="logo-figure" aria-hidden="true">
              <BarPreview name={name()} src={staged()?.url} version={version()} empty={!staged() && hasLogo() === false} phone />
              <figcaption class="small muted">Top bar on a phone.</figcaption>
            </figure>

            <Show when={checking()}><Spinner label="Checking your image" /></Show>
            <Show when={problem()}>{(p) => <Notice tone="bad" title="This image cannot be used">{p()}</Notice>}</Show>
            <Show
              when={staged()}
              fallback={
                <Show when={props.canEdit} fallback={<p class="muted small">Viewers cannot change the logo. Ask a colleague who works in the portal, or an administrator.</p>}>
                  <div class="row">
                    <LogoPicker label={hasLogo() ? 'Replace logo' : 'Choose logo'} busy={checking()} onFile={(f) => { void choose(f); }} />
                    <Show when={hasLogo()}><Button size="sm" variant="danger" onClick={() => setRemoving(true)}><Trash2 size={14} aria-hidden="true" /> Remove logo</Button></Show>
                  </div>
                </Show>
              }
            >
              {(s) => (
                <div class="stack-sm">
                  <Notice tone="info" title="Check the preview, then save">
                    {s().file.name}: {s().check.format === 'svg' ? `SVG, shape ${s().check.width} x ${s().check.height}` : `${s().check.format.toUpperCase()}, ${s().check.width} x ${s().check.height} pixels`}, {formatBytes(s().check.bytes)}.
                    {s().check.note ? ` ${s().check.note}` : ''}
                  </Notice>
                  <Show when={props.canEdit}>
                    <div class="row">
                      <Button variant="primary" loading={busy()} onClick={() => { void saveStaged(); }}>Use this logo</Button>
                      <LogoPicker label="Choose another file" busy={checking() || busy()} onFile={(f) => { void choose(f); }} />
                      <Button onClick={() => { setStaged(null); setProblem(null); }} disabled={busy()}>Cancel</Button>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </div>
      </div>
      <Dialog
        open={removing()}
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

function LogoPicker(props: { label: string; busy: boolean; onFile: (f: File) => void }) {
  let ref!: HTMLInputElement;
  return (
    <>
      <input ref={ref} type="file" hidden accept=".png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml" aria-label={props.label} onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) props.onFile(f); e.currentTarget.value = ''; }} />
      <Button size="sm" loading={props.busy} onClick={() => ref.click()}><ImagePlus size={14} aria-hidden="true" /> {props.label}</Button>
    </>
  );
}

function LogoImage(props: { src: string; alt: string; show: boolean }) {
  const [failed, setFailed] = createSignal(false);
  createEffect(on(() => props.src, () => setFailed(false)));
  return (
    <span class="logo-box">
      <Show when={props.show && !failed()} fallback={<span class="muted small" aria-label={`${props.alt}: none yet`}>No logo</span>}>
        <img src={props.src} alt={props.alt} onError={() => setFailed(true)} />
      </Show>
    </span>
  );
}

function BrandsCard(props: { profile: Profile; canEdit: boolean; onboarding: boolean }) {
  const qc = useQueryClient();
  const brands = createQuery(() => ({ queryKey: ['org-brands'], queryFn: async () => normalizeBrands(await api('/api/org/brands')) }));
  const [msg, setMsg] = createSignal<Msg>(null);
  const [version, setVersion] = createSignal<Record<string, number>>({});
  const [busyKey, setBusyKey] = createSignal<string | null>(null);
  const [newName, setNewName] = createSignal('');
  const [renaming, setRenaming] = createSignal<Brand | null>(null);
  const [removing, setRemoving] = createSignal<Brand | null>(null);
  const [locked, setLocked] = createSignal(false);

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

  const add = createMutation(() => ({
    mutationFn: () => api('/api/org/brands', { method: 'POST', body: { name: newName().trim() } }),
    onSuccess: () => { setNewName(''); setMsg({ tone: 'good', text: 'Brand added.' }); qc.invalidateQueries({ queryKey: ['org-brands'] }); },
    onError: (e: unknown) => setMsg({ tone: 'bad', text: errorText(e) }),
  }));
  const del = createMutation(() => ({
    mutationFn: (b: Brand) => api(`/api/org/brands/${b.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoving(null); setMsg({ tone: 'good', text: 'Brand removed.' }); qc.invalidateQueries({ queryKey: ['org-brands'] }); },
    onError: (e: unknown) => { setRemoving(null); setMsg({ tone: 'bad', text: errorText(e) }); },
  }));

  return (
    <Card title="Brands">
      <div class="stack">
        <p class="muted">Add the brands you send cases for. Each brand can have its own logo as a PNG, JPG or SVG image, up to {formatBytes(MAX_LOGO_BYTES)}. We check every image before we keep it.</p>
        {profileFilesNote(props.profile, props.onboarding)}
        <Feedback msg={msg()} />
        <Show when={locked()}><LockedNotice what="add more files" /></Show>

        <Show when={brands.isLoading}><Spinner /></Show>
        <Show when={brands.isError}><Notice tone="bad">{errorText(brands.error)}</Notice></Show>
        <Show when={brands.data && brands.data.length === 0}><p class="muted">No brands yet. Add one if you send cases under more than one name.</p></Show>
        <Show when={brands.data && brands.data.length}>
          <ul class="attach-list">
            <For each={brands.data}>
              {(b) => (
                <li class="attach-item">
                  <LogoImage src={`/api/org/brands/${b.id}/logo?v=${version()[b.id] ?? 0}`} alt={`Logo of ${b.name}`} show={b.hasLogo !== false} />
                  <span class="attach-meta"><span class="attach-name">{b.name}</span></span>
                  <Show when={props.canEdit}>
                    <span class="row" style={{ gap: '6px' }}>
                      <LogoPicker label={`Upload logo for ${b.name}`} busy={busyKey() === b.id} onFile={(f) => setLogo(b.id, f, (fileId) => api(`/api/org/brands/${b.id}/logo`, { method: 'POST', body: { fileId } }))} />
                      <Button size="sm" onClick={() => setRenaming(b)} aria-label={`Rename ${b.name}`}>Rename</Button>
                      <Button size="sm" variant="danger" onClick={() => setRemoving(b)} aria-label={`Remove ${b.name}`}>Remove</Button>
                    </span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={props.canEdit}>
          <form class="inline-form" onSubmit={(e) => { e.preventDefault(); if (newName().trim()) add.mutate(); }}>
            <Field label="New brand name" class="grow">{(p) => <input {...p} value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} maxLength={80} autocomplete="off" />}</Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!newName().trim()}>Add brand</Button>
          </form>
        </Show>
      </div>

      <RenameBrand brand={renaming()} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); setMsg({ tone: 'good', text: 'Brand renamed.' }); qc.invalidateQueries({ queryKey: ['org-brands'] }); }} />
      <Dialog
        open={!!removing()}
        title="Remove this brand?"
        onClose={() => setRemoving(null)}
        footer={<><Button onClick={() => setRemoving(null)}>Keep it</Button><Button variant="danger" loading={del.isPending} onClick={() => { const b = removing(); if (b) del.mutate(b); }}>Remove</Button></>}
      >
        <p>{removing()?.name} and its logo will be removed. Cases that already use this brand keep working.</p>
      </Dialog>
    </Card>
  );
}

function RenameBrand(props: { brand: Brand | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  // Start from the brand's own name each time the dialog opens for a brand.
  createEffect(on(() => props.brand, (b) => { if (b) { setName(b.name); setError(null); } }));
  const m = createMutation(() => ({
    mutationFn: () => api(`/api/org/brands/${props.brand!.id}`, { method: 'PATCH', body: { name: name().trim() } }),
    onSuccess: () => { props.onDone(); },
    onError: (e: unknown) => setError(errorText(e)),
  }));
  return (
    <Dialog open={!!props.brand} title="Rename brand" onClose={() => props.onClose()}>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        <Show when={error()}>{(err) => <Notice tone="bad">{err()}</Notice>}</Show>
        <Field label="Brand name">{(p) => <input {...p} value={name()} onInput={(e) => setName(e.currentTarget.value)} maxLength={80} required autofocus />}</Field>
        <div class="row-end">
          <Button onClick={() => props.onClose()}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!name().trim()}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

// -------------------------------------------------------------------------------------------------------- documents

function profileFilesNote(profile: Profile, onboarding: boolean): JSX.Element {
  const max = profile.profileFiles?.max ?? (onboarding ? PROFILE_FILE_LIMIT : null);
  if (!max) return null;
  const used = profile.profileFiles?.count;
  return (
    <p class="small muted">
      Until K Line approves your company you can keep at most {formatNumber(max)} files on this page, logos and documents together.
      {typeof used === 'number' ? ` You have stored ${formatNumber(used)}.` : ''}
    </p>
  );
}

function DocumentsCard(props: { profile: Profile; canEdit: boolean; onboarding: boolean }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const docs = createQuery(() => ({ queryKey: ['org-documents'], queryFn: async () => normalizeDocuments(await api('/api/org/documents')) }));
  const [kind, setKind] = createSignal<'qc_criteria' | 'packaging' | 'other'>('qc_criteria');
  const [status, setStatus] = createSignal<Record<string, FileStatus>>({});
  const [busy, setBusy] = createSignal(false);
  const [msg, setMsg] = createSignal<Msg>(null);
  const [removing, setRemoving] = createSignal<OrgDocument | null>(null);
  const [locked, setLocked] = createSignal(false);
  const pend = usePending({ exts: DOC_EXTS, maxFiles: 20, maxBytes: () => MAX_DOC_BYTES });

  async function send() {
    setBusy(true);
    setMsg(null);
    setStatus({});
    try {
      const last: Record<string, FileStatus> = {};
      const ok = await uploadPending({ purpose: 'document', kind: kind() }, pend.pending, (k, s) => { last[k] = s; setStatus((p) => ({ ...p, [k]: s })); });
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
  createEffect(() => {
    if (Object.values(status()).some((s) => s.error?.startsWith('Uploads are locked'))) setLocked(true);
  });

  const del = createMutation(() => ({
    mutationFn: (d: OrgDocument) => api(`/api/org/documents/${d.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoving(null); setMsg({ tone: 'good', text: 'Document removed.' }); qc.invalidateQueries({ queryKey: ['org-documents'] }); qc.invalidateQueries({ queryKey: ['org-profile'] }); },
    onError: (e: unknown) => { setRemoving(null); setMsg({ tone: 'bad', text: errorText(e) }); },
  }));

  return (
    <Card title="Documents">
      <div class="stack">
        <p class="muted">Share quality control criteria, packaging instructions and similar documents with K Line. PDF, JPG and PNG files, up to {formatBytes(MAX_DOC_BYTES)} each.</p>
        {profileFilesNote(props.profile, props.onboarding)}
        <Feedback msg={msg()} />
        <Show when={locked()}><LockedNotice what="add more files" /></Show>

        <Show when={docs.isLoading}><Spinner /></Show>
        <Show when={docs.isError}><Notice tone="bad">{errorText(docs.error)}</Notice></Show>
        <Show when={docs.data && docs.data.length === 0}><Empty title="No documents yet">Files you add appear here.</Empty></Show>
        <Show when={docs.data && docs.data.length}>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Document</th><th>Type</th><th class="num">Size</th><th>Added</th><th><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                <For each={docs.data}>
                  {(d) => (
                    <tr>
                      <td><strong>{d.name}</strong>{d.state !== 'ready' ? <div><Badge tone={d.state === 'rejected' ? 'bad' : 'info'}>{d.state === 'rejected' ? 'Not accepted' : 'Checking'}</Badge>{d.problem ? <div class="small muted">{d.problem}</div> : null}</div> : null}</td>
                      <td>{documentKindLabel(d.kind)}</td>
                      <td class="num nowrap">{formatBytes(d.size)}</td>
                      <td class="nowrap">{d.createdAt ? formatDate(d.createdAt) : ''}</td>
                      <td>
                        <div class="row" style={{ gap: '6px', 'justify-content': 'flex-end', 'flex-wrap': 'nowrap' }}>
                          {can('file.download') && d.state === 'ready' ? <a class="btn btn-sm" href={`/api/files/${d.id}/download`} aria-label={`Download ${d.name}`}><Download size={14} aria-hidden="true" /> Download</a> : null}
                          {props.canEdit ? <Button size="sm" variant="danger" onClick={() => setRemoving(d)} aria-label={`Delete ${d.name}`}><Trash2 size={14} aria-hidden="true" /> Delete</Button> : null}
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        <Show when={props.canEdit}>
          <div class="stack">
            <h3>Add documents</h3>
            <Field label="What are these documents?">
              {(p) => <select {...p} value={kind()} onChange={(e) => setKind(e.currentTarget.value as 'qc_criteria' | 'packaging' | 'other')} disabled={busy()}><For each={DOCUMENT_KINDS}>{(k) => <option value={k.id}>{k.label}</option>}</For></select>}
            </Field>
            <AttachmentPicker
              pending={pend.pending}
              problems={pend.problems}
              status={status()}
              onAdd={pend.add}
              onRemove={pend.remove}
              busy={busy()}
              accept=".pdf,.jpg,.jpeg,.png"
              label="Drop documents here or choose files"
              hint="PDF, JPG or PNG"
            />
            <Show when={pend.pending.length}>
              <div class="row-end">
                <Button onClick={() => { pend.clear(); setStatus({}); }} disabled={busy()}>Clear</Button>
                <Button variant="primary" loading={busy()} onClick={send}>Upload {formatNumber(pend.pending.length)} {pend.pending.length === 1 ? 'file' : 'files'}</Button>
              </div>
            </Show>
          </div>
        </Show>
      </div>
      <Dialog
        open={!!removing()}
        title="Delete this document?"
        onClose={() => setRemoving(null)}
        footer={<><Button onClick={() => setRemoving(null)}>Keep it</Button><Button variant="danger" loading={del.isPending} onClick={() => { const d = removing(); if (d) del.mutate(d); }}>Delete</Button></>}
      >
        <p>{removing()?.name} will be deleted. K Line will no longer see it.</p>
      </Dialog>
    </Card>
  );
}

// ------------------------------------------------------------------------------------- agreements and sites (read)

function AgreementsCard() {
  const q = createQuery(() => ({ queryKey: ['org-agreements'], queryFn: async () => normalizeAgreements(await api('/api/org/agreements')) }));
  return (
    <Card title="Agreements on file">
      <p class="muted">K Line records signed agreements with you. You cannot change them here.</p>
      <Show when={q.isLoading}><Spinner /></Show>
      <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
      <Show when={q.data && q.data.length === 0}><Empty title="Nothing recorded yet">Your data processing agreement appears here once K Line has recorded it.</Empty></Show>
      <Show when={q.data && q.data.length}>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Agreement</th><th>Signed</th><th>Expires</th><th>Reference</th></tr></thead>
            <tbody>
              <For each={q.data}>
                {(a) => (
                  <tr>
                    <td><strong>{agreementLabel(a.kind)}</strong></td>
                    <td class="nowrap">{a.signedAt ? formatDate(a.signedAt) : 'Not set'}</td>
                    <td class="nowrap">{a.expiresAt ? formatDate(a.expiresAt) : 'No end date'}</td>
                    <td>{a.reference ?? ''}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Card>
  );
}

function SitesCard() {
  const q = createQuery(() => ({ queryKey: ['org-sites'], queryFn: async () => normalizeSites(await api('/api/org/sites')) }));
  return (
    <Card title="Sites where your cases are made">
      <p class="muted">K Line decides which sites can make your cases. Ask your account team if you need a change.</p>
      <Show when={q.isLoading}><Spinner /></Show>
      <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
      <Show when={q.data && q.data.length === 0}><Empty title="No sites yet">K Line adds sites when they approve your company.</Empty></Show>
      <Show when={q.data && q.data.length}>
        <ul class="attach-list">
          <For each={q.data}>
            {(s) => (
              <li class="attach-item">
                <span class="attach-meta">
                  <span class="attach-name">{s.name} <span class="muted small">{s.code}</span> {s.isDefault ? <Badge tone="info">Default</Badge> : null}</span>
                  <span class="muted small">{[s.city, countryName(s.country)].filter(Boolean).join(', ')}</span>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Card>
  );
}
