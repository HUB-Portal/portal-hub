import { emptyResult, readAll, type ContentSource, type ValidationResult } from './index';

export const PTS_MAX_BYTES = 64 * 1024 * 1024;

export interface PtsParsed {
  points: Float64Array; // x y z per point
  count: number;
  unreadable: number;
  declaredCount: number | null;
}

/** Parses whitespace separated x y z lines. A first line holding a single integer is a declared point count. */
export function parsePts(text: string): PtsParsed {
  const lines = text.replace(/^﻿/, '').split(/\r?\n|\r/);
  let pts = new Float64Array(3 * Math.min(lines.length, 1 << 20));
  let n = 0;
  let unreadable = 0;
  let declared: number | null = null;
  let first = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const t = line.split(/\s+/);
    if (first) {
      first = false;
      if (t.length === 1 && /^\d+$/.test(t[0]!)) {
        declared = Number(t[0]);
        continue;
      }
    }
    if (t.length < 3) {
      unreadable++;
      continue;
    }
    const x = Number(t[0]);
    const y = Number(t[1]);
    const z = Number(t[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      unreadable++;
      continue;
    }
    if (n * 3 + 3 > pts.length) {
      const bigger = new Float64Array(pts.length * 2);
      bigger.set(pts);
      pts = bigger;
    }
    pts[n * 3] = x;
    pts[n * 3 + 1] = y;
    pts[n * 3 + 2] = z;
    n++;
  }
  return { points: pts.subarray(0, n * 3), count: n, unreadable, declaredCount: declared };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function validatePts(src: ContentSource): Promise<ValidationResult> {
  const r = emptyResult();
  const buf = await readAll(src, PTS_MAX_BYTES);
  if (buf.subarray(0, 8192).includes(0)) {
    r.errors.push({ code: 'pts_unreadable', message: 'This trim line file is not readable text.' });
    return r;
  }
  const p = parsePts(buf.toString('utf8'));
  const total = p.count + p.unreadable;
  if (p.count === 0) {
    r.errors.push({ code: 'pts_empty', message: 'The trim line file contains no points.' });
    return r;
  }
  if (p.unreadable / total > 0.1) {
    r.errors.push({ code: 'pts_unreadable', message: `${p.unreadable.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')} lines could not be read as x y z coordinates.` });
    return r;
  }
  if (p.unreadable > 0) {
    r.warnings.push({ code: 'pts_some_unreadable', message: `${p.unreadable.toLocaleString('en-GB')} lines could not be read and were ignored.` });
  }
  if (p.declaredCount !== null && p.declaredCount !== p.count) {
    r.warnings.push({ code: 'pts_count_mismatch', message: `The file says it has ${p.declaredCount.toLocaleString('en-GB')} points but ${p.count.toLocaleString('en-GB')} were read.` });
  }
  if (p.count < 30) {
    r.warnings.push({ code: 'pts_few_points', message: `The trim line has only ${p.count} points. At least 30 are expected.` });
  }

  const pts = p.points;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.count; i++) {
    for (let k = 0; k < 3; k++) {
      const v = pts[i * 3 + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  const segs = new Float64Array(Math.max(0, p.count - 1));
  for (let i = 1; i < p.count; i++) {
    const dx = pts[i * 3]! - pts[(i - 1) * 3]!;
    const dy = pts[i * 3 + 1]! - pts[(i - 1) * 3 + 1]!;
    const dz = pts[i * 3 + 2]! - pts[(i - 1) * 3 + 2]!;
    segs[i - 1] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  let median = 0;
  if (segs.length) {
    const sorted = Float64Array.from(segs).sort();
    median = sorted[Math.floor(sorted.length / 2)]!;
  }
  const gx = pts[0]! - pts[(p.count - 1) * 3]!;
  const gy = pts[1]! - pts[(p.count - 1) * 3 + 1]!;
  const gz = pts[2]! - pts[(p.count - 1) * 3 + 2]!;
  const gap = Math.sqrt(gx * gx + gy * gy + gz * gz);
  const closed = p.count >= 3 && gap <= Math.max(0.3, 3 * median);
  const breakLimit = Math.max(3, 10 * median);
  let breaks = 0;
  for (let i = 0; i < segs.length; i++) if (segs[i]! > breakLimit) breaks++;

  if (!closed) {
    r.warnings.push({ code: 'pts_open', message: `The trim line is not closed. The gap between its first and last point is ${round3(gap)} mm.` });
  }
  if (breaks > 0) {
    r.warnings.push({ code: 'pts_break', message: `The trim line has ${breaks} break${breaks === 1 ? '' : 's'} where neighbouring points are far apart.` });
  }
  r.meta = {
    points: p.count,
    declaredCount: p.declaredCount,
    closed,
    gapMm: round3(gap),
    medianSegmentMm: round3(median),
    breaks,
    bbox: { min: min.map(round3), max: max.map(round3) },
  };
  return r;
}
