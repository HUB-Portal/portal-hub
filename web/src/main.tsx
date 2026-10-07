import '@fontsource-variable/inter';
import './styles/app.css';
import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

/** The portal home is Direct manufacturing. People who cannot send cases land on their cases, or on the getting started steps. */
function PortalHome() {
  const { can } = useAuth();
  if (can('case.write')) return <SendBulk />;
  return <Navigate to={can('case.read') ? '/portal/cases' : '/portal/getting-started'} replace />;
}

function Root() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  return <Navigate to={homeFor(me)} replace />;
}

function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/" element={<Root />} />
        <Route path="/login" element={<Guard stage="anon"><Login /></Guard>} />
        <Route path="/mfa" element={<Guard stage="password"><Mfa /></Guard>} />
        <Route path="/mfa-setup" element={<Guard stage="mfa_setup"><MfaSetup /></Guard>} />
        <Route path="/forgot-password" element={<Guard stage="anon"><ForgotPassword /></Guard>} />
        <Route path="/reset-password" element={<Guard stage="anon"><ResetPassword /></Guard>} />
        <Route path="/invite/:token" element={<Guard stage="anon"><Invite /></Guard>} />
        <Route path="/register" element={<Guard stage="anon"><Register /></Guard>} />
        <Route path="/verify" element={<Guard stage="anon"><Verify /></Guard>} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/getting-started" element={<GettingStartedPublic />} />

        <Route path="/portal" element={<Guard kind="partner"><Shell /></Guard>}>
          <Route index element={<PortalHome />} />
          <Route path="getting-started" element={<GettingStartedPage />} />
          <Route path="send" element={<Navigate to="/portal" replace />} />
          <Route path="send/bulk" element={<Navigate to="/portal" replace />} />
          <Route path="send/bulk/batch/:id" element={<Guard kind="partner" perm="case.read"><BatchResult /></Guard>} />
          <Route path="cases" element={<Guard kind="partner" perm="case.read"><Cases /></Guard>} />
          <Route path="cases/:id" element={<Guard kind="partner" perm="case.read"><CaseDetail /></Guard>} />
          <Route path="cases/:id/claim" element={<Guard kind="partner" perm="claim.write" menu="claims"><ClaimNew /></Guard>} />
          <Route path="claims" element={<Guard kind="partner" perm="claim.read" menu="claims"><Claims /></Guard>} />
          <Route path="claims/:id" element={<Guard kind="partner" perm="claim.read" menu="claims"><ClaimDetail /></Guard>} />
          <Route path="spec" element={<Guard kind="partner" perm="spec.read" menu="spec"><Spec /></Guard>} />
          <Route path="spec/:id" element={<Guard kind="partner" perm="spec.read" menu="spec"><Spec /></Guard>} />
          <Route path="materials" element={<Guard kind="partner" perm="material.read" menu="materials"><Materials /></Guard>} />
          <Route path="company" element={<Guard kind="partner" perm="org.read"><Company /></Guard>} />
          <Route path="team" element={<Guard kind="partner" perm="team.manage"><Team /></Guard>} />
          <Route path="account" element={<Account />} />
          <Route path="access-log" element={<Guard kind="partner" perm="audit.read"><AccessLog /></Guard>} />
          <Route path="integrations" element={<Guard kind="partner" anyOf={['integration.manage', 'export.run']}><Integrations /></Guard>} />
          <Route path="settings/portal-api" element={<Guard kind="partner" perm="integration.manage"><PortalSettings /></Guard>} />
          <Route path="settings/bags" element={<Guard kind="partner" perm="org.edit"><BagLayoutPage /></Guard>} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Route>

        <Route path="/console" element={<Guard kind="kline"><Shell /></Guard>}>
          <Route index element={<Guard kind="kline" perm="case.read"><Console /></Guard>} />
          <Route path="intake" element={<Guard kind="kline" perm="intake.manage"><Intake /></Guard>} />
          <Route path="cases" element={<Guard kind="kline" perm="case.read"><ConsoleCases /></Guard>} />
          <Route path="cases/:id" element={<Guard kind="kline" perm="case.read"><CaseView /></Guard>} />
          <Route path="claims" element={<Guard kind="kline" perm="claim.read"><ConsoleClaims /></Guard>} />
          <Route path="claims/:id" element={<Guard kind="kline" perm="claim.read"><ClaimView /></Guard>} />
          <Route path="specs" element={<Guard kind="kline" perm="spec.read"><Specs /></Guard>} />
          <Route path="specs/:orgId" element={<Guard kind="kline" perm="spec.read"><PartnerSpec /></Guard>} />
          <Route path="specs/:orgId/:id" element={<Guard kind="kline" perm="spec.read"><PartnerSpec /></Guard>} />
          <Route path="materials" element={<Guard kind="kline" perm="material.read"><ConsoleMaterials /></Guard>} />
          <Route path="partners" element={<Guard kind="kline" perm="admin.partners"><Partners /></Guard>} />
          <Route path="partners/:id" element={<Guard kind="kline" perm="admin.partners"><PartnerDetail /></Guard>} />
          <Route path="mes" element={<Guard kind="kline" perm="admin.mes"><Mes /></Guard>} />
          <Route path="service-keys" element={<Guard kind="kline" perm="admin.mes"><ServiceKeys /></Guard>} />
          <Route path="staff" element={<Guard kind="kline" perm="admin.staff"><Staff /></Guard>} />
          <Route path="sites" element={<Guard kind="kline" perm="admin.sites"><Sites /></Guard>} />
          <Route path="audit" element={<Guard kind="kline" perm="audit.read"><Audit /></Guard>} />
          <Route path="account" element={<Account />} />
          <Route path="*" element={<Navigate to="/console" replace />} />
        </Route>

        <Route path="*" element={<Root />} />
      </Routes>
    </Suspense>
  );
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <BrowserRouter>
      <AuthProvider>
        <App />
        <StepUpHost />
      </AuthProvider>
    </BrowserRouter>
  </QueryClientProvider>,
);
