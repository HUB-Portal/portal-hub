import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseConfig } from '../src/config';
import {
  CHUNK_SIZE, chunkCountFor, fileCipherFromRow, newFileKey, openBuffer, openChunk, openStream, rewrapDataKey, sealBuffer, sealChunk, unwrapDataKey, wrappedKeyId,
} from '../src/crypto/envelope';
import { blindIndex, blindIndexes, decryptField, encryptField, fieldAad, fieldKeyId, normaliseName, rewrapField } from '../src/crypto/keys';
import { COMMON_PASSWORD_COUNT, checkPasswordPolicy, dummyVerify, hashPassword, verifyPassword } from '../src/crypto/password';
import {
  base32Decode, base32Encode, generateRecoveryCodes, hashRecoveryCode, hotp, otpauthUri, qrDataUrl, totpCode, verifyTotp,
} from '../src/crypto/totp';
import { csrfFor, randomToken, sha256Hex } from '../src/crypto/tokens';
import { generateApiKey, ipAllowed, isApiKeyFormat, permissionsForScopes } from '../src/auth/apikeys';
import { redactUrl } from '../src/http/util';
import { ALL_ROLES, KLINE_ROLES, PARTNER_ROLES, PERMISSIONS, can, permissionsFor } from '../../shared/roles';

describe('file envelope encryption', () => {
  const fileId = randomUUID();
  const data = Buffer.from('A'.repeat(100) + 'B'.repeat(100) + 'C'.repeat(50));

  it('round trips across several chunks', () => {
    const k = newFileKey(fileId);
    const sealed = sealBuffer(k.cipher, data, 100);
    expect(sealed).toHaveLength(3);
    expect(openBuffer(k.cipher, sealed, 3).equals(data)).toBe(true);
    expect(CHUNK_SIZE).toBe(8 * 1024 * 1024);
    expect(chunkCountFor(0)).toBe(1);
    expect(chunkCountFor(CHUNK_SIZE + 1)).toBe(2);
  });

  it('rejects a tampered chunk', () => {
    const k = newFileKey(fileId);
    const sealed = sealBuffer(k.cipher, data, 100);
    sealed[1][5] ^= 1;
    expect(() => openBuffer(k.cipher, sealed, 3)).toThrow();
  });

  it('rejects swapped chunks', () => {
    const k = newFileKey(fileId);
    const sealed = sealBuffer(k.cipher, data, 100);
    expect(() => openBuffer(k.cipher, [sealed[1], sealed[0], sealed[2]], 3)).toThrow();
  });

  it('rejects truncated files and truncated chunks', async () => {
    const k = newFileKey(fileId);
    const sealed = sealBuffer(k.cipher, data, 100);
    expect(() => openBuffer(k.cipher, sealed.slice(0, 2), 3)).toThrow();
    // dropping the last chunk but claiming a smaller count fails because the count is part of the AAD
    expect(() => openChunk(k.cipher, 0, 2, sealed[0])).toThrow();
    expect(() => openChunk(k.cipher, 0, 3, sealed[0].subarray(0, sealed[0].length - 3))).toThrow();
    async function* src() {
      yield sealed[0];
      yield sealed[1];
    }
    await expect(async () => {
      for await (const _ of openStream(k.cipher, src(), 3)) void _;
    }).rejects.toThrow();
  });

  it('binds chunks to their file', () => {
    const a = newFileKey(fileId);
    const sealed = sealChunk(a.cipher, 0, 1, Buffer.from('secret'));
    expect(() => openChunk({ ...a.cipher, fileId: randomUUID() }, 0, 1, sealed)).toThrow();
  });

  it('wraps, unwraps and rewraps the data key', () => {
    const k = newFileKey(fileId);
    expect(k.wrappedKey.startsWith('w1.k1.')).toBe(true);
    expect(unwrapDataKey(k.wrappedKey, fileId).equals(k.cipher.dataKey)).toBe(true);
    expect(() => unwrapDataKey(k.wrappedKey, randomUUID())).toThrow();
    const re = rewrapDataKey(k.wrappedKey, fileId, 'k2');
    expect(wrappedKeyId(re)).toBe('k2');
    const c2 = fileCipherFromRow({ id: fileId, wrapped_key: re, nonce_prefix: k.noncePrefix });
    const sealed = sealBuffer(k.cipher, data, 100);
    expect(openBuffer(c2, sealed, 3).equals(data)).toBe(true);
  });
});

describe('field encryption and blind index', () => {
  it('uses the documented format and binds the AAD', () => {
    const id = randomUUID();
    const t = encryptField('Marc Alonso', fieldAad.casePatient(id));
    expect(t).toMatch(/^f1\.k1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(t).not.toContain('Marc');
    expect(decryptField(t, fieldAad.casePatient(id))).toBe('Marc Alonso');
    expect(() => decryptField(t, fieldAad.caseNotes(id))).toThrow();
    expect(() => decryptField(t, fieldAad.casePatient(randomUUID()))).toThrow();
    const parts = t.split('.');
    parts[3] = Buffer.from('x').toString('base64url');
    expect(() => decryptField(parts.join('.'), fieldAad.casePatient(id))).toThrow();
  });

  it('rewraps under another key', () => {
    const aad = fieldAad.userTotp(randomUUID());
    const t = encryptField('JBSWY3DPEHPK3PXP', aad);
    const r = rewrapField(t, aad, 'k2');
    expect(fieldKeyId(r)).toBe('k2');
    expect(decryptField(r, aad)).toBe('JBSWY3DPEHPK3PXP');
    expect(rewrapField(r, aad, 'k2')).toBe(r);
  });

  it('normalises names for the blind index', () => {
    expect(normaliseName('  José   García-López ')).toBe('josegarcialopez');
    expect(blindIndex('José García')).toBe(blindIndex('JOSE   garcia'));
    expect(blindIndex('Ana Silva')).not.toBe(blindIndex('Ana Silvo'));
    expect(blindIndex('Ana Silva')).toMatch(/^[0-9a-f]{64}$/);
    expect(blindIndexes('Marc', 'Alonso')).toContain(blindIndex('Alonso Marc'));
    expect(blindIndex('Straße')).toBe(blindIndex('strasse'));
  });
});

describe('TOTP', () => {
  const ascii = Buffer.from('12345678901234567890');
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of vectors) expect(totpCode(ascii, t, 8)).toBe(code);
  });

  it('matches RFC 4226 HOTP vectors', () => {
    expect(hotp(ascii, 0)).toBe('755224');
    expect(hotp(ascii, 9)).toBe('520489');
  });

  it('accepts one step either side and refuses replays', () => {
    const secret = base32Encode(ascii);
    const now = 1_700_000_000;
    const step = Math.floor(now / 30);
    expect(verifyTotp(secret, totpCode(ascii, now), { nowSeconds: now })).toBe(step);
    expect(verifyTotp(secret, totpCode(ascii, now - 30), { nowSeconds: now })).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(ascii, now + 30), { nowSeconds: now })).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(ascii, now - 90), { nowSeconds: now })).toBeNull();
    expect(verifyTotp(secret, totpCode(ascii, now), { nowSeconds: now, lastStep: step })).toBeNull();
    expect(verifyTotp(secret, 'abcdef', { nowSeconds: now })).toBeNull();
  });

  it('encodes base32, builds the otpauth link and a QR code', async () => {
    expect(base32Decode(base32Encode(ascii)).equals(ascii)).toBe(true);
    const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'a@acme.demo' });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect((await qrDataUrl(uri)).startsWith('data:image/png;base64,')).toBe(true);
  });

  it('creates ten distinct recovery codes stored as HMACs', () => {
    const rc = generateRecoveryCodes();
    expect(new Set(rc.codes).size).toBe(10);
    expect(rc.hashes).toEqual(rc.codes.map(hashRecoveryCode));
    expect(hashRecoveryCode(rc.codes[0].toUpperCase())).toBe(rc.hashes[0]);
    expect(rc.hashes[0]).not.toContain(rc.codes[0]);
  });
});

describe('passwords', () => {
  it('hashes with scrypt and verifies in constant time form', async () => {
    const h = await hashPassword('correct horse battery staple 9', 10);
    expect(h.startsWith('s1$10$8$1$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery staple 9')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery staple 8')).toBe(false);
    expect(await verifyPassword('garbage', 'x')).toBe(false);
    expect(await dummyVerify('anything')).toBe(false);
  });

  it('enforces the policy', () => {
    expect(COMMON_PASSWORD_COUNT).toBeGreaterThanOrEqual(200);
    expect(checkPasswordPolicy('short1!')).toMatch(/12/);
    expect(checkPasswordPolicy('password1234')).toMatch(/common/);
    expect(checkPasswordPolicy('P@ssw0rd')).not.toBeNull();
    expect(checkPasswordPolicy('Welcome2026!')).toMatch(/common/);
    expect(checkPasswordPolicy('aaaaaaaaaaaaaaaa')).not.toBeNull();
    expect(checkPasswordPolicy('alexander-is-great-99', { email: 'alexander@acme.demo' })).toMatch(/email/);
    expect(checkPasswordPolicy('my name is Katrin ok ok', { name: 'Katrin Admin' })).toMatch(/name/);
    expect(checkPasswordPolicy('Demo2026PartnerHub', { email: 'admin@acme.demo', name: 'Alex Acme' })).toBeNull();
    expect(checkPasswordPolicy('violet-sofa-marathon-42')).toBeNull();
  });
});

describe('tokens, api keys, urls', () => {
  it('generates tokens and csrf values', () => {
    expect(randomToken()).toMatch(/^[\w-]{43}$/);
    expect(sha256Hex('a')).toHaveLength(64);
    const id = randomUUID();
    expect(csrfFor(id)).toBe(csrfFor(id));
    expect(csrfFor(id)).not.toBe(csrfFor(randomUUID()));
  });

  it('uses the documented API key format and CIDR lists', () => {
    const k = generateApiKey();
    expect(k.key).toMatch(/^kph_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(isApiKeyFormat(k.key)).toBe(true);
    expect(isApiKeyFormat('kph_short')).toBe(false);
    expect(ipAllowed([], '1.2.3.4')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], '10.2.3.4')).toBe(true);
    expect(ipAllowed(['10.0.0.0/8'], '11.2.3.4')).toBe(false);
    expect(ipAllowed(['10.0.0.0/8'], '::ffff:10.2.3.4')).toBe(true);
    expect(ipAllowed(['2001:db8::/32'], '2001:db8::1')).toBe(true);
    expect(permissionsForScopes(['cases:read']).has('case.read')).toBe(true);
    expect(permissionsForScopes(['cases:read']).has('case.write')).toBe(false);
  });

  it('redacts one time tokens from URLs', () => {
    expect(redactUrl('/reset-password?token=abc123&x=1')).toBe('/reset-password?token=[redacted]&x=1');
    expect(redactUrl('/api/auth/invite/SECRETTOKEN')).toBe('/api/auth/invite/[redacted]');
    expect(redactUrl('/api/auth/invite/accept')).toBe('/api/auth/invite/accept');
    expect(redactUrl('/invite/SECRETTOKEN?x=1')).toBe('/invite/[redacted]?x=1');
  });
});

describe('roles and permissions', () => {
  it('maps roles as in the brief', () => {
    expect(ALL_ROLES).toHaveLength(6);
    expect([...KLINE_ROLES]).toEqual(['kl_admin']);
    expect(can(['admin'], 'team.manage')).toBe(true);
    expect(can(['admin'], 'admin.partners')).toBe(false);
    expect(can(['admin'], 'integration.manage')).toBe(false);
    expect(can(['kl_admin'], 'integration.manage')).toBe(true);
    expect(can(['viewer'], 'case.write')).toBe(false);
    expect(can(['viewer'], 'case.read')).toBe(true);
    expect(can(['uploader'], 'case.reveal_name')).toBe(true);
    expect(can(['uploader'], 'team.manage')).toBe(false);
    expect(can(['finance'], 'export.run')).toBe(true);
    expect(can(['kl_admin'], 'claim.decide')).toBe(true);
    expect(can(['quality'], 'claim.decide')).toBe(false);
    expect(permissionsFor(['kl_admin']).size).toBe(PERMISSIONS.length);
    expect(can(['uploader', 'quality'], 'spec.sign')).toBe(true);
    for (const r of PARTNER_ROLES) expect(permissionsFor([r]).has('admin.staff')).toBe(false);
  });
});

describe('configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://kph_app:a_long_password_1234@localhost:5433/kph',
    MASTER_KEYS: JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') }),
    ACTIVE_KEY_ID: 'k1',
    BLIND_INDEX_KEY_ID: 'k1',
  };
  it('accepts a development configuration', () => {
    const c = parseConfig({ ...base, SCANNER: 'none' });
    expect(c.port).toBe(4000);
    expect(c.cookieName).toBe('kph_session');
  });
  it('cannot turn off two factor sign in for Google (fixed decision 4)', () => {
    for (const env of ['development', 'production']) {
      const b: Record<string, string> = env === 'production' ? { ...base, NODE_ENV: 'production', PUBLIC_URL: 'https://hub.example.com', SMTP_URL: 'smtp://x', SCANNER: 'clamav' } : { ...base };
      for (const v of ['false', '0', 'no', 'off', 'FALSE', 'maybe']) {
        expect(() => parseConfig({ ...b, OIDC_REQUIRE_LOCAL_MFA: v })).toThrow(/two factor sign in is required for everyone/);
      }
      expect(() => parseConfig({ ...b, OIDC_REQUIRE_LOCAL_MFA: 'true' })).not.toThrow();
      expect(() => parseConfig(b)).not.toThrow();
    }
    // the parsed configuration has no switch for it any more
    expect('requireLocalMfa' in parseConfig({ ...base }).oidc).toBe(false);
  });
  it('refuses unsafe production settings', () => {
    const prod = { ...base, NODE_ENV: 'production', PUBLIC_URL: 'https://hub.example.com', SMTP_URL: 'smtp://x', SCANNER: 'clamav' };
    expect(parseConfig(prod).cookieName).toBe('__Host-kph_session');
    expect(() => parseConfig({ ...prod, PUBLIC_URL: 'http://hub.example.com' })).toThrow(/https/);
    expect(() => parseConfig({ ...prod, DEMO_MODE: 'true' })).toThrow(/DEMO_MODE/);
    expect(() => parseConfig({ ...prod, PORTAL_FAKE: 'true' })).toThrow(/PORTAL_FAKE/);
    expect(parseConfig({ ...base, PORTAL_FAKE: 'true' }).portalFake).toBe(true);
    expect(parseConfig({ ...base }).portalFake).toBe(false);
    expect(() => parseConfig({ ...prod, SCANNER: 'none' })).toThrow(/scanner/);
    expect(parseConfig({ ...prod, SCANNER: 'none', ALLOW_NO_SCANNER: 'true' }).allowNoScanner).toBe(true);
    expect(() => parseConfig({ ...prod, SMTP_URL: undefined })).toThrow(/SMTP/);
    expect(() => parseConfig({ ...prod, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    expect(() => parseConfig({ ...prod, FILE_STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    expect(parseConfig({ ...base, STORAGE_DRIVER: 'fs', FILE_STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ENDPOINT: 'https://s3.example.com' }).storageDriver).toBe('s3');
    expect(parseConfig({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ENDPOINT: 'https://s3.example.com' }).storageDriver).toBe('s3');
    expect(parseConfig({ ...base }).storageDriver).toBe('fs');
    expect(() => parseConfig({ ...base, MASTER_KEYS: '{"k1":"c2hvcnQ="}' })).toThrow(/32 bytes/);
    expect(() => parseConfig({ ...base, DATABASE_URL: 'postgres://kph_app:short@localhost/kph' })).toThrow(/16 characters/);
  });
});
