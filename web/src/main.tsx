import '@fontsource-variable/inter';
import './styles/app.css';
import { type Component, type JSX, lazy, Show, Suspense } from 'solid-js';
import { render } from 'solid-js/web';
import { Navigate, Route, Router } from '@solidjs/router';
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query';
import type { Permission } from '@shared/roles';
import type { MenuKey } from '@shared/menu';
import { AuthProvider, Guard, homeFor, useAuth } from './lib/auth';
import { Shell } from './layout/Shell';
import { StepUpHost } from './ui/StepUp';
import { Spinner } from './ui/Common';
import Login from './pages/auth/Login';

const Mfa = lazy(() => import('./pages/auth/Mfa'));
const MfaSetup = lazy(() => import('./pages/auth/MfaSetup'));
const ForgotPassword = lazy(() => import('./pages/auth/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/auth/ResetPassword'));
const Invite = lazy(() => import('./pages/auth/Invite'));
const Register = lazy(() => import('./pages/auth/Register'));
const Verify = lazy(() => import('./pages/auth/Verify'));
const Privacy = lazy(() => import('./pages/auth/Privacy'));
const GettingStartedPublic = lazy(() => import('./pages/auth/GettingStartedPublic'));
const GettingStartedPage = lazy(() => import('./pages/partner/GettingStartedPage'));
const Cases = lazy(() => import('./pages/partner/Cases'));
const CaseDetail = lazy(() => import('./pages/partner/CaseDetail'));
const Team = lazy(() => import('./pages/partner/Team'));
const Company = lazy(() => import('./pages/partner/Company'));
const Account = lazy(() => import('./pages/partner/Account'));
const AccessLog = lazy(() => import('./pages/partner/AccessLog'));
const SendBulk = lazy(() => import('./pages/partner/SendBulk'));
const BatchResult = lazy(() => import('./pages/partner/BatchResult'));
const Integrations = lazy(() => import('./pages/partner/Integrations'));
const PortalSettings = lazy(() => import('./pages/partner/PortalSettings'));
const BagLayoutPage = lazy(() => import('./pages/partner/BagLayout'));
const Claims = lazy(() => import('./pages/partner/Claims'));
const ClaimNew = lazy(() => import('./pages/partner/ClaimNew'));
const ClaimDetail = lazy(() => import('./pages/partner/ClaimDetail'));
const Spec = lazy(() => import('./pages/partner/Spec'));
const Materials = lazy(() => import('./pages/partner/Materials'));
const Console = lazy(() => import('./pages/console/Console'));
const Intake = lazy(() => import('./pages/console/Intake'));
const ConsoleCases = lazy(() => import('./pages/console/Cases'));
const CaseView = lazy(() => import('./pages/console/CaseView'));
const Partners = lazy(() => import('./pages/console/Partners'));
const PartnerDetail = lazy(() => import('./pages/console/PartnerDetail'));
const PortalConnections = lazy(() => import('./pages/console/PortalConnections'));
const PortalConnectionPartner = lazy(() => import('./pages/console/PortalConnections').then((m) => ({ default: m.PortalConnectionPartner })));
const Mes = lazy(() => import('./pages/console/Mes'));
const ServiceKeys = lazy(() => import('./pages/console/ServiceKeys'));
const Staff = lazy(() => import('./pages/console/Staff'));
const Sites = lazy(() => import('./pages/console/Sites'));
const Audit = lazy(() => import('./pages/console/Audit'));
const ConsoleClaims = lazy(() => import('./pages/console/Claims'));
const ClaimView = lazy(() => import('./pages/console/ClaimView'));
const Specs = lazy(() => import('./pages/console/Specs'));
const PartnerSpec = lazy(() => import('./pages/console/Specs').then((m) => ({ default: m.PartnerSpec })));
const ConsoleMaterials = lazy(() => import('./pages/console/Materials'));

const client = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 15_000 } },
});

interface GuardOptions { stage?: 'password' | 'mfa_setup' | 'full' | 'anon'; kind?: 'partner' | 'kline'; perm?: Permission; anyOf?: Permission[]; menu?: MenuKey }

/** A route component wrapped in the sign in guard. */
const guarded = (Page: Component, opts: GuardOptions): Component => () => (
  <Guard {...opts}><Page /></Guard>
);

/** The portal home is Direct manufacturing. People who cannot send cases land on their cases, or on the getting started steps. */
function PortalHome() {
  const { can } = useAuth();
  return (
    <Show when={can('case.write')} fallback={<Navigate href={can('case.read') ? '/portal/cases' : '/portal/getting-started'} />}>
      <SendBulk />
    </Show>
  );
}

function Root() {
  const { me, loading } = useAuth();
  return <Show when={!loading()} fallback={<Spinner />}><Navigate href={homeFor(me())} /></Show>;
}

const anon = (Page: Component) => guarded(Page, { stage: 'anon' });
const partner = (Page: Component, opts: Omit<GuardOptions, 'kind'> = {}) => guarded(Page, { kind: 'partner', ...opts });
const kline = (Page: Component, opts: Omit<GuardOptions, 'kind'> = {}) => guarded(Page, { kind: 'kline', ...opts });
const to = (href: string): Component => () => <Navigate href={href} />;

/** The shell wraps the routes below it: the nested route is its children. */
const PartnerShell = (props: { children?: JSX.Element }) => <Guard kind="partner"><Shell>{props.children}</Shell></Guard>;
const KlineShell = (props: { children?: JSX.Element }) => <Guard kind="kline"><Shell>{props.children}</Shell></Guard>;

function AppRoot(props: { children?: JSX.Element }) {
  return (
    <>
      <Suspense fallback={<Spinner />}>{props.children}</Suspense>
      <StepUpHost />
    </>
  );
}

render(
  () => (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Router root={AppRoot}>
          <Route path="/" component={Root} />
          <Route path="/login" component={anon(Login)} />
          <Route path="/mfa" component={guarded(Mfa, { stage: 'password' })} />
          <Route path="/mfa-setup" component={guarded(MfaSetup, { stage: 'mfa_setup' })} />
          <Route path="/forgot-password" component={anon(ForgotPassword)} />
          <Route path="/reset-password" component={anon(ResetPassword)} />
          <Route path="/invite/:token" component={anon(Invite)} />
          <Route path="/register" component={anon(Register)} />
          <Route path="/verify" component={anon(Verify)} />
          <Route path="/privacy" component={Privacy} />
          <Route path="/getting-started" component={GettingStartedPublic} />

          <Route path="/portal" component={PartnerShell}>
            <Route path="/" component={PortalHome} />
            <Route path="/getting-started" component={GettingStartedPage} />
            <Route path="/send" component={to('/portal')} />
            <Route path="/send/bulk" component={to('/portal')} />
            <Route path="/send/bulk/batch/:id" component={partner(BatchResult, { perm: 'case.read' })} />
            <Route path="/cases" component={partner(Cases, { perm: 'case.read' })} />
            <Route path="/cases/:id" component={partner(CaseDetail, { perm: 'case.read' })} />
            <Route path="/cases/:id/claim" component={partner(ClaimNew, { perm: 'claim.write', menu: 'claims' })} />
            <Route path="/claims" component={partner(Claims, { perm: 'claim.read', menu: 'claims' })} />
            <Route path="/claims/:id" component={partner(ClaimDetail, { perm: 'claim.read', menu: 'claims' })} />
            <Route path="/spec" component={partner(Spec, { perm: 'spec.read', menu: 'spec' })} />
            <Route path="/spec/:id" component={partner(Spec, { perm: 'spec.read', menu: 'spec' })} />
            <Route path="/materials" component={partner(Materials, { perm: 'material.read', menu: 'materials' })} />
            <Route path="/company" component={partner(Company, { perm: 'org.read' })} />
            <Route path="/team" component={partner(Team, { perm: 'team.manage' })} />
            <Route path="/account" component={Account} />
            <Route path="/access-log" component={partner(AccessLog, { perm: 'audit.read' })} />
            <Route path="/integrations" component={partner(Integrations, { anyOf: ['integration.manage', 'export.run'] })} />
            <Route path="/settings/portal-api" component={partner(PortalSettings, { perm: 'integration.manage' })} />
            <Route path="/settings/bags" component={partner(BagLayoutPage, { perm: 'org.edit' })} />
            <Route path="*" component={to('/portal')} />
          </Route>

          <Route path="/console" component={KlineShell}>
            <Route path="/" component={kline(Console, { perm: 'case.read' })} />
            <Route path="/intake" component={kline(Intake, { perm: 'intake.manage' })} />
            <Route path="/cases" component={kline(ConsoleCases, { perm: 'case.read' })} />
            <Route path="/cases/:id" component={kline(CaseView, { perm: 'case.read' })} />
            <Route path="/claims" component={kline(ConsoleClaims, { perm: 'claim.read' })} />
            <Route path="/claims/:id" component={kline(ClaimView, { perm: 'claim.read' })} />
            <Route path="/specs" component={kline(Specs, { perm: 'spec.read' })} />
            <Route path="/specs/:orgId" component={kline(PartnerSpec, { perm: 'spec.read' })} />
            <Route path="/specs/:orgId/:id" component={kline(PartnerSpec, { perm: 'spec.read' })} />
            <Route path="/materials" component={kline(ConsoleMaterials, { perm: 'material.read' })} />
            <Route path="/partners" component={kline(Partners, { perm: 'admin.partners' })} />
            <Route path="/partners/:id" component={kline(PartnerDetail, { perm: 'admin.partners' })} />
            <Route path="/portal" component={kline(PortalConnections, { perm: 'admin.partners' })} />
            <Route path="/portal/:id" component={kline(PortalConnectionPartner, { perm: 'admin.partners' })} />
            <Route path="/mes" component={kline(Mes, { perm: 'admin.mes' })} />
            <Route path="/service-keys" component={kline(ServiceKeys, { perm: 'admin.mes' })} />
            <Route path="/staff" component={kline(Staff, { perm: 'admin.staff' })} />
            <Route path="/sites" component={kline(Sites, { perm: 'admin.sites' })} />
            <Route path="/audit" component={kline(Audit, { perm: 'audit.read' })} />
            <Route path="/account" component={Account} />
            <Route path="*" component={to('/console')} />
          </Route>

          <Route path="*" component={Root} />
        </Router>
      </AuthProvider>
    </QueryClientProvider>
  ),
  document.getElementById('root')!,
);
