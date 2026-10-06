import { createHmac, randomBytes, randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import { hmacHex, safeEqual } from './keys';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP (SHA-1). */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const STEP_SECONDS = 30;
export const stepAt = (unixSeconds: number, step = STEP_SECONDS) => Math.floor(unixSeconds / step);

/** RFC 6238 TOTP for a moment in time. */
export function totpCode(secret: Buffer, unixSeconds: number, digits = 6, step = STEP_SECONDS): string {
  return hotp(secret, stepAt(unixSeconds, step), digits);
}

/**
 * Checks a code within one step either side. Returns the matched step number, or null.
 * Steps at or before lastStep are refused, which blocks replay of a code already used.
 */
export function verifyTotp(secretBase32: string, code: string, opts: { lastStep?: number | null; nowSeconds?: number } = {}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const now = stepAt(opts.nowSeconds ?? Date.now() / 1000);
  let matched: number | null = null;
  for (const delta of [-1, 0, 1]) {
    const s = now + delta;
    // evaluate all three so timing does not reveal which step matched
    if (safeEqual(hotp(secret, s), code) && matched === null) matched = s;
  }
  if (matched === null) return null;
  if (opts.lastStep != null && matched <= opts.lastStep) return null;
  return matched;
}

export function otpauthUri(opts: { secret: string; account: string; issuer?: string }): string {
  const issuer = opts.issuer ?? 'Portal Hub';
  const label = encodeURIComponent(`${issuer}:${opts.account}`);
  return `otpauth://totp/${label}?secret=${opts.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function qrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

export function normaliseRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return hmacHex('recovery-code', normaliseRecoveryCode(code));
}

/** Ten one time codes such as `k3f9x-2mq7a`. Show once, store only the hashes. */
export function generateRecoveryCodes(n = 10): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    let c = '';
    for (let j = 0; j < 10; j++) c += CODE_CHARS[randomInt(CODE_CHARS.length)];
    codes.push(`${c.slice(0, 5)}-${c.slice(5)}`);
  }
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
