import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { unzipSync } from 'fflate';
import { bufferSource, fileSource, validateContent, detectExecutable, EXECUTABLE_EXTENSIONS } from '../src/services/validate';
import { validateStl, EDGE_ANALYSIS_LIMIT } from '../src/services/validate/stl';
import { validatePts } from '../src/services/validate/pts';
import { validatePdf } from '../src/services/validate/pdf';
import { validateSvg } from '../src/services/validate/svg';
import { validateCsv, isFormulaCell } from '../src/services/validate/csv';
import { validateImage } from '../src/services/validate/image';
import { FsStorage, S3Storage, assertKey, chunkKey, newStoragePrefix } from '../src/storage';
import { ClamdScanner, NoScanner, parseClamReply } from '../src/services/scanner';
import { canonicalNames, csvCell, zipStream } from '../src/services/packaging';
import { computeChecks, describeSteps, type CheckFile } from '../src/services/checks';
import { addBusinessDays, maskName } from '../src/services/cases';
import { canReceive } from '../../shared/geo';
import { PortalError } from '../src/services/portal/client';
import { FakePortalClient } from '../src/services/portal/fake';
import { PortalV2Client, assertSafePortalUrl, isPrivateAddress } from '../src/services/portal/v2';
import { validateBulkEntry } from '../src/services/bulk';

// ---------------------------------------------------------------------------
// Synthetic files
// ---------------------------------------------------------------------------
type Tri = [number, number, number][];

function binaryStl(tris: Tri[], header = 'synthetic'): Buffer {
  const b = Buffer.alloc(84 + tris.length * 50);
  b.write(header, 0, 'latin1');
  b.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) b.writeFloatLE(t[v]![k]!, o + 12 + v * 12 + k * 4);
  });
  return b;
}

function cube(size: number, ox = 0): Tri[] {
  const p = (x: number, y: number, z: number): [number, number, number] => [ox + x * size, y * size, z * size];
  const quad = (a: any, b: any, c: any, d: any): Tri[] => [[a, b, c], [a, c, d]];
  return [
    ...quad(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)),
    ...quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)),
    ...quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)),
    ...quad(p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)),
    ...quad(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)),
    ...quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)),
  ];
}

/** Watertight UV sphere with about 2 * n * m triangles. */
function sphere(radius: number, n: number, m: number): Tri[] {
  const ring = (i: number): [number, number, number][] =>
    Array.from({ length: m }, (_, j) => {
      const th = (Math.PI * i) / n;
      const ph = (2 * Math.PI * j) / m;
      return [radius * Math.sin(th) * Math.cos(ph), radius * Math.sin(th) * Math.sin(ph), radius * Math.cos(th)];
    });
  const top: [number, number, number] = [0, 0, radius];
  const bottom: [number, number, number] = [0, 0, -radius];
  const tris: Tri[] = [];
  const first = ring(1);
  for (let j = 0; j < m; j++) tris.push([top, first[j]!, first[(j + 1) % m]!]);
  let prev = first;
  for (let i = 2; i < n; i++) {
    const cur = ring(i);
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      tris.push([prev[j]!, cur[j]!, cur[j2]!]);
      tris.push([prev[j]!, cur[j2]!, prev[j2]!]);
    }
    prev = cur;
  }
  for (let j = 0; j < m; j++) tris.push([prev[j]!, bottom, prev[(j + 1) % m]!]);
  return tris;
}

const codes = (r: { errors: { code: string }[]; warnings: { code: string }[] }) => ({ e: r.errors.map((x) => x.code), w: r.warnings.map((x) => x.code) });

function ring(n: number, r = 20, z = 5): string {
  return Array.from({ length: n }, (_, i) => `${(r * Math.cos((2 * Math.PI * i) / n)).toFixed(6)} ${(r * Math.sin((2 * Math.PI * i) / n)).toFixed(6)} ${z}`).join('\n');
}

// ---------------------------------------------------------------------------
describe('STL validation', () => {
  it('accepts a closed 50 mm cube without warnings', async () => {
    const r = await validateStl(bufferSource(binaryStl(cube(50))));
    expect(codes(r)).toEqual({ e: [], w: [] });
    expect(r.meta).toMatchObject({ format: 'binary', triangles: 12, vertices: 8, openEdges: 0, nonManifoldEdges: 0, edgeAnalysis: true });
  });

  it('counts open edges when a triangle is missing', async () => {
    const r = await validateStl(bufferSource(binaryStl(cube(50).slice(1))));
    expect(r.meta.openEdges).toBe(3);
    expect(codes(r).w).toContain('stl_open_edges');
  });

  it('counts non manifold edges shared by three triangles', async () => {
    const a: Tri = [[0, 0, 0], [50, 0, 0], [0, 50, 0]];
    const b: Tri = [[0, 0, 0], [50, 0, 0], [0, 0, 50]];
    const c: Tri = [[0, 0, 0], [50, 0, 0], [0, -50, 0]];
    const r = await validateStl(bufferSource(binaryStl([a, b, c])));
    expect(r.meta.nonManifoldEdges).toBe(1);
    expect(codes(r).w).toContain('stl_non_manifold');
  });

  it('warns about units when the model is under 20 mm or over 150 mm', async () => {
    expect(codes(await validateStl(bufferSource(binaryStl(cube(5))))).w).toContain('stl_units');
    expect(codes(await validateStl(bufferSource(binaryStl(cube(200))))).w).toContain('stl_units');
    expect(codes(await validateStl(bufferSource(binaryStl(cube(150))))).w).not.toContain('stl_units');
    expect(codes(await validateStl(bufferSource(binaryStl(cube(20))))).w).not.toContain('stl_units');
  });

  it('welds vertices at 1 micrometre', async () => {
    // Two cubes whose shared face vertices differ by 0.4 micrometre still weld into a closed surface.
    const t = cube(50);
    const jitter = t.map((tri) => tri.map(([x, y, z]) => [x + 0.0004, y, z] as [number, number, number]) as Tri);
    const both = [...t.slice(0, 6), ...jitter.slice(6)];
    const r = await validateStl(bufferSource(binaryStl(both)));
    expect(r.meta.openEdges).toBe(0);
    // A 5 micrometre gap does not weld.
    const far = t.map((tri) => tri.map(([x, y, z]) => [x + 0.005, y, z] as [number, number, number]) as Tri);
    const r2 = await validateStl(bufferSource(binaryStl([...t.slice(0, 6), ...far.slice(6)])));
    expect(Number(r2.meta.openEdges)).toBeGreaterThan(0);
  });

  it('warns when more than 1 percent of triangles have no area', async () => {
    const tris = [...cube(50), [[0, 0, 0], [0, 0, 0], [1, 1, 1]] as Tri];
    const r = await validateStl(bufferSource(binaryStl(tris)));
    expect(codes(r).w).toContain('stl_zero_area');
  });

  it('reads ASCII STL', async () => {
    const lines = ['solid test'];
    for (const t of cube(50)) {
      lines.push('facet normal 0 0 0', 'outer loop', ...t.map((v) => `vertex ${v[0]} ${v[1]} ${v[2]}`), 'endloop', 'endfacet');
    }
    lines.push('endsolid test');
    const r = await validateStl(bufferSource(Buffer.from(lines.join('\n'))));
    expect(codes(r)).toEqual({ e: [], w: [] });
    expect(r.meta).toMatchObject({ format: 'ascii', triangles: 12 });
  });

  it('reads a binary STL whose header starts with "solid"', async () => {
    const r = await validateStl(bufferSource(binaryStl(cube(50), 'solid exported by some tool')));
    expect(r.meta.format).toBe('binary');
    expect(r.errors).toEqual([]);
  });

  it('rejects garbage, truncated and empty files', async () => {
    expect(codes(await validateStl(bufferSource(Buffer.from('hello world')))).e).toEqual(['stl_invalid']);
    const good = binaryStl(cube(50));
    expect(codes(await validateStl(bufferSource(good.subarray(0, good.length - 20)))).e).toEqual(['stl_invalid']);
    expect(codes(await validateStl(bufferSource(binaryStl([])))).e).toEqual(['stl_empty']);
    const nan = binaryStl(cube(50));
    nan.writeFloatLE(NaN, 84 + 12);
    expect(codes(await validateStl(bufferSource(nan))).e).toEqual(['stl_invalid_values']);
  });

  it('checks a 20 MB binary STL (420 thousand triangles) quickly', async () => {
    const buf = binaryStl(sphere(30, 460, 460));
    expect(buf.length).toBeGreaterThan(20_000_000);
    const t = Date.now();
    const r = await validateStl(bufferSource(buf));
    const ms = Date.now() - t;
    expect(codes(r)).toEqual({ e: [], w: [] });
    expect(r.meta).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, edgeAnalysis: true });
    expect(ms).toBeLessThan(8000);
  });

  it('skips edge analysis above the triangle limit', () => {
    expect(EDGE_ANALYSIS_LIMIT).toBe(3_000_000);
  });
});

// ---------------------------------------------------------------------------
describe('PTS validation', () => {
  it('accepts a closed trim line', async () => {
    const r = await validatePts(bufferSource(Buffer.from(ring(200))));
    expect(codes(r)).toEqual({ e: [], w: [] });
    expect(r.meta).toMatchObject({ points: 200, closed: true, breaks: 0 });
  });

  it('warns when the trim line is open', async () => {
    const half = ring(400).split('\n').slice(0, 200).join('\n');
    const r = await validatePts(bufferSource(Buffer.from(half)));
    expect(codes(r).w).toContain('pts_open');
    expect(r.meta.closed).toBe(false);
  });

  it('warns about breaks, few points and a wrong declared count', async () => {
    const pts = ring(100).split('\n');
    pts.splice(50, 20); // a long jump
    const r = await validatePts(bufferSource(Buffer.from(['100', ...pts].join('\n'))));
    expect(codes(r).w).toEqual(expect.arrayContaining(['pts_break', 'pts_count_mismatch']));
    const few = await validatePts(bufferSource(Buffer.from(ring(12))));
    expect(codes(few).w).toContain('pts_few_points');
  });

  it('reads a declared count line, CRLF line ends and extra columns', async () => {
    const text = ['60', ...ring(60).split('\n').map((l) => l + ' 0.0 0.0 1.0')].join('\r\n');
    const r = await validatePts(bufferSource(Buffer.from(text)));
    expect(codes(r)).toEqual({ e: [], w: [] });
    expect(r.meta).toMatchObject({ points: 60, declaredCount: 60 });
  });

  it('rejects when more than 10 percent of lines cannot be read, warns below that', async () => {
    const lines = ring(100).split('\n');
    const bad = lines.map((l, i) => (i % 5 === 0 ? 'not a point' : l)).join('\n');
    expect(codes(await validatePts(bufferSource(Buffer.from(bad)))).e).toEqual(['pts_unreadable']);
    const some = lines.map((l, i) => (i === 3 ? 'oops' : l)).join('\n');
    const r = await validatePts(bufferSource(Buffer.from(some)));
    expect(r.errors).toEqual([]);
    expect(codes(r).w).toContain('pts_some_unreadable');
    expect(codes(await validatePts(bufferSource(Buffer.from('')))).e).toEqual(['pts_empty']);
  });
});

// ---------------------------------------------------------------------------
describe('CSV, PDF, SVG and image checks', () => {
  it('does not warn about laser marking files (tab separated, plain negative numbers)', async () => {
    const csv = 'LaserPt1Start\t-25.010\t4.638\t11.049\r\nLaserPt1End\t-26.520\t-20.308\t9.148\r\ntext1\t90001_L01\r\nLaserPt2Start\t23.182\t-3.171\t11.090\r\ntext2\t\r\n';
    const r = await validateCsv(bufferSource(Buffer.from(csv)));
    expect(codes(r)).toEqual({ e: [], w: [] });
    expect(isFormulaCell('-19.622')).toBe(false);
    expect(isFormulaCell('+5')).toBe(false);
    expect(isFormulaCell('-')).toBe(false);
    expect(isFormulaCell('-1,5')).toBe(false);
  });

  it('warns about formula cells and non UTF-8 text', async () => {
    expect(codes(await validateCsv(bufferSource(Buffer.from('a,b\n=SUM(A1:A2),x')))).w).toEqual(['csv_formula']);
    expect(codes(await validateCsv(bufferSource(Buffer.from('a;@cmd|x;y')))).w).toEqual(['csv_formula']);
    expect(codes(await validateCsv(bufferSource(Buffer.from('a,-cmd|calc,y')))).w).toEqual(['csv_formula']);
    expect(codes(await validateCsv(bufferSource(Buffer.from([0x63, 0xe9, 0x2c, 0x31]))) ).w).toEqual(['csv_encoding']);
  });

  it('blocks PDF JavaScript and Launch, warns about embedded files and encryption', async () => {
    const pdf = (body: string) => bufferSource(Buffer.from(`%PDF-1.7\n1 0 obj\n<< ${body} >>\nendobj\n%%EOF`));
    expect(codes(await validatePdf(pdf('/Type /Catalog'))).e).toEqual([]);
    expect(codes(await validatePdf(pdf('/S /JavaScript /JS (app.alert(1))'))).e).toEqual(['pdf_javascript']);
    expect(codes(await validatePdf(pdf('/J#61vaScript'))).e).toEqual(['pdf_javascript']);
    expect(codes(await validatePdf(pdf('/S /Launch /F (cmd.exe)'))).e).toEqual(['pdf_launch']);
    expect(codes(await validatePdf(pdf('/EmbeddedFiles 3 0 R'))).w).toEqual(['pdf_embedded_files']);
    expect(codes(await validatePdf(pdf('/Encrypt 5 0 R'))).w).toEqual(['pdf_encrypted']);
    expect(codes(await validatePdf(bufferSource(Buffer.from('plain text')))).e).toEqual(['pdf_invalid']);
    // JSON is not JS
    expect(codes(await validatePdf(pdf('/Subtype /JSON'))).e).toEqual([]);
  });

  it('blocks active SVG content', async () => {
    const svg = (inner: string) => bufferSource(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`));
    expect(codes(await validateSvg(svg('<circle cx="5" cy="5" r="4"/>'))).e).toEqual([]);
    expect(codes(await validateSvg(svg('<script>alert(1)</script>'))).e).toContain('svg_script');
    expect(codes(await validateSvg(svg('<rect onload="x()" width="1" height="1"/>'))).e).toContain('svg_event_handler');
    expect(codes(await validateSvg(svg('<a href="javascript:alert(1)"><rect/></a>'))).e).toContain('svg_javascript_link');
    expect(codes(await validateSvg(svg('<a href="&#106;avascript:alert(1)"><rect/></a>'))).e).toContain('svg_javascript_link');
    expect(codes(await validateSvg(svg('<foreignObject><div/></foreignObject>'))).e).toContain('svg_foreign_object');
    expect(codes(await validateSvg(svg('<image href="https://evil.example/x.png"/>'))).e).toContain('svg_external_reference');
    expect(codes(await validateSvg(svg('<use xlink:href="#a"/>'))).e).toEqual([]);
    expect(codes(await validateSvg(bufferSource(Buffer.from('<html></html>')))).e).toEqual(['svg_invalid']);
    expect(codes(await validateSvg(bufferSource(Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>')))).e).toContain('svg_entity');
  });

  it('checks images by magic bytes', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
    expect((await validateImage(bufferSource(png), 'png')).errors).toEqual([]);
    expect((await validateImage(bufferSource(jpg), 'jpg')).errors).toEqual([]);
    expect((await validateImage(bufferSource(jpg), 'jpeg')).errors).toEqual([]);
    expect(codes(await validateImage(bufferSource(png), 'jpg')).e).toEqual(['image_type_mismatch']);
    expect(codes(await validateImage(bufferSource(Buffer.from('GIF89a....')), 'png')).e).toEqual(['image_invalid']);
  });

  it('refuses executables by magic bytes whatever the file type', async () => {
    const mz = Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1');
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    const macho = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);
    const she = Buffer.from('#!/bin/sh\necho hi\n');
    for (const b of [mz, elf, macho, she]) {
      expect(detectExecutable(b)).not.toBeNull();
      expect(codes(await validateContent('stl', 'stl', bufferSource(b))).e).toEqual(['executable_content']);
      expect(codes(await validateContent('other', 'txt', bufferSource(b))).e).toEqual(['executable_content']);
    }
    expect(detectExecutable(Buffer.from('solid x'))).toBeNull();
    expect(EXECUTABLE_EXTENSIONS.has('exe')).toBe(true);
    expect(codes(await validateContent('other', 'txt', bufferSource(Buffer.from([65, 0, 66])))).e).toEqual(['not_text']);
  });
});

// ---------------------------------------------------------------------------
// Optional: point KPH_REAL_SAMPLE_DIR at a local case folder (with STL, PTS and CSV sub folders and files named
// like <case id>_L01.stl) and set KPH_REAL_SAMPLE_CASE to its case id. Never commit real patient files.
const SAMPLE = process.env.KPH_REAL_SAMPLE_DIR ?? '';
const SAMPLE_CASE = process.env.KPH_REAL_SAMPLE_CASE ?? '';
describe.skipIf(!SAMPLE || !SAMPLE_CASE || !existsSync(SAMPLE))('real sample files', () => {
  it('validates a real 20 MB STL, its trim line and laser CSV without problems', async () => {
    const t = Date.now();
    const stl = await validateContent('stl', 'stl', await fileSource(path.join(SAMPLE, `STL/${SAMPLE_CASE}_L01.stl`)));
    expect(Date.now() - t).toBeLessThan(8000);
    expect(codes(stl)).toEqual({ e: [], w: [] });
    expect(stl.meta.triangles).toBeGreaterThan(0);
    const pts = await validateContent('pts', 'pts', await fileSource(path.join(SAMPLE, `PTS/${SAMPLE_CASE}_L01.pts`)));
    expect(codes(pts)).toEqual({ e: [], w: [] });
    expect(pts.meta.points).toBeGreaterThan(0);
    const csv = await validateContent('csv', 'csv', await fileSource(path.join(SAMPLE, `CSV/${SAMPLE_CASE}_L01.csv`)));
    expect(codes(csv)).toEqual({ e: [], w: [] });
    const c = computeChecks(
      [
        { id: 'a', kind: 'stl', arch: 'lower', step: 1, is_template: false, state: 'ready', validation: { errors: [], warnings: [] }, meta: stl.meta },
        { id: 'b', kind: 'pts', arch: 'lower', step: 1, is_template: false, state: 'ready', validation: { errors: [], warnings: [] }, meta: pts.meta },
      ],
      { requirePts: true },
    );
    expect(c.errors).toEqual([]);
    expect(c.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('storage', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'kph-store-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores, reads, checks and deletes objects with random names', async () => {
    const s = new FsStorage(dir);
    const prefix = newStoragePrefix();
    expect(prefix).toMatch(/^f\/[0-9a-f]{32}$/);
    await s.put(chunkKey(prefix, 0), Buffer.from('one'));
    await s.put(chunkKey(prefix, 1), Buffer.from('two'));
    expect((await s.getBuffer(chunkKey(prefix, 1))).toString()).toBe('two');
    const parts: Buffer[] = [];
    for await (const p of await s.get(chunkKey(prefix, 0))) parts.push(p as Buffer);
    expect(Buffer.concat(parts).toString()).toBe('one');
    expect(await s.exists(chunkKey(prefix, 0))).toBe(true);
    await s.delete(chunkKey(prefix, 0));
    expect(await s.exists(chunkKey(prefix, 0))).toBe(false);
    await s.deletePrefix(prefix + '/');
    expect(await s.exists(chunkKey(prefix, 1))).toBe(false);
  });

  it('refuses keys that could escape the storage directory', async () => {
    const s = new FsStorage(dir);
    for (const k of ['../x', 'a/../b', '/abs', 'a//b', 'a b', 'a\\b', '', 'a/.']) {
      expect(() => assertKey(k)).toThrow();
      await expect(s.put(k, Buffer.from('x'))).rejects.toThrow();
    }
    await expect(s.deletePrefix('f/abc')).rejects.toThrow();
  });

  it('talks to an S3 compatible client through the same interface', async () => {
    const objects = new Map<string, Buffer>();
    const client = {
      async send(cmd: any) {
        const n = cmd.constructor.name;
        const i = cmd.input;
        if (n === 'PutObjectCommand') objects.set(i.Key, Buffer.from(i.Body));
        else if (n === 'GetObjectCommand') return { Body: Readable.from([objects.get(i.Key)!]) };
        else if (n === 'DeleteObjectCommand') objects.delete(i.Key);
        else if (n === 'HeadObjectCommand') {
          if (!objects.has(i.Key)) throw new Error('missing');
        } else if (n === 'ListObjectsV2Command') return { Contents: [...objects.keys()].filter((k) => k.startsWith(i.Prefix)).map((Key) => ({ Key })), IsTruncated: false };
        else if (n === 'DeleteObjectsCommand') for (const o of i.Delete.Objects) objects.delete(o.Key);
        return {};
      },
    };
    const s = new S3Storage(client, 'bucket');
    await s.put('f/aa/0', Buffer.from('x'));
    await s.put('f/aa/1', Buffer.from('y'));
    expect((await s.getBuffer('f/aa/1')).toString()).toBe('y');
    expect(await s.exists('f/aa/0')).toBe(true);
    await s.deletePrefix('f/aa/');
    expect(objects.size).toBe(0);
    expect(await s.exists('f/aa/0')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('scanner', () => {
  const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  let server: net.Server;
  let port: number;
  let mode: 'normal' | 'limit' | 'hang' = 'normal';

  beforeAll(async () => {
    server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let started = false;
      let payload = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!started) {
          if (buf.subarray(0, 5).toString() === 'zPING') {
            sock.write('PONG\0');
            return sock.end();
          }
          if (buf.length < 10) return;
          expect(buf.subarray(0, 10).toString()).toBe('zINSTREAM\0');
          buf = buf.subarray(10);
          started = true;
        }
        for (;;) {
          if (buf.length < 4) return;
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            if (mode === 'hang') return;
            if (mode === 'limit') sock.write('INSTREAM size limit exceeded. ERROR\0');
            else if (payload.toString('latin1').includes(EICAR)) sock.write('stream: Win.Test.EICAR_HDB-1 FOUND\0');
            else sock.write('stream: OK\0');
            return sock.end();
          }
          if (buf.length < 4 + len) return;
          payload = Buffer.concat([payload, buf.subarray(4, 4 + len)]);
          buf = buf.subarray(4 + len);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function* chunks(...bs: Buffer[]) {
    for (const b of bs) yield b;
  }

  it('reports clean, infected and error results from clamd', async () => {
    const s = new ClamdScanner({ host: '127.0.0.1', port });
    expect(await s.ping()).toBe(true);
    mode = 'normal';
    expect(await s.scan(chunks(Buffer.from('hello'), Buffer.alloc(3 * 1024 * 1024, 1)))).toEqual({ status: 'clean' });
    const bad = await s.scan(chunks(Buffer.from('pre'), Buffer.from(EICAR), Buffer.from('post')));
    expect(bad.status).toBe('infected');
    expect(bad.signature).toContain('EICAR');
    mode = 'limit';
    expect(await s.scan(chunks(Buffer.from('x')))).toMatchObject({ status: 'error', reason: 'scanner_size_limit' });
    mode = 'normal';
  });

  it('gives an error status when clamd is down or too slow', async () => {
    const dead = new ClamdScanner({ host: '127.0.0.1', port: 1, connectTimeoutMs: 500 });
    expect((await dead.scan(chunks(Buffer.from('x')))).status).toBe('error');
    expect(await dead.ping()).toBe(false);
    mode = 'hang';
    const slow = new ClamdScanner({ host: '127.0.0.1', port, timeoutMs: 300 });
    expect(await slow.scan(chunks(Buffer.from('x')))).toMatchObject({ status: 'error', reason: 'scanner_timeout' });
    mode = 'normal';
  });

  it('parses clamd replies and the none driver skips', async () => {
    expect(parseClamReply('stream: OK')).toEqual({ status: 'clean' });
    expect(parseClamReply('stream: Eicar-Signature FOUND')).toEqual({ status: 'infected', signature: 'Eicar-Signature' });
    expect(parseClamReply('something odd').status).toBe('error');
    expect(await new NoScanner().scan(chunks(Buffer.from('x')))).toEqual({ status: 'skipped' });
  });
});

// ---------------------------------------------------------------------------
describe('packaging, checks, dates and geography', () => {
  it('names files canonically and keeps template slots apart', () => {
    const f = (id: string, over: any) => ({ id, kind: 'stl', arch: 'upper', step: 1, is_template: false, ext: 'stl', name: 'x.stl', ...over });
    const names = canonicalNames([
      f('1', {}),
      f('2', { is_template: true }),
      f('3', { kind: 'pts', ext: 'pts' }),
      f('4', { arch: 'lower', step: 12, kind: 'csv', ext: 'csv' }),
      f('5', { arch: null, step: null, kind: 'pdf', ext: 'pdf', name: '../../etc/passwd.pdf' }),
      f('6', { arch: null, step: null, kind: 'pdf', ext: 'pdf', name: '../../etc/passwd.pdf' }),
    ]);
    expect(names.get('1')).toBe('upper/U01.stl');
    expect(names.get('2')).toBe('upper/U01_T.stl');
    expect(names.get('3')).toBe('upper/U01.pts');
    expect(names.get('4')).toBe('lower/L12.csv');
    expect(names.get('5')).toBe('other/passwd.pdf');
    expect(names.get('6')).toBe('other/passwd_2.pdf');
  });

  it('streams a zip that reads back correctly and defuses CSV formulas', async () => {
    const out = zipStream([
      { name: 'a.txt', buffer: Buffer.from('hello'), level: 6 },
      { name: 'b/b.bin', stream: async function* () { yield Buffer.from([1, 2]); yield Buffer.from([3]); }, level: 0 },
    ]);
    const parts: Buffer[] = [];
    for await (const p of out) parts.push(p as Buffer);
    const files = unzipSync(new Uint8Array(Buffer.concat(parts)));
    expect(Buffer.from(files['a.txt']!).toString()).toBe('hello');
    expect([...files['b/b.bin']!]).toEqual([1, 2, 3]);
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('-25.01')).toBe('-25.01');
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  const file = (id: string, o: Partial<CheckFile>): CheckFile => ({ id, kind: 'stl', arch: 'upper', step: 1, is_template: false, state: 'ready', validation: { errors: [], warnings: [] }, meta: {}, ...o });

  it('computes errors and warnings per the brief', () => {
    expect(computeChecks([], { requirePts: false }).errors.map((e) => e.code)).toEqual(['no_stl']);
    const c = computeChecks(
      [
        file('a', {}),
        file('b', { id: 'b' }), // duplicate slot
        file('c', { step: null }),
        file('d', { arch: 'lower', step: 3, state: 'rejected', validation: { errors: [{ code: 'x', message: 'Broken model.' }] } }),
        file('e', { kind: 'pts', arch: 'upper', step: 9 }),
        file('f', { arch: 'upper', step: 4 }),
        file('g', { state: 'processing', arch: null, step: null }),
      ],
      { requirePts: true },
    );
    const e = c.errors.map((x) => x.code);
    expect(e).toEqual(expect.arrayContaining(['duplicate_file', 'missing_mapping', 'file_rejected', 'files_processing']));
    const w = c.warnings.map((x) => x.code);
    expect(w).toEqual(expect.arrayContaining(['missing_pts', 'trim_without_model', 'missing_steps']));
    expect(c.errors.find((x) => x.code === 'file_rejected')?.message).toContain('Broken model.');
  });

  it('keeps a template U01_T apart from the aligner U01 and only asks trim lines for aligners', () => {
    const c = computeChecks([file('a', {}), file('t', { is_template: true }), file('p', { kind: 'pts' })], { requirePts: true });
    expect(c.errors).toEqual([]);
    expect(c.warnings).toEqual([]);
    expect(c.counts).toEqual({ upper: 1, lower: 0, templates: 1 });
    const two = computeChecks([file('a', {}), file('t', { is_template: true }), file('t2', { is_template: true })], { requirePts: false });
    expect(two.errors.map((x) => x.code)).toEqual(['duplicate_file']);
  });

  it('warns when a trim line is not on its model and passes file warnings through', () => {
    const bb = (min: number[], max: number[]) => ({ bbox: { min, max } });
    const c = computeChecks(
      [
        file('m', { meta: bb([0, 0, 0], [50, 50, 20]), validation: { errors: [], warnings: [{ code: 'stl_open_edges', message: 'Holes.' }] } }),
        file('p', { kind: 'pts', meta: bb([100, 0, 0], [150, 50, 20]) }),
      ],
      { requirePts: false },
    );
    expect(c.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['trim_outside_model', 'stl_open_edges']));
    expect(describeSteps([4, 7, 8, 9, 12])).toBe('4, 7 to 9, 12');
  });

  it('adds business days and masks names', () => {
    expect(addBusinessDays(new Date('2026-09-25T10:00:00Z'), 3)).toBe('2026-09-30'); // Friday + 3
    expect(addBusinessDays(new Date('2026-09-26T10:00:00Z'), 1)).toBe('2026-09-28'); // Saturday + 1
    expect(maskName('Marc Alonso')).toBe('M*** A*****');
    expect(maskName('Élodie')).toBe('É*****');
  });

  it('applies the transfer gate', () => {
    const chaves = { country: 'PT', eea: true, adequacy: false };
    const cairo = { country: 'EG', eea: false, adequacy: false };
    const tokyo = { country: 'JP', eea: false, adequacy: false };
    expect(canReceive('PT', chaves, false)).toBe(true);
    expect(canReceive('PT', cairo, false)).toBe(false);
    expect(canReceive('PT', cairo, true)).toBe(true);
    expect(canReceive('DE', tokyo, false)).toBe(true); // adequacy
    expect(canReceive('US', cairo, false)).toBe(true); // partners outside the EEA are not restricted
    expect(canReceive(null, cairo, false)).toBe(false); // unknown counts as EEA
  });

  it('validates bulk entries', () => {
    const ok = validateBulkEntry({ key: 'k', patientId: '55813', firstName: 'Marc', lastName: 'Alonso' });
    expect(ok).toMatchObject({ ok: true, patientId: '55813' });
    expect(validateBulkEntry({ key: 'k', firstName: 'a', lastName: 'b' })).toMatchObject({ ok: true, patientId: null }); // the patient ID is optional now
    expect(validateBulkEntry({ key: 'k', patientId: '', firstName: 'a', lastName: 'b' })).toMatchObject({ ok: true, patientId: null });
    // the names are optional (review of 8 Oct 2026)
    expect(validateBulkEntry({ key: 'k', patientId: '1', firstName: '', lastName: 'b' })).toMatchObject({ ok: true, first: '', last: 'b' });
    expect(validateBulkEntry({ key: 'k', patientId: '1', firstName: 'a', lastName: '  ' })).toMatchObject({ ok: true, first: 'a', last: '' });
    expect(validateBulkEntry({ key: 'k', firstName: '', lastName: '' })).toMatchObject({ ok: true, patientId: null });
    expect(validateBulkEntry({ key: 'k', patientId: '1', firstName: 'a'.repeat(51), lastName: 'b' })).toMatchObject({ ok: false, error: 'name_too_long' });
    expect(validateBulkEntry({ key: 'k', patientId: 'bad<id>', firstName: 'a', lastName: 'b' })).toMatchObject({ ok: false, error: 'invalid_patient_id' });
  });
});

// ---------------------------------------------------------------------------
describe('portal client', () => {
  it('only allows https portal addresses that are not private', () => {
    expect(assertSafePortalUrl('https://portal.example.com/')).toBe('https://portal.example.com');
    expect(assertSafePortalUrl('https://portal.example.com/api/v2/')).toBe('https://portal.example.com');
    expect(assertSafePortalUrl('http://localhost:4010', { allowLocal: true })).toBe('http://localhost:4010');
    for (const bad of ['http://portal.example.com', 'ftp://portal.example.com', 'https://user:pw@portal.example.com', 'https://10.0.0.5', 'https://192.168.1.10/x', 'https://169.254.169.254', 'https://[::1]', 'https://intranet', 'https://db.internal', 'not a url']) {
      expect(() => assertSafePortalUrl(bad, { allowLocal: false }), bad).toThrow(PortalError);
    }
    expect(() => assertSafePortalUrl('http://localhost:4010', { allowLocal: false })).toThrow(PortalError);
    expect(() => assertSafePortalUrl('http://127.0.0.1:4010/', { allowLocal: false })).toThrow(PortalError);
    expect(isPrivateAddress('::ffff:10.1.2.3')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('fd00::1')).toBe(true);
  });

  describe('v2 over http', () => {
    let srv: http.Server;
    let base: string;
    const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
    let respond: (req: http.IncomingMessage) => { status: number; body: any } = () => ({ status: 200, body: {} });

    beforeAll(async () => {
      srv = http.createServer((req, res) => {
        const parts: Buffer[] = [];
        req.on('data', (d) => parts.push(d));
        req.on('end', () => {
          seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(parts) });
          const r = respond(req);
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r.body));
        });
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => srv.close(() => r())));

    const mk = () => new PortalV2Client({ baseUrl: base, apiKey: 'test-key-not-real-0123456789', userUuid: '123e4567-e89b-12d3-a456-426614174000', doctorId: 'doc-1', rules: { allowLocal: true } });

    it('sends the documented headers, paths and bodies', async () => {
      const c = mk();
      respond = (req) => (req.url!.endsWith('/ping') ? { status: 200, body: { data: { message: 'pong' } } } : req.url!.endsWith('/cases') ? { status: 200, body: { data: { uuid: 'aaaaaaaa-1111-2222-3333-444444444444' } } } : req.url!.includes('/files/') ? { status: 200, body: { data: { uuid: 'x' }, file_uuid: 'f-1' } } : { status: 200, body: { data: { uuid: 'aaaaaaaa-1111-2222-3333-444444444444', case_status: 'New' } } });
      await c.ping();
      const created = await c.createCase({ firstName: 'Marc', lastName: 'Alonso', gender: 2, productType: 0, doctorInstructions: 'Please hurry' });
      expect(created.uuid).toBe('aaaaaaaa-1111-2222-3333-444444444444');
      const up = await c.uploadFile(created.uuid, 'field_case_other_docs', 'Ünïcode "name".zip', Readable.from([Buffer.from('zip-bytes')]), 9);
      expect(up.fileUuid).toBe('f-1');
      await c.submitCase(created.uuid);
      expect((await c.getCase(created.uuid)).status).toBe('New');
      await c.close();

      expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
        'GET /api/v2/ping',
        'POST /api/v2/cases',
        'POST /api/v2/cases/aaaaaaaa-1111-2222-3333-444444444444/files/field_case_other_docs',
        'PATCH /api/v2/cases/aaaaaaaa-1111-2222-3333-444444444444/submit',
        'GET /api/v2/cases/aaaaaaaa-1111-2222-3333-444444444444',
      ]);
      for (const s of seen) {
        expect(s.headers['x-kline-api-key']).toBe('test-key-not-real-0123456789');
        expect(s.headers['x-kline-api-user-uuid']).toBe('123e4567-e89b-12d3-a456-426614174000');
        expect(s.headers['x-kline-doctor-id']).toBe('doc-1');
      }
      expect(JSON.parse(seen[1]!.body.toString())).toEqual({ first_name: 'Marc', last_name: 'Alonso', gender: 2, product_type: 0, doctor_instructions: 'Please hurry' });
      expect(seen[2]!.headers['content-type']).toBe('application/octet-stream');
      expect(seen[2]!.headers['content-disposition']).toBe('attachment; filename="_n_code _name_.zip"');
      expect(seen[2]!.body.toString()).toBe('zip-bytes');
      seen.length = 0;
    });

    it('maps errors without copying the portal message', async () => {
      const c = mk();
      const cases: [number, string, boolean][] = [[401, 'auth', false], [404, 'not_found', false], [422, 'validation', false], [429, 'rate_limited', true], [503, 'server', true]];
      for (const [status, code, retryable] of cases) {
        respond = () => ({ status, body: { message: 'Patient Marc Alonso already exists' } });
        const err = await c.createCase({ firstName: 'a', lastName: 'b', gender: 2, productType: 0 }).catch((e) => e);
        expect(err).toBeInstanceOf(PortalError);
        expect(err.code).toBe(code);
        expect(err.retryable).toBe(retryable);
        expect(err.message).not.toContain('Marc');
      }
      await c.close();
    });

    it('reads status, tracking number and expected shipping date from the case', async () => {
      const c = mk();
      respond = () => ({ status: 200, body: { data: { uuid: 'aaaaaaaa-1111-2222-3333-444444444444', case_status: 'Shipped', first_name: 'Marc', tracking_number: 'DHL 12345', expected_shipping_date: '2026-10-05T00:00:00+00:00' } } });
      expect(await c.getCase('aaaaaaaa-1111-2222-3333-444444444444')).toEqual({ uuid: 'aaaaaaaa-1111-2222-3333-444444444444', status: 'Shipped', trackingNumber: 'DHL 12345', expectedShippingDate: '2026-10-05T00:00:00+00:00' });
      respond = () => ({ status: 200, body: { data: { case_status: 'InProduction', tracking_number: null, expected_shipping_date: '' } } });
      expect(await c.getCase('aaaaaaaa-1111-2222-3333-444444444444')).toEqual({ uuid: 'aaaaaaaa-1111-2222-3333-444444444444', status: 'InProduction', trackingNumber: null, expectedShippingDate: null });
      await expect(c.getCase('not a uuid!')).rejects.toMatchObject({ code: 'validation' });
      await c.close();
    });

    it('reports network errors and refuses private addresses in production rules', async () => {
      const dead = new PortalV2Client({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k'.repeat(20), userUuid: '123e4567-e89b-12d3-a456-426614174000', rules: { allowLocal: true } });
      await expect(dead.ping()).rejects.toMatchObject({ code: 'network', retryable: true });
      await dead.close();
      expect(() => new PortalV2Client({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k'.repeat(20), userUuid: 'u', rules: { allowLocal: false } })).toThrow(PortalError);
    });
  });

  it('fake client records calls and can be made to fail', async () => {
    const f = new FakePortalClient();
    const { uuid } = await f.createCase({ firstName: 'a', lastName: 'b', gender: 2, productType: 0 });
    await f.uploadFile(uuid, 'field_case_other_docs', 'x.zip', Readable.from([Buffer.from('abc')]), 3);
    f.failNext('submitCase', 'server');
    await expect(f.submitCase(uuid)).rejects.toMatchObject({ code: 'server' });
    await f.submitCase(uuid);
    expect(f.cases.get(uuid)!.uploads[0]!.data.toString()).toBe('abc');
    expect(f.calls.map((c) => c.op)).toEqual(['createCase', 'uploadFile', 'submitCase', 'submitCase']);
    expect((await f.getCase(uuid)).status).toBe('InPlanning');
    f.setPortalState(uuid, { status: 'Shipped', trackingNumber: 'DHL 1', expectedShippingDate: '2026-10-05T00:00:00+00:00' });
    expect(await f.getCase(uuid)).toEqual({ uuid, status: 'Shipped', trackingNumber: 'DHL 1', expectedShippingDate: '2026-10-05T00:00:00+00:00' });
  });
});
