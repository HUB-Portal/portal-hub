import { createMemo, For, type JSX, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { useAuth, useMenu } from '../../lib/auth';
import { usePublicConfig, useCaseCounts, useMfaRequired, useOnboarding, type OnboardingItem } from '../../lib/orgApi';
import { Badge, Notice } from '../../ui/Common';

type Lane = 'company' | 'kline';
interface FlowStep { key: string; lane: Lane; number?: number; title: string; body: JSX.Element; /** Shown instead of the title and body while two factor sign in is switched off. */ withoutMfa?: { title: string; body: JSX.Element } }

const LANE_NAME: Record<Lane, string> = { company: 'Your company', kline: 'K Line' };

const FLOW: FlowStep[] = [
  { key: 'register', lane: 'company', number: 1, title: 'Register the company', body: 'Fill in the registration form with your company details and your case address.' },
  { key: 'confirm', lane: 'company', number: 2, title: 'Confirm the email', body: 'We send you a link. It is valid for 48 hours.' },
  { key: 'password', lane: 'company', number: 3, title: 'Choose a password and set up the authenticator app', body: 'Everyone signs in with two factor authentication. Save the 10 recovery codes in a safe place.', withoutMfa: { title: 'Choose a password', body: 'You sign in with your email address and your password.' } },
  { key: 'notified', lane: 'kline', title: 'K Line is notified', body: 'K Line is told that a new company has confirmed its email.' },
  { key: 'prepare', lane: 'company', number: 4, title: 'Prepare the company', body: 'Add your logo, your case address, your production spec and your company details.' },
  {
    key: 'review', lane: 'kline', title: 'K Line reviews',
    body: (
      <>
        <span>K Line needs:</span>
        <ul>
          <li>the email confirmed</li>
          <li>a Data Processing Agreement on file</li>
          <li>at least one production site</li>
          <li>the logo</li>
        </ul>
      </>
    ),
  },
  { key: 'approved', lane: 'kline', number: 5, title: 'Company approved', body: 'Sending cases opens.' },
  { key: 'team', lane: 'company', number: 6, title: 'Invite the team', body: 'Give each person a role.' },
  { key: 'send', lane: 'company', number: 7, title: 'Send cases', body: 'Send your first cases with Direct manufacturing.' },
];

const ROLES: { role: string; can: string }[] = [
  { role: 'Admin', can: 'Manages the team, the company profile, integrations and the menu.' },
  { role: 'Uploader', can: 'Sends cases and orders replacements.' },
  { role: 'Quality', can: 'Follows claims and the production spec.' },
  { role: 'Finance', can: 'Sees shipped cases and exports.' },
  { role: 'Viewer', can: 'Can look but not change.' },
];

/** `mfa` marks a line that is only true while two factor sign in is switched on. */
const GOOD_TO_KNOW: { text: string; mfa?: boolean }[] = [
  { text: 'Until K Line approves the company, sending cases, inviting people, API keys and material shipments are locked.' },
  { text: 'K Line checks your first cases.' },
  { text: 'Passwords need at least 12 characters.' },
  { text: 'Five wrong sign in attempts lock the account for 15 minutes.' },
  { text: 'Sessions end after 30 minutes of inactivity.' },
  { text: 'Sensitive actions ask for a fresh code from your authenticator app.', mfa: true },
  { text: 'Invitation links work once and last 7 days.' },
  { text: 'A registration that is never confirmed is deleted after 7 days.' },
];

type StepProgress = 'done' | 'next';

/**
 * Where this company stands in the steps below (review of 8 Oct 2026, A6): finished steps are ticked and the first open one is highlighted.
 * Only for a signed in partner. Steps the Hub cannot know about (inviting the team) are left unmarked.
 * Returns an accessor: call it (`progress()`) inside JSX or an effect.
 */
function useStepProgress(): () => Record<string, StepProgress> {
  const { me, can } = useAuth();
  const signedIn = () => me()?.stage === 'full' && me()?.org?.kind === 'partner';
  const onboarding = useOnboarding(() => signedIn() && can('org.read'));
  const counts = useCaseCounts(() => signedIn() && can('case.read'));
  return createMemo(() => {
    if (!signedIn()) return {};
    const items = onboarding.data?.items;
    const done = (id: string) => items?.find((i) => i.id === id)?.done === true;
    const prepared = !!items && ['profile', 'logo', 'case_address', 'spec'].every(done);
    const state: Record<string, boolean | undefined> = {
      register: true, confirm: true, password: true,
      prepare: items ? prepared : undefined,
      review: items ? done('approval') : undefined,
      approved: items ? done('approval') : undefined,
      send: counts.data ? counts.data.all > 0 : undefined,
    };
    const out: Record<string, StepProgress> = {};
    let nextFound = false;
    for (const f of FLOW) {
      const v = state[f.key];
      if (v === true) out[f.key] = 'done';
      else if (v === false && !nextFound) { out[f.key] = 'next'; nextFound = true; }
    }
    return out;
  });
}

function HowItWorks() {
  const mfa = useMfaRequired();
  const progress = useStepProgress();
  return (
    <section class="gs-section" aria-labelledby="gs-how">
      <h2 id="gs-how">How it works</h2>
      <div class="gs-lanes" aria-hidden="true">
        <span class="gs-lane-head gs-lane-company">{LANE_NAME.company}</span>
        <span />
        <span class="gs-lane-head gs-lane-kline">{LANE_NAME.kline}</span>
      </div>
      <ol class="gs-flow">
        <For each={FLOW}>
          {(step, n) => {
            const s = () => (!mfa() && step.withoutMfa ? { ...step, ...step.withoutMfa } : step);
            const p = () => progress()[step.key];
            return (
              <li class={`gs-step gs-${step.lane}${p() ? ` gs-${p()}` : ''}`} style={{ 'grid-row': `${n() + 1}` }} aria-current={p() === 'next' ? 'step' : undefined}>
                <span class="gs-dot" aria-hidden="true">{p() === 'done' ? '✓' : step.number ?? ''}</span>
                <div class="gs-card">
                  <p class="gs-lane-label">
                    <span class="gs-lane-text">{LANE_NAME[step.lane]}</span>
                    {step.number ? <span class="gs-count">{`Step ${step.number}`}</span> : null}
                    {p() === 'done' ? <span class="gs-state gs-state-done">Done</span> : null}
                    {p() === 'next' ? <span class="gs-state gs-state-next">Your next step</span> : null}
                  </p>
                  <h3>{s().title}</h3>
                  <div class="gs-body">{s().body}</div>
                </div>
              </li>
            );
          }}
        </For>
      </ol>
    </section>
  );
}

function Checklist() {
  const { me, can } = useAuth();
  const menu = useMenu();
  const signedIn = () => me()?.stage === 'full' && me()?.org?.kind === 'partner';
  const q = useOnboarding(() => signedIn() && can('org.read'));
  const items = () => q.data?.items ?? [];
  const allDone = () => items().every((i) => i.done);

  function action(item: OnboardingItem): JSX.Element {
    switch (item.id) {
      case 'account_secured': return <A class="btn btn-sm" href="/portal/account" aria-label={`${item.label}: go to Account`}>Go to Account</A>;
      case 'profile': return can('org.read') ? <A class="btn btn-sm" href="/portal/company" aria-label={`${item.label}: go to Company profile`}>Go to Company profile</A> : null;
      case 'logo':
        if (!can('org.logo')) return <span class="muted small">Ask a colleague to add it.</span>;
        return <A class="btn btn-sm" href="/portal/company#logo" aria-label={`${item.label}: go to the logo`}>Go to the logo</A>;
      case 'case_address':
        return <A class="btn btn-sm" href={can('org.edit') ? '/portal/company#case-address' : '/portal/account#case-address'} aria-label={`${item.label}: go to the case address`}>Go to the case address</A>;
      case 'spec':
        if (can('spec.read') && menu.spec) return <A class="btn btn-sm" href="/portal/spec" aria-label={`${item.label}: go to Production spec`}>Go to Production spec</A>;
        return <span class="muted small">Ask a colleague who can see the production spec.</span>;
      case 'dpa':
      case 'approval':
        return <span class="muted small">K Line does this</span>;
      default: return null;
    }
  }

  return (
    <Show when={signedIn() && !q.isLoading && !q.isError && q.data && q.data.items.length > 0}>
      <section class="gs-section" aria-labelledby="gs-list">
        <h2 id="gs-list">Your checklist</h2>
        <Show when={allDone()}>
          <Notice tone="good" title="You are all set" action={can('case.write') ? <A class="btn btn-sm btn-primary" href="/portal">Go to Direct manufacturing</A> : undefined}>
            Every step is done. You can send your first cases with Direct manufacturing.
          </Notice>
        </Show>
        <ul class="gs-check">
          <For each={items()}>
            {(i) => (
              <li>
                <span class="gs-check-label">{i.label}</span>
                <Badge tone={i.done ? 'good' : 'neutral'}>{i.done ? 'Done' : 'Not yet'}</Badge>
                <span class="gs-check-action">{action(i)}</span>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

function Roles() {
  return (
    <section class="gs-section" aria-labelledby="gs-roles">
      <h2 id="gs-roles">Who can do what</h2>
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">What each role can do in the Portal Hub</caption>
          <thead>
            <tr><th scope="col">Role</th><th scope="col">What it can do</th></tr>
          </thead>
          <tbody>
            <For each={ROLES}>
              {(r) => <tr><th scope="row" class="gs-role">{r.role}</th><td>{r.can}</td></tr>}
            </For>
          </tbody>
        </table>
      </div>
      <p>Everyone except viewers can change the company logo. Each person can set their own case address in Account.</p>
    </section>
  );
}

function GoodToKnow() {
  const mfa = useMfaRequired();
  return (
    <section class="gs-section" aria-labelledby="gs-know">
      <h2 id="gs-know">Good to know</h2>
      <ul class="gs-bullets">
        <For each={GOOD_TO_KNOW.filter((t) => mfa() || !t.mfa)}>{(t) => <li>{t.text}</li>}</For>
      </ul>
    </section>
  );
}

function Help() {
  const config = usePublicConfig();
  return (
    <Show when={config.data?.supportEmail}>
      {(email) => (
        <section class="gs-section" aria-labelledby="gs-help">
          <h2 id="gs-help">Need help?</h2>
          <p>Write to <a href={`mailto:${email()}`}>{email()}</a> and we will help you.</p>
        </section>
      )}
    </Show>
  );
}

/** Explains how a company gets from registering to sending cases. Used inside the portal and on the public page. */
export function GettingStarted(props: { showChecklist?: boolean }) {
  return (
    <div class="gs">
      <p class="gs-intro">
        The Portal Hub is where partners send cases to K Line and follow them through production. Follow these steps to send your first cases.
      </p>
      <HowItWorks />
      <Show when={props.showChecklist}><Checklist /></Show>
      <Roles />
      <GoodToKnow />
      <Help />
    </div>
  );
}
