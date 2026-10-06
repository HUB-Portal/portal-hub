import { randomBytes } from 'node:crypto';
import { aesGcmOpen, aesGcmSeal, activeKeyId, deriveKey } from './keys';

/** Encrypted chunk size for files: 8 MB of plaintext per chunk. */
export const CHUNK_SIZE = 8 * 1024 * 1024;
const TAG_LEN = 16;

const b64u = (b: Buffer) => b.toString('base64url');

export interface FileCipher {
  fileId: string;
  dataKey: Buffer;
  noncePrefix: Buffer; // 8 bytes
}

export interface NewFileKey {
  cipher: FileCipher;
  /** Store on the file row: `w1.<keyId>.<iv>.<ct>.<tag>`. */
  wrappedKey: string;
  keyId: string;
  /** Store on the file row (base64url). */
  noncePrefix: string;
}

export function chunkCountFor(size: number, chunkSize = CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

const wrapAad = (fileId: string) => Buffer.from(`key|${fileId}`, 'utf8');
const chunkAad = (fileId: string, idx: number, count: number) => Buffer.from(`chunk|${fileId}|${idx}|${count}`, 'utf8');

/** Wraps a data key with the KEK derived (HKDF) from the master key. */
export function wrapDataKey(dataKey: Buffer, fileId: string, keyId: string = activeKeyId()): string {
  const { iv, ct, tag } = aesGcmSeal(deriveKey(keyId, 'file-kek'), dataKey, wrapAad(fileId));
  return `w1.${keyId}.${b64u(iv)}.${b64u(ct)}.${b64u(tag)}`;
}

export function unwrapDataKey(wrapped: string, fileId: string): Buffer {
  const p = wrapped.split('.');
  if (p.length !== 5 || p[0] !== 'w1') throw new Error('Malformed wrapped key');
  const [, keyId, iv, ct, tag] = p;
  return aesGcmOpen(
    deriveKey(keyId, 'file-kek'),
    Buffer.from(iv, 'base64url'),
    Buffer.from(ct, 'base64url'),
    Buffer.from(tag, 'base64url'),
    wrapAad(fileId),
  );
}

export function wrappedKeyId(wrapped: string): string {
  const p = wrapped.split('.');
  if (p.length !== 5 || p[0] !== 'w1') throw new Error('Malformed wrapped key');
  return p[1];
}

/** Re-wraps a data key under another master key without touching file content. */
export function rewrapDataKey(wrapped: string, fileId: string, newKeyId: string = activeKeyId()): string {
  if (wrappedKeyId(wrapped) === newKeyId) return wrapped;
  return wrapDataKey(unwrapDataKey(wrapped, fileId), fileId, newKeyId);
}

/** New random data key and nonce prefix for a file. */
export function newFileKey(fileId: string): NewFileKey {
  const dataKey = randomBytes(32);
  const noncePrefix = randomBytes(8);
  const keyId = activeKeyId();
  return { cipher: { fileId, dataKey, noncePrefix }, wrappedKey: wrapDataKey(dataKey, fileId, keyId), keyId, noncePrefix: b64u(noncePrefix) };
}

/** Rebuilds the cipher from the values stored on the file row. */
export function fileCipherFromRow(row: { id: string; wrapped_key: string; nonce_prefix: string }): FileCipher {
  return { fileId: row.id, dataKey: unwrapDataKey(row.wrapped_key, row.id), noncePrefix: Buffer.from(row.nonce_prefix, 'base64url') };
}

function nonce(prefix: Buffer, idx: number): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(idx, 8);
  return n;
}

/** Seals one chunk. Output is ciphertext followed by the 16 byte tag. */
export function sealChunk(cipher: FileCipher, idx: number, count: number, plaintext: Buffer): Buffer {
  if (idx < 0 || idx >= count) throw new Error('Chunk index out of range');
  const { ct, tag } = aesGcmSeal(cipher.dataKey, plaintext, chunkAad(cipher.fileId, idx, count), nonce(cipher.noncePrefix, idx));
  return Buffer.concat([ct, tag]);
}

/** Opens one chunk. Throws when the chunk was altered, moved to another position or belongs to another file. */
export function openChunk(cipher: FileCipher, idx: number, count: number, sealed: Buffer): Buffer {
  if (sealed.length < TAG_LEN) throw new Error('Chunk too short');
  return aesGcmOpen(
    cipher.dataKey,
    nonce(cipher.noncePrefix, idx),
    sealed.subarray(0, sealed.length - TAG_LEN),
    sealed.subarray(sealed.length - TAG_LEN),
    chunkAad(cipher.fileId, idx, count),
  );
}

/** Splits and seals a whole buffer (small files, tests). */
export function sealBuffer(cipher: FileCipher, data: Buffer, chunkSize = CHUNK_SIZE): Buffer[] {
  const count = chunkCountFor(data.length, chunkSize);
  const out: Buffer[] = [];
  for (let i = 0; i < count; i++) out.push(sealChunk(cipher, i, count, data.subarray(i * chunkSize, (i + 1) * chunkSize)));
  return out;
}

/** Opens all chunks and refuses when the number of chunks differs from the recorded count (truncation). */
export function openBuffer(cipher: FileCipher, chunks: Buffer[], count: number): Buffer {
  if (chunks.length !== count) throw new Error('Chunk count mismatch');
  return Buffer.concat(chunks.map((c, i) => openChunk(cipher, i, count, c)));
}

/** Streaming decrypt: verifies each chunk as it arrives and the total count at the end. */
export async function* openStream(cipher: FileCipher, sealedChunks: AsyncIterable<Buffer>, count: number): AsyncGenerator<Buffer> {
  let i = 0;
  for await (const s of sealedChunks) {
    if (i >= count) throw new Error('Too many chunks');
    yield openChunk(cipher, i, count, s);
    i++;
  }
  if (i !== count) throw new Error('Chunk count mismatch');
}
