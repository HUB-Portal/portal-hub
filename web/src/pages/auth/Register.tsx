import { createSignal, For, Match, Show, Switch } from 'solid-js';
import { A } from '@solidjs/router';
import { createQuery } from '@tanstack/solid-query';
import { api, ApiError } from '../../lib/api';
import { normalizeDemoRegistrations, usePublicConfig } from '../../lib/orgApi';
import { COUNTRIES, VOLUME_BANDS, PRIVACY_VERSION, emailProblem, nameProblem, websiteProblem } from '../../lib/signup';
import { CASE_ADDRESS_INTRO, emptyCaseAddress, serverCaseAddressProblems, validateCaseAddress, type CaseAddress, type CaseAddressField } from '../../lib/caseAddress';
import { Button, Field, Notice, Spinner } from '../../ui/Common';
import { CaseAddressFields } from '../../ui/CaseAddressFields';
import { AuthLayout } from './AuthLayout';

type FieldName = 'companyName' | 'country' | 'personName' | 'email' | 'website' | 'volume' | 'acceptAuthority' | 'acceptPrivacy';
type Errors = Partial<Record<FieldName, string>>;

const FIELD_NAMES: FieldName[] = ['companyName', 'country', 'personName', 'email', 'website', 'volume', 'acceptAuthority', 'acceptPrivacy'];

// The case address section. Recipient name, company and email are not asked here: they start as the registrant's own details.
const ADDRESS_FIELDS: CaseAddressField[] = ['street', 'postalCode', 'city', 'stateProvince', 'country', 'phone'];
const ADDRESS_NAMES: Partial<Record<CaseAddressField, string>> = {
  street: 'caseStreet', postalCode: 'casePostalCode', city: 'caseCity', stateProvince: 'caseStateProvince', country: 'caseCountry', phone: 'casePhone',
};
type AddressErrors = Partial<Record<CaseAddressField, string>>;

export default function Register() {
  const config = usePublicConfig();
  const [companyName, setCompanyName] = createSignal('');
  const [country, setCountry] = createSignal('');
  const [personName, setPersonName] = createSignal('');
  const [email, setEmail] = createSignal('');
  const [website, setWebsite] = createSignal('');
  const [volume, setVolume] = createSignal('');
  const [acceptAuthority, setAcceptAuthority] = createSignal(false);
  const [acceptPrivacy, setAcceptPrivacy] = createSignal(false);
  const [hp, setHp] = createSignal('');
  const [errors, setErrors] = createSignal<Errors>({});
  const [address, setAddress] = createSignal<CaseAddress>(emptyCaseAddress());
  const [addressTouched, setAddressTouched] = createSignal(false); // once the person picks a case country, we stop following the company country
  const [addressErrors, setAddressErrors] = createSignal<AddressErrors>({});
  const [formError, setFormError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [sentTo, setSentTo] = createSignal<string | null>(null);

  const demo = createQuery(() => ({
    queryKey: ['demo-registrations'],
    enabled: sentTo() !== null,
    queryFn: async () => normalizeDemoRegistrations(await api<unknown>('/api/demo/registrations', { quiet401: true })),
    retry: false,
    staleTime: 0,
  }));

  const shownAddress = (): CaseAddress => ({ ...address(), country: addressTouched() ? address().country : country() });

  function changeAddress(field: CaseAddressField, v: string) {
    if (field === 'country') setAddressTouched(true);
    setAddress((a) => ({ ...a, [field]: v }));
  }

  function check(): Errors {
    const e: Errors = {};
    const c = nameProblem(companyName(), 'company'); if (c) e.companyName = c;
    if (!country()) e.country = 'Choose the country where your company is based.';
    const p = nameProblem(personName(), 'person'); if (p) e.personName = p;
    const m = emailProblem(email()); if (m) e.email = m;
    const w = websiteProblem(website()); if (w) e.website = w;
    if (!acceptAuthority()) e.acceptAuthority = 'Please confirm that you may register this company.';
    if (!acceptPrivacy()) e.acceptPrivacy = 'Please confirm that you have read the privacy notice.';
    return e;
  }

  async function submit(ev: SubmitEvent) {
    ev.preventDefault();
    setFormError(null);
    const e = check();
    const addr = shownAddress();
    const ae = validateCaseAddress(addr, ADDRESS_FIELDS);
    setErrors(e);
    setAddressErrors(ae);
    if (Object.keys(e).length || Object.keys(ae).length) {
      const first = FIELD_NAMES.find((k) => e[k]);
      const firstAddress = ADDRESS_FIELDS.find((k) => ae[k]);
      const target = first ?? (firstAddress ? ADDRESS_NAMES[firstAddress] : undefined);
      if (target) document.querySelector<HTMLElement>(`[name="${target}"]`)?.focus();
      return;
    }
    setBusy(true);
    try {
      await api('/api/auth/register', {
        method: 'POST',
        quiet401: true,
        body: {
          companyName: companyName().trim(), country: country(), personName: personName().trim(), email: email().trim(),
          ...(website().trim() ? { website: website().trim() } : {}),
          ...(volume() ? { volume: volume() } : {}),
          caseAddress: {
            street: addr.street.trim(), city: addr.city.trim(), postalCode: addr.postalCode.trim(),
            stateProvince: addr.stateProvince.trim(), country: addr.country, phone: addr.phone.trim(),
          },
          acceptAuthority: true, acceptPrivacy: true,
          privacyVersion: config.data?.privacyVersion ?? PRIVACY_VERSION,
          ...(hp() ? { hp: hp() } : {}),
        },
      });
      // The same message every time, whatever happened on the server.
      setSentTo(email().trim());
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setFormError('Too many attempts from this network. Please wait ten minutes and try again.');
      } else if (err instanceof ApiError && err.status === 400) {
        const fields = Array.isArray(err.extra.fields) ? (err.extra.fields as { path: string; message: string }[]) : [];
        const next: Errors = {};
        const other: string[] = [];
        const addressNext = serverCaseAddressProblems(fields);
        setAddressErrors(addressNext);
        for (const f of fields) {
          if (f.path.startsWith('caseAddress')) continue;
          if ((FIELD_NAMES as string[]).includes(f.path)) next[f.path as FieldName] = f.message;
          else if (f.message) other.push(f.message);
        }
        if (err.code === 'email_not_allowed' && !next.email) next.email = err.message;
        setErrors(next);
        setFormError(other.length ? other.join(' ') : Object.keys(next).length || Object.keys(addressNext).length ? 'Please check the highlighted fields.' : err.message);
      } else if (err instanceof ApiError && err.code === 'signup_disabled') {
        setFormError('Online registration is closed at the moment. Please contact your K Line account team.');
      } else {
        setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Switch>
      <Match when={config.isLoading}>
        <AuthLayout title="Register your company"><Spinner /></AuthLayout>
      </Match>

      <Match when={config.data && !config.data.signupEnabled}>
        <AuthLayout title="Register your company">
          <Notice tone="info">Online registration is closed at the moment. <Show when={config.data?.supportEmail} fallback="Please contact your K Line account team.">{(mail) => <>Please write to <a href={`mailto:${mail()}`}>{mail()}</a> and we will help you.</>}</Show></Notice>
          <p class="small"><A href="/login">Back to sign in</A></p>
        </AuthLayout>
      </Match>

      <Match when={sentTo() !== null}>
        <AuthLayout title="Check your email" wide>
          <Notice tone="good" title="We have sent you an email">
            If the details are right, a message with a link is on its way to the address you gave. The link works for 48 hours. It can take a few minutes to arrive, so check your spam folder too.
          </Notice>
          <p class="small muted">After you confirm your email address and choose a password, K Line reviews your company. You can sign in and set up your profile while you wait.</p>
          <Show when={demo.data?.length}>
            <div class="demo-box">
              <strong>Demo only: confirmation links</strong>
              <p class="small muted">In the demo no email leaves this computer. Open a link here to carry on.</p>
              <div class="demo-list">
                <For each={demo.data}>
                  {(d) => (
                    <A href={d.path} class="demo-item">
                      <span><strong>{d.label}</strong>{d.email && d.email !== d.label ? <><br /><span class="small muted">{d.email}</span></> : null}</span>
                      <span class="small">Open</span>
                    </A>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <p class="small"><A href="/login">Back to sign in</A></p>
        </AuthLayout>
      </Match>

      <Match when={true}>
        <AuthLayout title="Register your company" intro="Tell us who you are and we will email you a link to confirm your address. K Line then reviews your company before you can send cases." wide>
          <form onSubmit={submit} class="stack" noValidate>
            <Show when={formError()}><Notice tone="bad">{formError()}</Notice></Show>
            <Field label="Company name" error={errors().companyName}>
              {(p) => <input {...p} name="companyName" value={companyName()} onInput={(e) => setCompanyName(e.currentTarget.value)} maxLength={120} autocomplete="organization" required autofocus />}
            </Field>
            <Field label="Country" error={errors().country}>
              {(p) => (
                <select {...p} name="country" value={country()} onChange={(e) => setCountry(e.currentTarget.value)} autocomplete="country" required>
                  <option value="" selected={country() === ''}>Choose a country</option>
                  <For each={COUNTRIES}>{(c) => <option value={c.code} selected={country() === c.code}>{c.name}</option>}</For>
                </select>
              )}
            </Field>
            <Field label="Your full name" error={errors().personName}>
              {(p) => <input {...p} name="personName" value={personName()} onInput={(e) => setPersonName(e.currentTarget.value)} maxLength={120} autocomplete="name" required />}
            </Field>
            <Field label="Work email address" hint="Use your company address. We send the confirmation link here." error={errors().email}>
              {(p) => <input {...p} name="email" type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} autocomplete="email" required />}
            </Field>
            <Field label="Company website (optional)" hint="For example https://www.example.com" error={errors().website}>
              {(p) => <input {...p} name="website" type="url" value={website()} onInput={(e) => setWebsite(e.currentTarget.value)} maxLength={200} autocomplete="url" />}
            </Field>
            <Field label="How many cases do you expect to send each year? (optional)" error={errors().volume}>
              {(p) => (
                <select {...p} name="volume" value={volume()} onChange={(e) => setVolume(e.currentTarget.value)}>
                  <option value="" selected={volume() === ''}>I am not sure yet</option>
                  <For each={VOLUME_BANDS}>{(v) => <option value={v.id} selected={volume() === v.id}>{v.label}</option>}</For>
                </select>
              )}
            </Field>

            <section class="stack" aria-labelledby="reg-case-address">
              <h2 id="reg-case-address">Case address</h2>
              <p class="small muted">{CASE_ADDRESS_INTRO} We use your name, company name and email address on the delivery label to start with.</p>
              <CaseAddressFields value={shownAddress()} errors={addressErrors()} onChange={changeAddress} fields={ADDRESS_FIELDS} names={ADDRESS_NAMES} />
              <p class="small muted">Your logo is needed as well. You will add your logo after you sign in.</p>
            </section>

            {/* Honeypot: people never see or reach this field. Bots tend to fill it in. */}
            <div style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px', overflow: 'hidden' }} aria-hidden="true">
              <label for="reg-hp">Leave this field empty</label>
              <input id="reg-hp" name="hp" type="text" tabIndex={-1} autocomplete="off" value={hp()} onInput={(e) => setHp(e.currentTarget.value)} />
            </div>

            <div class="stack-sm">
              <div class="check">
                <input id="reg-acceptAuthority" name="acceptAuthority" type="checkbox" checked={acceptAuthority()} onChange={(e) => setAcceptAuthority(e.currentTarget.checked)} aria-invalid={errors().acceptAuthority ? true : undefined} aria-describedby={errors().acceptAuthority ? 'reg-acceptAuthority-e' : undefined} />
                <label for="reg-acceptAuthority">I am allowed to register this company with K Line.</label>
                <Show when={errors().acceptAuthority}><p class="field-error" id="reg-acceptAuthority-e" role="alert" style={{ 'grid-column': '2' }}>{errors().acceptAuthority}</p></Show>
              </div>
              <div class="check">
                <input id="reg-acceptPrivacy" name="acceptPrivacy" type="checkbox" checked={acceptPrivacy()} onChange={(e) => setAcceptPrivacy(e.currentTarget.checked)} aria-invalid={errors().acceptPrivacy ? true : undefined} aria-describedby={errors().acceptPrivacy ? 'reg-acceptPrivacy-e' : undefined} />
                <label for="reg-acceptPrivacy">I have read the <A href="/privacy" target="_blank" rel="noopener">privacy notice</A>.</label>
                <Show when={errors().acceptPrivacy}><p class="field-error" id="reg-acceptPrivacy-e" role="alert" style={{ 'grid-column': '2' }}>{errors().acceptPrivacy}</p></Show>
              </div>
            </div>

            <Button type="submit" variant="primary" loading={busy()}>Register</Button>
            <p class="small">Already registered? <A href="/login">Sign in</A></p>
            <p class="small"><A href="/getting-started">How it works</A></p>
          </form>
        </AuthLayout>
      </Match>
    </Switch>
  );
}
