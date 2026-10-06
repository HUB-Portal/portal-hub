import { emptyResult, readAll, type ContentSource, type ValidationResult } from './index';

export const SVG_MAX_BYTES = 10 * 1024 * 1024;

const ATTR_HREF = /\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** SVG: scripts, event handlers, javascript: links, foreignObject, external references and entities all block. */
export async function validateSvg(src: ContentSource): Promise<ValidationResult> {
  const r = emptyResult();
  const text = (await readAll(src, SVG_MAX_BYTES)).toString('utf8');
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 2048).toLowerCase();
  if (!/<svg[\s>]/.test(text.toLowerCase()) || !(head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!--') || head.startsWith('<!doctype svg'))) {
    r.errors.push({ code: 'svg_invalid', message: 'This is not a valid SVG file.' });
    return r;
  }
  // Decode numeric character references so "&#106;avascript:" cannot hide.
  const decoded = text.replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/&#(\d+);?/g, (_m, d: string) => String.fromCharCode(Number(d)));
  const lower = decoded.toLowerCase();
  const block = (code: string, message: string) => {
    if (!r.errors.some((e) => e.code === code)) r.errors.push({ code, message });
  };
  if (/<\s*script\b/.test(lower)) block('svg_script', 'This SVG contains a script, which is not allowed.');
  if (/[\s"'/]on[a-z]+\s*=/.test(lower)) block('svg_event_handler', 'This SVG contains an event handler, which is not allowed.');
  if (/javascript\s*:/.test(lower.replace(/[\u0000- ]/g, ''))) block('svg_javascript_link', 'This SVG contains a javascript: link, which is not allowed.');
  if (/<\s*foreignobject\b/.test(lower)) block('svg_foreign_object', 'This SVG contains embedded HTML (foreignObject), which is not allowed.');
  if (/<\s*(iframe|embed|object)/.test(lower)) block('svg_embedded_content', 'This SVG embeds other content, which is not allowed.');
  if (/<!entity\b/.test(lower)) block('svg_entity', 'This SVG declares entities, which is not allowed.');
  if (/@import\b/.test(lower) || /url\(\s*["']?\s*(https?:|\/\/|ftp:|file:)/.test(lower)) block('svg_external_reference', 'This SVG refers to an external resource, which is not allowed.');
  for (const m of decoded.matchAll(ATTR_HREF)) {
    const v = (m[1] ?? m[2] ?? '').trim().toLowerCase().replace(/[\u0000- ]/g, '');
    if (!v || v.startsWith('#') || /^data:image\/(png|jpeg|jpg|gif);base64,/.test(v)) continue;
    block('svg_external_reference', 'This SVG refers to an external resource, which is not allowed.');
  }
  return r;
}
