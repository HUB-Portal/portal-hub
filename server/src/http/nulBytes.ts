/**
 * PostgreSQL cannot store a NUL character (U+0000) in text, so it would fail deep inside a query with a server error.
 * This is checked once, early, for everything a caller can send: query string, route parameters and the JSON body (nested).
 */
export const NUL_MESSAGE = 'Some of the text contains a character that cannot be used. Please remove it and try again.';

const hasNul = (s: string) => s.includes('\u0000');

/** True when any string, or any object key, in the value contains a NUL character. Iterative, so a deeply nested body cannot overflow the stack. */
export function containsNul(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (hasNul(v)) return true;
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (v && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Uint8Array)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (hasNul(k)) return true;
        stack.push(x);
      }
    }
  }
  return false;
}
