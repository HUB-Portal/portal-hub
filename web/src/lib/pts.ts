// Parse a PTS trim line (one point per line, three numbers) and tell whether it is closed. Matches the server rule.

export interface TrimLine {
  points: Float32Array; // x y z triples
  count: number;
  closed: boolean;
  gap: number;
}

export function parsePts(text: string): TrimLine {
  const nums: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/[\s,;]+/).filter(Boolean);
    if (parts.length < 3) continue;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) nums.push(x, y, z);
  }
  const count = Math.floor(nums.length / 3);
  const points = new Float32Array(nums);
  if (count < 3) return { points, count, closed: false, gap: Infinity };
  const seg: number[] = [];
  for (let i = 1; i < count; i++) seg.push(dist(points, i - 1, i));
  const sorted = [...seg].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const gap = dist(points, 0, count - 1);
  return { points, count, closed: gap <= Math.max(0.3, 3 * median), gap };
}

function dist(p: Float32Array, a: number, b: number): number {
  const dx = p[a * 3]! - p[b * 3]!;
  const dy = p[a * 3 + 1]! - p[b * 3 + 1]!;
  const dz = p[a * 3 + 2]! - p[b * 3 + 2]!;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
