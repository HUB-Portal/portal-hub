import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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
  const [companyName, setCompanyName] = useState('');
  const [country, setCountry] = useState('');
  const [personName, setPersonName] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [volume, setVolume] = useState('');
  const [acceptAuthority, setAcceptAuthority] = useState(false);
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [hp, setHp] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [address, setAddress] = useState<CaseAddress>(emptyCaseAddress());
  const [addressTouched, setAddressTouched] = useState(false); // once the person picks a case country, we stop following the company country
  const [addressErrors, setAddressErrors] = useState<AddressErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const demo = useQuery({
    queryKey: ['demo-registrations'],
    enabled: sentTo !== null,
    queryFn: async () => normalizeDemoRegistrations(await api<unknown>('/api/demo/registrations', { quiet401: true })),
    retry: false,
    staleTime: 0,
  });

  const shownAddress: CaseAddress = { ...address, country: addressTouched ? address.country : country };

  function changeAddress(field: CaseAddressField, v: string) {
    if (field === 'country') setAddressTouched(true);
    setAddress((a) => ({ ...a, [field]: v }));
  }

  function check(): Errors {
    const e: Errors = {};
    const c = nameProblem(companyName, 'company'); if (c) e.companyName = c;
    if (!country) e.country = 'Choose the country where your company is based.';
    const p = nameProblem(personName, 'person'); if (p) e.personName = p;
    const m = emailProblem(email); if (m) e.email = m;
    const w = websiteProblem(website); if (w) e.website = w;
    if (!acceptAuthority) e.acceptAuthority = 'Please confirm that you may register this company.';
    if (!acceptPrivacy) e.acceptPrivacy = 'Please confirm that you have read the privacy notice.';
    return e;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setFormError(null);
    const e = check();
    const ae = validateCaseAddress(shownAddress, ADDRESS_FIELDS);
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
          companyName: companyName.trim(), country, personName: personName.trim(), email: email.trim(),
          ...(website.trim() ? { website: website.trim() } : {}),
          ...(volume ? { volume } : {}),
          caseAddress: {
            street: shownAddress.street.trim(), city: shownAddress.city.trim(), postalCode: shownAddress.postalCode.trim(),
            stateProvince: shownAddress.stateProvince.trim(), country: shownAddress.country, phone: shownAddress.phone.trim(),
          },
          acceptAuthority: true, acceptPrivacy: true,
          privacyVersion: config.data?.privacyVersion ?? PRIVACY_VERSION,
          ...(hp ? { hp } : {}),
        },
      });
      // The same message every time, whatever happened on the server.
      setSentTo(email.trim());
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

  if (config.isLoading) return <AuthLayout title="Register your company"><Spinner /></AuthLayout>;

  if (config.data && !config.data.signupEnabled) {
    return (
      <AuthLayout title="Register your company">
        <Notice tone="info">Online registration is closed at the moment. {config.data.supportEmail ? <>Please write to <a href={`mailto:${config.data.supportEmail}`}>{config.data.supportEmail}</a> and we will help you.</> : 'Please contact your K Line account team.'}</Notice>
        <p className="small"><Link to="/login">Back to sign in</Link></p>
      </AuthLayout>
    );
  }

  if (sentTo !== null) {
    return (
      <AuthLayout title="Check your email" wide>
        <Notice tone="good" title="We have sent you an email">
          If the details are right, a message with a link is on its way to the address you gave. The link works for 48 hours. It can take a few minutes to arrive, so check your spam folder too.
        </Notice>
        <p className="small muted">After you confirm your email address and choose a password, K Line reviews your company. You can sign in and set up your profile while you wait.</p>
        {demo.data && demo.data.length ? (
          <div className="demo-box">
            <strong>Demo only: confirmation links</strong>
            <p className="small muted">In the demo no email leaves this computer. Open a link here to carry on.</p>
            <div className="demo-list">
              {demo.data.map((d) => (
                <Link key={d.key} to={d.path} className="demo-item">
                  <span><strong>{d.label}</strong>{d.email && d.email !== d.label ? <><br /><span className="small muted">{d.email}</span></> : null}</span>
                  <span className="small">Open</span>
                </Link>
              ))}
            </div>
          </div>
        ) : null}
        <p className="small"><Link to="/login">Back to sign in</Link></p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Register your company" intro="Tell us who you are and we will email you a link to confirm your address. K Line then reviews your company before you can send cases." wide>
      <form onSubmit={submit} className="stack" noValidate>
        {formError ? <Notice tone="bad">{formError}</Notice> : null}
        <Field label="Company name" error={errors.companyName}>
          {(p) => <input {...p} name="companyName" value={companyName} onChange={(e) => setCompanyName(e.target.value)} maxLength={120} autoComplete="organization" required autoFocus />}
        </Field>
        <Field label="Country" error={errors.country}>
          {(p) => (
            <select {...p} name="country" value={country} onChange={(e) => setCountry(e.target.value)} autoComplete="country" required>
              <option value="">Choose a country</option>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Your full name" error={errors.personName}>
          {(p) => <input {...p} name="personName" value={personName} onChange={(e) => setPersonName(e.target.value)} maxLength={120} autoComplete="name" required />}
        </Field>
        <Field label="Work email address" hint="Use your company address. We send the confirmation link here." error={errors.email}>
          {(p) => <input {...p} name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />}
        </Field>
        <Field label="Company website (optional)" hint="For example https://www.example.com" error={errors.website}>
          {(p) => <input {...p} name="website" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} maxLength={200} autoComplete="url" />}
        </Field>
        <Field label="How many cases do you expect to send each year? (optional)" error={errors.volume}>
          {(p) => (
            <select {...p} name="volume" value={volume} onChange={(e) => setVolume(e.target.value)}>
              <option value="">I am not sure yet</option>
              {VOLUME_BANDS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          )}
        </Field>

        <section className="stack" aria-labelledby="reg-case-address">
          <h2 id="reg-case-address">Case address</h2>
          <p className="small muted">{CASE_ADDRESS_INTRO} We use your name, company name and email address on the delivery label to start with.</p>
          <CaseAddressFields value={shownAddress} errors={addressErrors} onChange={changeAddress} fields={ADDRESS_FIELDS} names={ADDRESS_NAMES} />
          <p className="small muted">Your logo is needed as well. You will add your logo after you sign in.</p>
        </section>

        {/* Honeypot: people never see or reach this field. Bots tend to fill it in. */}
        <div style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }} aria-hidden="true">
          <label htmlFor="reg-hp">Leave this field empty</label>
          <input id="reg-hp" name="hp" type="text" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} />
        </div>

        <div className="stack-sm">
          <div className="check">
            <input id="reg-acceptAuthority" name="acceptAuthority" type="checkbox" checked={acceptAuthority} onChange={(e) => setAcceptAuthority(e.target.checked)} aria-invalid={errors.acceptAuthority ? true : undefined} aria-describedby={errors.acceptAuthority ? 'reg-acceptAuthority-e' : undefined} />
            <label htmlFor="reg-acceptAuthority">I am allowed to register this company with K Line.</label>
            {errors.acceptAuthority ? <p className="field-error" id="reg-acceptAuthority-e" role="alert" style={{ gridColumn: 2 }}>{errors.acceptAuthority}</p> : null}
          </div>
          <div className="check">
            <input id="reg-acceptPrivacy" name="acceptPrivacy" type="checkbox" checked={acceptPrivacy} onChange={(e) => setAcceptPrivacy(e.target.checked)} aria-invalid={errors.acceptPrivacy ? true : undefined} aria-describedby={errors.acceptPrivacy ? 'reg-acceptPrivacy-e' : undefined} />
            <label htmlFor="reg-acceptPrivacy">I have read the <Link to="/privacy" target="_blank" rel="noopener">privacy notice</Link>.</label>
            {errors.acceptPrivacy ? <p className="field-error" id="reg-acceptPrivacy-e" role="alert" style={{ gridColumn: 2 }}>{errors.acceptPrivacy}</p> : null}
          </div>
        </div>

        <Button type="submit" variant="primary" loading={busy}>Register</Button>
        <p className="small">Already registered? <Link to="/login">Sign in</Link></p>
        <p className="small"><Link to="/getting-started">How it works</Link></p>
      </form>
    </AuthLayout>
  );
}
