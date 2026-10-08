import { createEffect, createSignal, Show } from 'solid-js';
import { A, useLocation } from '@solidjs/router';
import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { api, ApiError, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  CASE_ADDRESS_FIELDS, caseAddressBody, caseAddressLine, emptyCaseAddress, serverCaseAddressProblems, validateCaseAddress,
  type CaseAddress, type CaseAddressProblems,
} from '../../lib/caseAddress';
import { USER_CASE_ADDRESS_KEY, normalizeUserCaseAddress, useUserCaseAddress, type UserCaseAddress } from '../../lib/orgApi';
import { countryName } from '../../lib/signup';
import { Badge, Button, Card, Dialog, Notice, Spinner } from '../../ui/Common';
import { CaseAddressFields } from '../../ui/CaseAddressFields';

const ownFieldName = (f: string) => `own${f.charAt(0).toUpperCase()}${f.slice(1)}`;
const FIELD_NAMES = Object.fromEntries(CASE_ADDRESS_FIELDS.map((f) => [f, ownFieldName(f)]));

function AddressBlock(props: { a: CaseAddress }) {
  return (
    <dl class="facts">
      <dt>Company</dt><dd>{props.a.company}</dd>
      <dt>Recipient</dt><dd>{props.a.fullName}</dd>
      <dt>Address</dt><dd>{caseAddressLine(props.a, countryName)}</dd>
      <dt>Phone</dt><dd>{props.a.phone}</dd>
      <dt>Email address</dt><dd>{props.a.email}</dd>
    </dl>
  );
}

/** What the form starts with: the saved own address, else the company address as a template with this person's name and email. */
function startingAddress(d: UserCaseAddress, name: string, email: string, orgName: string, country: string): CaseAddress {
  if (d.own) return { ...emptyCaseAddress(), ...d.own };
  const base = d.company ? { ...emptyCaseAddress(), ...d.company } : { ...emptyCaseAddress(), company: orgName, country };
  return { ...base, fullName: name, email };
}

/**
 * Every partner person can keep a case address of their own (Account page). It is used for the direct manufacturing cases they send.
 * Without one, the company address (company profile) is used. The server decides which one applies; this card only shows it.
 */
export function CaseAddressCard() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const loc = useLocation();
  const q = useUserCaseAddress();
  const [value, setValue] = createSignal<CaseAddress>(emptyCaseAddress());
  const [errors, setErrors] = createSignal<CaseAddressProblems>({});
  const [msg, setMsg] = createSignal<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [confirm, setConfirm] = createSignal(false);
  let form!: HTMLFormElement;
  const userName = () => me()?.user.name ?? '';
  const userEmail = () => me()?.user.email ?? '';
  const orgName = () => me()?.org?.name ?? '';
  const orgCountry = () => me()?.org?.country ?? '';

  createEffect(() => {
    const d = q.data;
    const name = userName();
    const email = userEmail();
    const org = orgName();
    const country = orgCountry();
    if (d) { setValue(startingAddress(d, name, email, org, country)); setErrors({}); }
  });

  createEffect(() => {
    if (!q.data || loc.hash !== '#case-address') return;
    const el = document.getElementById('case-address');
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  });

  const after = (r: unknown, text: string) => {
    qc.setQueryData(USER_CASE_ADDRESS_KEY, normalizeUserCaseAddress(r));
    setMsg({ tone: 'good', text });
  };
  const save = createMutation(() => ({
    mutationFn: (a: CaseAddress) => api('/api/account/case-address', { method: 'PUT', body: caseAddressBody(a) }),
    onSuccess: (r: unknown) => after(r, 'Your own case address is saved. It is used for the cases you send from now on.'),
    onError: (e: unknown) => {
      const fields = e instanceof ApiError && Array.isArray(e.extra.fields) ? (e.extra.fields as { path: string; message: string }[]) : [];
      const next = serverCaseAddressProblems(fields);
      setErrors(next);
      setMsg({ tone: 'bad', text: Object.keys(next).length ? 'Please check the highlighted fields.' : errorText(e) });
    },
  }));
  const remove = createMutation(() => ({
    mutationFn: () => api('/api/account/case-address', { method: 'DELETE' }),
    onSuccess: (r: unknown) => { setConfirm(false); after(r, 'Your own case address is removed. Your company address is used again.'); },
    onError: (e: unknown) => { setConfirm(false); setMsg({ tone: 'bad', text: errorText(e) }); },
  }));

  function submit(ev: SubmitEvent) {
    ev.preventDefault();
    setMsg(null);
    const p = validateCaseAddress(value());
    setErrors(p);
    const first = CASE_ADDRESS_FIELDS.find((f) => p[f]);
    if (first) { form.querySelector<HTMLElement>(`[name="${ownFieldName(first)}"]`)?.focus(); return; }
    save.mutate(value());
  }

  const badge = () => {
    const d = q.data;
    return !d ? undefined : d.effective === 'own' ? <Badge tone="good">Your own address</Badge> : d.effective === 'company' ? <Badge tone="info">Your company's address</Badge> : <Badge tone="warn">Needed</Badge>;
  };
  return (
    <div id="case-address" tabIndex={-1} class="anchor">
      <Card title="Case address" actions={badge()}>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.data}>
          {(d) => (
            <form ref={form} onSubmit={submit} class="stack" noValidate>
              <p class="muted">
                This is where K Line sends back the direct manufacturing cases you send. If you save your own address, it is used for your cases. Without one, your company's address is used. A case that was already sent keeps the address it was sent with.
              </p>
              <Show when={d().effective === 'own'}><Notice tone="info">Your cases are sent with your own address.</Notice></Show>
              <Show when={d().effective === 'company'}><Notice tone="info">Your cases are sent with your company's address, shown below. Save an address of your own to use a different one.</Notice></Show>
              <Show when={d().effective === 'none'}>
                <Notice tone="warn" title="Add a case address">
                  Direct manufacturing stays blocked for you until you save a complete address here{can('org.edit') ? ' or in the company profile' : ', or an administrator adds the company address'}.
                </Notice>
              </Show>
              <div role="status"><Show when={msg()}>{(m) => <Notice tone={m().tone}>{m().text}</Notice>}</Show></div>

              <Show when={d().company}>
                {(company) => (
                  <details open={d().effective === 'company'}>
                    <summary>Company address{d().companyComplete ? '' : ' (incomplete)'}</summary>
                    <AddressBlock a={company()} />
                    <p class="small muted">
                      {can('org.edit') ? <>You can change it in the <A href="/portal/company#case-address">company profile</A>.</> : 'Only an administrator can change it.'}
                    </p>
                  </details>
                )}
              </Show>

              <h3>{d().own ? 'Your own address' : 'Add an address of your own'}</h3>
              <Show when={!d().own && d().company}><p class="small muted">We started with your company address, so you only need to change what is different.</p></Show>
              <CaseAddressFields value={value()} errors={errors()} onChange={(f, v) => setValue((a) => ({ ...a, [f]: v }))} fields={CASE_ADDRESS_FIELDS} names={FIELD_NAMES} />
              <div class="row">
                <Button type="submit" variant="primary" loading={save.isPending}>Save my case address</Button>
                <Show when={d().own}><Button type="button" onClick={() => setConfirm(true)}>Use the company address instead</Button></Show>
              </div>
            </form>
          )}
        </Show>
      </Card>
      <Dialog
        open={confirm()}
        title="Use the company address instead?"
        onClose={() => setConfirm(false)}
        footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" loading={remove.isPending} onClick={() => remove.mutate()}>Remove my address</Button></>}
      >
        <p>
          Your own case address will be removed. The cases you send from now on use your company's address
          {q.data?.companyComplete ? '' : ', which is not complete yet, so Direct manufacturing stays blocked until it is'}. Cases already sent keep the address they were sent with.
        </p>
      </Dialog>
    </div>
  );
}
