import { emptyResult, readHead, type ContentSource, type ValidationResult } from './index';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ImageType = 'png' | 'jpeg' | null;

export function sniffImage(head: Buffer): ImageType {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG)) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  return null;
}

/** Images are checked by magic bytes: the content must be what the extension says. */
export async function validateImage(src: ContentSource, ext: string): Promise<ValidationResult> {
  const r = emptyResult();
  const t = sniffImage(await readHead(src, 16));
  const want = ext.toLowerCase() === 'png' ? 'png' : 'jpeg';
  if (t === null) r.errors.push({ code: 'image_invalid', message: 'This is not a valid PNG or JPEG image.' });
  else if (t !== want) r.errors.push({ code: 'image_type_mismatch', message: `The file name says ${want.toUpperCase()} but the content is ${t.toUpperCase()}.` });
  else r.meta = { format: t };
  return r;
}
