import { createHash, createHmac, randomBytes } from 'node:crypto';
import { deriveKey, safeEqual, stableKeyId } from './keys';

export { safeEqual };

/** Random URL safe token (default 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** CSRF token: HMAC of the session id. */
export function csrfFor(sessionId: string): string {
  return createHmac('sha256', deriveKey(stableKeyId(), 'csrf')).update(sessionId).digest('base64url');
}
