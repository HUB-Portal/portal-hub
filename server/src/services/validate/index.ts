import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { validateStl } from './stl';
import { validatePts } from './pts';
import { validatePdf } from './pdf';
import { validateSvg } from './svg';
import { validateCsv } from './csv';
import { validateImage } from './image';

export interface Issue {
  code: string;
  message: string;
}

export interface ValidationResult {
  /** Errors reject the file. */
  errors: Issue[];
  /** Warnings need the partner's confirmation before the case is submitted. */
  warnings: Issue[];
  meta: Record<string, unknown>;
}

/** Plain content of one file, read as often as needed (decrypting on the fly for stored files). */
export interface ContentSource {
  size: number;
  stream(): AsyncIterable<Buffer>;
}

export function bufferSource(buf: Buffer, chunkSize = 1024 * 1024): ContentSource {
  return {
    size: buf.length,
    async *stream() {
      for (let o = 0; o < buf.length; o += chunkSize) yield buf.subarray(o, Math.min(buf.length, o + chunkSize));
    },
  };
}

export async function fileSource(path: string): Promise<ContentSource> {
  const s = await stat(path);
  return { size: s.size, stream: () => createReadStream(path, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer> };
}

export class TooLargeError extends Error {}

/** Reads a whole source into memory, refusing when it is larger than maxBytes. */
export async function readAll(src: ContentSource, maxBytes: number): Promise<Buffer> {
  if (src.size > maxBytes) throw new TooLargeError();
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of src.stream()) {
    n += c.length;
    if (n > maxBytes) throw new TooLargeError();
    parts.push(c);
  }
  return Buffer.concat(parts);
}

/** First `n` bytes of a source. */
export async function readHead(src: ContentSource, n: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let have = 0;
  for await (const c of src.stream()) {
    parts.push(c);
    have += c.length;
    if (have >= n) break;
  }
  return Buffer.concat(parts).subarray(0, n);
}

export const emptyResult = (): ValidationResult => ({ errors: [], warnings: [], meta: {} });

// ---------------------------------------------------------------------------
// Executables: refused whatever the extension says.
// ---------------------------------------------------------------------------
export const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'dll', 'com', 'scr', 'bat', 'cmd', 'msi', 'msp', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  'jar', 'sh', 'bash', 'zsh', 'run', 'bin', 'elf', 'so', 'dylib', 'app', 'command', 'pif', 'cpl', 'lnk', 'reg', 'apk', 'ipa',
  'deb', 'rpm', 'dmg', 'pkg', 'py', 'pl', 'rb', 'php',
]);

/** Returns a short label when the first bytes are an executable (MZ, ELF, Mach-O, Java class) or a shebang script. */
export function detectExecutable(head: Buffer): string | null {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return 'Windows executable';
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'Linux executable';
  if (head.length >= 4) {
    const m = head.readUInt32BE(0);
    if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcffaedfe) return 'macOS executable';
    if (m === 0xcafebabe) return 'macOS or Java executable';
  }
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return 'script';
  return null;
}

/** Validates the content of one file by kind. Never throws on bad content: problems are returned as errors. */
export async function validateContent(kind: string, ext: string, src: ContentSource): Promise<ValidationResult> {
  const head = await readHead(src, 16);
  if (detectExecutable(head)) {
    return { errors: [{ code: 'executable_content', message: 'Programs and scripts cannot be uploaded.' }], warnings: [], meta: {} };
  }
  try {
    switch (kind) {
      case 'stl':
        return await validateStl(src);
      case 'pts':
        return await validatePts(src);
      case 'pdf':
        return await validatePdf(src);
      case 'svg':
        return await validateSvg(src);
      case 'csv':
        return await validateCsv(src);
      case 'image':
        return await validateImage(src, ext);
      case 'video':
        return await validateVideo(src);
      default:
        return await validateText(src);
    }
  } catch (e) {
    if (e instanceof TooLargeError) {
      return { errors: [{ code: 'file_too_large_to_check', message: 'This file is too large to be checked for its type.' }], warnings: [], meta: {} };
    }
    throw e;
  }
}

/** Videos (mp4, mov, m4v) are checked by their first box: an ISO base media file starts with a box whose type sits at byte 4. */
export async function validateVideo(src: ContentSource): Promise<ValidationResult> {
  const head = await readHead(src, 16);
  const r = emptyResult();
  const type = head.length >= 8 ? head.subarray(4, 8).toString('latin1') : '';
  if (!['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(type)) r.errors.push({ code: 'video_invalid', message: 'This is not a valid MP4 or MOV video.' });
  else r.meta = { format: type === 'ftyp' ? head.subarray(8, 12).toString('latin1').trim() || 'mp4' : 'mov' };
  return r;
}

/** txt, xml and json files must look like text. */
async function validateText(src: ContentSource): Promise<ValidationResult> {
  const head = await readHead(src, 8192);
  const r = emptyResult();
  if (head.includes(0)) r.errors.push({ code: 'not_text', message: 'This file is not readable text.' });
  return r;
}
