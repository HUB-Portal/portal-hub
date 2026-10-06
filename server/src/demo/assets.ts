import { deflateSync } from 'node:zlib';
import { randomInt } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { ZipFile } from 'yazl';
import type { Readable } from 'node:stream';

/**
 * Synthetic demo files. Everything here is made up: no real patient, no real partner. The generators are deterministic
 * (the same input gives the same bytes) so tests can rely on them. All sizes are modest.
 */

type Vec = [number, number, number];

// ---------------------------------------------------------------------------
// Binary STL
// ---------------------------------------------------------------------------
function stlFromIndexed(vertices: Vec[], faces: [number, number, number][], header: string): Buffer {
  const b = Buffer.alloc(84 + faces.length * 50);
  b.write(header.slice(0, 79), 0, 'latin1');
  b.writeUInt32LE(faces.length, 80);
  faces.forEach((f, i) => {
    const o = 84 + i * 50;
    const [a, bb, c] = [vertices[f[0]]!, vertices[f[1]]!, vertices[f[2]]!];
    const u: Vec = [bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]];
    const v: Vec = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    b.writeFloatLE(n[0] / len, o);
    b.writeFloatLE(n[1] / len, o + 4);
    b.writeFloatLE(n[2] / len, o + 8);
    [a, bb, c].forEach((p, k) => {
      b.writeFloatLE(p[0], o + 12 + k * 12);
      b.writeFloatLE(p[1], o + 16 + k * 12);
      b.writeFloatLE(p[2], o + 20 + k * 12);
    });
  });
  return b;
}

const f32 = Math.fround;

/** Centre line of the arch: a half ellipse, in millimetres. */
function archPoint(theta: number, scale: number): { p: [number, number]; n: [number, number] } {
  const A = 22 * scale;
  const B = 26 * scale;
  const p: [number, number] = [A * Math.cos(theta), B * Math.sin(theta)];
  const nx = B * Math.cos(theta);
  const ny = A * Math.sin(theta);
  const len = Math.hypot(nx, ny) || 1;
  return { p, n: [nx / len, ny / len] };
}

const ARCH_SEGMENTS = 60;
const RING_POINTS = 16;
const RADIAL = 4.5; // half width of the tooth row
const HEIGHT = 14; // tooth height

export interface ArchOptions {
  step: number;
  arch: 'upper' | 'lower';
  template?: boolean;
}

/** Scale of the arch for a step: teeth move a little each step. */
const scaleFor = (o: ArchOptions) => (o.arch === 'upper' ? 1 : 0.94) * (1 - 0.0025 * o.step);

/**
 * A closed dental arch shaped solid: an elliptical tube along a horseshoe, capped at both ends.
 * Vertices are shared, so the mesh is a valid closed manifold. About 2,000 triangles, roughly 100 KB.
 */
export function archStl(o: ArchOptions): Buffer {
  const scale = scaleFor(o);
  const V: Vec[] = [];
  const F: [number, number, number][] = [];
  for (let i = 0; i <= ARCH_SEGMENTS; i++) {
    const theta = (Math.PI * i) / ARCH_SEGMENTS;
    const { p, n } = archPoint(theta, scale);
    for (let k = 0; k < RING_POINTS; k++) {
      const phi = (2 * Math.PI * k) / RING_POINTS;
      const r = RADIAL * Math.cos(phi);
      const z = HEIGHT / 2 + (HEIGHT / 2) * Math.sin(phi);
      V.push([f32(p[0] + n[0] * r), f32(p[1] + n[1] * r), f32(z)]);
    }
  }
  const idx = (i: number, k: number) => i * RING_POINTS + (k % RING_POINTS);
  for (let i = 0; i < ARCH_SEGMENTS; i++) {
    for (let k = 0; k < RING_POINTS; k++) {
      F.push([idx(i, k), idx(i + 1, k), idx(i + 1, k + 1)]);
      F.push([idx(i, k), idx(i + 1, k + 1), idx(i, k + 1)]);
    }
  }
  // End caps: a fan around the centre of the first and last ring.
  for (const [ring, flip] of [[0, true], [ARCH_SEGMENTS, false]] as const) {
    const c = V.length;
    const cs = V.slice(ring * RING_POINTS, (ring + 1) * RING_POINTS);
    V.push([f32(cs.reduce((s, v) => s + v[0], 0) / cs.length), f32(cs.reduce((s, v) => s + v[1], 0) / cs.length), f32(HEIGHT / 2)]);
    for (let k = 0; k < RING_POINTS; k++) F.push(flip ? [c, idx(ring, k + 1), idx(ring, k)] : [c, idx(ring, k), idx(ring, k + 1)]);
  }
  return stlFromIndexed(V, F, `Synthetic ${o.arch} arch step ${o.step}${o.template ? ' template' : ''} (demo data)`);
}

/** A closed sphere of the given radius (millimetres), as a UV mesh with pole caps. About 1,000 triangles. */
export function sphereStl(radius = 25, segments = 24): Buffer {
  const V: Vec[] = [[0, 0, f32(radius)]];
  const F: [number, number, number][] = [];
  const rings = segments / 2;
  for (let r = 1; r < rings; r++) {
    const phi = (Math.PI * r) / rings;
    for (let s = 0; s < segments; s++) {
      const th = (2 * Math.PI * s) / segments;
      V.push([f32(radius * Math.sin(phi) * Math.cos(th)), f32(radius * Math.sin(phi) * Math.sin(th)), f32(radius * Math.cos(phi))]);
    }
  }
  const south = V.length;
  V.push([0, 0, f32(-radius)]);
  const at = (r: number, s: number) => 1 + (r - 1) * segments + (s % segments);
  for (let s = 0; s < segments; s++) F.push([0, at(1, s), at(1, s + 1)]);
  for (let r = 1; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) {
      F.push([at(r, s), at(r + 1, s), at(r + 1, s + 1)]);
      F.push([at(r, s), at(r + 1, s + 1), at(r, s + 1)]);
    }
  }
  for (let s = 0; s < segments; s++) F.push([south, at(rings - 1, s + 1), at(rings - 1, s)]);
  return stlFromIndexed(V, F, 'Synthetic sphere (demo data)');
}

// ---------------------------------------------------------------------------
// Trim lines (PTS)
// ---------------------------------------------------------------------------
/**
 * Trim line around an arch model: along the outside of the tooth row, back along the inside, at gum height.
 * Closed by repeating the first point. With `open` the last part is left out, so the line has a gap of several millimetres.
 */
export function trimLinePts(o: ArchOptions & { open?: boolean }): Buffer {
  const scale = scaleFor(o);
  const z = 9;
  const offset = 4.2; // on the surface of the tooth row at gum height
  const n = 90;
  const pts: Vec[] = [];
  const at = (theta: number, side: 1 | -1): Vec => {
    const { p, n: nn } = archPoint(theta, scale);
    return [p[0] + nn[0] * offset * side, p[1] + nn[1] * offset * side, z];
  };
  for (let i = 0; i <= n; i++) pts.push(at((Math.PI * i) / n, 1));
  for (let i = n; i >= 0; i--) pts.push(at((Math.PI * i) / n, -1));
  if (o.open) pts.splice(pts.length - 22); // leaves a gap of roughly 20 mm between first and last point
  else pts.push(pts[0]!);
  return Buffer.from(pts.map((p) => `${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)}`).join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Laser marking CSV (tab separated), as the partners send it
// ---------------------------------------------------------------------------
export function laserCsv(caseId: string, arch: 'upper' | 'lower', step: number): Buffer {
  const label = `${caseId}_${arch === 'upper' ? 'U' : 'L'}${String(step).padStart(2, '0')}`;
  const rows = [
    ['LaserPt1Start', '-25.010', '4.638', '11.049'],
    ['LaserPt1End', '-26.520', '-20.308', '9.148'],
    ['text1', label],
    ['LaserPt2Start', '23.182', '-3.171', '11.090'],
    ['LaserPt2End', '24.688', '-8.623', '8.920'],
    ['text2', ''],
  ];
  return Buffer.from(rows.map((r) => r.join('\t')).join('\r\n') + '\r\n', 'utf8');
}

// ---------------------------------------------------------------------------
// PDF (a simple treatment plan), PNG and SVG
// ---------------------------------------------------------------------------
const pdfEscape = (s: string) => s.replace(/[\\()]/g, (m) => '\\' + m).replace(/[^\x20-\x7e]/g, '?');

/** A small, valid, one page PDF with text only. No JavaScript, no attachments, no actions. */
export function planPdf(title: string, lines: string[]): Buffer {
  const content = [
    'BT', '/F1 18 Tf', '56 780 Td', `(${pdfEscape(title)}) Tj`, '/F1 11 Tf', '0 -28 Td', '14 TL',
    ...lines.map((l) => `(${pdfEscape(l)}) Tj T*`), 'ET',
  ].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A valid 64 by 64 PNG: a soft gradient with a simple tooth like outline. */
export function samplePng(): Buffer {
  const w = 64;
  const h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const inside = ((x - 32) / 22) ** 2 + ((y - 34) / 26) ** 2 < 1;
      raw[o] = inside ? 244 : 214 + y / 4;
      raw[o + 1] = inside ? 244 : 228 + x / 8;
      raw[o + 2] = inside ? 240 : 240;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A safe SVG: shapes only, no scripts, no event handlers, no external references. */
export function sampleSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="240" height="120"><rect width="120" height="60" fill="#f4f7fa"/><path d="M14 46 C14 12 106 12 106 46" fill="none" stroke="#1d4f91" stroke-width="5" stroke-linecap="round"/><text x="60" y="54" font-family="sans-serif" font-size="8" text-anchor="middle" fill="#334155">Demo logo</text></svg>\n`;
}

/**
 * A fictional company logo for the demo organisations: a transparent SVG, 300 by 90 (about 3 to 1), shapes and one line of text only,
 * so it passes the SVG checks and the logo rules (viewBox ratio between 1 and 6, margin around the artwork, readable on white).
 */
export function sampleLogoSvg(label: string, colour = '#1d4f91'): string {
  const safe = label.replace(/[^A-Za-z0-9 .&-]/g, '').slice(0, 24);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 90" width="300" height="90"><circle cx="45" cy="45" r="26" fill="${colour}"/><path d="M33 47 C33 30 57 30 57 47" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/><text x="88" y="53" font-family="sans-serif" font-size="22" font-weight="bold" fill="#1f2937">${safe}</text></svg>
`;
}

// ---------------------------------------------------------------------------
// Instructions files: Word (.docx), RTF, plain text
// ---------------------------------------------------------------------------
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A minimal valid Word document (one paragraph per line). */
export function docxInstructions(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join('');
  const files = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    ),
  };
  return Buffer.from(zipSync(files, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) }));
}

export function rtfInstructions(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\{}]/g, (m) => '\\' + m);
  return Buffer.from(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs22 ${lines.map(esc).join('\\par\n')}\\par}\n`, 'latin1');
}

export const textInstructions = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');

// ---------------------------------------------------------------------------
// Sample folders for trying the Send files screen
// ---------------------------------------------------------------------------
export interface SampleEntry {
  path: string;
  data: Buffer;
}

export interface SampleCases {
  entries: SampleEntry[];
  /** The case folder names and the IDs inside them, for tests and the demo script. */
  folders: { folder: string; caseId: string; kind: 'arch_folders' | 'flat' | 'patient_folder' | 'open_trim_line' }[];
}

/** Four distinct five digit numbers (never a year or a date). */
function freshNumbers(n: number, rand: (lo: number, hi: number) => number): string[] {
  const out = new Set<string>();
  while (out.size < n) out.add(String(rand(10000, 99999)));
  return [...out];
}

// Fictional patients. Each folder is named "<patient ID> <first name> <last name>", the way Direct manufacturing reads it.
const FICTIONAL_NAMES = ['Marc Alonso', 'Anna Berg', 'Lucia Garcia', 'Omar Haddad'] as const;

/**
 * Builds the four sample cases. Numbers are fresh on every call, so the same sample can be sent again and again without
 * clashing with an earlier upload. Patient names are fictional.
 */
export function buildSampleCases(rand: (lo: number, hi: number) => number = (lo, hi) => randomInt(lo, hi + 1)): SampleCases {
  const [id1, id2, id3, id4] = freshNumbers(4, rand) as [string, string, string, string];
  const entries: SampleEntry[] = [];
  const folders: SampleCases['folders'] = [];
  const add = (path: string, data: Buffer) => entries.push({ path, data });

  // 1. Arch folders, a Word instructions file and a PDF plan
  const f1 = `${id1} ${FICTIONAL_NAMES[0]}`;
  folders.push({ folder: f1, caseId: id1, kind: 'arch_folders' });
  for (const arch of ['upper', 'lower'] as const) {
    const dir = arch === 'upper' ? 'Upper' : 'Lower';
    const p = arch === 'upper' ? 'U' : 'L';
    for (const step of [1, 2, 3]) {
      const name = `${p}${String(step).padStart(2, '0')}`;
      add(`${f1}/${dir}/${name}.stl`, archStl({ arch, step }));
      add(`${f1}/${dir}/${name}.pts`, trimLinePts({ arch, step }));
    }
  }
  add(`${f1}/Instructions.docx`, docxInstructions([
    `Case ${id1}. Upper and lower, three steps each.`,
    'Leave the attachments on the upper canines as designed.',
    'Please trim 0.5 mm above the gum line on the lower incisors.',
    'Ship to the practice, not to the patient.',
  ]));
  add(`${f1}/Plan ${id1}.pdf`, planPdf(`Treatment plan ${id1}`, [
    'Demo data. Not a real plan.',
    'Upper arch: steps 1 to 3. Lower arch: steps 1 to 3.',
    'Attachments on the upper canines. No interproximal reduction.',
  ]));

  // 2. Flat files named with the case ID and an instructions.txt
  const f2 = `${id2} ${FICTIONAL_NAMES[1]}`;
  folders.push({ folder: f2, caseId: id2, kind: 'flat' });
  for (const step of [1, 2]) {
    const n = String(step).padStart(2, '0');
    add(`${f2}/${id2}_U${n}.stl`, archStl({ arch: 'upper', step }));
    add(`${f2}/${id2}_U${n}.pts`, trimLinePts({ arch: 'upper', step }));
    add(`${f2}/${id2}_L${n}.stl`, archStl({ arch: 'lower', step }));
    add(`${f2}/${id2}_L${n}.pts`, trimLinePts({ arch: 'lower', step }));
  }
  add(`${f2}/${id2}_U01_T.stl`, archStl({ arch: 'upper', step: 1, template: true }));
  add(`${f2}/instructions.txt`, textInstructions([
    `Case ${id2}.`,
    'Two steps per arch, plus an upper template.',
    'Please use the standard trim. No rush.',
  ]));

  // 3. A (fictional) patient folder with Maxilla and Mandible folders and an RTF file
  const f3 = `${id3} ${FICTIONAL_NAMES[2]}`;
  folders.push({ folder: f3, caseId: id3, kind: 'patient_folder' });
  for (const [dir, arch] of [['Maxilla', 'upper'], ['Mandible', 'lower']] as const) {
    for (const step of [1, 2, 3]) {
      add(`${f3}/${dir}/Step ${String(step).padStart(2, '0')}.stl`, archStl({ arch, step }));
      add(`${f3}/${dir}/Step ${String(step).padStart(2, '0')}.pts`, trimLinePts({ arch, step }));
    }
  }
  add(`${f3}/Instructions.rtf`, rtfInstructions([
    'Prescription, fictional patient for the demo.',
    `Internal reference ${id3}.`,
    'Mild crowding in the lower front teeth. Please keep the trim straight.',
  ]));

  // 4. An open trim line on U03
  const f4 = `${id4} ${FICTIONAL_NAMES[3]}`;
  folders.push({ folder: f4, caseId: id4, kind: 'open_trim_line' });
  for (const step of [1, 2, 3]) {
    const n = `U${String(step).padStart(2, '0')}`;
    add(`${f4}/Upper/${n}.stl`, archStl({ arch: 'upper', step }));
    add(`${f4}/Upper/${n}.pts`, trimLinePts({ arch: 'upper', step, open: step === 3 }));
  }
  add(`${f4}/instructions.txt`, textInstructions([`Case ${id4}.`, 'The trim line of step 3 is open on purpose, so the checks have something to show.']));

  return { entries, folders };
}

/** Streams the sample cases as a zip (deflate, except files that are compressed already). Dates are fixed so the bytes depend only on the content. */
export function sampleCasesZip(sample: SampleCases): Readable {
  const zip = new ZipFile();
  const mtime = new Date(Date.UTC(2026, 0, 1));
  for (const e of sample.entries) zip.addBuffer(e.data, e.path, { mtime, compress: !/\.(docx|png)$/.test(e.path)});
  zip.end();
  return zip.outputStream as unknown as Readable;
}
