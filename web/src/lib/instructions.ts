// Read case instructions from txt, md, rtf and docx files in the browser. Pure helpers, no network.
import { unzipSync } from 'fflate';

export const INSTRUCTIONS_MAX = 8000;

export interface InstructionRead {
  text: string;
  truncated: boolean;
  message: string | null;
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  // UTF-16 without a BOM: many zero bytes at odd or even positions.
  if (bytes.length >= 4) {
    let odd = 0;
    let even = 0;
    const n = Math.min(bytes.length, 200);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) (i % 2 ? odd++ : even++);
    if (odd > n / 4 && even === 0) return new TextDecoder('utf-16le').decode(bytes);
    if (even > n / 4 && odd === 0) return new TextDecoder('utf-16be').decode(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function docxToText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const doc = files['word/document.xml'];
  if (!doc) throw new Error('No document text found.');
  const xml = new TextDecoder('utf-8').decode(doc);
  const text = xml
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:(br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeXmlEntities(text);
}

const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'footnote', 'object', 'themedata', 'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'generator']);

export function rtfToText(src: string): string {
  let out = '';
  const stack: { skip: boolean }[] = [];
  let skip = false;
  let uc = 1;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '{') {
      stack.push({ skip });
      i++;
      // A destination group such as {\*\foo ...} or {\fonttbl ...}
      const m = /^\\(\*)?\\?([a-z]+)/i.exec(src.slice(i, i + 40));
      if (m && (m[1] || RTF_SKIP.has(m[2]!.toLowerCase()))) skip = true;
    } else if (ch === '}') {
      skip = stack.pop()?.skip ?? false;
      i++;
    } else if (ch === '\\') {
      const next = src[i + 1] ?? '';
      if (next === "'") {
        const hex = src.slice(i + 2, i + 4);
        if (!skip) out += new TextDecoder('windows-1252').decode(new Uint8Array([parseInt(hex, 16) || 63]));
        i += 4;
      } else if (/[a-z]/i.test(next)) {
        const m = /^\\([a-z]+)(-?\d+)? ?/i.exec(src.slice(i, i + 40))!;
        const word = m[1]!.toLowerCase();
        const num = m[2] !== undefined ? Number(m[2]) : undefined;
        i += m[0].length;
        if (skip) continue;
        if (word === 'par' || word === 'line') out += '\n';
        else if (word === 'tab') out += '\t';
        else if (word === 'uc' && num !== undefined) uc = num;
        else if (word === 'u' && num !== undefined) {
          out += String.fromCodePoint(num < 0 ? num + 65536 : num);
          i += uc; // skip the fallback characters
        } else if (word === 'emdash' || word === 'endash') out += ' ';
        else if (word === 'lquote' || word === 'rquote') out += "'";
        else if (word === 'ldblquote' || word === 'rdblquote') out += '"';
      } else {
        if (!skip && (next === '\\' || next === '{' || next === '}')) out += next;
        else if (!skip && next === '~') out += ' ';
        i += 2;
      }
    } else {
      if (!skip && ch !== '\r' && ch !== '\n') out += ch;
      i++;
    }
  }
  return out;
}

export function tidyText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Read instructions from file bytes. `name` decides the format. */
export function readInstructionBytes(name: string, bytes: Uint8Array): InstructionRead {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'doc') {
    return { text: '', truncated: false, message: 'Old Word files (.doc) cannot be read here. Save it as .docx or .txt, or paste the text in.' };
  }
  let raw = '';
  try {
    if (ext === 'docx') raw = docxToText(bytes);
    else if (ext === 'rtf') raw = rtfToText(decodeText(bytes));
    else raw = decodeText(bytes);
  } catch {
    return { text: '', truncated: false, message: 'We could not read that file. Paste the text in instead.' };
  }
  const text = tidyText(raw);
  if (text.length > INSTRUCTIONS_MAX) {
    return { text: text.slice(0, INSTRUCTIONS_MAX), truncated: true, message: `The text was longer than ${INSTRUCTIONS_MAX.toLocaleString('en-GB')} characters. We kept the first ${INSTRUCTIONS_MAX.toLocaleString('en-GB')}.` };
  }
  return { text, truncated: false, message: null };
}

/** Join several instruction files into one text, within the limit. */
export function joinInstructions(parts: InstructionRead[]): InstructionRead {
  const texts = parts.map((p) => p.text).filter(Boolean);
  const joined = texts.join('\n\n');
  const message = parts.find((p) => p.message)?.message ?? null;
  if (joined.length > INSTRUCTIONS_MAX) {
    return { text: joined.slice(0, INSTRUCTIONS_MAX), truncated: true, message: `The instructions were longer than ${INSTRUCTIONS_MAX.toLocaleString('en-GB')} characters. We kept the first ${INSTRUCTIONS_MAX.toLocaleString('en-GB')}.` };
  }
  return { text: joined, truncated: parts.some((p) => p.truncated), message };
}
