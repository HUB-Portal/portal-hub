// Company logo rules shared by the server and the web app. Plain TypeScript, no imports, no Node APIs.

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MIN_WIDTH = 400;
export const LOGO_MIN_HEIGHT = 120;
export const LOGO_MAX_WIDTH = 4000;
export const LOGO_MAX_HEIGHT = 4000;
/** Width divided by height must be between 1 (square) and 6 (very wide). */
export const LOGO_MIN_RATIO = 1;
export const LOGO_MAX_RATIO = 6;
export const LOGO_RECOMMENDED = { width: 800, height: 240 } as const;

export type LogoFormat = 'png' | 'jpeg' | 'svg';
export type LogoProblemCode = 'logo_too_small' | 'logo_too_large' | 'logo_bad_ratio' | 'logo_type';

/** The instruction repeated in every refusal. */
export const LOGO_INSTRUCTIONS =
  'Use a PNG (best, with a transparent background), an SVG or a JPG of at most 2 MB. ' +
  'Aim for 800 x 240 pixels (landscape, about 3 to 1). It must be at least 400 x 120 and at most 4000 x 4000 pixels, ' +
  'and the width must be between 1 and 6 times the height. Leave about 10 percent empty margin and make sure it can be read on white.';

export interface LogoProblem {
  code: LogoProblemCode;
  message: string;
}

const problem = (code: LogoProblemCode, message: string): LogoProblem => ({ code, message: `${message} ${LOGO_INSTRUCTIONS}` });

/** Checks the size in bytes. */
export function checkLogoBytes(bytes: number): LogoProblem | null {
  return bytes > LOGO_MAX_BYTES ? problem('logo_too_large', 'This logo file is larger than 2 MB.') : null;
}

/** Checks the width and height. For an SVG these are the viewBox (or width and height) values: only the ratio is checked. */
export function checkLogoDimensions(format: LogoFormat, width: number, height: number): LogoProblem | null {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return problem(format === 'svg' ? 'logo_bad_ratio' : 'logo_type', format === 'svg' ? 'This SVG needs a viewBox, or a width and a height.' : 'The size of this image could not be read.');
  }
  const ratio = width / height;
  if (format !== 'svg') {
    if (width > LOGO_MAX_WIDTH || height > LOGO_MAX_HEIGHT) {
      return problem('logo_too_large', `This logo is ${Math.round(width)} x ${Math.round(height)} pixels, which is too large.`);
    }
    if (width < LOGO_MIN_WIDTH || height < LOGO_MIN_HEIGHT) {
      return problem('logo_too_small', `This logo is ${Math.round(width)} x ${Math.round(height)} pixels, which is too small.`);
    }
  }
  if (ratio < LOGO_MIN_RATIO) return problem('logo_bad_ratio', 'This logo is taller than it is wide.');
  if (ratio > LOGO_MAX_RATIO) return problem('logo_bad_ratio', 'This logo is too wide for its height.');
  return null;
}

// ---------------------------------------------------------------------------
// Reading the size from the file itself
// ---------------------------------------------------------------------------
export interface ImageSize {
  format: LogoFormat;
  width: number;
  height: number;
}

const be32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const be16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;

/** PNG: width and height sit in the IHDR chunk straight after the signature. Returns null when the header is not a PNG header. */
export function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (sig.some((v, i) => b[i] !== v)) return null;
  // chunk length (4), type "IHDR" (4)
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  const width = be32(b, 16);
  const height = be32(b, 20);
  return width > 0 && height > 0 ? { format: 'png', width, height } : null;
}

/** JPEG: walks the marker segments up to the first start of frame (SOF) segment. Returns null when none is found. */
export function jpegSize(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    let marker = b[o + 1]!;
    // fill bytes
    while (marker === 0xff && o + 2 < b.length) {
      o++;
      marker = b[o + 1]!;
    }
    o += 2;
    // markers without a length
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (o + 2 > b.length) return null;
    const len = be16(b, o);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (o + 7 > b.length) return null;
      const height = be16(b, o + 3);
      const width = be16(b, o + 5);
      return width > 0 && height > 0 ? { format: 'jpeg', width, height } : null;
    }
    o += len;
  }
  return null;
}

const NUM = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*(px)?\s*$/i;

/** SVG: the viewBox of the root element, else its width and height (plain numbers or px). Percent and other units are not usable. */
export function svgSize(svgText: string): ImageSize | null {
  const tag = /<svg\b([^>]*)>/i.exec(svgText.replace(/^﻿/, ''));
  if (!tag) return null;
  const attrs = tag[1]!;
  const attr = (name: string): string | null => {
    const m = new RegExp(`(?:^|[\\s"'])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
    return m ? (m[1] ?? m[2] ?? '') : null;
  };
  const vb = attr('viewBox');
  if (vb !== null) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2]! > 0 && parts[3]! > 0) return { format: 'svg', width: parts[2]!, height: parts[3]! };
  }
  const w = attr('width');
  const h = attr('height');
  const wm = w === null ? null : NUM.exec(w);
  const hm = h === null ? null : NUM.exec(h);
  if (wm && hm && Number(wm[1]) > 0 && Number(hm[1]) > 0) return { format: 'svg', width: Number(wm[1]), height: Number(hm[1]) };
  return null;
}

/** Size of a logo file from its bytes. SVG text is decoded as UTF-8. Returns null when the size cannot be read. */
export function readLogoSize(format: LogoFormat, bytes: Uint8Array): ImageSize | null {
  if (format === 'png') return pngSize(bytes);
  if (format === 'jpeg') return jpegSize(bytes);
  return svgSize(new TextDecoder('utf-8').decode(bytes.subarray(0, 64 * 1024)));
}

/** Full check of a logo file: size in bytes, then pixel size or ratio. Returns null when the logo is acceptable. */
export function checkLogoFile(format: LogoFormat, bytes: Uint8Array): LogoProblem | null {
  const big = checkLogoBytes(bytes.length);
  if (big) return big;
  const size = readLogoSize(format, bytes);
  if (!size) return checkLogoDimensions(format, 0, 0);
  return checkLogoDimensions(format, size.width, size.height);
}
