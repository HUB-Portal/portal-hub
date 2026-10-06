// Text rules shared by the server and the web app. Pure TypeScript.

/**
 * Bidirectional control characters (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069). They can make a file name or a sentence
 * read differently from what it is (for example a name that looks like "photo.png" but ends in another extension), so they are
 * refused in names and in text that other people read. They are not refused in patient names.
 */
const BIDI_CONTROL = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

export function hasBidiControl(text: string): boolean {
  return BIDI_CONTROL.test(text);
}

export const BIDI_MESSAGE = 'That text has hidden text direction characters in it. Please remove them and try again.';
