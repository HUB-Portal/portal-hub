// Case ID pattern helper for the company profile. The pattern is tested in the browser only.

export const MAX_PATTERN_LENGTH = 200;
export const MAX_SAMPLE_LENGTH = 64;

export type PatternState =
  | { ok: true; regex: RegExp | null }
  | { ok: false; message: string };

/** A nested repeat such as (a+)+ can make a pattern very slow. Refuse the obvious shapes. */
function looksCatastrophic(p: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(p);
}

export function readPattern(pattern: string): PatternState {
  const p = pattern.trim();
  if (!p) return { ok: true, regex: null };
  if (p.length > MAX_PATTERN_LENGTH) return { ok: false, message: `Use at most ${MAX_PATTERN_LENGTH} characters.` };
  let regex: RegExp;
  try { regex = new RegExp(p); } catch { return { ok: false, message: 'This is not a valid pattern. Check the brackets and backslashes.' }; }
  if (looksCatastrophic(p)) return { ok: false, message: 'This pattern repeats a repeat, which can make checks very slow. Please simplify it.' };
  return { ok: true, regex };
}

export interface SampleResult { text: string; match: boolean; tooLong: boolean }

export function testSamples(regex: RegExp, samples: string[]): SampleResult[] {
  return samples.map((raw) => {
    const text = raw.trim();
    const tooLong = text.length > MAX_SAMPLE_LENGTH;
    return { text, tooLong, match: !tooLong && regex.test(text) };
  });
}
