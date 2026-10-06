import { StringDecoder } from 'node:string_decoder';
import { emptyResult, type ContentSource, type ValidationResult } from './index';

/** Edge analysis is skipped above this many triangles. */
export const EDGE_ANALYSIS_LIMIT = 3_000_000;
/** Vertices closer than this (millimetres) are one vertex. */
export const WELD_MM = 0.001;
const ZERO_AREA_MM2 = 1e-10;

class TriSink {
  coords: Float32Array | null;
  n = 0; // vertices received
  nonFinite = 0;
  min = [Infinity, Infinity, Infinity];
  max = [-Infinity, -Infinity, -Infinity];
  private store = true;
  constructor(expectedTriangles: number | null) {
    const t = expectedTriangles ?? 4096;
    if (t > EDGE_ANALYSIS_LIMIT) {
      this.store = false;
      this.coords = null;
    } else {
      this.coords = new Float32Array(Math.max(9, t * 9));
    }
  }
  push(x: number, y: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      this.nonFinite++;
      this.n++;
      return;
    }
    if (x < this.min[0]) this.min[0] = x;
    if (y < this.min[1]) this.min[1] = y;
    if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x;
    if (y > this.max[1]) this.max[1] = y;
    if (z > this.max[2]) this.max[2] = z;
    if (this.store && this.coords) {
      const o = this.n * 3;
      if (o + 3 > this.coords.length) {
        if (this.n / 3 >= EDGE_ANALYSIS_LIMIT) {
          this.store = false;
          this.coords = null;
        } else {
          const bigger = new Float32Array(Math.min(EDGE_ANALYSIS_LIMIT * 9, this.coords.length * 2));
          bigger.set(this.coords);
          this.coords = bigger;
        }
      }
      if (this.store && this.coords) {
        this.coords[o] = x;
        this.coords[o + 1] = y;
        this.coords[o + 2] = z;
      }
    }
    this.n++;
  }
}

async function parseBinary(src: ContentSource, sink: TriSink): Promise<void> {
  let skip = 84;
  let carry: Buffer = Buffer.alloc(0);
  for await (const raw of src.stream()) {
    let chunk: Buffer = raw;
    if (skip > 0) {
      if (chunk.length <= skip) {
        skip -= chunk.length;
        continue;
      }
      chunk = chunk.subarray(skip);
      skip = 0;
    }
    if (carry.length) {
      chunk = Buffer.concat([carry, chunk]);
      carry = Buffer.alloc(0);
    }
    const whole = Math.floor(chunk.length / 50);
    for (let i = 0; i < whole; i++) {
      const o = i * 50 + 12; // skip the normal
      sink.push(chunk.readFloatLE(o), chunk.readFloatLE(o + 4), chunk.readFloatLE(o + 8));
      sink.push(chunk.readFloatLE(o + 12), chunk.readFloatLE(o + 16), chunk.readFloatLE(o + 20));
      sink.push(chunk.readFloatLE(o + 24), chunk.readFloatLE(o + 28), chunk.readFloatLE(o + 32));
    }
    carry = Buffer.from(chunk.subarray(whole * 50));
  }
}

const VERTEX = /^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)/;

async function parseAscii(src: ContentSource, sink: TriSink): Promise<void> {
  const dec = new StringDecoder('utf8');
  let rest = '';
  const lines = (text: string) => {
    const parts = (rest + text).split(/\r?\n|\r/);
    rest = parts.pop() ?? '';
    for (const line of parts) {
      const m = VERTEX.exec(line);
      if (m) sink.push(Number(m[1]), Number(m[2]), Number(m[3]));
    }
  };
  for await (const c of src.stream()) lines(dec.write(c));
  lines(dec.end() + '\n');
}

export interface MeshStats {
  vertices: number;
  openEdges: number;
  nonManifoldEdges: number;
  zeroAreaTriangles: number;
}

/**
 * Welds vertices at 1 micrometre (integer quantisation and an open addressing hash table over typed arrays)
 * and counts edges by sorting packed edge keys. Open edges are used by exactly one triangle, non manifold
 * edges by three or more.
 */
export function analyseMesh(coords: Float32Array, tris: number): MeshStats {
  const total = tris * 3;
  const ids = new Int32Array(total);
  let cap = 1 << 16;
  while (cap < total) cap <<= 1;
  cap <<= 1; // load factor never above 0.5
  const mask = cap - 1;
  let table: Int32Array | null = new Int32Array(cap).fill(-1);
  let qcap = Math.max(1024, Math.min(total, tris + 1024));
  let qx = new Int32Array(qcap);
  let qy = new Int32Array(qcap);
  let qz = new Int32Array(qcap);
  let nv = 0;
  const scale = 1 / WELD_MM;
  const clamp = (v: number) => Math.max(-2147483647, Math.min(2147483647, Math.round(v * scale)));
  for (let i = 0; i < total; i++) {
    const x = clamp(coords[i * 3]!);
    const y = clamp(coords[i * 3 + 1]!);
    const z = clamp(coords[i * 3 + 2]!);
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
    for (;;) {
      const e = table[h]!;
      if (e === -1) {
        if (nv === qcap) {
          qcap = Math.min(total, qcap * 2);
          const nx = new Int32Array(qcap);
          nx.set(qx);
          qx = nx;
          const ny = new Int32Array(qcap);
          ny.set(qy);
          qy = ny;
          const nz = new Int32Array(qcap);
          nz.set(qz);
          qz = nz;
        }
        qx[nv] = x;
        qy[nv] = y;
        qz[nv] = z;
        table[h] = nv;
        ids[i] = nv++;
        break;
      }
      if (qx[e] === x && qy[e] === y && qz[e] === z) {
        ids[i] = e;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  table = null;

  const keys = new Float64Array(total);
  let nk = 0;
  let zero = 0;
  const N = nv + 1;
  for (let t = 0; t < tris; t++) {
    const a = ids[t * 3]!;
    const b = ids[t * 3 + 1]!;
    const c = ids[t * 3 + 2]!;
    const o = t * 9;
    const ux = coords[o + 3]! - coords[o]!;
    const uy = coords[o + 4]! - coords[o + 1]!;
    const uz = coords[o + 5]! - coords[o + 2]!;
    const vx = coords[o + 6]! - coords[o]!;
    const vy = coords[o + 7]! - coords[o + 1]!;
    const vz = coords[o + 8]! - coords[o + 2]!;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    const collapsed = a === b || b === c || a === c;
    if (collapsed || area < ZERO_AREA_MM2) zero++;
    if (collapsed) continue; // no usable edges
    keys[nk++] = (a < b ? a : b) * N + (a < b ? b : a);
    keys[nk++] = (b < c ? b : c) * N + (b < c ? c : b);
    keys[nk++] = (c < a ? c : a) * N + (c < a ? a : c);
  }
  const sorted = keys.subarray(0, nk);
  sorted.sort();
  let open = 0;
  let nonManifold = 0;
  for (let i = 0; i < nk; ) {
    let j = i + 1;
    while (j < nk && sorted[j] === sorted[i]) j++;
    const run = j - i;
    if (run === 1) open++;
    else if (run > 2) nonManifold++;
    i = j;
  }
  return { vertices: nv, openEdges: open, nonManifoldEdges: nonManifold, zeroAreaTriangles: zero };
}

const fmt = (n: number) => n.toLocaleString('en-GB');
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round1 = (n: number) => Math.round(n * 10) / 10;

export async function validateStl(src: ContentSource): Promise<ValidationResult> {
  const r = emptyResult();
  const parts: Buffer[] = [];
  let have = 0;
  for await (const c of src.stream()) {
    parts.push(c);
    have += c.length;
    if (have >= 84) break;
  }
  const head = Buffer.concat(parts);
  const startsSolid = head.subarray(0, 5).toString('latin1').toLowerCase() === 'solid';
  if (head.length < 84 && !startsSolid) {
    r.errors.push({ code: 'stl_invalid', message: 'This is not a valid STL file.' });
    return r;
  }
  const declared = head.length >= 84 ? head.readUInt32LE(80) : 0;
  const isBinary = head.length >= 84 && src.size === 84 + 50 * declared;

  let sink: TriSink;
  let format: 'binary' | 'ascii';
  if (isBinary) {
    format = 'binary';
    sink = new TriSink(declared);
    await parseBinary(src, sink);
  } else if (startsSolid) {
    format = 'ascii';
    sink = new TriSink(null);
    await parseAscii(src, sink);
    if (sink.n % 3 !== 0) {
      r.errors.push({ code: 'stl_invalid', message: 'The STL file is incomplete: a facet is missing vertices.' });
      return r;
    }
  } else {
    r.errors.push({ code: 'stl_invalid', message: 'This is not a valid STL file. Its size does not match its triangle count.' });
    return r;
  }

  const tris = Math.floor(sink.n / 3);
  if (tris === 0) {
    r.errors.push({ code: 'stl_empty', message: 'The STL file contains no triangles.' });
    return r;
  }
  if (sink.nonFinite > 0) {
    r.errors.push({ code: 'stl_invalid_values', message: 'The STL file contains coordinates that are not valid numbers.' });
    return r;
  }

  const size = [0, 1, 2].map((i) => sink.max[i]! - sink.min[i]!);
  const maxDim = Math.max(...size);
  r.meta = {
    format,
    triangles: tris,
    bbox: { min: sink.min.map(round3), max: sink.max.map(round3), size: size.map(round3) },
  };
  if (maxDim > 150 || maxDim < 20) {
    r.warnings.push({
      code: 'stl_units',
      message: `The model is ${round1(maxDim)} mm across at its longest. Dental models are normally 20 to 150 mm, so please check the units are millimetres.`,
    });
  }
  if (sink.coords && tris <= EDGE_ANALYSIS_LIMIT) {
    const st = analyseMesh(sink.coords, tris);
    Object.assign(r.meta, { vertices: st.vertices, openEdges: st.openEdges, nonManifoldEdges: st.nonManifoldEdges, zeroAreaTriangles: st.zeroAreaTriangles, edgeAnalysis: true });
    if (st.openEdges > 0) r.warnings.push({ code: 'stl_open_edges', message: `The surface has ${fmt(st.openEdges)} open edges, so the model has holes or is not closed.` });
    if (st.nonManifoldEdges > 0) r.warnings.push({ code: 'stl_non_manifold', message: `The surface has ${fmt(st.nonManifoldEdges)} edges shared by more than two triangles.` });
    if (st.zeroAreaTriangles / tris > 0.01) r.warnings.push({ code: 'stl_zero_area', message: `${fmt(st.zeroAreaTriangles)} triangles have no area (more than 1% of the model).` });
  } else {
    Object.assign(r.meta, { edgeAnalysis: false });
  }
  return r;
}
