// Turn dropped folders, files and zips into SourceFile lists (path relative to the dropped item).
import { blobSource, type SourceFile } from './source';
import { openZip, ZipError } from './zip';

export interface IntakeResult { files: SourceFile[]; notes: string[] }

const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
export function isJunkPath(path: string): boolean {
  const segs = path.split('/');
  if (segs.some((s) => s === '__MACOSX')) return true;
  const last = segs[segs.length - 1]!.toLowerCase();
  return JUNK_NAMES.has(last) || last.startsWith('._') || last === '';
}

const MAX_FILES = 20000;

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () => reader.readEntries((batch) => {
      if (batch.length === 0) resolve(all);
      else { all.push(...batch); next(); }
    }, reject);
    next();
  });
}

function entryFile(e: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => e.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, prefix: string, out: { path: string; file: File }[]): Promise<void> {
  if (out.length > MAX_FILES) return;
  if (entry.isFile) {
    const f = await entryFile(entry as FileSystemFileEntry);
    out.push({ path: `${prefix}${entry.name}`, file: f });
  } else if (entry.isDirectory) {
    const kids = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const k of kids) await walk(k, `${prefix}${entry.name}/`, out);
  }
}

function stripZip(name: string): string {
  return name.replace(/\.zip$/i, '');
}

async function expand(items: { path: string; file: File }[]): Promise<IntakeResult> {
  const files: SourceFile[] = [];
  const notes: string[] = [];
  for (const it of items) {
    if (isJunkPath(it.path)) continue;
    if (/\.zip$/i.test(it.path)) {
      try {
        const entries = await openZip(it.file);
        const base = stripZip(it.path);
        for (const e of entries) {
          const p = `${base}/${e.name}`;
          if (isJunkPath(p)) continue;
          files.push({ path: p, size: e.size, source: e.source });
        }
      } catch (err) {
        notes.push(`${it.file.name}: ${err instanceof ZipError ? err.message : 'This zip file could not be read.'}`);
      }
      continue;
    }
    files.push({ path: it.path, size: it.file.size, source: blobSource(it.file) });
  }
  if (items.length > MAX_FILES) notes.push(`Only the first ${MAX_FILES.toLocaleString('en-GB')} files were read.`);
  return { files, notes };
}

/** Call synchronously inside the drop event handler, before any await. */
export function snapshotDrop(dt: DataTransfer): { entries: FileSystemEntry[]; loose: File[] } {
  const entries: FileSystemEntry[] = [];
  const loose: File[] = [];
  const items = Array.from(dt.items ?? []);
  if (items.length && typeof items[0]!.webkitGetAsEntry === 'function') {
    for (const it of items) {
      if (it.kind !== 'file') continue;
      const e = it.webkitGetAsEntry();
      if (e) entries.push(e);
      else { const f = it.getAsFile(); if (f) loose.push(f); }
    }
  } else {
    loose.push(...Array.from(dt.files ?? []));
  }
  return { entries, loose };
}

export async function readDrop(snap: { entries: FileSystemEntry[]; loose: File[] }): Promise<IntakeResult> {
  const out: { path: string; file: File }[] = [];
  for (const e of snap.entries) await walk(e, '', out);
  for (const f of snap.loose) out.push({ path: f.name, file: f });
  return expand(out);
}

/** From an `<input type="file">` (with or without webkitdirectory). */
export async function readFileList(list: FileList | File[]): Promise<IntakeResult> {
  const out = Array.from(list).map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f }));
  return expand(out);
}
