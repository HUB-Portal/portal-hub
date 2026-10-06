// Company logo rules and the check that runs in the browser before an upload. Phase 8 contract, section 2.
// The limits and the messages come from shared/logo.ts, so the browser and the server say the same thing. The server checks again
// after the upload. Nothing here puts an image into the page: PNG and JPEG sizes are read from the file header, and an SVG is only
// read as text with a regular expression, never parsed into the DOM.
import {
  LOGO_MAX_BYTES, LOGO_MAX_HEIGHT, LOGO_MAX_WIDTH, LOGO_MIN_HEIGHT, LOGO_MIN_WIDTH, LOGO_RECOMMENDED, LOGO_INSTRUCTIONS,
  checkLogoBytes, checkLogoDimensions, jpegSize, pngSize, svgSize, type LogoFormat,
} from '@shared/logo';

export const LOGO_RULES = {
  maxBytes: LOGO_MAX_BYTES,
  minWidth: LOGO_MIN_WIDTH,
  minHeight: LOGO_MIN_HEIGHT,
  maxWidth: LOGO_MAX_WIDTH,
  maxHeight: LOGO_MAX_HEIGHT,
  recommendedWidth: LOGO_RECOMMENDED.width,
  recommendedHeight: LOGO_RECOMMENDED.height,
} as const;

export interface LogoOk {
  ok: true;
  format: LogoFormat;
  width: number;
  height: number;
  bytes: number;
  /** A gentle remark that does not stop the upload. */
  note: string | null;
}
export type LogoCheck = LogoOk | { ok: false; message: string };

const NOT_AN_IMAGE = `This does not look like a PNG, SVG or JPG image. ${LOGO_INSTRUCTIONS}`;

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Checks a chosen logo file: size on disk, real file type and pixel size. The messages repeat the instruction. */
export async function checkLogoFile(file: File): Promise<LogoCheck> {
  if (file.size === 0) return { ok: false, message: 'This file is empty. Choose your logo image.' };
  const big = checkLogoBytes(file.size);
  if (big) return { ok: false, message: `This file is ${sizeText(file.size)}. ${big.message}` };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, message: 'We could not read this file. Please try again.' };
  }

  // The type comes from what is inside the file, not from its name.
  let size = pngSize(bytes) ?? jpegSize(bytes);
  if (!size) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64 * 1024));
    if (/<svg\b/i.test(head)) size = svgSize(head) ?? { format: 'svg', width: 0, height: 0 };
  }
  if (!size) return { ok: false, message: NOT_AN_IMAGE };

  const problem = checkLogoDimensions(size.format, size.width, size.height);
  if (problem) return { ok: false, message: problem.message };

  const small = size.format !== 'svg' && (size.width < LOGO_RECOMMENDED.width || size.height < LOGO_RECOMMENDED.height);
  return {
    ok: true,
    format: size.format,
    width: Math.round(size.width),
    height: Math.round(size.height),
    bytes: file.size,
    note: small ? `This logo is smaller than the recommended ${LOGO_RECOMMENDED.width} x ${LOGO_RECOMMENDED.height} pixels. It can look soft on high resolution screens.` : null,
  };
}
