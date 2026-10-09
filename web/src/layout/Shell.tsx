import { createEffect, createSignal, For, type JSX, on, Show } from 'solid-js';
import { A, useLocation, useNavigate } from '@solidjs/router';
import { Activity, Boxes, Building2, FileCheck2, Inbox, KeyRound, ListChecks, LogOut, Menu, MapPin, Package, PlugZap, Rocket, ScrollText, ShieldAlert, ShieldCheck, Tag, UserCircle, UserCog, Users, Webhook, Workflow, X } from 'lucide-solid';
import { useAuth, useMenu } from '../lib/auth';
import { useCaseCounts, useOrgLogo } from '../lib/orgApi';
import { Button, Notice } from '../ui/Common';
import { NotificationBell } from '../ui/NotificationBell';
import { OrgLogoImage } from '../ui/OrgLogo';

export function BrandMark() {
  return (
    <div class="brand">
      <span>Portal Hub</span>
    </div>
  );
}

interface NavItem { to: string; label: string; icon: typeof Package; end?: boolean; show: boolean; /** A number on the menu item, for example the cases that need attention. */ badge?: number }

/** The frame around every signed in page: the menu on the left, the top bar, and the page itself (the nested route) in the middle. */
export function Shell(props: { children?: JSX.Element }) {
  const { me, can, isKline, signOut } = useAuth();
  const menu = useMenu();
  const [open, setOpen] = createSignal(false);
  const loc = useLocation();
  const nav = useNavigate();
  createEffect(on(() => loc.pathname, () => setOpen(false)));
  const logo = useOrgLogo(() => !isKline() && can('org.read'));
  const showLogo = () => !isKline() && logo.hasLogo === true && can('org.read');
  const onCompanyPage = () => loc.pathname.startsWith('/portal/company');
  const counts = useCaseCounts(() => !isKline() && can('case.read'));

  const partnerItems = (): NavItem[] => [
    { to: '/portal', label: 'Direct manufacturing', icon: Package, end: true, show: can('case.write') },
    { to: '/portal/getting-started', label: 'Getting started', icon: Rocket, show: true },
    { to: '/portal/cases', label: 'Cases', icon: ListChecks, show: can('case.read'), badge: counts.data?.attention },
    { to: '/portal/claims', label: 'Quality claims', icon: ShieldAlert, show: can('claim.read') && menu.claims },
    { to: '/portal/spec', label: 'Production spec', icon: FileCheck2, show: can('spec.read') && menu.spec },
    { to: '/portal/materials', label: 'Materials', icon: Boxes, show: can('material.read') && menu.materials },
    { to: '/portal/company', label: 'Company profile', icon: Building2, show: can('org.read') },
    { to: '/portal/team', label: 'Team', icon: Users, show: can('team.manage') },
    { to: '/portal/access-log', label: 'Access log', icon: Activity, show: can('audit.read') },
    { to: '/portal/integrations', label: 'ERP and API', icon: Webhook, show: can('integration.manage') || can('export.run') },
    { to: '/portal/settings/portal-api', label: 'Portal connection', icon: PlugZap, show: can('integration.manage') },
    { to: '/portal/settings/bags', label: 'Bag labels', icon: Tag, show: can('org.edit') },
    { to: '/portal/account', label: 'Account', icon: UserCircle, show: true },
  ];
  const klineItems = (): NavItem[] => [
    { to: '/console', label: 'Overview', icon: ShieldCheck, end: true, show: can('case.read') },
    { to: '/console/intake', label: 'Intake', icon: Inbox, show: can('intake.manage') },
    { to: '/console/cases', label: 'Cases', icon: ListChecks, show: can('case.read') },
    { to: '/console/claims', label: 'Quality claims', icon: ShieldAlert, show: can('claim.read') },
    { to: '/console/specs', label: 'Partner specs', icon: FileCheck2, show: can('spec.read') },
    { to: '/console/materials', label: 'Partner materials', icon: Boxes, show: can('material.read') },
    { to: '/console/partners', label: 'Partners', icon: Building2, show: can('admin.partners') },
    { to: '/console/portal', label: 'Portal connection', icon: PlugZap, show: can('admin.partners') },
    { to: '/console/mes', label: 'MES integration', icon: Workflow, show: can('admin.mes') },
    { to: '/console/service-keys', label: 'Service keys', icon: KeyRound, show: can('admin.mes') },
    { to: '/console/staff', label: 'Staff', icon: UserCog, show: can('admin.staff') },
    { to: '/console/sites', label: 'Sites', icon: MapPin, show: can('admin.sites') },
    { to: '/console/audit', label: 'Audit log', icon: ScrollText, show: can('audit.read') },
    { to: '/console/account', label: 'Account', icon: UserCircle, show: true },
  ];
  const items = () => (isKline() ? klineItems() : partnerItems()).filter((i) => i.show);

  async function out() {
    await signOut();
    nav('/login', { replace: true });
  }

  return (
    <div class="shell">
      <a class="skip-link" href="#main">Skip to main content</a>
      <aside class={`sidebar${open() ? ' open' : ''}`} aria-label="Main">
        <div class="row" style={{ 'justify-content': 'space-between', 'flex-wrap': 'nowrap' }}>
          <BrandMark />
          <button type="button" class="icon-btn menu-btn" aria-label="Close menu" onClick={() => setOpen(false)} style={{ color: '#fff' }}><X size={20} aria-hidden="true" /></button>
        </div>
        <nav class="nav" aria-label="Sections">
          <For each={items()}>
            {(i) => (
              <A href={i.to} end={i.end}>
                <i.icon size={18} aria-hidden="true" />
                {i.label}
                <Show when={i.badge}>{(n) => <span class="nav-badge" title={`${n()} to look at`}>{n()}<span class="sr-only"> to look at</span></span>}</Show>
              </A>
            )}
          </For>
        </nav>
        <div class="sidebar-foot">
          <div>
            <div style={{ 'font-weight': 600, color: '#fff' }}>{me()?.user.name}</div>
            <div>{me()?.org?.name}</div>
          </div>
          <Button onClick={out}><LogOut size={16} aria-hidden="true" /> Sign out</Button>
        </div>
      </aside>
      <div class={`scrim${open() ? ' open' : ''}`} onClick={() => setOpen(false)} aria-hidden="true" />
      <div class="main">
        <header class="topbar">
          <div class="row">
            <button type="button" class="icon-btn menu-btn" aria-label="Open menu" aria-expanded={open()} onClick={() => setOpen(true)}><Menu size={20} aria-hidden="true" /></button>
            <span class="topbar-brand">
              <Show when={showLogo()}><OrgLogoImage name={me()?.org?.name ?? 'Company'} version={logo.version} /></Show>
              <span class="topbar-title">{me()?.org?.name}</span>
            </span>
          </div>
          <NotificationBell caseBase={isKline() ? '/console/cases' : '/portal/cases'} />
        </header>
        <Show when={!isKline() && logo.hasLogo === false}>
          <div class="logo-banner">
            <Notice
              tone="warn"
              title="Add your company logo"
              action={onCompanyPage() || !can('org.logo') ? undefined : <A class="btn btn-sm" href="/portal/company#logo">Add logo</A>}
            >
              It is needed so your team and K Line can recognise your account.{can('org.logo') ? '' : ' Ask a colleague to add it.'}
            </Notice>
          </div>
        </Show>
        <main id="main" tabIndex={-1}>
          {props.children}
        </main>
      </div>
    </div>
  );
}
