import { emptyResult, readAll, type ContentSource, type ValidationResult } from './index';

export const CSV_MAX_BYTES = 64 * 1024 * 1024;

const PLAIN_NUMBER = /^[-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][-+]?\d+)?$/;

/** True when a cell would be read as a formula by a spreadsheet: starts with = @ + - and carries text after it. */
export function isFormulaCell(cell: string): boolean {
  let c = cell.trim();
  if (c.length > 1 && c.startsWith('"') && c.endsWith('"')) c = c.slice(1, -1).trim();
  if (c.length < 2) return false;
  if (!'=@+-'.includes(c[0]!)) return false;
  return !PLAIN_NUMBER.test(c);
}

/** CSV: non UTF-8 warns; cells that look like formulas warn (plain numbers such as -19.622 are fine). Tab, comma and semicolon separated files are read. */
export async function validateCsv(src: ContentSource): Promise<ValidationResult> {
  const r = emptyResult();
  const buf = await readAll(src, CSV_MAX_BYTES);
  let text: string;
  let utf8 = true;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    utf8 = false;
    text = buf.toString('latin1');
  }
  if (!utf8) r.warnings.push({ code: 'csv_encoding', message: 'This file is not UTF-8 text, so special characters may not display correctly.' });
  text = text.replace(/^﻿/, '');
  let rows = 0;
  let formulas = 0;
  let columns = 0;
  for (const line of text.split(/\r?\n|\r/)) {
    if (!line.trim()) continue;
    rows++;
    const cells = line.split(/\t|,|;/);
    if (cells.length > columns) columns = cells.length;
    for (const cell of cells) if (isFormulaCell(cell)) formulas++;
  }
  if (formulas > 0) {
    r.warnings.push({
      code: 'csv_formula',
      message: `${formulas.toLocaleString('en-GB')} cell${formulas === 1 ? ' starts' : 's start'} with = @ + or - followed by text, which a spreadsheet could run as a formula.`,
    });
  }
  r.meta = { rows, columns, utf8 };
  return r;
}
