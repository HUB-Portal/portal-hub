import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

const derived = new Map<string, Buffer>();

export function masterKey(keyId: string): Buffer {
  const k = config.masterKeys[keyId];
  if (!k) throw new Error('Unknown master key id');
  return k;
}

/** HKDF-SHA256 sub key from a master key. Purposes keep keys for different uses independent. */
export function deriveKey(keyId: string, purpose: string): Buffer {
  const cacheKey = `${keyId}|${purpose}`;
  let k = derived.get(cacheKey);
  if (!k) {
    k = Buffer.from(hkdfSync('sha256', masterKey(keyId), Buffer.from('kph-hub-v1'), Buffer.from(purpose), 32));
    derived.set(cacheKey, k);
  }
  return k;
}

export function activeKeyId(): string {
  return config.activeKeyId;
}

/** Forgets derived sub keys (tests that change the configured master keys, and key rotation checks). */
export function clearDerivedKeys(): void {
  derived.clear();
}

/**
 * Key id for keyed hashes that cannot be re-created once stored (API key hashes, recovery code hashes, CSRF tokens).
 * It is HASH_KEY_ID (by default the blind index key) and does not rotate with ACTIVE_KEY_ID: rotating the active key must never
 * invalidate a customer's API key or recovery codes, because only the hash is stored and the original value is unknown.
 */
export function stableKeyId(): string {
  return config.hashKeyId;
}

export function aesGcmSeal(key: Buffer, plaintext: Buffer, aad: Buffer, iv: Buffer = randomBytes(12)): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}

export function aesGcmOpen(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// ---------------------------------------------------------------------------
// Field encryption: f1.<keyId>.<iv>.<ciphertext>.<tag>, all base64url
// ---------------------------------------------------------------------------
export const fieldAad = {
  casePatient: (id: string) => `case|${id}|patient`,
  casePatientFirst: (id: string) => `case|${id}|patient_first`,
  casePatientLast: (id: string) => `case|${id}|patient_last`,
  caseNotes: (id: string) => `case|${id}|notes`,
  fileName: (id: string) => `file|${id}`,
  userTotp: (id: string) => `user|${id}|totp`,
  webhook: (id: string) => `webhook|${id}`,
  portalKey: (orgId: string) => `org|${orgId}|portal_api_key`,
  portalHook: (orgId: string) => `org|${orgId}|portal_hook`,
};

export function encryptField(plain: string, aad: string, keyId: string = config.activeKeyId): string {
  const { iv, ct, tag } = aesGcmSeal(deriveKey(keyId, 'field'), Buffer.from(plain, 'utf8'), Buffer.from(aad, 'utf8'));
  return `f1.${keyId}.${b64u(iv)}.${b64u(ct)}.${b64u(tag)}`;
}

export function fieldKeyId(token: string): string {
  const p = token.split('.');
  if (p.length !== 5 || p[0] !== 'f1') throw new Error('Malformed encrypted field');
  return p[1];
}

export function decryptField(token: string, aad: string): string {
  const p = token.split('.');
  if (p.length !== 5 || p[0] !== 'f1') throw new Error('Malformed encrypted field');
  const [, keyId, iv, ct, tag] = p;
  return aesGcmOpen(deriveKey(keyId, 'field'), fromB64u(iv), fromB64u(ct), fromB64u(tag), Buffer.from(aad, 'utf8')).toString('utf8');
}

/** Re-encrypts a field under another master key (default: active). Returns the input when already current. */
export function rewrapField(token: string, aad: string, newKeyId: string = config.activeKeyId): string {
  if (fieldKeyId(token) === newKeyId) return token;
  return encryptField(decryptField(token, aad), aad, newKeyId);
}

// ---------------------------------------------------------------------------
// Blind index for exact patient name search
// ---------------------------------------------------------------------------
const FOLD: Record<string, string> = {
  'ß': 'ss',
  'ø': 'o',
  'æ': 'ae',
  'œ': 'oe',
  'đ': 'd',
  'ł': 'l',
  'ð': 'd',
  'þ': 'th',
};

/** Case, accents, spaces and punctuation removed. */
export function normaliseName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[ßøæœđłðþ]/g, (ch) => FOLD[ch] ?? ch)
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** HMAC-SHA256 hex of the normalised name. */
export function blindIndex(name: string): string {
  return createHmac('sha256', deriveKey(config.blindIndexKeyId, 'blind-index')).update(normaliseName(name)).digest('hex');
}

/** Both name orders, so a search matches regardless of which order the partner used. */
export function blindIndexes(first: string, last: string): string[] {
  return [...new Set([blindIndex(`${first} ${last}`), blindIndex(`${last} ${first}`)])];
}

// ---------------------------------------------------------------------------
// Keyed hashes for recovery codes and API keys (stable key, see stableKeyId)
// ---------------------------------------------------------------------------
export function hmacHex(purpose: string, value: string): string {
  return createHmac('sha256', deriveKey(stableKeyId(), purpose)).update(value).digest('hex');
}

/** Constant time string compare. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
