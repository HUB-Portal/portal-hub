import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SYSTEM, tx } from '../src/db';
import { base32Decode, totpCode } from '../src/crypto/totp';
import { encryptField, fieldAad } from '../src/crypto/keys';
import { hashPassword } from '../src/crypto/password';
import { DEMO_PASSWORD, demoTotpSecret } from '../src/services/demo';
import { runDueJobs } from '../src/worker';

let ipCounter = 100;

export const totp = (email: string) => totpCode(base32Decode(demoTotpSecret(email)), Date.now() / 1000);

export async function resetTotpStep(email: string) {
  await tx(SYSTEM, (c) => c.query('UPDATE users SET totp_last_step = NULL, failed_logins = 0, locked_until = NULL, lockout_count = 0, mfa_failed_codes = 0, mfa_fail_window_start = NULL, mfa_lockout_count = 0 WHERE lower(email) = $1', [email]));
}

export class Client {
  cookie = '';
  csrf = '';
  ip = `10.2.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`;
  constructor(private app: FastifyInstance) {}

  async call(method: string, url: string, body?: unknown, opts: { headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const res = await this.app.inject({ method: method as any, url, payload: body as any, headers, remoteAddress: this.ip });
    const set = res.cookies.find((c) => c.name === 'kph_session');
    if (set) this.cookie = set.value ? `kph_session=${set.value}` : '';
    let json: any = null;
    try {
      json = res.json();
    } catch {
      /* binary or empty */
    }
    if (json?.csrfToken) this.csrf = json.csrfToken;
    return { status: res.statusCode, json, res };
  }

  /** Full sign in with the demo authenticator secret. */
  async full(email: string) {
    await resetTotpStep(email);
    const l = await this.call('POST', '/api/auth/login', { email, password: DEMO_PASSWORD });
    expect(l.status).toBe(200);
    const v = await this.call('POST', '/api/auth/mfa/verify', { code: totp(email) });
    expect(v.status).toBe(200);
    return this;
  }

  /** Refreshes the step up window. */
  async stepUp(email: string) {
    await resetTotpStep(email);
    // a code from the next step avoids replay protection after the sign in code
    const r = await this.call('POST', '/api/auth/step-up', { code: totpCode(base32Decode(demoTotpSecret(email)), Date.now() / 1000 + 30) });
    expect(r.status).toBe(200);
  }

  /** Uploads one file through the chunked protocol and waits for the worker. Returns the final file JSON. */
  async uploadFile(caseId: string, name: string, data: Buffer, extra: Record<string, unknown> = {}, opts: { process?: boolean } = {}) {
    const init = await this.call('POST', '/api/uploads', { purpose: 'case', caseId, name, size: data.length, ...extra });
    expect(init.status, JSON.stringify(init.json)).toBe(200);
    const { fileId, chunkSize, chunkCount, received } = init.json;
    for (let i = 0; i < chunkCount; i++) {
      if (received.includes(i)) continue;
      const part = data.subarray(i * chunkSize, (i + 1) * chunkSize);
      const put = await this.putChunk(fileId, i, part);
      expect(put.status, JSON.stringify(put.json)).toBe(200);
    }
    const done = await this.call('POST', `/api/uploads/${fileId}/complete`, {});
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    if (opts.process !== false) await runDueJobs();
    const f = await this.call('GET', `/api/files/${fileId}`);
    return { fileId: fileId as string, file: f.json };
  }

  putChunk(fileId: string, idx: number, part: Buffer, sha?: string) {
    return this.call('PUT', `/api/uploads/${fileId}/chunks/${idx}`, part, {
      headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha ?? createHash('sha256').update(part).digest('hex') },
    });
  }
}

/** Inserts an active demo user (same password and authenticator secret rules as the seed). */
export async function createDemoUser(orgId: string, email: string, name: string, roles: string[]): Promise<string> {
  const id = randomUUID();
  const hash = await hashPassword(DEMO_PASSWORD);
  await tx(SYSTEM, (c) =>
    c.query(
      `INSERT INTO users (id, org_id, email, name, roles, status, password_hash, password_changed_at, totp_secret_enc, mfa_enabled, mfa_enrolled_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, now(), $7, true, now())`,
      [id, orgId, email, name, roles, hash, encryptField(demoTotpSecret(email), fieldAad.userTotp(id))],
    ),
  );
  return id;
}

export async function orgIdOf(code: string): Promise<string> {
  return tx(SYSTEM, async (c) => (await c.query('SELECT id FROM organizations WHERE code = $1', [code])).rows[0].id);
}

// ---------------------------------------------------------------------------
// Synthetic files
// ---------------------------------------------------------------------------
type Tri = [number, number, number][];

export function binaryStl(tris: Tri[], header = 'synthetic model'): Buffer {
  const b = Buffer.alloc(84 + tris.length * 50);
  b.write(header, 0, 'latin1');
  b.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) b.writeFloatLE(t[v]![k]!, o + 12 + v * 12 + k * 4);
  });
  return b;
}

/** Closed cube spanning 0..size on every axis. */
export function cubeStl(size: number, header?: string): Buffer {
  const p = (x: number, y: number, z: number): [number, number, number] => [x * size, y * size, z * size];
  const quad = (a: any, b: any, c: any, d: any): Tri[] => [[a, b, c], [a, c, d]];
  const tris: Tri[] = [
    ...quad(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)),
    ...quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)),
    ...quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)),
    ...quad(p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)),
    ...quad(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)),
    ...quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)),
  ];
  return binaryStl(tris, header);
}

/** Closed trim line (circle) inside a 50 mm cube. */
export function trimLine(n = 120): Buffer {
  return Buffer.from(
    Array.from({ length: n }, (_, i) => `${(25 + 15 * Math.cos((2 * Math.PI * i) / n)).toFixed(6)} ${(25 + 15 * Math.sin((2 * Math.PI * i) / n)).toFixed(6)} 5.000000`).join('\n') + '\n',
  );
}

export const laserCsv = () =>
  Buffer.from('LaserPt1Start\t-25.010\t4.638\t11.049\r\nLaserPt1End\t-26.520\t-20.308\t9.148\r\ntext1\t55813_U01\r\nLaserPt2Start\t23.182\t-3.171\t11.090\r\nLaserPt2End\t24.688\t-8.623\t8.920\r\ntext2\t\r\n');

export const minimalPdf = (extra = '') => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog ${extra} >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);

export const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

/** A PNG header (signature and IHDR) with the given pixel size. Enough for the magic byte check and the logo size check. */
export function pngOfSize(width: number, height: number, pad = 64): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, Buffer.from('IHDR', 'latin1'), ihdr, Buffer.alloc(4), Buffer.alloc(pad, 7)]);
}

/** A JPEG with an APP0 segment and a start of frame (SOF0) segment of the given pixel size. */
export function jpegOfSize(width: number, height: number): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9, 1)]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.set([0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(40, 3), Buffer.from([0xff, 0xd9])]);
}

/** A logo PNG that passes the company logo rules (800 x 240). */
export const LOGO_PNG = pngOfSize(800, 240);
/** A logo SVG that passes the company logo rules (viewBox 300 x 90). */
export const LOGO_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 90" width="300" height="90"><rect x="10" y="10" width="280" height="70" fill="#0088cc"/></svg>');

/** Gives an organisation a (stub) logo file row, for tests that only need the logo to exist, such as the approval gate. */
export async function giveOrgLogo(orgId: string): Promise<string> {
  const id = randomUUID();
  await tx(SYSTEM, async (c) => {
    await c.query(
      `INSERT INTO files (id, org_id, purpose, kind, state, size, chunk_count, storage_prefix, ext, content_type) VALUES ($1, $2, 'logo', 'svg', 'ready', 10, 1, $3, 'svg', 'image/svg+xml')`,
      [id, orgId, 'stub/' + id],
    );
    await c.query('UPDATE organizations SET logo_file_id = $2 WHERE id = $1', [orgId, id]);
  });
  return id;
}
