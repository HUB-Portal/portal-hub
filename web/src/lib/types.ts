import type { Permission } from '@shared/roles';
import type { SimpleStatus, StepperStep } from '@shared/stages';

export type Stage = 'password' | 'mfa_setup' | 'full';

export interface Me {
  authenticated: boolean;
  stage: Stage;
  csrfToken: string | null;
  /** False while two factor sign in is switched off on the server. */
  mfaRequired: boolean;
  user: { id: string; email: string; name: string; roles: string[]; mfaEnabled: boolean; recoveryCodesRemaining: number };
  org: { id: string; kind: 'kline' | 'partner'; name: string; code: string; status: string; country: string | null } | null;
  permissions: Permission[];
  stepUp: { valid: boolean; minutes: number };
  demo: { enabled: boolean; code: { code: string; secondsLeft: number } | null };
}

export interface Issue { code: string; message: string; fileId?: string; arch?: 'upper' | 'lower'; step?: number }

export type PortalStatus = 'not_applicable' | 'pending' | 'pushing' | 'pushed' | 'failed';

export interface CasePortal {
  status: PortalStatus;
  caseUuid?: string;
  attempts: number;
  step?: number;
  steps?: number;
  lastError?: string;
  /** Partners only: the one thing they can fix themselves. The error text is never sent to them. */
  actionNeeded?: 'case_address';
  /** True when the in memory demo portal was used: nothing was sent to the K Line portal. */
  demo?: boolean;
  /** Last status read from the K Line portal, its label, and when it was read. */
  portalStatus?: string;
  portalStatusLabel?: string;
  syncedAt?: string;
  syncError?: string;
}

export interface CaseItem {
  id: string;
  ref: string;
  /** Set when the data of the case was purged or erased. Only the production record is left. */
  purgedAt?: string | null;
  caseId: string | null;
  status: string;
  stage?: string | null;
  kind: string;
  priority: string;
  manufacturingMode: 'standard' | 'direct';
  patientMasked: string | null;
  /** Partner people only: the full name of a patient their own company uploaded. K Line staff get the masked name. */
  patientName?: string | null;
  hasPatientName: boolean;
  brandId?: string | null;
  siteCode?: string | null;
  dueDate?: string | null;
  holdReason?: string | null;
  counts: { upper: number; lower: number; templates: number; shipped: number };
  checks: { errors: Issue[]; warnings: Issue[] };
  warningsAcknowledged: boolean;
  portal: CasePortal;
  instructions?: string | null;
  createdAt: string;
  submittedAt?: string | null;
  readyAt?: string | null;
  cancelledAt?: string | null;
  receivedAt?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  stageLabel?: string | null;
  expectedShipDate?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  simpleStatus?: SimpleStatus;
  stepper?: StepperStep[];
  orgId?: string;
  orgName?: string;
  orgCode?: string;
  /** Intake list only: the partner's sites with the transfer gate applied. */
  sites?: SiteOption[];
  defaultSiteCode?: string | null;
  waitingHours?: number;
  /** Phase 4: parent and spec version. */
  parentId?: string | null;
  parentRef?: string | null;
  specId?: string | null;
  specVersion?: number | null;
  claimId?: string | null;
  requestedItems?: { arch: 'upper' | 'lower'; step: number; template?: boolean }[] | null;
}

export type { StepperStep, SimpleStatus } from '@shared/stages';

export interface SiteOption { code: string; name: string; country?: string; allowed?: boolean; reason?: string | null }
/** Staff case detail only. */
export interface Routing {
  siteCode: string | null;
  siteName: string | null;
  mesCaseId: string | null;
  canRoute: boolean;
  partnerCountry: string | null;
  sccOnFile: boolean;
  defaultSiteCode: string | null;
  sites: SiteOption[];
}

export type FileState = 'uploading' | 'processing' | 'ready' | 'rejected' | 'purged';

export interface CaseFile {
  id: string;
  kind: string;
  arch: 'upper' | 'lower' | null;
  step: number | null;
  template: boolean;
  name: string;
  ext: string;
  size: number;
  state: FileState;
  scan?: string;
  validation?: { errors?: Issue[]; warnings?: Issue[]; meta?: Record<string, unknown> } | null;
  createdAt: string;
}

export interface CaseEvent {
  id?: string;
  type: string;
  at?: string;
  createdAt?: string;
  actorType?: string | null;
  actorLabel?: string | null;
  sourceLabel?: string | null;
  source?: string | null;
  data?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
}

export interface CaseList { items: CaseItem[]; total: number; page: number; pageSize: number }
export interface CaseClaimRef { id: string; number: string; status: string; summary: string; createdAt?: string }
export interface CaseChild { id: string; ref: string; kind: string; status: string }
export interface CaseDetail { case: CaseItem; files: CaseFile[]; events: CaseEvent[]; instructions?: string | null; routing?: Routing | null; children?: CaseChild[]; claims?: CaseClaimRef[] }

export interface OrgInfo {
  id: string; kind: string; name: string; code: string; status: string; country: string | null;
  sites: { id: string; code: string; name: string; country: string }[];
  settings: { requirePts: boolean; manualReview: boolean; slaDays: number; caseIdRegex: string | null };
  dpaOnFile: boolean;
  uploadsUnlocked: boolean;
  /** Phase 8. `version` changes when the logo changes. */
  logo?: { hasLogo: boolean; version: string | number | null };
  /** What the signed in person sees in the menu. Visibility only. */
  menu?: { claims: boolean; spec: boolean; materials: boolean };
}

export interface TeamUser {
  id: string; email: string; name: string; roles: string[]; status: 'invited' | 'active' | 'disabled';
  mfaEnabled: boolean; lastLoginAt: string | null; createdAt: string; isYou: boolean;
  /** Set while the account is locked after wrong passwords or wrong authenticator codes. */
  lockedUntil?: string | null; locked?: boolean;
}

export interface SessionRow { id: string; current: boolean; ip?: string | null; userAgent?: string | null; createdAt?: string; lastSeenAt?: string; [k: string]: unknown }

export interface AuditEntry {
  seq: number; at: string; actorType: string; actorLabel: string; action: string;
  targetType: string | null; targetId: string | null; ip: string | null; details: Record<string, unknown> | null;
}

export interface BatchResult {
  batch: { id: string; createdAt?: string; [k: string]: unknown };
  cases: CaseItem[];
}
