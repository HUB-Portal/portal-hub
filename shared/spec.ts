// Production specification (BRIEF section 15): content structure, validation, canonical JSON, hashing and clause diff.
// Pure TypeScript, used by the server and the web app. The web app recomputes the hash in the browser with hashSpec.
import { z } from 'zod';
import { BIDI_MESSAGE, hasBidiControl } from './text';
import { BAG_LIMITS, DEFAULT_BAG_LAYOUT, layoutProblems, type BagLayout } from './bag';

export const SPEC_SECTIONS = ['material', 'trim', 'hooks', 'templates', 'finish', 'marking', 'packaging', 'records'] as const;
export type SpecSection = (typeof SPEC_SECTIONS)[number];

export const SPEC_SECTION_INFO: Record<SpecSection, { label: string; prefix: string }> = {
  material: { label: 'Material', prefix: 'MT' },
  trim: { label: 'Trim line', prefix: 'TR' },
  hooks: { label: 'Hooks and cut shapes', prefix: 'HK' },
  templates: { label: 'Templates', prefix: 'TP' },
  finish: { label: 'Finish', prefix: 'FN' },
  marking: { label: 'Marking', prefix: 'MK' },
  packaging: { label: 'Packaging', prefix: 'PK' },
  records: { label: 'Records', prefix: 'RC' },
};

export const SPEC_STATUSES = ['draft', 'proposed', 'active', 'superseded', 'rejected'] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

export const SPEC_LIMITS = { maxClausesPerSection: 40, titleMax: 120, textMax: 2000, changeNoteMax: 1000, rejectNoteMax: 1000 } as const;
export const CLAUSE_ID_RE = /^(MT|TR|HK|TP|FN|MK|PK|RC)-[1-9][0-9]{0,2}$/;

export interface Clause {
  id: string;
  title: string;
  text: string;
}
export interface SpecSectionContent {
  clauses: Clause[];
}
export type SpecContent = { schemaVersion: 1; bag: BagLayout } & Record<SpecSection, SpecSectionContent>;

/** Text without control characters (line breaks and tabs are fine). */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const cleanText = (max: number, msg: string) =>
  z
    .string()
    .trim()
    .min(1, msg)
    .max(max)
    .refine((v) => !CONTROL_CHARS.test(v), 'Remove control characters.');

const clauseSchema = z
  .object({
    id: z.string().regex(CLAUSE_ID_RE, 'A clause number looks like MT-1.'),
    title: cleanText(SPEC_LIMITS.titleMax, 'Every clause needs a title.'),
    text: cleanText(SPEC_LIMITS.textMax, 'Every clause needs some text.'),
  })
  .strict();

const sectionSchema = z.object({ clauses: z.array(clauseSchema).max(SPEC_LIMITS.maxClausesPerSection) }).strict();

const bagSchema = z
  .object({
    widthMm: z.number().min(BAG_LIMITS.widthMm.min).max(BAG_LIMITS.widthMm.max),
    heightMm: z.number().min(BAG_LIMITS.heightMm.min).max(BAG_LIMITS.heightMm.max),
    marginMm: z.number().min(BAG_LIMITS.marginMm.min).max(BAG_LIMITS.marginMm.max),
    perAligner: z.literal(true),
    wearDays: z.number().int().min(BAG_LIMITS.wearDays.min).max(BAG_LIMITS.wearDays.max),
    lines: z.array(z.string().max(BAG_LIMITS.maxLineLength).refine((v) => !CONTROL_CHARS.test(v), 'Remove control characters.')).max(BAG_LIMITS.maxLines),
    barcode: z.string().min(1).max(BAG_LIMITS.maxBarcodeLength).refine((v) => !CONTROL_CHARS.test(v), 'Remove control characters.'),
    showPatientName: z.boolean(),
    showPatientInitials: z.boolean(),
  })
  .strict();

export const specContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    material: sectionSchema,
    trim: sectionSchema,
    hooks: sectionSchema,
    templates: sectionSchema,
    finish: sectionSchema,
    marking: sectionSchema,
    packaging: sectionSchema,
    records: sectionSchema,
    bag: bagSchema,
  })
  .strict();

/** Flat list of clauses with their section, in section order. */
export function clausesOf(content: SpecContent): (Clause & { section: SpecSection })[] {
  return SPEC_SECTIONS.flatMap((s) => (content[s]?.clauses ?? []).map((c) => ({ ...c, section: s })));
}
export function clauseIds(content: SpecContent): string[] {
  return clausesOf(content).map((c) => c.id);
}

export type SpecParseResult = { ok: true; content: SpecContent } | { ok: false; problems: string[] };

/**
 * Validates and normalises spec content: shape, clause numbers (prefix must match the section, unique across the spec) and the bag layout.
 * With `rejectBidi` (used when someone writes a draft) hidden text direction characters in clause titles and text and in the bag lines are refused.
 * Reading stored content does not use it, so a specification saved before the rule existed can still be read, compared and cited.
 */
export function parseSpecContent(input: unknown, opts: { rejectBidi?: boolean } = {}): SpecParseResult {
  const r = specContentSchema.safeParse(input);
  if (!r.success) {
    const problems = [...new Set(r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)))];
    return { ok: false, problems };
  }
  const content = r.data as SpecContent;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of SPEC_SECTIONS) {
    for (const c of content[s].clauses) {
      if (!c.id.startsWith(SPEC_SECTION_INFO[s].prefix + '-')) problems.push(`${s}: clause ${c.id} must start with ${SPEC_SECTION_INFO[s].prefix}-.`);
      if (seen.has(c.id)) problems.push(`Clause ${c.id} is used twice.`);
      seen.add(c.id);
    }
  }
  problems.push(...layoutProblems(content.bag).map((p) => `bag: ${p}`));
  if (opts.rejectBidi) {
    for (const s of SPEC_SECTIONS) {
      for (const c of content[s].clauses) if (hasBidiControl(c.title) || hasBidiControl(c.text)) problems.push(`${s}: clause ${c.id}: ${BIDI_MESSAGE}`);
    }
    if (content.bag.lines.some(hasBidiControl) || hasBidiControl(content.bag.barcode)) problems.push(`bag: ${BIDI_MESSAGE}`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, content };
}

/** A fresh copy of the default spec with sensible K Line defaults. Short, generic and editable. */
export function defaultSpecContent(): SpecContent {
  const clause = (id: string, title: string, text: string): Clause => ({ id, title, text });
  return {
    schemaVersion: 1,
    material: {
      clauses: [
        clause('MT-1', 'Film', 'Aligners are made from a medical grade thermoforming film of the thickness agreed with the partner.'),
        clause('MT-2', 'Protective foil', 'The protective foil is removed from the film before forming. No foil residue is left on the aligner.'),
        clause('MT-3', 'Adaptation', 'The film fits closely to the model. Gaps between film and model are not accepted.'),
      ],
    },
    trim: {
      clauses: [
        clause('TR-1', 'Trim line source', 'The trim line follows the trim line file (PTS) supplied with the case. Without one, the standard scalloped trim is used.'),
        clause('TR-2', 'Open trim lines', 'A trim line that is not closed is reported to the partner and the case is put on hold until it is corrected.'),
        clause('TR-3', 'Distal extensions', 'The trim ends at the distal edge of the last tooth unless the case says otherwise.'),
      ],
    },
    hooks: {
      clauses: [
        clause('HK-1', 'Cut shape', 'Hooks and cut-outs follow the shape drawn on the model.'),
        clause('HK-2', 'Surrounding plastic', 'The plastic around a cut-out stays intact, with no cracks or stress marks.'),
        clause('HK-3', 'Check before shipping', 'Every cut-out is checked by hand before the aligner is packed.'),
      ],
    },
    templates: {
      clauses: [
        clause('TP-1', 'Trim height', 'Templates are trimmed to the height given in the case instructions.'),
        clause('TP-2', 'Notches', 'Notches are cut where the model shows them.'),
        clause('TP-3', 'Trim method', 'Templates are trimmed by machine unless the case says otherwise.'),
      ],
    },
    finish: {
      clauses: [
        clause('FN-1', 'Edges', 'All edges are smooth and free of burrs.'),
        clause('FN-2', 'Cleaning', 'Aligners are cleaned and dried before packing.'),
        clause('FN-3', 'Scratches', 'Scratches that can be seen at arm length are not accepted.'),
      ],
    },
    marking: {
      clauses: [
        clause('MK-1', 'Content', 'Each aligner carries the laser marking supplied with the case, or its step number if none is supplied.'),
        clause('MK-2', 'Position', 'The marking sits on the outer surface of the aligner, away from the trim line.'),
      ],
    },
    packaging: {
      clauses: [
        clause('PK-1', 'Bags', 'Each aligner is packed in its own labelled bag, laid out as set below.'),
        clause('PK-2', 'Box and inserts', 'Bags are packed in a box with the inserts the partner has supplied.'),
      ],
    },
    records: {
      clauses: [
        clause('RC-1', 'Pre shipment record', 'A quality check is recorded for every case before it ships.'),
        clause('RC-2', 'Claims', 'Quality claims are answered within three working days.'),
      ],
    },
    bag: { ...DEFAULT_BAG_LAYOUT, lines: [...DEFAULT_BAG_LAYOUT.lines] },
  };
}

// ---------------------------------------------------------------------------
// Canonical JSON and hashing
// ---------------------------------------------------------------------------
/**
 * Canonical JSON: object keys sorted (UTF-16 code unit order) at every level, no whitespace, arrays in order,
 * properties with undefined values left out. Numbers and strings use JSON.stringify. Throws on numbers that JSON cannot carry.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('Cannot canonicalise a non finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
    }
    default:
      throw new Error('Cannot canonicalise this value');
  }
}

/** Lower case hex SHA-256 of UTF-8 text, through Web Crypto (browsers and Node 20 or later). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The hash that is signed: SHA-256 of the canonical JSON of the content. */
export function hashSpec(content: unknown): Promise<string> {
  return sha256Hex(canonicalJson(content));
}

// ---------------------------------------------------------------------------
// Clause level diff
// ---------------------------------------------------------------------------
export interface ClauseChange {
  id: string;
  before: { title: string; text: string };
  after: { title: string; text: string };
  titleChanged: boolean;
  textChanged: boolean;
}
export interface SectionDiff {
  section: SpecSection;
  label: string;
  added: Clause[];
  removed: Clause[];
  changed: ClauseChange[];
}
export interface SpecDiff {
  sections: SectionDiff[];
  bag: { changed: boolean; before: BagLayout; after: BagLayout };
  /** Total number of added, removed and changed clauses, plus one when the bag layout changed. */
  changeCount: number;
}

/**
 * What `target` adds, removes and changes compared with `base`, per section. A clause is matched by its id.
 * Sections with no differences are still listed (with empty lists) so a screen can show every section.
 */
export function diffSpecs(base: SpecContent, target: SpecContent): SpecDiff {
  let count = 0;
  const sections = SPEC_SECTIONS.map((s): SectionDiff => {
    const before = new Map((base[s]?.clauses ?? []).map((c) => [c.id, c]));
    const after = new Map((target[s]?.clauses ?? []).map((c) => [c.id, c]));
    const added = [...after.values()].filter((c) => !before.has(c.id));
    const removed = [...before.values()].filter((c) => !after.has(c.id));
    const changed: ClauseChange[] = [];
    for (const [id, a] of after) {
      const b = before.get(id);
      if (!b) continue;
      const titleChanged = a.title !== b.title;
      const textChanged = a.text !== b.text;
      if (titleChanged || textChanged) changed.push({ id, before: { title: b.title, text: b.text }, after: { title: a.title, text: a.text }, titleChanged, textChanged });
    }
    count += added.length + removed.length + changed.length;
    return { section: s, label: SPEC_SECTION_INFO[s].label, added, removed, changed };
  });
  const bagChanged = canonicalJson(base.bag) !== canonicalJson(target.bag);
  if (bagChanged) count += 1;
  return { sections, bag: { changed: bagChanged, before: base.bag, after: target.bag }, changeCount: count };
}
