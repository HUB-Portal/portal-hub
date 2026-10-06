import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STAGE_MAP, MAP_TARGETS, STAGES, STAGE_CODE_RE, STAGE_IDS, isMapTarget, stageIndex, stageLabel, stepperSteps, statusForStage, simpleStatus, portalStatusToHub, portalStatusLabel, SIMPLE_STATUS_LABELS, STATUSES,
} from '../../shared/stages';
import {
  BAG_LIMITS, DEFAULT_BAG_LAYOUT, alignerCode, initialsOf, layoutProblems, printsPersonalData, renderBags, unknownTokens, type BagLayout,
} from '../../shared/bag';
import { planTransition } from '../src/services/stageEngine';
import { parseCsv, stageMapSchema, eventSchema } from '../src/services/mes';
import { parseBagLayout, layoutFromSettings } from '../src/services/bags';
import { siteScope, assertInScope } from '../src/services/scope';
import type { AuthContext } from '../src/auth/context';

describe('stages', () => {
  it('lists the stages in production order with labels', () => {
    expect(STAGE_IDS).toEqual(['received', 'printing', 'thermoforming', 'trimming', 'finishing', 'quality_check', 'packing', 'shipped', 'delivered']);
    expect(STAGES.map((s) => s.label)).toEqual([
      'Received at factory', '3D printing', 'Thermoforming', 'Trimming', 'Finishing and cleaning', 'Quality check', 'Packing', 'Shipped', 'Delivered',
    ]);
    expect(stageIndex('trimming')).toBe(3);
    expect(stageIndex(null)).toBe(-1);
    expect(stageIndex('nonsense')).toBe(-1);
    expect(stageLabel('quality_check')).toBe('Quality check');
    expect(stageLabel(null)).toBe('');
  });

  it('maps stages to statuses: printing to packing are in production', () => {
    expect(statusForStage('received')).toBe('received');
    for (const s of ['printing', 'thermoforming', 'trimming', 'finishing', 'quality_check', 'packing'] as const) expect(statusForStage(s)).toBe('in_production');
    expect(statusForStage('shipped')).toBe('shipped');
    expect(statusForStage('delivered')).toBe('delivered');
  });

  it('builds the four step bar: Draft, Submitted, Production, Shipped', () => {
    const states = (c: { status: string; stage?: string | null }) => stepperSteps(c).map((s) => s.state);
    const cur = (c: { status: string; stage?: string | null; portalStatus?: string | null }) => stepperSteps(c).filter((s) => s.state === 'current');
    expect(stepperSteps({ status: 'draft' }).map((s) => s.id)).toEqual(['draft', 'submitted', 'production', 'shipped']);
    expect(stepperSteps({ status: 'draft' }).map((s) => s.label)).toEqual(['Draft', 'Submitted', 'Production', 'Shipped']);
    expect(states({ status: 'draft' })).toEqual(['current', 'upcoming', 'upcoming', 'upcoming']);
    for (const st of ['submitted', 'on_hold', 'ready']) expect(states({ status: st }), st).toEqual(['done', 'current', 'upcoming', 'upcoming']);
    for (const st of ['received', 'in_production']) expect(states({ status: st }), st).toEqual(['done', 'done', 'current', 'upcoming']);
    for (const st of ['shipped', 'delivered']) expect(states({ status: st }), st).toEqual(['done', 'done', 'done', 'current']);
    // Cancelled: the bar is there, but no step is current.
    expect(states({ status: 'cancelled' })).toEqual(['upcoming', 'upcoming', 'upcoming', 'upcoming']);
    // The detail caption sits on the current step only.
    expect(cur({ status: 'in_production', stage: 'printing' })).toEqual([{ id: 'production', label: 'Production', state: 'current', detail: '3D printing' }]);
    expect(cur({ status: 'in_production', stage: null })[0]!.detail).toBeUndefined();
    expect(cur({ status: 'on_hold' })[0]!.detail).toBe('On hold');
    expect(cur({ status: 'ready' })[0]!.detail).toBe('Files checked');
    expect(cur({ status: 'submitted', portalStatus: 'PendingPlanReview' })[0]!.detail).toBe('Waiting for approval');
    expect(cur({ status: 'submitted', portalStatus: 'InProduction' })[0]!.detail).toBeUndefined();
    expect(cur({ status: 'delivered' })[0]!.detail).toBe('Delivered');
    expect(stepperSteps({ status: 'in_production', stage: 'printing' }).filter((s) => s.id !== 'production').every((s) => !('detail' in s))).toBe(true);
  });

  it('maps a Hub status to the simple status', () => {
    const m: Record<string, string> = {
      draft: 'draft', submitted: 'submitted', on_hold: 'submitted', ready: 'submitted', received: 'production', in_production: 'production',
      shipped: 'shipped', delivered: 'shipped', cancelled: 'cancelled',
    };
    for (const [status, want] of Object.entries(m)) expect(simpleStatus({ status }), status).toBe(want);
    expect(STATUSES.every((s) => simpleStatus({ status: s }) in SIMPLE_STATUS_LABELS)).toBe(true);
  });

  it('maps K Line portal statuses to the simple status', () => {
    expect(portalStatusToHub('New')).toBe('draft');
    for (const p of ['InPlanning', 'PendingPlanReview', 'PlanRejected']) expect(portalStatusToHub(p), p).toBe('submitted');
    expect(portalStatusToHub('InProduction')).toBe('production');
    expect(portalStatusToHub('Shipped')).toBe('shipped');
    expect(portalStatusToHub('Something new')).toBeNull();
    expect(portalStatusToHub(null)).toBeNull();
    expect(portalStatusLabel('InProduction')).toBe('In production');
    expect(portalStatusLabel(null)).toBe('');
  });

  it('ships a default stage map that covers the agreed codes and validates targets', () => {
    const m = Object.fromEntries(DEFAULT_STAGE_MAP.map((e) => [e.code, e.target]));
    expect(m).toMatchObject({
      RECEIVED: 'received', CAD: 'received', PRINT: 'printing', POSTPRINT: 'printing', THERMO: 'thermoforming', TRIM: 'trimming', LASER: 'trimming',
      POLISH: 'finishing', CLEAN: 'finishing', QC: 'quality_check', PACK: 'packing', SHIP: 'shipped', DELIVERED: 'delivered', HOLD: 'hold', CANCEL: 'cancelled',
    });
    for (const e of DEFAULT_STAGE_MAP) {
      expect(isMapTarget(e.target)).toBe(true);
      expect(STAGE_CODE_RE.test(e.code)).toBe(true);
    }
    expect(MAP_TARGETS).toContain('ignore');
    expect(isMapTarget('teleport')).toBe(false);
  });
});

describe('stage engine decisions', () => {
  const at = (status: string, stage: string | null = null, extra: Record<string, unknown> = {}) => ({ status, stage, manufacturing_mode: 'standard', ...extra });
  const ship = { carrier: 'DHL', trackingNumber: 'JD0146', alignersShipped: 24 };

  it('moves forward only', () => {
    expect(planTransition(at('ready'), { target: 'printing', source: 'mes' }).kind).toBe('apply');
    expect(planTransition(at('ready'), { target: 'received', source: 'mes' }).kind).toBe('apply');
    expect(planTransition(at('in_production', 'trimming'), { target: 'packing', source: 'mes' }).kind).toBe('apply');
    expect(planTransition(at('in_production', 'trimming'), { target: 'printing', source: 'mes' })).toMatchObject({ kind: 'ignored' });
    expect(planTransition(at('in_production', 'trimming'), { target: 'trimming', source: 'mes' })).toMatchObject({ kind: 'ignored' });
    expect(planTransition(at('delivered', 'delivered'), { target: 'packing', source: 'mes' })).toMatchObject({ kind: 'ignored' });
  });

  it('ignores a stale stage value on a case that is ready again', () => {
    expect(planTransition(at('ready', 'printing'), { target: 'received', source: 'mes' }).kind).toBe('apply');
  });

  it('needs carrier, tracking and aligners for shipped, from every source', () => {
    for (const source of ['mes', 'csv', 'kline'] as const) {
      expect(planTransition(at('in_production', 'packing'), { target: 'shipped', source })).toMatchObject({ kind: 'error', code: 'shipping_details_required' });
      expect(planTransition(at('in_production', 'packing'), { target: 'shipped', source, ...ship, carrier: '' })).toMatchObject({ kind: 'error' });
      expect(planTransition(at('in_production', 'packing'), { target: 'shipped', source, ...ship, alignersShipped: 0 })).toMatchObject({ kind: 'error' });
      expect(planTransition(at('in_production', 'packing'), { target: 'shipped', source, ...ship }).kind).toBe('apply');
    }
    expect(planTransition(at('in_production', 'packing'), { target: 'shipped', source: 'mes', ...ship, trackingNumber: 'x'.repeat(101) })).toMatchObject({ code: 'invalid_shipping_details' });
  });

  it('holds and cancels', () => {
    expect(planTransition(at('in_production', 'printing'), { target: 'hold', source: 'mes' }).kind).toBe('apply');
    expect(planTransition(at('on_hold'), { target: 'hold', source: 'mes' }).kind).toBe('ignored');
    expect(planTransition(at('shipped', 'shipped'), { target: 'hold', source: 'mes' }).kind).toBe('ignored');
    expect(planTransition(at('draft'), { target: 'hold', source: 'mes' })).toMatchObject({ kind: 'error' });
    // staff must give a reason, the factory system does not have to
    expect(planTransition(at('submitted'), { target: 'hold', source: 'kline', holdReason: 'no' })).toMatchObject({ kind: 'error', code: 'invalid_hold_reason' });
    expect(planTransition(at('submitted'), { target: 'hold', source: 'kline', holdReason: 'Open trim line' }).kind).toBe('apply');
    expect(planTransition(at('ready'), { target: 'cancelled', source: 'mes' }).kind).toBe('apply');
    expect(planTransition(at('cancelled'), { target: 'cancelled', source: 'mes' }).kind).toBe('ignored');
    expect(planTransition(at('shipped', 'shipped'), { target: 'cancelled', source: 'mes' }).kind).toBe('ignored');
  });

  it('refuses stages for cases that are not with the factory, and for direct cases', () => {
    expect(planTransition(at('submitted'), { target: 'printing', source: 'mes' })).toMatchObject({ kind: 'error', code: 'case_not_in_production' });
    expect(planTransition(at('on_hold'), { target: 'printing', source: 'mes' })).toMatchObject({ kind: 'error' });
    expect(planTransition(at('cancelled'), { target: 'printing', source: 'mes' }).kind).toBe('ignored');
    expect(planTransition(at('ready', null, { manufacturing_mode: 'direct' }), { target: 'printing', source: 'mes' })).toMatchObject({ kind: 'error', code: 'direct_case' });
    expect(planTransition(at('ready', null, { mes_case_id: 'A' }), { target: 'printing', source: 'mes', mesCaseId: 'B' })).toMatchObject({ code: 'mes_case_id_mismatch' });
  });
});

describe('csv and event parsing', () => {
  it('reads quoted cells, doubled quotes, CRLF and a BOM', () => {
    const rows = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n3,,\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['3', '', '']]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,b\n"multi\nline",2')).toEqual([['a', 'b'], ['multi\nline', '2']]);
  });

  it('validates events without echoing values', () => {
    expect(eventSchema.safeParse({ event_id: 'e1', stage_code: 'PRINT', occurred_at: '2026-09-30T10:00:00Z', case_ref: 'ACME-000001' }).success).toBe(true);
    expect(eventSchema.safeParse({ event_id: '', stage_code: 'PRINT', occurred_at: 'x' }).success).toBe(false);
    expect(eventSchema.safeParse({ event_id: 'e', stage_code: 'SHIP', occurred_at: '2026-09-30', aligners_shipped: '24' })).toMatchObject({ success: true, data: { aligners_shipped: 24 } });
    expect(eventSchema.safeParse({ event_id: 'e', stage_code: 'SHIP', occurred_at: '2026-09-30', aligners_shipped: 'many' }).success).toBe(false);
  });

  it('validates stage map edits', () => {
    expect(stageMapSchema.safeParse([{ code: 'polish', target: 'finishing', note: 'x' }])).toMatchObject({ success: true, data: [{ code: 'POLISH' }] });
    expect(stageMapSchema.safeParse([{ code: 'bad code!', target: 'finishing' }]).success).toBe(false);
    expect(stageMapSchema.safeParse([{ code: 'X', target: 'moon' }]).success).toBe(false);
    expect(stageMapSchema.safeParse([]).success).toBe(false);
  });
});

describe('bag labels', () => {
  const data = { ref: 'ACME-000123', caseId: '55813', brand: 'Acme Clear', patientName: 'Marc Alonso', aligners: [
    { arch: 'lower' as const, step: 2 }, { arch: 'upper' as const, step: 2 }, { arch: 'upper' as const, step: 1 }, { arch: 'lower' as const, step: 1 }, { arch: 'upper' as const, step: 1 },
  ] };

  it('has the agreed defaults', () => {
    expect(DEFAULT_BAG_LAYOUT).toMatchObject({ widthMm: 76, heightMm: 127, marginMm: 4, perAligner: true, wearDays: 14, barcode: '{ref} {aligner}', showPatientName: false, showPatientInitials: false });
    expect(layoutProblems(DEFAULT_BAG_LAYOUT)).toEqual([]);
  });

  it('renders one bag per aligner, upper first, with no personal data by default', () => {
    const bags = renderBags(DEFAULT_BAG_LAYOUT, data);
    expect(bags.map((b) => b.aligner)).toEqual(['U01', 'U02', 'L01', 'L02']);
    expect(bags[0]).toEqual({
      aligner: 'U01', arch: 'upper', step: 1, barcode: 'ACME-000123 U01',
      lines: ['Acme Clear', '55813', 'U01 Upper', 'Step 1 of 2', 'Wear for 14 days'],
    });
    expect(JSON.stringify(bags)).not.toMatch(/Marc|Alonso/);
    expect(printsPersonalData(DEFAULT_BAG_LAYOUT)).toBe(false);
  });

  it('fills patient tokens only when the layout explicitly enables them', () => {
    const base: BagLayout = { ...DEFAULT_BAG_LAYOUT, lines: ['{patient_name}', '{patient_initials}', '{step_padded}/{total_steps} {arch_short}'] };
    // tokens used but switches off: empty and not flagged
    expect(renderBags(base, data)[0]!.lines.slice(0, 2)).toEqual(['', '']);
    expect(printsPersonalData(base)).toBe(false);
    const on = { ...base, showPatientName: true, showPatientInitials: true };
    expect(renderBags(on, data)[0]!.lines).toEqual(['Marc Alonso', 'M.A.', '01/2 U']);
    expect(printsPersonalData(on)).toBe(true);
    // switch on but never used: nothing is printed, so not flagged
    expect(printsPersonalData({ ...DEFAULT_BAG_LAYOUT, showPatientName: true })).toBe(false);
    // the caller can withhold the name completely (the factory system never gets one)
    expect(renderBags(on, { ...data, patientName: null })[0]!.lines.slice(0, 2)).toEqual(['', '']);
    expect(initialsOf('marc alonso')).toBe('M.A.');
    expect(alignerCode('lower', 7)).toBe('L07');
  });

  it('validates layouts: ranges, at most 8 lines of 60 characters, no unknown tokens', () => {
    expect(unknownTokens('{ref} {nope} {')).toEqual(['nope', '{']);
    expect(layoutProblems({ ...DEFAULT_BAG_LAYOUT, widthMm: 5 }).length).toBe(1);
    expect(layoutProblems({ ...DEFAULT_BAG_LAYOUT, lines: Array(9).fill('x') }).length).toBe(1);
    expect(layoutProblems({ ...DEFAULT_BAG_LAYOUT, lines: ['x'.repeat(61)] }).length).toBe(1);
    expect(layoutProblems({ ...DEFAULT_BAG_LAYOUT, lines: ['{bogus}'] }).length).toBe(1);
    expect(layoutProblems({ ...DEFAULT_BAG_LAYOUT, barcode: '' }).length).toBe(1);
    expect(() => parseBagLayout({ ...DEFAULT_BAG_LAYOUT, lines: ['{bogus}'] })).toThrow();
    expect(() => parseBagLayout({ ...DEFAULT_BAG_LAYOUT, wearDays: BAG_LIMITS.wearDays.max + 1 })).toThrow();
    expect(parseBagLayout(DEFAULT_BAG_LAYOUT)).toEqual(DEFAULT_BAG_LAYOUT);
    expect(layoutFromSettings({ bag: { wearDays: 21 } }).wearDays).toBe(21);
    expect(layoutFromSettings({ bag: { lines: ['{bogus}'] } })).toEqual(DEFAULT_BAG_LAYOUT);
    expect(layoutFromSettings(null)).toEqual(DEFAULT_BAG_LAYOUT);
  });
});

describe('site scope', () => {
  const user = (roles: string[], siteIds: string[], orgKind: 'kline' | 'partner' = 'kline'): AuthContext => ({ kind: 'user', orgKind, roles, siteIds } as unknown as AuthContext);
  it('applies to production staff with sites only', () => {
    expect(siteScope(user(['kl_production'], ['s1']))).toEqual(['s1']);
    expect(siteScope(user(['kl_production'], []))).toBeNull();
    expect(siteScope(user(['kl_production', 'kl_intake'], ['s1']))).toBeNull();
    expect(siteScope(user(['kl_admin'], ['s1']))).toBeNull();
    expect(siteScope(user(['kl_quality'], ['s1']))).toBeNull();
    expect(siteScope(user(['viewer'], ['s1'], 'partner'))).toBeNull();
  });
  it('hides cases outside the sites as not found', () => {
    const a = user(['kl_production'], ['s1']);
    expect(() => assertInScope(a, { site_id: 's1' })).not.toThrow();
    expect(() => assertInScope(a, { site_id: 's2' })).toThrow();
    expect(() => assertInScope(a, { site_id: null })).toThrow();
    expect(() => assertInScope(user(['kl_admin'], []), { site_id: null })).not.toThrow();
  });
});
