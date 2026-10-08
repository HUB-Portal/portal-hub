import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { A, useLocation } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { ImagePlus, Trash2 } from 'lucide-solid';
import { api, ApiError, errorText } from '../../lib/api';
import { MENU_KEYS, type MenuKey, type MenuSetting } from '@shared/menu';
import { useAuth } from '../../lib/auth';
import { CASE_ADDRESS_FIELDS, CASE_ADDRESS_INTRO, caseAddressBody, emptyCaseAddress, serverCaseAddressProblems, validateCaseAddress, type CaseAddress, type CaseAddressField, type CaseAddressProblems } from '../../lib/caseAddress';
import { formatBytes, formatNumber } from '../../lib/format';
import { LOGO_RULES, checkLogoFile, type LogoCheck } from '../../lib/logoCheck';
import {
  isNotApproved, normalizeProfile, profileBody, useOrgLogo, USER_CASE_ADDRESS_KEY, type Profile,
} from '../../lib/orgApi';
import { blobSource } from '../../lib/source';
import { uploadCaseFiles, type FileStatus, type UploadSpec } from '../../lib/upload';
import { Badge, Button, Card, Dialog, Notice, PageHeader, Spinner, Toggle } from '../../ui/Common';
import { CaseAddressFields } from '../../ui/CaseAddressFields';
import { LockedNotice } from '../../ui/Locked';
import { OrgLogoImage } from '../../ui/OrgLogo';

const LOGO_EXTS = ['png', 'jpg', 'jpeg', 'svg'];
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

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
      <PageHeader title="Company profile" subtitle="Where K Line sends your cases back to, and how your company appears to your team." />
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
            <div id="case-address" tabIndex={-1} class="anchor"><CaseAddressCard profile={profile()} canEdit={canEdit()} /></div>
            <div id="logo" tabIndex={-1} class="anchor"><LogoCard profile={profile()} canEdit={canLogo()} onboarding={onboarding()} /></div>
            <Show when={canEdit()}><MenuCard /></Show>
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
      setMsg({ tone: 'good', text: 'Your shipping address is saved.' });
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
    <Card title="Shipping address" actions={complete() === undefined ? undefined : <Badge tone={complete() ? 'good' : 'warn'}>{complete() ? 'Complete' : 'Needed'}</Badge>}>
      <form ref={form} onSubmit={submit} class="stack" noValidate>
        <p class="muted">{CASE_ADDRESS_INTRO} It goes on the label of every case you send with Direct manufacturing, so the carrier knows who receives it. A case that has already been sent keeps the address it was sent with.</p>
        <Show when={complete() === false}>
          <Notice tone="warn" title="Add your shipping address">
            Direct manufacturing stays blocked until you save a complete shipping address.{!props.profile.caseAddress ? ' We started with your company address. Check it, add the missing details and save.' : ''}
          </Notice>
        </Show>
        <Feedback msg={msg()} />
        <fieldset class="plain-fieldset stack" disabled={!props.canEdit}>
          <legend class="sr-only">Shipping address</legend>
          <CaseAddressFields value={value()} errors={errors()} onChange={(f, v) => setValue((a) => ({ ...a, [f]: v }))} fields={CASE_ADDRESS_FIELDS} />
        </fieldset>
        <Show when={props.canEdit}><div><Button type="submit" variant="primary" loading={save.isPending}>Save shipping address</Button></div></Show>
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

