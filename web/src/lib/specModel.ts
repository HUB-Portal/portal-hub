// Production specification model for the web app (PHASE4_CONTRACT section 2). The content structure, canonical JSON,
// hashing and clause diff come from shared/spec.ts, so the server and the browser always agree.
import {
  SPEC_LIMITS, SPEC_SECTIONS as SECTION_IDS, SPEC_SECTION_INFO, diffSpecs, parseSpecContent,
  type Clause, type SectionDiff, type SpecContent, type SpecSection, type SpecStatus,
} from '@shared/spec';
import type { BagLayout } from '@shared/bag';

export type { Clause, SectionDiff, SpecContent, SpecSection, SpecStatus };
export { SPEC_LIMITS, diffSpecs };

export interface SectionDef { id: SpecSection; title: string; prefix: string; about: string }

const ABOUT: Record<SpecSection, string> = {
  material: 'Film, protective foil and adaptation.',
  trim: 'Source of the trim line, open trim lines and distal extensions.',
  hooks: 'Cut shape, surrounding plastic and the check before shipping.',
  templates: 'Trim height, notches and trim method.',
  finish: 'Edges, cleaning and scratches.',
  marking: 'What is marked on the aligner and where.',
  packaging: 'Bags, box and inserts.',
  records: 'The pre shipment record and claims.',
};

export const SPEC_SECTIONS: readonly SectionDef[] = SECTION_IDS.map((id) => ({ id, title: SPEC_SECTION_INFO[id].label, prefix: SPEC_SECTION_INFO[id].prefix, about: ABOUT[id] }));

export interface Signature { name: string; at: string }
export interface SpecActions { edit: boolean; delete: boolean; propose: boolean; sign: boolean; reject: boolean }

export interface SpecSummary {
  id: string;
  orgId: string | null;
  orgName: string | null;
  version: number;
  status: SpecStatus;
  title: string;
  changeNote: string;
  contentHash: string | null;
  createdSide: 'partner' | 'kline' | null;
  partnerSignature: Signature | null;
  klineSignature: Signature | null;
  rejectionNote: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  proposedAt: string | null;
  activatedAt: string | null;
  /** What the signed in person may do with this version, as decided by the server. */
  actions: SpecActions | null;
}

export interface Spec extends SpecSummary { content: SpecContent }

/* eslint-disable @typescript-eslint/no-explicit-any */
function str(v: unknown): string | null { return typeof v === 'string' && v ? v : null; }

function signature(raw: any): Signature | null {
  if (!raw || typeof raw !== 'object') return null;
  const at = str(raw.signedAt ?? raw.at);
  return at ? { name: str(raw.name) ?? 'Unknown', at } : null;
}

function actions(raw: any): SpecActions | null {
  if (!raw || typeof raw !== 'object') return null;
  return { edit: !!raw.edit, delete: !!raw.delete, propose: !!raw.propose, sign: !!raw.sign, reject: !!raw.reject };
}

export function normalizeSpec(raw: any): Spec {
  const r = raw?.spec ?? raw ?? {};
  const side = str(r.createdSide);
  return {
    id: String(r.id ?? ''),
    orgId: str(r.orgId),
    orgName: str(r.orgName),
    version: Number(r.version ?? 0),
    status: (r.status ?? 'draft') as SpecStatus,
    title: typeof r.title === 'string' ? r.title : '',
    changeNote: typeof r.changeNote === 'string' ? r.changeNote : '',
    contentHash: str(r.contentHash),
    createdSide: side === 'partner' || side === 'kline' ? side : null,
    partnerSignature: signature(r.partnerSignature),
    klineSignature: signature(r.klineSignature),
    rejectionNote: str(r.rejectionNote),
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
    proposedAt: str(r.proposedAt),
    activatedAt: str(r.activatedAt),
    actions: actions(r.actions),
    content: (r.content && typeof r.content === 'object' ? r.content : {}) as SpecContent,
  };
}

export function normalizeSpecList(raw: any): SpecSummary[] {
  const items: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
  return items.map((i) => {
    const { content: _c, ...rest } = normalizeSpec(i);
    return rest;
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function sectionClauses(content: SpecContent, id: string): Clause[] {
  const s = (content as unknown as Record<string, { clauses?: Clause[] } | undefined>)[id];
  return Array.isArray(s?.clauses) ? s!.clauses : [];
}

export function allClauses(content: SpecContent): (Clause & { section: string })[] {
  return SPEC_SECTIONS.flatMap((s) => sectionClauses(content, s.id).map((c) => ({ ...c, section: s.id })));
}

export function nextClauseId(prefix: string, clauses: Clause[]): string {
  let max = 0;
  for (const c of clauses) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

/** Problems with a draft, in plain words. The server checks again with the same rules. */
export function contentProblems(content: SpecContent): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of SPEC_SECTIONS) {
    const list = sectionClauses(content, s.id);
    if (list.length > SPEC_LIMITS.maxClausesPerSection) out.push(`${s.title} can have at most ${SPEC_LIMITS.maxClausesPerSection} clauses.`);
    for (const c of list) {
      if (!c.title.trim()) out.push(`Clause ${c.id} has no title.`);
      if (!c.text.trim()) out.push(`Clause ${c.id} has no text.`);
      if (seen.has(c.id)) out.push(`Clause ${c.id} is used twice.`);
      seen.add(c.id);
    }
  }
  if (!out.length) {
    const r = parseSpecContent(content, { rejectBidi: true });
    if (!r.ok) out.push(...r.problems);
  }
  return out;
}

export const STATUS_LABEL: Record<SpecStatus, string> = {
  draft: 'Draft', proposed: 'Waiting for signatures', active: 'Active', superseded: 'Replaced', rejected: 'Rejected',
};
export const STATUS_TONE: Record<SpecStatus, 'neutral' | 'info' | 'good' | 'warn' | 'bad'> = {
  draft: 'neutral', proposed: 'warn', active: 'good', superseded: 'neutral', rejected: 'bad',
};

/** Bag layout differences, setting by setting. */
const BAG_FIELDS: [keyof BagLayout, string][] = [
  ['widthMm', 'Width'], ['heightMm', 'Height'], ['marginMm', 'Margin'], ['wearDays', 'Wear days'], ['lines', 'Text lines'],
  ['barcode', 'Barcode text'], ['showPatientName', 'Patient name allowed'], ['showPatientInitials', 'Patient initials allowed'],
];

function bagValue(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.join(' | ') : 'No lines';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v === undefined || v === null ? 'Not set' : String(v);
}

export function diffBag(from: BagLayout | undefined, to: BagLayout | undefined): { label: string; before: string; after: string }[] {
  const out: { label: string; before: string; after: string }[] = [];
  for (const [k, label] of BAG_FIELDS) {
    const b = bagValue(from?.[k]);
    const a = bagValue(to?.[k]);
    if (b !== a) out.push({ label, before: b, after: a });
  }
  return out;
}
