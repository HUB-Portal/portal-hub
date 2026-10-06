// Zip reading that never loads the whole archive: the central directory gives names and sizes,
// and single entries are inflated lazily (streaming) when they are uploaded. Supports zip64.
import { Inflate } from 'fflate';
import type { Chunk, FileSource } from './source';

export const ZIP_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 5000;

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  localOffset: number;
  source: FileSource;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

async function bytesOf(blob: Blob, from: number, to: number): Promise<DataView> {
  const buf = await blob.slice(from, to).arrayBuffer();
  return new DataView(buf);
}

function u64(dv: DataView, o: number): number {
  return Number(dv.getBigUint64(o, true));
}

function decodeName(raw: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder('utf-8').decode(raw);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return new TextDecoder('windows-1252').decode(raw);
  }
}

function entrySource(blob: Blob, e: { size: number; compressedSize: number; method: number; localOffset: number }): FileSource {
  return {
    size: e.size,
    async *chunks(chunkSize: number, skip?: ReadonlySet<number>): AsyncGenerator<Chunk> {
      const head = await bytesOf(blob, e.localOffset, e.localOffset + 30);
      if (head.getUint32(0, true) !== SIG_LOCAL) throw new ZipError('The zip file looks damaged.');
      const dataStart = e.localOffset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
      const dataEnd = dataStart + e.compressedSize;
      let idx = 0;
      let pending: Uint8Array[] = [];
      let pendingLen = 0;
      const ready: Chunk[] = [];
      const take = (n: number): Uint8Array => {
        const out = new Uint8Array(n);
        let o = 0;
        while (o < n) {
          const first = pending[0]!;
          const need = n - o;
          if (first.length <= need) { out.set(first, o); o += first.length; pending.shift(); }
          else { out.set(first.subarray(0, need), o); pending[0] = first.subarray(need); o += need; }
        }
        pendingLen -= n;
        return out;
      };
      const flush = (final: boolean) => {
        while (pendingLen >= chunkSize) {
          const data = take(chunkSize);
          if (!skip?.has(idx)) ready.push({ idx, data });
          idx++;
        }
        if (final && (pendingLen > 0 || idx === 0)) {
          const data = take(pendingLen);
          if (!skip?.has(idx)) ready.push({ idx, data });
          idx++;
        }
      };
      const add = (d: Uint8Array) => { if (d.length) { pending.push(d); pendingLen += d.length; } };

      if (e.method === 0) {
        for (let p = dataStart; p < dataEnd; p += 4 * 1024 * 1024) {
          add(new Uint8Array(await blob.slice(p, Math.min(dataEnd, p + 4 * 1024 * 1024)).arrayBuffer()));
          flush(false);
          while (ready.length) yield ready.shift()!;
        }
        flush(true);
        while (ready.length) yield ready.shift()!;
        return;
      }
      if (e.method !== 8) throw new ZipError('This zip file uses a compression method we cannot read.');
      let failed: Error | null = null;
      const inf = new Inflate((d) => add(d));
      for (let p = dataStart; p < dataEnd || p === dataStart; p += 2 * 1024 * 1024) {
        const end = Math.min(dataEnd, p + 2 * 1024 * 1024);
        const part = new Uint8Array(await blob.slice(p, end).arrayBuffer());
        try { inf.push(part, end >= dataEnd); } catch (err) { failed = err as Error; }
        if (failed) throw new ZipError('The zip file looks damaged.');
        flush(false);
        while (ready.length) yield ready.shift()!;
        if (end >= dataEnd) break;
      }
      flush(true);
      while (ready.length) yield ready.shift()!;
    },
  };
}

/** List the entries of a zip file (files only). Throws ZipError with a friendly message. */
export async function openZip(blob: Blob): Promise<ZipEntry[]> {
  if (blob.size > ZIP_MAX_BYTES) throw new ZipError('This zip file is larger than 2 GB. Split it into smaller zip files.');
  if (blob.size < 22) throw new ZipError('This zip file is empty or damaged.');
  const tailLen = Math.min(blob.size, 65557 + 22);
  const tailStart = blob.size - tailLen;
  const tail = await bytesOf(blob, tailStart, blob.size);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('This does not look like a zip file, or it is damaged.');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locPos = tailStart + eocd - 20;
    if (locPos >= 0) {
      const loc = await bytesOf(blob, locPos, locPos + 20);
      if (loc.getUint32(0, true) === SIG_LOC64) {
        const off64 = u64(loc, 8);
        const rec = await bytesOf(blob, off64, off64 + 56);
        if (rec.getUint32(0, true) === SIG_EOCD64) {
          count = u64(rec, 32);
          cdSize = u64(rec, 40);
          cdOffset = u64(rec, 48);
        }
      }
    }
  }
  if (count > ZIP_MAX_ENTRIES * 4) throw new ZipError(`This zip file has more than ${ZIP_MAX_ENTRIES.toLocaleString('en-GB')} files. Split it into smaller zip files.`);
  if (cdOffset + cdSize > blob.size) throw new ZipError('This zip file looks damaged.');
  const cd = await bytesOf(blob, cdOffset, cdOffset + cdSize);
  const raw = new Uint8Array(cd.buffer);
  const out: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === SIG_CEN) {
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let localOffset = cd.getUint32(p + 42, true);
    const name = decodeName(raw.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    // zip64 extra field
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.getUint16(x, true);
      const len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let o = x + 4;
        if (size === 0xffffffff) { size = u64(cd, o); o += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(cd, o); o += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(cd, o); o += 8; }
      }
      x += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // folder entry
    if (flags & 1) throw new ZipError('This zip file is password protected. Remove the password and try again.');
    out.push({ name, size, compressedSize, method, localOffset, source: entrySource(blob, { size, compressedSize, method, localOffset }) });
    if (out.length > ZIP_MAX_ENTRIES) throw new ZipError(`This zip file has more than ${ZIP_MAX_ENTRIES.toLocaleString('en-GB')} files. Split it into smaller zip files.`);
  }
  return out;
}
