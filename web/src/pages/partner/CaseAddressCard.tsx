import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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

function AddressBlock({ a }: { a: CaseAddress }) {
  return (
    <dl className="facts">
      <dt>Company</dt><dd>{a.company}</dd>
      <dt>Recipient</dt><dd>{a.fullName}</dd>
      <dt>Address</dt><dd>{caseAddressLine(a, countryName)}</dd>
      <dt>Phone</dt><dd>{a.phone}</dd>
      <dt>Email address</dt><dd>{a.email}</dd>
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
  const [value, setValue] = useState<CaseAddress>(emptyCaseAddress());
  const [errors, setErrors] = useState<CaseAddressProblems>({});
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const userName = me?.user.name ?? '';
  const userEmail = me?.user.email ?? '';
  const orgName = me?.org?.name ?? '';
  const orgCountry = me?.org?.country ?? '';

  useEffect(() => {
    if (q.data) { setValue(startingAddress(q.data, userName, userEmail, orgName, orgCountry)); setErrors({}); }
  }, [q.data, userName, userEmail, orgName, orgCountry]);

  useEffect(() => {
    if (!q.data || loc.hash !== '#case-address') return;
    const el = document.getElementById('case-address');
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  }, [loc.hash, q.data]);

  const after = (r: unknown, text: string) => {
    qc.setQueryData(USER_CASE_ADDRESS_KEY, normalizeUserCaseAddress(r));
    setMsg({ tone: 'good', text });
  };
  const save = useMutation({
    mutationFn: (a: CaseAddress) => api('/api/account/case-address', { method: 'PUT', body: caseAddressBody(a) }),
    onSuccess: (r) => after(r, 'Your own case address is saved. It is used for the cases you send from now on.'),
    onError: (e) => {
      const fields = e instanceof ApiError && Array.isArray(e.extra.fields) ? (e.extra.fields as { path: string; message: string }[]) : [];
      const next = serverCaseAddressProblems(fields);
      setErrors(next);
      setMsg({ tone: 'bad', text: Object.keys(next).length ? 'Please check the highlighted fields.' : errorText(e) });
    },
  });
  const remove = useMutation({
    mutationFn: () => api('/api/account/case-address', { method: 'DELETE' }),
    onSuccess: (r) => { setConfirm(false); after(r, 'Your own case address is removed. Your company address is used again.'); },
    onError: (e) => { setConfirm(false); setMsg({ tone: 'bad', text: errorText(e) }); },
  });

  function submit(ev: FormEvent) {
    ev.preventDefault();
    setMsg(null);
    const p = validateCaseAddress(value);
    setErrors(p);
    const first = CASE_ADDRESS_FIELDS.find((f) => p[f]);
    if (first) { form.current?.querySelector<HTMLElement>(`[name="${ownFieldName(first)}"]`)?.focus(); return; }
    save.mutate(value);
  }

  const d = q.data;
  const badge = !d ? undefined : d.effective === 'own' ? <Badge tone="good">Your own address</Badge> : d.effective === 'company' ? <Badge tone="info">Your company's address</Badge> : <Badge tone="warn">Needed</Badge>;
  return (
    <div id="case-address" tabIndex={-1} className="anchor">
      <Card title="Case address" actions={badge}>
        {q.isLoading ? <Spinner /> : null}
        {q.isError ? <Notice tone="bad">{errorText(q.error)}</Notice> : null}
        {d ? (
          <form ref={form} onSubmit={submit} className="stack" noValidate>
            <p className="muted">
              This is where K Line sends back the direct manufacturing cases you send. If you save your own address, it is used for your cases. Without one, your company's address is used. A case that was already sent keeps the address it was sent with.
            </p>
            {d.effective === 'own' ? <Notice tone="info">Your cases are sent with your own address.</Notice> : null}
            {d.effective === 'company' ? <Notice tone="info">Your cases are sent with your company's address, shown below. Save an address of your own to use a different one.</Notice> : null}
            {d.effective === 'none' ? (
              <Notice tone="warn" title="Add a case address">
                Direct manufacturing stays blocked for you until you save a complete address here{can('org.edit') ? ' or in the company profile' : ', or an administrator adds the company address'}.
              </Notice>
            ) : null}
            <div role="status">{msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}</div>

            {d.company ? (
              <details open={d.effective === 'company'}>
                <summary>Company address{d.companyComplete ? '' : ' (incomplete)'}</summary>
                <AddressBlock a={d.company} />
                <p className="small muted">
                  {can('org.edit') ? <>You can change it in the <Link to="/portal/company#case-address">company profile</Link>.</> : 'Only an administrator can change it.'}
                </p>
              </details>
            ) : null}

            <h3>{d.own ? 'Your own address' : 'Add an address of your own'}</h3>
            {!d.own && d.company ? <p className="small muted">We started with your company address, so you only need to change what is different.</p> : null}
            <CaseAddressFields value={value} errors={errors} onChange={(f, v) => setValue((a) => ({ ...a, [f]: v }))} fields={CASE_ADDRESS_FIELDS} names={FIELD_NAMES} />
            <div className="row">
              <Button type="submit" variant="primary" loading={save.isPending}>Save my case address</Button>
              {d.own ? <Button type="button" onClick={() => setConfirm(true)}>Use the company address instead</Button> : null}
            </div>
          </form>
        ) : null}
      </Card>
      <Dialog
        open={confirm}
        title="Use the company address instead?"
        onClose={() => setConfirm(false)}
        footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" loading={remove.isPending} onClick={() => remove.mutate()}>Remove my address</Button></>}
      >
        <p>
          Your own case address will be removed. The cases you send from now on use your company's address
          {d?.companyComplete ? '' : ', which is not complete yet, so Direct manufacturing stays blocked until it is'}. Cases already sent keep the address they were sent with.
        </p>
      </Dialog>
    </div>
  );
}
