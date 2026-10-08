// Types and small helpers for phase 5: company profile, onboarding checklist, public configuration.
// Response shapes follow docs/PHASE5_CONTRACT.md. Readers are tolerant of small differences in field names.
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { PRIVACY_VERSION } from './signup';
import { readCaseAddress, isCompleteCaseAddress, type CaseAddress } from './caseAddress';
import type { OrgInfo } from './types';

/** True when the server refused because K Line has not approved the company yet. */
export function isNotApproved(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'org_not_approved';
}

export const AGREEMENT_KINDS: { id: string; label: string }[] = [
  { id: 'dpa', label: 'Data processing agreement (DPA)' },
  { id: 'scc', label: 'Standard contractual clauses (SCC)' },
  { id: 'msa', label: 'Master service agreement' },
  { id: 'qaa', label: 'Quality assurance agreement' },
  { id: 'it', label: 'IT security agreement' },
];
export const agreementLabel = (k: string) => AGREEMENT_KINDS.find((a) => a.id === k)?.label ?? k.toUpperCase();

// ---- public configuration ---------------------------------------------------------------------------------------

export interface PublicConfig { privacyEmail: string | null; supportEmail: string | null; signupEnabled: boolean; privacyVersion: string; googleSignIn: boolean; /** False while two factor sign in is switched off on the server. */ mfaRequired: boolean }

export function usePublicConfig() {
  return useQuery({
    queryKey: ['public-config'],
    queryFn: async (): Promise<PublicConfig> => {
      const r = await api<Partial<PublicConfig>>('/api/public/config', { quiet401: true });
      return {
        privacyEmail: r.privacyEmail ?? null,
        supportEmail: r.supportEmail ?? null,
        signupEnabled: r.signupEnabled !== false,
        privacyVersion: r.privacyVersion ?? PRIVACY_VERSION,
        googleSignIn: r.googleSignIn === true,
        mfaRequired: r.mfaRequired === true,
      };
    },
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export interface CaseCounts { all: number; attention: number; drafts: number; draftsWithErrors: number }

/** Counts for the filter chips, the Cases menu badge and the link on Direct manufacturing. Refreshes now and then, and when the cases change. */
export function useCaseCounts(enabled = true) {
  return useQuery({
    queryKey: ['case-counts'],
    enabled,
    queryFn: () => api<CaseCounts>('/api/cases/counts'),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

/** True when sign in asks for an authenticator code. Texts about the authenticator are only shown then. False until the answer is known. */
export function useMfaRequired(): boolean {
  return !!usePublicConfig().data?.mfaRequired;
}

// ---- onboarding checklist -----------------------------------------------------------------------------------------

export interface OnboardingItem { id: string; label: string; done: boolean }
export interface Onboarding { items: OnboardingItem[]; approved: boolean }

/** Where each checklist item is worked on, and what to tell people when it is not in their hands. */
export const ONBOARDING_HELP: Record<string, { to?: string; hint: string }> = {
  account_secured: { to: '/portal/account', hint: 'Set up your authenticator app so only you can sign in.' },
  profile: { to: '/portal/company', hint: 'Add your legal name, VAT ID if you have one, your address and at least one contact.' },
  logo: { to: '/portal/company#logo', hint: 'Add your company logo so your team and K Line can recognise your account.' },
  case_address: { to: '/portal/company#case-address', hint: 'Tell K Line where to send your cases back to. People can also add an address of their own in Account.' },
  spec: { to: '/portal/spec', hint: 'Read the production specification and propose changes if you need them.' },
  dpa: { hint: 'K Line records the data processing agreement with you. Uploads stay locked until it is done.' },
  approval: { hint: 'K Line checks your details and approves your company. This usually takes one working day.' },
};

// ---- company profile ----------------------------------------------------------------------------------------------

export interface Contact { name: string; email: string; phone: string }
export const CONTACT_KEYS = ['operations', 'quality', 'finance', 'it'] as const;
export type ContactKey = (typeof CONTACT_KEYS)[number];
export const CONTACT_LABEL: Record<ContactKey, string> = { operations: 'Operations', quality: 'Quality', finance: 'Finance', it: 'IT' };

export interface Address { street: string; city: string; postalCode: string; country: string }

export interface Profile {
  name: string;
  code: string | null;
  legalName: string;
  country: string;
  vatId: string;
  address: Address;
  contacts: Record<ContactKey, Contact>;
  settings: { caseIdRegex: string; requirePts: boolean };
  hasLogo: boolean | undefined;
  logoRequired: boolean;
  /** The address K Line sends cases back to. Null until one is saved. */
  caseAddress: CaseAddress | null;
  /** False means direct manufacturing is blocked. Undefined when the server does not say. */
  caseAddressComplete: boolean | undefined;
  status: string | null;
  /** After approval only K Line can change the country. */
  countryLocked: boolean;
  vatRequired: boolean;
  profileFiles: { count: number; max: number | null } | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function contactOf(v: any): Contact { return { name: str(v?.name), email: str(v?.email), phone: str(v?.phone) }; }

export function normalizeProfile(raw: any): Profile {
  const r = raw?.profile ?? raw ?? {};
  const a = r.address ?? {};
  const c = r.contacts ?? {};
  const s = r.settings ?? {};
  return {
    name: str(r.name),
    code: typeof r.code === 'string' ? r.code : null,
    legalName: str(r.legalName),
    country: str(r.country),
    vatId: str(r.vatId),
    address: { street: str(a.street), city: str(a.city), postalCode: str(a.postalCode), country: str(a.country) },
    contacts: { operations: contactOf(c.operations), quality: contactOf(c.quality), finance: contactOf(c.finance), it: contactOf(c.it) },
    settings: { caseIdRegex: str(s.caseIdRegex), requirePts: !!s.requirePts },
    hasLogo: typeof r.logo?.hasLogo === 'boolean' ? r.logo.hasLogo : typeof r.hasLogo === 'boolean' ? r.hasLogo : undefined,
    logoRequired: r.logoRequired !== false,
    caseAddress: readCaseAddress(r.caseAddress),
    caseAddressComplete: typeof r.caseAddressComplete === 'boolean' ? r.caseAddressComplete : r.caseAddress !== undefined ? isCompleteCaseAddress(readCaseAddress(r.caseAddress)) : undefined,
    status: typeof r.status === 'string' ? r.status : null,
    countryLocked: !!r.countryLocked,
    vatRequired: !!r.vatRequired,
    profileFiles: r.profileFiles && typeof r.profileFiles.count === 'number' ? { count: r.profileFiles.count, max: typeof r.profileFiles.max === 'number' ? r.profileFiles.max : null } : null,
  };
}

/** The body of PUT /api/org/profile. Empty optional fields are left out so they clear on the server. */
export function profileBody(p: Profile): Record<string, unknown> {
  const contacts: Record<string, unknown> = {};
  for (const k of CONTACT_KEYS) {
    const c = p.contacts[k];
    contacts[k] = { name: c.name.trim(), email: c.email.trim(), phone: c.phone.trim() };
  }
  return {
    ...(p.name.trim() ? { name: p.name.trim() } : {}),
    legalName: p.legalName.trim(),
    ...(p.country ? { country: p.country } : {}),
    vatId: p.vatId.trim(),
    address: { street: p.address.street.trim(), city: p.address.city.trim(), postalCode: p.address.postalCode.trim(), country: p.address.country || p.country },
    contacts,
    settings: { caseIdRegex: p.settings.caseIdRegex.trim() || null, requirePts: p.settings.requirePts },
  };
}

/** The company profile, shared by the pages that need it. */
export function useProfile(enabled = true) {
  return useQuery({ queryKey: ['org-profile'], enabled, queryFn: async () => normalizeProfile(await api('/api/org/profile')) });
}

/**
 * The signed in person's own case address, the company default and which one a case sent by this person uses.
 * 'own' = their own complete address, 'company' = the company address, 'none' = neither is complete (direct manufacturing is blocked).
 */
export interface UserCaseAddress {
  own: CaseAddress | null;
  ownComplete: boolean;
  company: CaseAddress | null;
  companyComplete: boolean;
  effective: 'own' | 'company' | 'none';
}

export function normalizeUserCaseAddress(raw: any): UserCaseAddress {
  const own = readCaseAddress(raw?.own);
  const company = readCaseAddress(raw?.company);
  const ownComplete = typeof raw?.ownComplete === 'boolean' ? raw.ownComplete : isCompleteCaseAddress(own);
  const companyComplete = typeof raw?.companyComplete === 'boolean' ? raw.companyComplete : isCompleteCaseAddress(company);
  const effective = raw?.effective === 'own' || raw?.effective === 'company' || raw?.effective === 'none' ? raw.effective : ownComplete ? 'own' : companyComplete ? 'company' : 'none';
  return { own, ownComplete, company, companyComplete, effective };
}

/** Query key shared by the Account card, the Direct manufacturing page and the overview. Invalidate it after any address change. */
export const USER_CASE_ADDRESS_KEY = ['case-address'] as const;

export function useUserCaseAddress(enabled = true) {
  return useQuery({ queryKey: USER_CASE_ADDRESS_KEY, enabled, retry: false, queryFn: async () => normalizeUserCaseAddress(await api('/api/account/case-address')) });
}

/** The logo of the signed in company. Shared by the top bar, the banner and the checklist. */
export interface OrgLogoState {
  /** True or false when the server says. Undefined while loading or when the server does not say. */
  hasLogo: boolean | undefined;
  /** Changes whenever the logo changes, so the browser fetches the new image. */
  version: string;
}

export function logoUrl(version: string): string { return `/api/org/logo?v=${encodeURIComponent(version)}`; }

export function useOrgLogo(enabled: boolean): OrgLogoState & { orgName: string | undefined } {
  const q = useQuery({ queryKey: ['org'], enabled, queryFn: () => api<OrgInfo>('/api/org'), retry: false, staleTime: 60_000 });
  const l = q.data?.logo;
  return { hasLogo: typeof l?.hasLogo === 'boolean' ? l.hasLogo : undefined, version: l?.version !== undefined && l?.version !== null ? String(l.version) : '0', orgName: q.data?.name };
}

export interface Brand { id: string; name: string; hasLogo: boolean | undefined }

function listOf(raw: any, ...keys: string[]): any[] {
  if (Array.isArray(raw)) return raw;
  for (const k of ['items', ...keys]) if (Array.isArray(raw?.[k])) return raw[k];
  return [];
}

export function normalizeBrands(raw: any): Brand[] {
  return listOf(raw, 'brands').map((b) => ({
    id: String(b.id),
    name: str(b.name),
    hasLogo: typeof b.hasLogo === 'boolean' ? b.hasLogo : undefined,
  }));
}

export const DOCUMENT_KINDS: { id: string; label: string }[] = [
  { id: 'qc_criteria', label: 'Quality control criteria' },
  { id: 'packaging', label: 'Packaging' },
  { id: 'other', label: 'Other' },
];
export const documentKindLabel = (k: string) => DOCUMENT_KINDS.find((d) => d.id === k)?.label ?? 'Other';

export interface OrgDocument { id: string; name: string; kind: string; size: number; state: string; problem: string | null; createdAt: string | null }

export function normalizeDocuments(raw: any): OrgDocument[] {
  return listOf(raw, 'documents', 'files').map((d) => ({
    id: String(d.id),
    name: str(d.name) || 'Document',
    kind: str(d.kind) || str(d.documentKind) || 'other',
    size: typeof d.size === 'number' ? d.size : 0,
    state: str(d.state) || 'ready',
    problem: typeof d.problem === 'string' ? d.problem : null,
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : null,
  }));
}

export interface OrgAgreement { id: string; kind: string; signedAt: string | null; expiresAt: string | null; reference: string | null }

export function normalizeAgreements(raw: any): OrgAgreement[] {
  return listOf(raw, 'agreements').map((a, i) => ({
    id: String(a.id ?? `${a.kind}-${i}`),
    kind: str(a.kind) || str(a.type),
    signedAt: typeof a.signedAt === 'string' ? a.signedAt : null,
    expiresAt: typeof a.expiresAt === 'string' ? a.expiresAt : typeof a.validUntil === 'string' ? a.validUntil : null,
    reference: typeof a.reference === 'string' && a.reference ? a.reference : null,
  }));
}

export interface OrgSite { code: string; name: string; country: string; city: string | null; isDefault: boolean; active: boolean }

export function normalizeSites(raw: any): OrgSite[] {
  return listOf(raw, 'sites').map((s) => ({ code: str(s.code), name: str(s.name), country: str(s.country), city: typeof s.city === 'string' ? s.city : null, isDefault: !!s.isDefault, active: s.active !== false }));
}

// ---- demo registrations -----------------------------------------------------------------------------------------

export interface DemoRegistration { key: string; email: string; label: string; path: string }

/** Turns the demo list into on screen links. Returns [] when the server does not offer it. */
export function normalizeDemoRegistrations(raw: any): DemoRegistration[] {
  return listOf(raw, 'registrations', 'links').flatMap((r, i): DemoRegistration[] => {
    const link = str(r.path) || str(r.url) || str(r.link) || str(r.verifyUrl) || str(r.confirmationLink);
    if (!link) return [];
    let path = link;
    try { const u = new URL(link, window.location.origin); path = `${u.pathname}${u.search}`; } catch { /* keep as given */ }
    if (!path.startsWith('/verify')) return [];
    const email = str(r.email) || str(r.to);
    return [{ key: `${i}-${email}`, email, label: str(r.orgName) || str(r.companyName) || email || 'Registration', path }];
  });
}

/** The onboarding checklist of the signed in company. Shared with the overview (same query key). */
export function useOnboarding(enabled: boolean) {
  return useQuery({ queryKey: ['onboarding'], enabled, queryFn: () => api<Onboarding>('/api/org/onboarding'), retry: false });
}
