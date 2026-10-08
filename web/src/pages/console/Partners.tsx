import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { A, useLocation, useNavigate, useSearchParams } from '@solidjs/router';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
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

export function PartnerStatus(props: { status: string; declined?: boolean }) {
  const s = () => PARTNER_STATUS[props.status] ?? { label: props.status, tone: 'warn' as const };
  return (
    <Show when={!props.declined} fallback={<Badge tone="bad">Declined</Badge>}>
      <Badge tone={s().tone}>{s().label}</Badge>
    </Show>
  );
}

/** Badges for companies that registered themselves. */
export function SignupBadges(props: { p: Pick<PartnerRow, 'newSignup' | 'emailNotConfirmed' | 'declined' | 'freeEmail'> }) {
  return (
    <Show when={props.p.newSignup || props.p.emailNotConfirmed || props.p.declined || props.p.freeEmail}>
      <span class="badge-row">
        {props.p.newSignup && !props.p.declined ? <Badge tone="info">New sign up</Badge> : null}
        {props.p.emailNotConfirmed && !props.p.declined ? <Badge tone="warn">Email not confirmed</Badge> : null}
        {props.p.declined ? <Badge tone="bad">Declined</Badge> : null}
        {props.p.freeEmail ? <Badge tone="neutral" title="They registered with a personal mailbox, not a company address">Personal email</Badge> : null}
      </span>
    </Show>
  );
}

/** A search parameter as plain text: empty when it is missing. */
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

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
  const tab = (): Tab => (params.tab === 'review' || params.tab === 'declined' ? params.tab : 'all');
  const [text, setText] = createSignal(one(params.search));
  const [search, setSearch] = createSignal(text());
  const [adding, setAdding] = createSignal(false);
  const flash = () => (loc.state as { notice?: string } | null)?.notice ?? null;

  createEffect(() => {
    const t = text();
    const h = setTimeout(() => setSearch(t.trim()), 300);
    onCleanup(() => clearTimeout(h));
  });

  const q = createQuery(() => ({
    queryKey: ['partners', tab(), search()],
    queryFn: () => api<PartnerList>(`/api/partners?tab=${tab()}${search() ? `&search=${encodeURIComponent(search())}` : ''}`),
  }));
  const rows = () => q.data?.items ?? [];
  const showRegistered = () => rows().some((r) => r.signupAt);
  const showDeletes = () => tab() === 'declined' && rows().some((r) => r.deletesAt);

  function pick(t: Tab) {
    setParams({ tab: t === 'all' ? undefined : t }, { replace: true });
  }

  return (
    <div class="page">
      <PageHeader
        title="Partners"
        subtitle="Partner organisations, their agreements and where their cases may be made."
        actions={<Button variant="primary" onClick={() => setAdding(true)}>Add partner</Button>}
      />
      <Show when={flash()}>{(f) => <Notice tone="good">{f()}</Notice>}</Show>
      <Card>
        <div class="toolbar">
          <div class="tabs" role="group" aria-label="Show">
            <For each={TABS}>
              {(t) => (
                <button type="button" class="tab" aria-pressed={tab() === t.id} onClick={() => pick(t.id)}>
                  {t.label}
                  {q.data?.counts && q.data.counts[t.id] > 0 ? <span class="tab-count">{formatNumber(q.data.counts[t.id])}</span> : null}
                </button>
              )}
            </For>
          </div>
          <Field label="Search partners" class="grow">
            {(p) => <input {...p} type="search" value={text()} onInput={(e) => setText(e.currentTarget.value)} placeholder="Name or code" autocomplete="off" />}
          </Field>
        </div>
        <Show when={q.isLoading}><Spinner /></Show>
        <Show when={q.isError}><Notice tone="bad">{errorText(q.error)}</Notice></Show>
        <Show when={q.data && rows().length === 0}><Empty title={search() ? 'No partners match your search' : EMPTY[tab()].title}>{search() ? 'Try a different name or code.' : EMPTY[tab()].text}</Empty></Show>
        <Show when={rows().length}>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Partner</th><th>Status</th><th>Country</th>
                  <Show when={showRegistered()}><th>Registered</th></Show>
                  <Show when={showDeletes()}><th>Deleted on</th></Show>
                  <th>DPA</th><th>SCC</th><th class="num">Sites</th><th class="num">People</th><th class="num">Open cases</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(p) => (
                    <tr>
                      <td class="link-cell">
                        <A href={`/console/partners/${p.id}`}>{p.name}</A> <span class="muted small">{p.code}</span>
                        <SignupBadges p={p} />
                      </td>
                      <td><PartnerStatus status={p.status} declined={p.declined} /></td>
                      <td>{countryName(p.country)}</td>
                      <Show when={showRegistered()}><td class="nowrap">{p.signupAt ? formatDate(p.signupAt) : ''}</td></Show>
                      <Show when={showDeletes()}><td class="nowrap">{p.deletesAt ? formatDate(p.deletesAt) : ''}</td></Show>
                      <td><Gate ok={p.dpaOnFile} /></td>
                      <td><Gate ok={p.sccOnFile} /></td>
                      <td class="num">{formatNumber(p.siteCodes.length)}</td>
                      <td class="num">{formatNumber(p.usersCount)}</td>
                      <td class="num">{formatNumber(p.openCases)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Card>
      <AddPartnerDialog open={adding()} onClose={() => setAdding(false)} />
    </div>
  );
}

function AddPartnerDialog(props: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const sites = useSites();
  const [name, setName] = createSignal('');
  const [code, setCode] = createSignal('');
  const [codeEdited, setCodeEdited] = createSignal(false);
  const [country, setCountry] = createSignal('');
  const [legalName, setLegalName] = createSignal('');
  const [retention, setRetention] = createSignal('');
  const [siteCodes, setSiteCodes] = createSignal<string[]>([]);
  const [defaultSite, setDefaultSite] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);

  createEffect(on(() => props.open, (open) => {
    if (open) { setName(''); setCode(''); setCodeEdited(false); setCountry(''); setLegalName(''); setRetention(''); setSiteCodes([]); setDefaultSite(''); setError(null); }
  }));

  const cProblem = () => (code() ? codeProblem(code()) : null);
  const r = () => Number(retention());
  const retentionOk = () => !retention() || (Number.isInteger(r()) && r() >= 1 && r() <= 180);
  const valid = () => name().trim().length >= 2 && !!code() && !cProblem() && !!country() && retentionOk();

  const m = createMutation(() => ({
    mutationFn: () => api<{ id?: string; partner?: { id: string } }>('/api/partners', {
      method: 'POST',
      body: {
        name: name().trim(), code: code(), country: country(),
        ...(legalName().trim() ? { legalName: legalName().trim() } : {}),
        ...(retention() ? { retentionMonths: r() } : {}),
        siteCodes: siteCodes(),
        ...(defaultSite() && siteCodes().includes(defaultSite()) ? { defaultSiteCode: defaultSite() } : {}),
      },
    }),
    onSuccess: (res: { id?: string; partner?: { id: string } }) => {
      qc.invalidateQueries({ queryKey: ['partners'] });
      qc.invalidateQueries({ queryKey: ['console-overview'] });
      const id = res?.id ?? res?.partner?.id;
      props.onClose();
      if (id) nav(`/console/partners/${id}`);
    },
    onError: (e: unknown) => setError(errorText(e)),
  }));

  const list = () => sites.data?.sites.filter((s) => s.active) ?? [];
  return (
    <Dialog open={props.open} title="Add a partner" onClose={props.onClose} wide>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); setError(null); m.mutate(); }}>
        <p class="muted">Use this for a company that did not register itself. It starts in onboarding. Invite its first user from the partner page afterwards.</p>
        <Show when={error()}>{(e) => <Notice tone="bad">{e()}</Notice>}</Show>
        <div class="form-grid">
          <Field label="Company name">
            {(p) => <input {...p} value={name()} maxLength={120} required autocomplete="off" onInput={(e) => { setName(e.currentTarget.value); if (!codeEdited()) setCode(suggestCompanyCode(e.currentTarget.value)); }} />}
          </Field>
          <Field label="Code" hint="2 to 8 capital letters or digits. It starts every case reference." error={cProblem()}>
            {(p) => <input {...p} class="mono" value={code()} maxLength={8} required autocomplete="off" onInput={(e) => { setCodeEdited(true); setCode(e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); }} />}
          </Field>
          <Field label="Country">
            {(p) => (
              <select {...p} value={country()} required onChange={(e) => setCountry(e.currentTarget.value)}>
                <option value="" selected={country() === ''}>Choose a country</option>
                <For each={COUNTRIES}>{(c) => <option value={c.code} selected={c.code === country()}>{c.name}</option>}</For>
              </select>
            )}
          </Field>
          <Field label="Legal name (optional)">
            {(p) => <input {...p} value={legalName()} maxLength={160} autocomplete="off" onInput={(e) => setLegalName(e.currentTarget.value)} />}
          </Field>
          <Field label="Keep files after shipping, in months (optional)" hint="Between 1 and 180. Leave empty for the standard time." error={retentionOk() ? null : 'Enter a whole number from 1 to 180.'}>
            {(p) => <input {...p} type="number" min={1} max={180} value={retention()} onInput={(e) => setRetention(e.currentTarget.value)} />}
          </Field>
        </div>
        <Show when={list().length}>
          <div class="stack">
            <fieldset class="check-group">
              <legend>Sites where this partner's cases may be made (optional)</legend>
              <For each={list()}>
                {(s) => (
                  <div class="check">
                    <input id={`add-site-${s.code}`} type="checkbox" checked={siteCodes().includes(s.code)} onChange={(e) => setSiteCodes(e.currentTarget.checked ? [...siteCodes(), s.code] : siteCodes().filter((x) => x !== s.code))} />
                    <label for={`add-site-${s.code}`}>{s.code}, {s.name}</label>
                  </div>
                )}
              </For>
            </fieldset>
            <Show when={siteCodes().length}>
              <Field label="Default site">
                {(p) => (
                  <select {...p} value={defaultSite()} onChange={(e) => setDefaultSite(e.currentTarget.value)}>
                    <option value="" selected={defaultSite() === ''}>None</option>
                    <For each={siteCodes()}>{(c) => <option value={c} selected={c === defaultSite()}>{c}</option>}</For>
                  </select>
                )}
              </Field>
            </Show>
          </div>
        </Show>
        <IfMfa><p class="small muted">You will be asked for your authenticator code.</p></IfMfa>
        <div class="row-end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!valid()}>Add partner</Button>
        </div>
      </form>
    </Dialog>
  );
}
