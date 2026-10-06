import { Readable } from 'node:stream';
import yazl from 'yazl';

export interface NamedFile {
  id: string;
  kind: string;
  arch: 'upper' | 'lower' | null;
  step: number | null;
  is_template: boolean;
  ext: string | null;
  /** Decrypted original name, used only for files without an arch and step. */
  name: string;
}

/** Keeps a name safe as a zip entry: no path parts, no control characters, no leading dots. */
export function safeEntryName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '_').trim().slice(0, 120);
  return cleaned || 'file';
}

/**
 * Canonical entry names: `upper/U01.stl`, `lower/L12_T.pts`, and `other/<name>` for everything else.
 * Duplicates get a numeric suffix so no entry overwrites another.
 */
export function canonicalNames(files: NamedFile[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const unique = (name: string): string => {
    let n = name;
    let i = 2;
    while (used.has(n.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      n = dot > 0 ? `${name.slice(0, dot)}_${i}${name.slice(dot)}` : `${name}_${i}`;
      i++;
    }
    used.add(n.toLowerCase());
    return n;
  };
  const sorted = [...files].sort((a, b) => (a.arch ?? '').localeCompare(b.arch ?? '') || (a.step ?? 0) - (b.step ?? 0) || a.id.localeCompare(b.id));
  for (const f of sorted) {
    const ext = (f.ext ?? '').toLowerCase();
    if (f.arch && f.step !== null && ['stl', 'pts', 'csv'].includes(f.kind)) {
      const letter = f.arch === 'upper' ? 'U' : 'L';
      const num = String(f.step).padStart(2, '0');
      out.set(f.id, unique(`${f.arch}/${letter}${num}${f.is_template ? '_T' : ''}${ext ? '.' + ext : ''}`));
    } else {
      out.set(f.id, unique(`other/${safeEntryName(f.name)}`));
    }
  }
  return out;
}

export interface ZipEntry {
  name: string;
  /** Provide one of the two. Streams are opened lazily, one at a time. */
  buffer?: Buffer;
  stream?: () => AsyncIterable<Buffer>;
  size?: number;
  /** Deflate level 0 to 9. 0 stores without compression. */
  level?: number;
}

/** Streams a zip built with yazl. Entry streams are read one after another, so memory stays small. */
export function zipStream(entries: ZipEntry[]): Readable {
  const zip = new yazl.ZipFile();
  const out = zip.outputStream as unknown as Readable;
  zip.on('error', (e: Error) => out.destroy(e));
  const mtime = new Date();
  for (const e of entries) {
    const level = e.level ?? 0;
    const opts: any = { mtime, compressionLevel: level, mode: 0o100644 };
    if (e.buffer) {
      zip.addBuffer(e.buffer, e.name, opts);
    } else if (e.stream) {
      const r = Readable.from(e.stream());
      r.on('error', (err) => out.destroy(err));
      zip.addReadStream(r, e.name, e.size !== undefined ? { ...opts, size: e.size } : opts);
    }
  }
  zip.end();
  return out;
}

/** Escapes a CSV cell (and defuses formulas: cells starting with = + - @ get a leading apostrophe unless they are plain numbers). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=@+-]/.test(s) && !/^[-+]?\d+([.,]\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
