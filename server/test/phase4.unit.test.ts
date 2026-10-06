import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CLAIM_RESOLUTIONS, CLAIM_STATUSES, DEFECTS, DEFECT_CODES, defectLabel, isDefectCode } from '../../shared/defects';
import {
  CLAUSE_ID_RE, SPEC_SECTIONS, SPEC_SECTION_INFO, canonicalJson, clauseIds, clausesOf, defaultSpecContent, diffSpecs, hashSpec, parseSpecContent, sha256Hex, type SpecContent,
} from '../../shared/spec';
import { daysOfCover } from '../src/services/materials';
import { isRequestedFile, itemsOf } from '../src/services/requested';

const nodeSha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('defect codes', () => {
  it('lists every code from the brief with a label', () => {
    expect(DEFECT_CODES).toEqual([
      'DEBRIS', 'FOIL_RESIDUE', 'WASH_RESIDUE', 'SCRATCHES', 'TRANSPARENCY', 'THERMO_INSUFFICIENT', 'DEFORMED', 'CRACK',
      'TRIM_LINE', 'TRIM_DISTAL', 'SHARP_EDGE', 'NOTCH_CUT', 'TEMPLATE_TRIM', 'LASER_MARK', 'WRONG_STEP', 'MISSING', 'PACKAGING', 'OTHER',
    ]);
    expect(DEFECTS.map((d) => d.code)).toEqual([...DEFECT_CODES]);
    for (const d of DEFECTS) {
      expect(d.label.length).toBeGreaterThan(3);
      expect(d.label).not.toMatch(/ [-–—] /); // no dash separators in interface text
    }
    expect(isDefectCode('CRACK')).toBe(true);
    expect(isDefectCode('crack')).toBe(false);
    expect(defectLabel('SCRATCHES')).toBe('Scratches');
    expect(defectLabel('UNKNOWN')).toBe('UNKNOWN');
    expect(CLAIM_STATUSES).toEqual(['open', 'in_review', 'awaiting_partner', 'accepted', 'rejected', 'closed']);
    expect(CLAIM_RESOLUTIONS).toEqual(['remake', 'credit', 'no_action', 'other']);
  });
});

describe('canonical JSON', () => {
  it('sorts keys at every level and leaves out whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(canonicalJson({ z: { y: 2, x: { w: 1, v: 0 } }, a: [] })).toBe('{"a":[],"z":{"x":{"v":0,"w":1},"y":2}}');
    expect(canonicalJson([{ b: 1, a: 2 }, [3, 1]])).toBe('[{"a":2,"b":1},[3,1]]');
  });

  it('keeps array order, drops undefined properties and escapes strings like JSON', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson({ t: 'Café "film"\n' })).toBe(JSON.stringify({ t: 'Café "film"\n' }));
    expect(canonicalJson('plain')).toBe('"plain"');
    expect(canonicalJson(null)).toBe('null');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson({ n: Infinity })).toThrow();
  });

  it('gives the same text whatever the insertion order', () => {
    const a = { one: 1, two: { b: 2, a: 1 }, three: [{ y: 1, x: 2 }] };
    const b = { three: [{ x: 2, y: 1 }], two: { a: 1, b: 2 }, one: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe('spec hash test vectors', () => {
  // Fixed vectors: the web app must produce exactly these values in the browser.
  const VECTORS: [unknown, string, string][] = [
    [{}, '{}', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'],
    [[], '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'],
    [{ b: 1, a: [true, null, 'x'] }, '{"a":[true,null,"x"],"b":1}', '54a65415ad370228851a1da4b31b6fd42dc58b19a50d35cae759325f7388ce64'],
    [{ clauses: [{ title: 'Film', text: 'Café "film"', id: 'MT-1' }] }, '{"clauses":[{"id":"MT-1","text":"Café \\"film\\"","title":"Film"}]}', 'be95cd43e13cec28c0ff75be577f7de41699434066469d993953fc16b4f098df'],
  ];

  it.each(VECTORS)('canonicalises and hashes %j', async (value, text, hash) => {
    expect(canonicalJson(value)).toBe(text);
    expect(await hashSpec(value)).toBe(hash);
    expect(await sha256Hex(text)).toBe(hash);
    expect(nodeSha(text)).toBe(hash);
  });

  it('hashes the default spec the same way as an independent SHA-256', async () => {
    const c = defaultSpecContent();
    expect(await hashSpec(c)).toBe(nodeSha(canonicalJson(c)));
    expect(await hashSpec(c)).toMatch(/^[0-9a-f]{64}$/);
    // a copy in another key order has the same hash
    const reordered = JSON.parse(JSON.stringify(c, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)));
    expect(await hashSpec(reordered)).toBe(await hashSpec(c));
  });

  it('changes when anything in the content changes', async () => {
    const base = defaultSpecContent();
    const h0 = await hashSpec(base);
    const text = defaultSpecContent();
    text.material.clauses[0]!.text += ' ';
    const title = defaultSpecContent();
    title.trim.clauses[1]!.title = 'Open trim line';
    const extra = defaultSpecContent();
    extra.records.clauses.push({ id: 'RC-3', title: 'Retention', text: 'Records are kept for ten years.' });
    const bag = defaultSpecContent();
    bag.bag.wearDays = 10;
    const hashes = await Promise.all([text, title, extra, bag].map(hashSpec));
    expect(new Set([h0, ...hashes]).size).toBe(5);
  });
});

describe('spec content', () => {
  it('has the eight sections and a valid default', () => {
    expect(SPEC_SECTIONS).toEqual(['material', 'trim', 'hooks', 'templates', 'finish', 'marking', 'packaging', 'records']);
    const c = defaultSpecContent();
    const r = parseSpecContent(c);
    expect(r.ok).toBe(true);
    for (const s of SPEC_SECTIONS) {
      expect(c[s].clauses.length).toBeGreaterThan(0);
      for (const cl of c[s].clauses) {
        expect(cl.id).toMatch(CLAUSE_ID_RE);
        expect(cl.id.startsWith(SPEC_SECTION_INFO[s].prefix + '-')).toBe(true);
      }
    }
    expect(new Set(clauseIds(c)).size).toBe(clauseIds(c).length);
    expect(clausesOf(c)[0]!.section).toBe('material');
    // a fresh copy each time: editing one never changes the next
    c.material.clauses[0]!.title = 'Changed';
    expect(defaultSpecContent().material.clauses[0]!.title).toBe('Film');
    expect(defaultSpecContent().bag.lines).not.toBe(defaultSpecContent().bag.lines);
  });

  it('refuses duplicate ids, wrong prefixes, unknown keys, missing text and bad bag layouts', () => {
    const dup = defaultSpecContent();
    dup.finish.clauses.push({ id: 'FN-1', title: 'Again', text: 'Twice.' });
    const d = parseSpecContent(dup);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.problems.join(' ')).toMatch(/FN-1 is used twice/);

    const wrong = defaultSpecContent();
    wrong.finish.clauses.push({ id: 'MT-9', title: 'Wrong section', text: 'Text.' });
    expect(parseSpecContent(wrong).ok).toBe(false);

    const badId = defaultSpecContent();
    badId.finish.clauses.push({ id: 'XX-1', title: 'Bad', text: 'Text.' });
    expect(parseSpecContent(badId).ok).toBe(false);
    const zero = defaultSpecContent();
    zero.finish.clauses.push({ id: 'FN-0', title: 'Bad', text: 'Text.' });
    expect(parseSpecContent(zero).ok).toBe(false);

    expect(parseSpecContent({ ...defaultSpecContent(), extra: 1 }).ok).toBe(false);
    const noText = defaultSpecContent();
    noText.hooks.clauses[0]!.text = '   ';
    expect(parseSpecContent(noText).ok).toBe(false);
    const ctrl = defaultSpecContent();
    ctrl.hooks.clauses[0]!.text = 'bad\u0000text';
    expect(parseSpecContent(ctrl).ok).toBe(false);

    const bag = defaultSpecContent();
    bag.bag.lines = ['{nonsense}'];
    const b = parseSpecContent(bag);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.problems.join(' ')).toMatch(/placeholder/);
    expect(parseSpecContent(null).ok).toBe(false);
    expect(parseSpecContent({}).ok).toBe(false);
  });

  it('trims clause text on the way in', () => {
    const c = defaultSpecContent();
    c.material.clauses[0]!.title = '  Film  ';
    const r = parseSpecContent(c);
    expect(r.ok && r.content.material.clauses[0]!.title).toBe('Film');
  });
});

describe('clause diff', () => {
  it('reports added, removed and changed clauses per section, and bag changes', () => {
    const base = defaultSpecContent();
    const target: SpecContent = JSON.parse(JSON.stringify(base));
    target.finish.clauses.push({ id: 'FN-4', title: 'Final inspection', text: 'Look at every aligner.' });
    target.trim.clauses = target.trim.clauses.filter((c) => c.id !== 'TR-2');
    target.material.clauses[0]!.text = 'A different film.';
    target.hooks.clauses[1]!.title = 'Plastic around the cut';
    target.bag.wearDays = 7;

    const d = diffSpecs(base, target);
    expect(d.sections.map((s) => s.section)).toEqual([...SPEC_SECTIONS]);
    const by = (n: string) => d.sections.find((s) => s.section === n)!;
    expect(by('finish').added.map((c) => c.id)).toEqual(['FN-4']);
    expect(by('trim').removed.map((c) => c.id)).toEqual(['TR-2']);
    expect(by('material').changed).toHaveLength(1);
    expect(by('material').changed[0]).toMatchObject({ id: 'MT-1', titleChanged: false, textChanged: true, after: { text: 'A different film.' } });
    expect(by('hooks').changed[0]).toMatchObject({ id: 'HK-2', titleChanged: true, textChanged: false });
    expect(by('records')).toMatchObject({ added: [], removed: [], changed: [] });
    expect(d.bag.changed).toBe(true);
    expect(d.changeCount).toBe(5);

    const same = diffSpecs(base, JSON.parse(JSON.stringify(base)));
    expect(same.changeCount).toBe(0);
    expect(same.bag.changed).toBe(false);
  });
});

describe('material helpers', () => {
  it('computes days of cover from the last 28 days of use', () => {
    expect(daysOfCover(280, 28)).toBe(280);
    expect(daysOfCover(100, 56)).toBe(50);
    expect(daysOfCover(10, 0)).toBeNull();
    expect(daysOfCover(-5, 28)).toBe(0);
    expect(daysOfCover(50, 84)).toBe(16.7);
  });
});

describe('requested items', () => {
  it('only requires the ordered aligners, and always the loose documents', () => {
    const items = itemsOf([{ arch: 'upper', step: 3, template: false }, { arch: 'lower', step: 1, template: true, defectCode: 'CRACK' }, { arch: 'bogus', step: 1 }]);
    expect(items).toEqual([
      { arch: 'upper', step: 3, template: false },
      { arch: 'lower', step: 1, template: true, defectCode: 'CRACK' },
    ]);
    expect(itemsOf(null)).toBeNull();
    expect(isRequestedFile({ arch: 'upper', step: 3, is_template: false }, items)).toBe(true);
    expect(isRequestedFile({ arch: 'upper', step: 3, is_template: true }, items)).toBe(false);
    expect(isRequestedFile({ arch: 'upper', step: 4, is_template: false }, items)).toBe(false);
    expect(isRequestedFile({ arch: 'lower', step: 1, is_template: true }, items)).toBe(true);
    expect(isRequestedFile({ arch: null, step: null, is_template: false }, items)).toBe(true);
    expect(isRequestedFile({ arch: 'upper', step: 9, is_template: false }, null)).toBe(true);
  });
});
