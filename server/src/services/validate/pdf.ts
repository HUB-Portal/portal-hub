import { emptyResult, type ContentSource, type ValidationResult } from './index';

const OVERLAP = 64;

/** Decodes #xx escapes inside PDF names so /J#61vaScript is seen as /JavaScript. */
function unescapeNames(s: string): string {
  return s.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const NAME_END = '(?![A-Za-z0-9_])';
const CHECKS: { key: 'js' | 'launch' | 'embedded' | 'encrypt'; re: RegExp }[] = [
  { key: 'js', re: new RegExp('/(?:JavaScript|JS)' + NAME_END) },
  { key: 'launch', re: new RegExp('/Launch' + NAME_END) },
  { key: 'embedded', re: new RegExp('/EmbeddedFiles?' + NAME_END) },
  { key: 'encrypt', re: new RegExp('/Encrypt' + NAME_END) },
];

/**
 * PDF: /JavaScript, /JS and /Launch block; embedded files and password protection warn.
 * Names inside compressed object streams cannot be seen, which is why the malware scan also runs.
 */
export async function validatePdf(src: ContentSource): Promise<ValidationResult> {
  const r = emptyResult();
  const found = { js: false, launch: false, embedded: false, encrypt: false };
  let tail = '';
  let first = true;
  let headerOk = false;
  for await (const c of src.stream()) {
    const text = tail + unescapeNames(c.toString('latin1'));
    if (first) {
      first = false;
      headerOk = text.slice(0, 1024).includes('%PDF-');
    }
    for (const ch of CHECKS) if (!found[ch.key] && ch.re.test(text)) found[ch.key] = true;
    tail = text.slice(-OVERLAP);
  }
  if (!headerOk) {
    r.errors.push({ code: 'pdf_invalid', message: 'This is not a valid PDF file.' });
    return r;
  }
  if (found.js) r.errors.push({ code: 'pdf_javascript', message: 'This PDF contains JavaScript, which is not allowed.' });
  if (found.launch) r.errors.push({ code: 'pdf_launch', message: 'This PDF can launch other programs, which is not allowed.' });
  if (found.embedded) r.warnings.push({ code: 'pdf_embedded_files', message: 'This PDF contains embedded files.' });
  if (found.encrypt) r.warnings.push({ code: 'pdf_encrypted', message: 'This PDF is password protected, so it cannot be fully checked.' });
  return r;
}
