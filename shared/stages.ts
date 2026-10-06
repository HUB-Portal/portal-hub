// Case statuses, factory stages and the partner facing stepper. Pure TypeScript, used by server and web.

export const STATUSES = ['draft', 'submitted', 'on_hold', 'ready', 'received', 'in_production', 'shipped', 'delivered', 'cancelled'] as const;
export type CaseStatus = (typeof STATUSES)[number];

export const STAGE_IDS = ['received', 'printing', 'thermoforming', 'trimming', 'finishing', 'quality_check', 'packing', 'shipped', 'delivered'] as const;
export type StageId = (typeof STAGE_IDS)[number];

export const STAGES: readonly { id: StageId; label: string }[] = [
  { id: 'received', label: 'Received at factory' },
  { id: 'printing', label: '3D printing' },
  { id: 'thermoforming', label: 'Thermoforming' },
  { id: 'trimming', label: 'Trimming' },
  { id: 'finishing', label: 'Finishing and cleaning' },
  { id: 'quality_check', label: 'Quality check' },
  { id: 'packing', label: 'Packing' },
  { id: 'shipped', label: 'Shipped' },
  { id: 'delivered', label: 'Delivered' },
];

/** What a stage map row may point to: a stage, or an action. */
export const MAP_ACTIONS = ['hold', 'cancelled', 'ignore'] as const;
export type MapAction = (typeof MAP_ACTIONS)[number];
export type MapTarget = StageId | MapAction;
export const MAP_TARGETS: readonly MapTarget[] = [...STAGE_IDS, ...MAP_ACTIONS];

export function isStageId(v: unknown): v is StageId {
  return typeof v === 'string' && (STAGE_IDS as readonly string[]).includes(v);
}
export function isMapTarget(v: unknown): v is MapTarget {
  return typeof v === 'string' && (MAP_TARGETS as readonly string[]).includes(v);
}

/** Position of a stage in the production order, or -1 for none or unknown. */
export function stageIndex(stage: string | null | undefined): number {
  return stage ? (STAGE_IDS as readonly string[]).indexOf(stage) : -1;
}

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return '';
  return STAGES.find((s) => s.id === stage)?.label ?? stage.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Case status implied by a stage. Printing to packing are all "in production". */
export function statusForStage(stage: StageId): 'received' | 'in_production' | 'shipped' | 'delivered' {
  if (stage === 'received') return 'received';
  if (stage === 'shipped') return 'shipped';
  if (stage === 'delivered') return 'delivered';
  return 'in_production';
}

export type StepState = 'done' | 'current' | 'upcoming';

/** The only four statuses the partner sees on the progress bar and in lists. */
export const SIMPLE_STATUSES = ['draft', 'submitted', 'production', 'shipped'] as const;
export type HubSimpleStatus = (typeof SIMPLE_STATUSES)[number];
export type SimpleStatus = HubSimpleStatus | 'cancelled';

export const SIMPLE_STATUS_LABELS: Record<SimpleStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  production: 'Production',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
};

export interface StepperStep {
  id: HubSimpleStatus;
  label: string;
  state: StepState;
  /** Short caption under the current step, for example the factory stage ("3D printing"). */
  detail?: string | null;
}

/** Hub case status to the simple status. Held, ready and submitted are all "Submitted"; received and in production are "Production". */
export function simpleStatus(c: { status: string }): SimpleStatus {
  switch (c.status) {
    case 'draft':
      return 'draft';
    case 'submitted':
    case 'on_hold':
    case 'ready':
      return 'submitted';
    case 'received':
    case 'in_production':
      return 'production';
    case 'shipped':
    case 'delivered':
      return 'shipped';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'submitted';
  }
}

/** K Line portal status codes (API 2.6) and how the portal words them. */
export const PORTAL_STATUS_LABELS: Record<string, string> = {
  New: 'Draft',
  InPlanning: 'In planning',
  PendingPlanReview: 'Waiting for approval',
  PlanRejected: 'Plan rejected',
  InProduction: 'In production',
  Shipped: 'Shipped',
};

export function portalStatusLabel(portalStatus: string | null | undefined): string {
  return portalStatus ? PORTAL_STATUS_LABELS[portalStatus] ?? 'Unknown' : '';
}

/** K Line portal status to the Hub simple status. Returns null for a code this version does not know. */
export function portalStatusToHub(portalStatus: string | null | undefined): HubSimpleStatus | null {
  switch (portalStatus) {
    case 'New':
      return 'draft';
    case 'InPlanning':
    case 'PendingPlanReview':
    case 'PlanRejected':
      return 'submitted';
    case 'InProduction':
      return 'production';
    case 'Shipped':
      return 'shipped';
    default:
      return null;
  }
}

/**
 * Partner progress bar: Draft, Submitted, Production, Shipped. Steps before the current one are done.
 * A cancelled case has no current step (the page shows a Cancelled notice instead).
 * The caption under the current step gives the detail: the factory stage, "On hold", or the portal's own status.
 */
export function stepperSteps(c: { status: string; stage?: string | null; portalStatus?: string | null }): StepperStep[] {
  const simple = simpleStatus(c);
  const at = simple === 'cancelled' ? -1 : SIMPLE_STATUSES.indexOf(simple);
  let detail: string | null = null;
  if (simple === 'submitted') {
    detail = c.status === 'on_hold' ? 'On hold' : c.status === 'ready' ? 'Files checked' : c.portalStatus && portalStatusToHub(c.portalStatus) === 'submitted' ? portalStatusLabel(c.portalStatus) : null;
  } else if (simple === 'production') {
    detail = c.stage ? stageLabel(c.stage) : null;
  } else if (simple === 'shipped') {
    detail = c.status === 'delivered' ? 'Delivered' : null;
  }
  return SIMPLE_STATUSES.map((id, i) => ({
    id,
    label: SIMPLE_STATUS_LABELS[id],
    state: at < 0 ? 'upcoming' : i < at ? 'done' : i === at ? 'current' : 'upcoming',
    ...(i === at && detail ? { detail } : {}),
  }));
}

export interface StageMapEntry {
  code: string;
  target: MapTarget;
  note: string;
}

/** Default mapping of factory system stage codes. K Line can edit it. */
export const DEFAULT_STAGE_MAP: readonly StageMapEntry[] = [
  { code: 'RECEIVED', target: 'received', note: 'Case received at the factory' },
  { code: 'CAD', target: 'received', note: 'Design work started' },
  { code: 'PRINT', target: 'printing', note: '3D printing' },
  { code: 'POSTPRINT', target: 'printing', note: 'Post print cleaning' },
  { code: 'THERMO', target: 'thermoforming', note: 'Thermoforming' },
  { code: 'TRIM', target: 'trimming', note: 'Trimming' },
  { code: 'LASER', target: 'trimming', note: 'Laser marking and cutting' },
  { code: 'POLISH', target: 'finishing', note: 'Polishing' },
  { code: 'CLEAN', target: 'finishing', note: 'Cleaning' },
  { code: 'QC', target: 'quality_check', note: 'Quality check' },
  { code: 'PACK', target: 'packing', note: 'Packing' },
  { code: 'SHIP', target: 'shipped', note: 'Shipped, needs carrier and tracking' },
  { code: 'DELIVERED', target: 'delivered', note: 'Delivered' },
  { code: 'HOLD', target: 'hold', note: 'Put the case on hold' },
  { code: 'CANCEL', target: 'cancelled', note: 'Cancel the case' },
];

export const STAGE_CODE_RE = /^[A-Z0-9][A-Z0-9_.-]{0,39}$/;
