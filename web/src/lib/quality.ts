// Types, labels and normalisers for quality claims and partner materials (docs/PHASE4_CONTRACT.md sections 1 and 3).
import { alignerCode } from '@shared/bag';
import { CLAIMABLE_CASE_STATUSES as CLAIMABLE, OPEN_CLAIM_STATUSES } from '@shared/defects';
import type { Tone } from './format';
import { formatNumber } from './format';
import type { CaseFile } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
function str(v: unknown): string | null { return typeof v === 'string' && v ? v : null; }
function num(v: unknown, d = 0): number { const n = Number(v); return Number.isFinite(n) ? n : d; }
function list(raw: any, ...keys: string[]): any[] {
  if (Array.isArray(raw)) return raw;
  for (const k of keys) if (Array.isArray(raw?.[k])) return raw[k];
  return [];
}

/* ---------- claims ---------- */

export type ClaimStatus = 'open' | 'in_review' | 'awaiting_partner' | 'accepted' | 'rejected' | 'closed';
export const CLAIM_STATUSES: ClaimStatus[] = ['open', 'in_review', 'awaiting_partner', 'accepted', 'rejected', 'closed'];
export const ACTIVE_CLAIM_STATUSES: ClaimStatus[] = [...OPEN_CLAIM_STATUSES];
export const CLAIMABLE_CASE_STATUSES: string[] = [...CLAIMABLE];
export const REPLACEABLE_CASE_STATUSES = ['shipped', 'delivered'];

export function claimStatusLabel(s: string, side: 'partner' | 'kline' = 'partner'): string {
  switch (s) {
    case 'open': return 'Open';
    case 'in_review': return 'In review';
    case 'awaiting_partner': return side === 'partner' ? 'Waiting for you' : 'Waiting for the partner';
    case 'accepted': return 'Accepted';
    case 'rejected': return 'Rejected';
    case 'closed': return 'Closed';
    default: return s;
  }
}
export function claimStatusTone(s: string): Tone {
  switch (s) {
    case 'open': case 'in_review': return 'info';
    case 'awaiting_partner': return 'warn';
    case 'accepted': return 'good';
    case 'rejected': return 'bad';
    default: return 'neutral';
  }
}
export const RESOLUTIONS: { id: string; label: string; help: string }[] = [
  { id: 'remake', label: 'Make the aligners again', help: 'K Line creates a rush rework case that reuses the files already stored.' },
  { id: 'credit', label: 'Give a credit', help: 'Finance is told to credit the affected aligners.' },
  { id: 'no_action', label: 'No action needed', help: 'The claim is accepted but nothing more is done.' },
  { id: 'other', label: 'Something else', help: 'Explain in the note.' },
];
export function resolutionLabel(r: string | null | undefined): string {
  return RESOLUTIONS.find((x) => x.id === r)?.label ?? (r ? r : 'Not decided');
}

export interface Claim {
  id: string;
  number: string;
  status: ClaimStatus;
  resolution: string | null;
  summary: string;
  description: string | null;
  specClauseIds: string[];
  rootCause: string | null;
  correctiveAction: string | null;
  decisionNote: string | null;
  caseId: string | null;
  caseRef: string | null;
  orgId: string | null;
  orgName: string | null;
  reworkCaseId: string | null;
  reworkCaseRef: string | null;
  openedByName: string | null;
  itemCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  decidedAt: string | null;
  closedAt: string | null;
}

export interface ClaimItem { id?: string; arch: 'upper' | 'lower'; step: number; template: boolean; defectCode: string; note: string | null }
export interface ClaimMessage { id: string; side: 'partner' | 'kline' | 'system'; authorName: string | null; body: string; createdAt: string }
export interface ClaimDetailData { claim: Claim; items: ClaimItem[]; messages: ClaimMessage[]; evidence: CaseFile[]; specClauses: { id: string; title: string | null }[] }

export function normalizeClaim(raw: any): Claim {
  const r = raw?.claim ?? raw ?? {};
  const c = r.case && typeof r.case === 'object' ? r.case : null;
  const rw = r.reworkCase && typeof r.reworkCase === 'object' ? r.reworkCase : null;
  return {
    id: String(r.id ?? ''),
    number: String(r.number ?? r.ref ?? r.claimNumber ?? ''),
    status: (r.status ?? 'open') as ClaimStatus,
    resolution: str(r.resolution),
    summary: typeof r.summary === 'string' ? r.summary : '',
    description: str(r.description),
    specClauseIds: Array.isArray(r.specClauseIds) ? r.specClauseIds.filter((x: unknown): x is string => typeof x === 'string') : [],
    rootCause: str(r.rootCause),
    correctiveAction: str(r.correctiveAction),
    decisionNote: str(r.decisionNote ?? r.note),
    caseId: str(r.caseId ?? c?.id),
    caseRef: str(r.caseRef ?? c?.ref),
    orgId: str(r.orgId),
    orgName: str(r.orgName),
    reworkCaseId: str(r.reworkCaseId ?? rw?.id),
    reworkCaseRef: str(r.reworkCaseRef ?? rw?.ref),
    openedByName: str(r.openedByName ?? r.openedBy?.name),
    itemCount: r.itemCount === undefined ? null : num(r.itemCount),
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
    decidedAt: str(r.decidedAt),
    closedAt: str(r.closedAt),
  };
}

export interface ClaimList { items: Claim[]; total: number; page: number; pageSize: number }
export function normalizeClaimList(raw: any): ClaimList {
  const items = list(raw, 'items', 'claims').map(normalizeClaim);
  return { items, total: num(raw?.total, items.length), page: num(raw?.page, 1), pageSize: num(raw?.pageSize, items.length || 25) };
}

export function normalizeClaimDetail(raw: any): ClaimDetailData {
  const items: ClaimItem[] = list(raw?.items ?? raw?.claim?.items).map((i: any) => ({
    id: i.id, arch: i.arch === 'lower' ? 'lower' : 'upper', step: num(i.step), template: !!(i.template ?? i.isTemplate), defectCode: String(i.defectCode ?? i.defect ?? 'OTHER'), note: str(i.note),
  }));
  const messages: ClaimMessage[] = list(raw?.messages ?? raw?.claim?.messages).map((m: any) => ({
    id: String(m.id ?? Math.random()), side: m.side === 'kline' || m.side === 'system' ? m.side : 'partner', authorName: str(m.authorName ?? m.author?.name), body: String(m.body ?? ''), createdAt: String(m.createdAt ?? ''),
  }));
  const evidence: CaseFile[] = list(raw?.evidence ?? raw?.files ?? raw?.claim?.evidence);
  const specClauses = list(raw?.specClauses).map((x: any) => ({ id: String(x.id), title: str(x.title) }));
  return { claim: normalizeClaim(raw), items, messages, evidence, specClauses };
}

/* ---------- aligners of a case ---------- */

export interface AlignerRef { key: string; arch: 'upper' | 'lower'; step: number; template: boolean; code: string }

export function alignerKey(a: { arch: string; step: number; template?: boolean }): string { return `${a.arch}|${a.step}|${a.template ? 1 : 0}`; }
export function alignerName(a: { arch: 'upper' | 'lower'; step: number; template?: boolean }): string {
  return `${alignerCode(a.arch, a.step)}${a.template ? ' template' : ''}`;
}

/** The aligner manifest of a case: one entry per arch, step and template flag that has a model or trim line file. */
export function alignersOf(files: CaseFile[]): AlignerRef[] {
  const map = new Map<string, AlignerRef>();
  for (const f of files) {
    if ((f.kind !== 'stl' && f.kind !== 'pts') || !f.arch || f.step === null) continue;
    const a = { arch: f.arch, step: f.step, template: f.template };
    const key = alignerKey(a);
    if (!map.has(key)) map.set(key, { key, ...a, code: alignerName(a) });
  }
  return [...map.values()].sort((a, b) => (a.arch === b.arch ? 0 : a.arch === 'upper' ? -1 : 1) || a.step - b.step || Number(a.template) - Number(b.template));
}

/* ---------- evidence files ---------- */

export const EVIDENCE_EXTS = ['jpg', 'jpeg', 'png', 'mp4', 'mov', 'm4v', 'pdf'];
export const VIDEO_EXTS = ['mp4', 'mov', 'm4v'];
export const MAX_EVIDENCE_FILES = 40;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
export const MAX_SHIPMENT_DOC_BYTES = 25 * 1024 * 1024;
export const MAX_SHIPMENT_DOCS = 20;

export function extOf(name: string): string { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); }
export type MediaKind = 'image' | 'video' | 'pdf' | 'other';
export function mediaKind(ext: string): MediaKind {
  const e = ext.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'].includes(e)) return 'image';
  if (VIDEO_EXTS.includes(e)) return 'video';
  if (e === 'pdf') return 'pdf';
  return 'other';
}

/* ---------- materials ---------- */

export const MATERIAL_CATEGORIES: { id: string; label: string }[] = [
  { id: 'box', label: 'Box' }, { id: 'bag', label: 'Bag' }, { id: 'elastic', label: 'Elastic' },
  { id: 'button', label: 'Button' }, { id: 'insert', label: 'Insert' }, { id: 'other', label: 'Other' },
];
export function categoryLabel(id: string): string { return MATERIAL_CATEGORIES.find((c) => c.id === id)?.label ?? id; }

export interface StockRow { siteCode: string; onHand: number; inTransit: number; used28d: number; daysOfCover: number | null; lowStock: boolean | null }
export interface Material {
  id: string; sku: string; name: string; category: string; unit: string; perCase: number; perAligner: number; minStock: number;
  stock: StockRow[]; orgId: string | null; orgName: string | null; active: boolean;
}

export function normalizeMaterials(raw: any): Material[] {
  return list(raw, 'items', 'materials').map((m: any) => ({
    id: String(m.id), sku: String(m.sku ?? ''), name: String(m.name ?? ''), category: String(m.category ?? 'other'), unit: String(m.unit ?? 'pcs'),
    perCase: num(m.perCase), perAligner: num(m.perAligner), minStock: num(m.minStock),
    stock: list(m.stock).map((s: any) => ({
      siteCode: String(s.siteCode ?? ''), onHand: num(s.onHand), inTransit: num(s.inTransit), used28d: num(s.used28d),
      daysOfCover: s.daysOfCover === null || s.daysOfCover === undefined ? null : num(s.daysOfCover),
      lowStock: typeof s.lowStock === 'boolean' ? s.lowStock : null,
    })),
    orgId: str(m.orgId), orgName: str(m.orgName), active: m.active !== false,
  }));
}

export function isLow(m: Material, s: StockRow): boolean { return s.lowStock ?? (m.minStock > 0 && s.onHand < m.minStock); }
export function coverText(days: number | null): string {
  if (days === null) return 'No recent use';
  if (days < 1) return 'Under 1 day';
  return `${formatNumber(Math.floor(days))} ${Math.floor(days) === 1 ? 'day' : 'days'}`;
}

export type ShipmentStatus = 'in_transit' | 'received' | 'discrepancy' | 'cancelled';
export interface ShipmentLine { id: string; materialId: string; sku: string | null; name: string | null; unit: string | null; quantity: number; receivedQuantity: number | null }
export interface Shipment {
  id: string; number: string; orgId: string | null; orgName: string | null; siteCode: string; carrier: string | null; tracking: string | null;
  expectedDate: string | null; status: ShipmentStatus; lines: ShipmentLine[]; note: string | null; createdAt: string | null; receivedAt: string | null;
}

export function shipmentStatusLabel(s: string): string {
  return ({ in_transit: 'On its way', received: 'Received', discrepancy: 'Received with differences', cancelled: 'Cancelled' } as Record<string, string>)[s] ?? s;
}
export function shipmentStatusTone(s: string): Tone {
  return s === 'received' ? 'good' : s === 'discrepancy' ? 'warn' : s === 'cancelled' ? 'neutral' : 'info';
}

export interface ShipmentPage { items: Shipment[]; total: number; page: number; pageSize: number }
export function normalizeShipmentPage(raw: any): ShipmentPage {
  const items = normalizeShipments(raw);
  return { items, total: num(raw?.total, items.length), page: num(raw?.page, 1), pageSize: num(raw?.pageSize, 25) };
}

export function normalizeShipments(raw: any): Shipment[] {
  return list(raw, 'items', 'shipments').map((s: any) => ({
    id: String(s.id), number: String(s.number ?? s.ref ?? ''), orgId: str(s.orgId), orgName: str(s.orgName), siteCode: String(s.siteCode ?? ''),
    carrier: str(s.carrier), tracking: str(s.tracking ?? s.trackingNumber), expectedDate: str(s.expectedDate), status: (s.status ?? 'in_transit') as ShipmentStatus,
    lines: list(s.lines).map((l: any) => ({
      id: String(l.id ?? l.lineId ?? ''), materialId: String(l.materialId ?? ''), sku: str(l.sku), name: str(l.name ?? l.materialName), unit: str(l.unit),
      quantity: num(l.quantity ?? l.declaredQuantity), receivedQuantity: l.receivedQuantity === null || l.receivedQuantity === undefined ? null : num(l.receivedQuantity),
    })),
    note: str(s.receiveNote ?? s.note), createdAt: str(s.createdAt), receivedAt: str(s.receivedAt),
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */
