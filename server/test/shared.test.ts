import { describe, it, expect } from 'vitest';
import { groupCases, parseFileName, isStructuralFolder, missingTrimLines, rangeOf } from '../../shared/filenames';
import { parseBulkFolderName, buildBulkCases, swapNames, validateBulkCase } from '../../shared/bulk';

const f = (path: string, size = 1000) => ({ path, size });

function sampleCase(folder: string, id: string, prefix = '') {
  const out = [];
  for (const a of ['U', 'L']) {
    for (let i = 1; i <= 20; i++) {
      const n = String(i).padStart(2, '0');
      for (const [dir, ext] of [['STL', 'stl'], ['PTS', 'pts'], ['CSV', 'csv']] as const) {
        out.push(f(`${prefix}${folder}/${dir}/${id}_${a}${n}.${ext}`));
      }
    }
    out.push(f(`${prefix}${folder}/STL/${id}_${a}01_T.stl`), f(`${prefix}${folder}/PTS/${id}_${a}01_T.pts`));
  }
  return out;
}

describe('file name parsing', () => {
  it('reads arch and step from U04 / L06 names', () => {
    expect(parseFileName('90001_U04.stl', ['STL'], '90001')).toMatchObject({ kind: 'stl', arch: 'upper', step: 4, template: false });
    expect(parseFileName('90001_L06.pts', ['PTS'], '90001')).toMatchObject({ kind: 'pts', arch: 'lower', step: 6 });
  });
  it('treats a _T suffix as a template for that step', () => {
    expect(parseFileName('90002_U01_T.stl', ['STL'], '90002')).toMatchObject({ arch: 'upper', step: 1, template: true });
    expect(parseFileName('90001_L11_T.csv', ['CSV'], '90001')).toMatchObject({ arch: 'lower', step: 11, template: true });
  });
  it('treats Template as step 0', () => {
    expect(parseFileName('Upper Template.stl')).toMatchObject({ arch: 'upper', step: 0, template: true });
  });
  it('reads words and folders', () => {
    expect(parseFileName('Step 12.stl', ['Maxilla'])).toMatchObject({ arch: 'upper', step: 12 });
    expect(parseFileName('12.stl', ['Unterkiefer'])).toMatchObject({ arch: 'lower', step: 12 });
    expect(parseFileName('plan.pdf')).toMatchObject({ kind: 'pdf', arch: null, step: null });
  });
  it('knows structural folders', () => {
    for (const n of ['Upper', 'STL', 'Trim lines', 'Maxilla models', 'Subsetups', 'Photos 2', 'Rx']) expect(isStructuralFolder(n)).toBe(true);
    expect(isStructuralFolder('90001 Kowalski')).toBe(false);
  });
});

describe('folder grouping', () => {
  it('one dropped case folder gives one case', () => {
    const g = groupCases(sampleCase('90001 Kowalski Jan (2)', '90001'));
    expect(g).toHaveLength(1);
    expect(g[0]!.caseId).toBe('90001');
    expect(g[0]!.idFromFolderName).toBe(false);
    expect(g[0]!.problems).toEqual([]);
    expect(rangeOf(g[0]!.files, 'upper')).toEqual({ min: 1, max: 20, count: 20 });
    expect(missingTrimLines(g[0]!.files)).toHaveLength(0);
  });
  it('a zip with several case folders gives one case per folder', () => {
    const files = [...sampleCase('90001 Kowalski Jan (2)', '90001', 'bulk.zip/'), ...sampleCase('90002 Greta Kask Lind', '90002', 'bulk.zip/')];
    const g = groupCases(files);
    expect(g.map((x) => x.caseId).sort()).toEqual(['90001', '90002']);
    expect(g.every((x) => x.files.length === 124)).toBe(true);
  });
  it('a batch folder with sub folders gives one case each and ignores structural folders', () => {
    const g = groupCases([
      f('Batch/31001 Smith/Upper/U01.stl'), f('Batch/31001 Smith/Lower/L01.stl'),
      f('Batch/31002 Jones/Upper/U01.stl'),
    ]);
    expect(g.map((x) => x.caseId).sort()).toEqual(['31001', '31002']);
    expect(g.find((x) => x.caseId === '31001')!.files.map((x) => x.arch).sort()).toEqual(['lower', 'upper']);
  });
  it('names a case without an ID by the folder and flags it', () => {
    const g = groupCases([f('Garcia Lucia/Maxilla/Step 01.stl'), f('Garcia Lucia/Mandible/Step 01.stl')]);
    expect(g).toHaveLength(1);
    expect(g[0]!.caseId).toBe('Garcia Lucia');
    expect(g[0]!.idFromFolderName).toBe(true);
  });
  it('removes accents and odd characters from a folder-name case ID', () => {
    const g = groupCases([f('José Núñez*/U01.stl')]);
    expect(g[0]!.caseId).toBe('Jose Nunez');
  });
  it('ignores years and dates as IDs', () => {
    const g = groupCases([f('Case 2026 20260924 Lee/U01.stl'), f('Case 2026 20260924 Lee/L01.stl')]);
    expect(g[0]!.idFromFolderName).toBe(true);
  });
  it('groups loose files by the ID at the start of the name', () => {
    const g = groupCases([f('31001_U01.stl'), f('31001_L01.stl'), f('31002_U01.stl'), f('31002_instructions.txt')]);
    expect(g.map((x) => x.caseId).sort()).toEqual(['31001', '31002']);
    expect(g.find((x) => x.caseId === '31002')!.files).toHaveLength(2);
  });
  it('flags a case without models and files without arch or step', () => {
    const g = groupCases([f('40001 Doe/notes.pdf')]);
    expect(g[0]!.problems.join(' ')).toContain('No 3D models');
    const h = groupCases([f('40002 Doe/model.stl')]);
    expect(h[0]!.problems.join(' ')).toContain('without arch or step');
  });
  it('uses the deepest shared folder with an ID for nested exports', () => {
    const g = groupCases([f('Export/2026/55813 Marc Alonso/STL/55813_U01.stl'), f('Export/2026/55813 Marc Alonso/STL/55813_L01.stl')]);
    expect(g).toHaveLength(1);
    expect(g[0]!.caseId).toBe('55813');
  });
});

describe('bulk direct manufacturing folder names', () => {
  it('reads id, first and last name', () => {
    expect(parseBulkFolderName('55813 Marc Alonso')).toMatchObject({ patientId: '55813', firstName: 'Marc', lastName: 'Alonso', needsReview: false, problems: [] });
  });
  it('strips copy suffixes and accepts accents and other scripts', () => {
    expect(parseBulkFolderName('90001 Kowalski Jan (2)')).toMatchObject({ patientId: '90001', firstName: 'Kowalski', lastName: 'Jan' });
    expect(parseBulkFolderName('70001 Zoë Ünal')).toMatchObject({ firstName: 'Zoë', lastName: 'Ünal' });
    expect(parseBulkFolderName('70002 Иван Петров')).toMatchObject({ firstName: 'Иван', lastName: 'Петров' });
  });
  it('flags three word names and handles "Last, First"', () => {
    expect(parseBulkFolderName('90002 Greta Kask Lind')).toMatchObject({ firstName: 'Greta', lastName: 'Kask Lind', needsReview: true });
    expect(parseBulkFolderName('55813 Alonso, Marc')).toMatchObject({ firstName: 'Marc', lastName: 'Alonso' });
  });
  it('reports missing mandatory data', () => {
    expect(parseBulkFolderName('55813').problems).toHaveLength(2);
    expect(parseBulkFolderName('Marc Alonso')).toMatchObject({ firstName: 'Marc', lastName: 'Alonso', problems: [] }); // no patient ID needed
  });
  it('swaps names', () => {
    expect(swapNames({ firstName: 'Kowalski', lastName: 'Jan' })).toEqual({ firstName: 'Jan', lastName: 'Kowalski' });
  });
  it('builds bulk cases from a zip and separates other documents', () => {
    const files = [...sampleCase('90001 Kowalski Jan (2)', '90001', 'z.zip/'), f('z.zip/55813 Marc Alonso/STL/55813_U01.stl'), f('z.zip/55813 Marc Alonso/plan.pdf'), f('z.zip/55813 Marc Alonso/notes.txt')];
    const cases = buildBulkCases(files);
    expect(cases).toHaveLength(2);
    const marc = cases.find((c) => c.firstName === 'Marc')!;
    expect(marc).toMatchObject({ firstName: 'Marc', lastName: 'Alonso' });
    expect(marc.documents.map((d) => d.name)).toEqual(['plan.pdf']);
    expect(marc.instructionFiles.map((d) => d.name)).toEqual(['notes.txt']);
    const other = cases.find((c) => c.firstName === 'Kowalski')!;
    expect(other.documents.every((d) => d.kind === 'csv')).toBe(true);
    expect(validateBulkCase({ ...marc, firstName: '' })).toContain('Patient first name is missing.');
  });
});

describe('patient name pre-fill', () => {
  it('fills the name from "<ID> <name>" folders and stays empty otherwise', async () => {
    const { patientNameFromFolder } = await import('../../shared/bulk');
    expect(patientNameFromFolder('55813 Marc Alonso')).toBe('Marc Alonso');
    expect(patientNameFromFolder('90001 Kowalski Jan (2)')).toBe('Kowalski Jan');
    expect(patientNameFromFolder('31001')).toBe('');
    expect(patientNameFromFolder('Garcia Lucia')).toBe('');
  });
});
