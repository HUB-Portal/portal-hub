import { z } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isIP } from 'node:net';

const here = path.dirname(fileURLToPath(import.meta.url));
/** server/ directory (works from src/ and from dist/). */
export const SERVER_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? d : ['true', '1', 'yes', 'on'].includes(v.toLowerCase())));

const num = (d: number, min = 0, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max).default(d);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: num(4000, 1, 65535),
  PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  TRUST_PROXY: z.string().default('false'),
  DATABASE_URL: z.string().url(),
  DATABASE_OWNER_URL: z.string().url().optional(),
  MASTER_KEYS: z.string().min(2),
  ACTIVE_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  BLIND_INDEX_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  /** Key for hashes that cannot be re-created (API keys, recovery codes, CSRF tokens). Defaults to BLIND_INDEX_KEY_ID. Never rotates. */
  HASH_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
  STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  /** Same meaning as STORAGE_DRIVER and wins over it. Use this name on hosts whose image builder reads STORAGE_DRIVER itself (Vercel container builds do). */
  FILE_STORAGE_DRIVER: z.enum(['fs', 's3']).optional(),
  STORAGE_DIR: z.string().default(path.join(SERVER_ROOT, 'data', 'files')),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('eu-central-1'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(true),
  SCANNER: z.enum(['clamav', 'none']).default('clamav'),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: num(3310, 1, 65535),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Portal Hub <no-reply@localhost>'),
  SESSION_IDLE_MINUTES: num(30, 1, 24 * 60),
  SESSION_MAX_HOURS: num(12, 1, 24 * 14),
  STEP_UP_MINUTES: num(10, 1, 60),
  SCRYPT_LOG_N: num(17, 10, 20),
  SIGNUP_ENABLED: bool(false),
  SIGNUP_DAILY_LIMIT: num(100, 0, 100000),
  /** Every registration answer takes at least this long (milliseconds). Tests lower it. */
  SIGNUP_MIN_MS: num(600, 0, 10000),
  SUPPORT_EMAIL: z.string().default('support@localhost'),
  PRIVACY_EMAIL: z.string().default('privacy@localhost'),
  RUN_WORKER: bool(false),
  DEMO_MODE: bool(false),
  /**
   * Development tunnels only (for example cloudflared in front of a dev Hub). When true, a request that carries proxy headers
   * (x-forwarded-for, forwarded, cf-connecting-ip, cf-ray, x-real-ip) is answered 404 unless it is for the portal webhook receiver
   * or the health check. Refused in production.
   */
  TUNNEL_HOOKS_ONLY: bool(false),
  PORTAL_FAKE: bool(false),
  ALLOW_NO_SCANNER: bool(false),
  AUDIT_RETENTION_MONTHS: num(36, 1, 600),
  WEB_DIST: z.string().default(path.join(REPO_ROOT, 'web', 'dist')),
  LOG_LEVEL: z.string().optional(),
  // Google Workspace sign in for K Line staff (OpenID Connect). Optional: both the client id and the secret switch it on.
  OIDC_GOOGLE_CLIENT_ID: z.string().optional(),
  OIDC_GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Hosted domain (Workspace domain) a staff member's Google account must belong to, for example klineeurope.com. */
  OIDC_ALLOWED_DOMAIN: z.string().optional(),
  /**
   * Two factor sign in is required for everyone (fixed decision 4): a Google sign in is only the first factor and the authenticator code
   * is always asked. The variable is accepted only as true (or left out). Any other value stops the server from starting.
   */
  OIDC_REQUIRE_LOCAL_MFA: z.string().optional(),
  // Two factor sign in is on unless this is explicitly set to false, 0, no or off (any other value, a typo included, keeps it on). Temporary switch: see docs/SECURITY.md.
  MFA_REQUIRED: z
    .string()
    .optional()
    .transform((v) => !(v !== undefined && ['false', '0', 'no', 'off'].includes(v.trim().toLowerCase()))),
  /** Discovery document. Only tests and proxies change this; it must be https in production. */
  OIDC_GOOGLE_DISCOVERY_URL: z.string().url().default('https://accounts.google.com/.well-known/openid-configuration'),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  isProd: boolean;
  host: string;
  port: number;
  publicUrl: string;
  /** Passed to Fastify: false, true, a number of hops, or a comma separated list of addresses, ranges and the names loopback, linklocal and uniquelocal. */
  trustProxy: boolean | number | string;
  databaseUrl: string;
  databaseOwnerUrl?: string;
  masterKeys: Record<string, Buffer>;
  activeKeyId: string;
  blindIndexKeyId: string;
  /** Master key that keys the hashes of API keys and recovery codes. It does not rotate with ACTIVE_KEY_ID. */
  hashKeyId: string;
  storageDriver: 'fs' | 's3';
  storageDir: string;
  s3: { endpoint?: string; bucket?: string; region: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle: boolean };
  scanner: 'clamav' | 'none';
  clamav: { host: string; port: number };
  smtpUrl?: string;
  mailFrom: string;
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  stepUpMinutes: number;
  scryptLogN: number;
  signupEnabled: boolean;
  /** False = people sign in with their password (or Google) only, no authenticator code. Default true. */
  mfaRequired: boolean;
  signupDailyLimit: number;
  /** Minimum time (ms) of every registration answer. */
  signupMinMs: number;
  supportEmail: string;
  privacyEmail: string;
  runWorker: boolean;
  demoMode: boolean;
  /** Development tunnels only: through a proxy, only the portal webhook receiver and the health check answer. */
  tunnelHooksOnly: boolean;
  /** Development and test only: organisations without portal credentials use an in memory portal and nothing is sent. */
  portalFake: boolean;
  allowNoScanner: boolean;
  auditRetentionMonths: number;
  webDist: string;
  logLevel: string;
  cookieName: string;
  oidc: {
    /** Client id and secret are both set. */
    googleEnabled: boolean;
    googleClientId?: string;
    googleClientSecret?: string;
    allowedDomain?: string;
    discoveryUrl: string;
  };
}

const TRUST_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * TRUST_PROXY: `false` (default), `true` (trust every hop, only behind a proxy that overwrites the header), a number of hops,
 * or a comma separated list of proxy addresses, CIDR ranges and the names `loopback`, `linklocal` and `uniquelocal`
 * (for example `loopback` for a tunnel on the same computer, or `loopback, 172.29.10.2`). Anything else is a mistake and
 * stops the server from starting, so a typo can never silently leave every request looking like it comes from the proxy.
 */
export function parseTrustProxy(raw: string): boolean | number | string | { problem: string } {
  const v = raw.trim();
  const low = v.toLowerCase();
  if (low === 'true') return true;
  if (low === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) return Number(v);
  const parts = v.split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return false;
  for (const p of parts) {
    if (TRUST_NAMES.has(p.toLowerCase())) continue;
    const [addr, mask, extra] = p.split('/');
    const fam = isIP(addr ?? '');
    const maxMask = fam === 4 ? 32 : 128;
    const okMask = mask === undefined || (/^\d{1,3}$/.test(mask) && Number(mask) <= maxMask);
    if (!fam || extra !== undefined || !okMask) {
      return { problem: 'TRUST_PROXY must be true, false, a number of hops, or a comma separated list of IP addresses, CIDR ranges and the names loopback, linklocal and uniquelocal' };
    }
  }
  return parts.map((p) => (TRUST_NAMES.has(p.toLowerCase()) ? p.toLowerCase() : p)).join(',');
}

export function parseConfig(source: Record<string, string | undefined>): Config {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && v !== '') raw[k] = v;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const problems: string[] = [];

  let masterKeys: Record<string, Buffer> = {};
  try {
    const obj = JSON.parse(e.MASTER_KEYS) as Record<string, string>;
    for (const [id, b64] of Object.entries(obj)) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) problems.push(`MASTER_KEYS: invalid key id "${id}"`);
      const buf = Buffer.from(b64, 'base64');
      if (buf.length !== 32) problems.push(`MASTER_KEYS: key "${id}" must be 32 bytes in base64`);
      masterKeys[id] = buf;
    }
  } catch {
    problems.push('MASTER_KEYS must be a JSON object of key id to 32 byte base64 key');
    masterKeys = {};
  }
  if (!masterKeys[e.ACTIVE_KEY_ID]) problems.push('ACTIVE_KEY_ID is not present in MASTER_KEYS');
  if (!masterKeys[e.BLIND_INDEX_KEY_ID]) problems.push('BLIND_INDEX_KEY_ID is not present in MASTER_KEYS');
  if (e.HASH_KEY_ID && !masterKeys[e.HASH_KEY_ID]) problems.push('HASH_KEY_ID is not present in MASTER_KEYS');

  const storageDriver = e.FILE_STORAGE_DRIVER ?? e.STORAGE_DRIVER;
  const isProd = e.NODE_ENV === 'production';
  if (isProd) {
    if (!e.PUBLIC_URL.startsWith('https://')) problems.push('PUBLIC_URL must be https in production');
    if (e.DEMO_MODE) problems.push('DEMO_MODE must be off in production');
    if (e.TUNNEL_HOOKS_ONLY) problems.push('TUNNEL_HOOKS_ONLY is for development tunnels and must be off in production');
    if (e.PORTAL_FAKE) problems.push('PORTAL_FAKE must be off in production');
    if (e.SCANNER === 'none' && !e.ALLOW_NO_SCANNER) problems.push('A malware scanner is required in production (SCANNER=clamav) unless ALLOW_NO_SCANNER=true');
    if (!e.SMTP_URL) problems.push('SMTP_URL is required in production');
    if (storageDriver === 's3' && (!e.S3_BUCKET || !e.S3_ENDPOINT)) problems.push('S3_BUCKET and S3_ENDPOINT are required for the s3 storage driver');
    if (e.SIGNUP_ENABLED && !raw.PRIVACY_EMAIL) problems.push('PRIVACY_EMAIL is required in production when SIGNUP_ENABLED is on');
    if (e.SIGNUP_ENABLED && e.SIGNUP_MIN_MS < 600) problems.push('SIGNUP_MIN_MS must be at least 600 in production');
    if (e.SCRYPT_LOG_N < 15) problems.push('SCRYPT_LOG_N must be at least 15 in production');
  }
  const oidcId = e.OIDC_GOOGLE_CLIENT_ID?.trim();
  const oidcSecret = e.OIDC_GOOGLE_CLIENT_SECRET?.trim();
  const oidcDomain = e.OIDC_ALLOWED_DOMAIN?.trim().toLowerCase().replace(/^@/, '');
  if (!!oidcId !== !!oidcSecret) problems.push('OIDC_GOOGLE_CLIENT_ID and OIDC_GOOGLE_CLIENT_SECRET must be set together');
  if (oidcId && oidcSecret && !oidcDomain) problems.push('OIDC_ALLOWED_DOMAIN is required when Google sign in is configured');
  if (oidcDomain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(oidcDomain)) problems.push('OIDC_ALLOWED_DOMAIN must be a domain name such as example.com');
  if (isProd && oidcId && !e.OIDC_GOOGLE_DISCOVERY_URL.startsWith('https://')) problems.push('OIDC_GOOGLE_DISCOVERY_URL must be https in production');
  if (e.OIDC_REQUIRE_LOCAL_MFA !== undefined && !['true', '1', 'yes', 'on'].includes(e.OIDC_REQUIRE_LOCAL_MFA.trim().toLowerCase())) {
    problems.push('OIDC_REQUIRE_LOCAL_MFA cannot be turned off: two factor sign in is required for everyone. Remove the variable or set it to true.');
  }
  if (new URL(e.DATABASE_URL).password.length < 16) problems.push('The database password in DATABASE_URL must be at least 16 characters');
  if (problems.length) throw new Error(`Invalid configuration:\n${problems.map((p) => '  ' + p).join('\n')}`);

  const trust = parseTrustProxy(e.TRUST_PROXY);
  if (typeof trust === 'object') throw new Error(`Invalid configuration:\n  ${trust.problem}`);
  const trustProxy: boolean | number | string = trust;

  return {
    env: e.NODE_ENV,
    isProd,
    host: e.HOST,
    port: e.PORT,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ''),
    trustProxy,
    databaseUrl: e.DATABASE_URL,
    databaseOwnerUrl: e.DATABASE_OWNER_URL,
    masterKeys,
    activeKeyId: e.ACTIVE_KEY_ID,
    blindIndexKeyId: e.BLIND_INDEX_KEY_ID,
    hashKeyId: e.HASH_KEY_ID ?? e.BLIND_INDEX_KEY_ID,
    storageDriver,
    storageDir: path.resolve(e.STORAGE_DIR),
    s3: { endpoint: e.S3_ENDPOINT, bucket: e.S3_BUCKET, region: e.S3_REGION, accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY, forcePathStyle: e.S3_FORCE_PATH_STYLE },
    scanner: e.SCANNER,
    clamav: { host: e.CLAMAV_HOST, port: e.CLAMAV_PORT },
    smtpUrl: e.SMTP_URL,
    mailFrom: e.MAIL_FROM,
    sessionIdleMinutes: e.SESSION_IDLE_MINUTES,
    sessionMaxHours: e.SESSION_MAX_HOURS,
    stepUpMinutes: e.STEP_UP_MINUTES,
    scryptLogN: e.SCRYPT_LOG_N,
    signupEnabled: e.SIGNUP_ENABLED,
    mfaRequired: e.MFA_REQUIRED,
    signupDailyLimit: e.SIGNUP_DAILY_LIMIT,
    signupMinMs: e.SIGNUP_MIN_MS,
    supportEmail: e.SUPPORT_EMAIL,
    privacyEmail: e.PRIVACY_EMAIL,
    runWorker: e.RUN_WORKER,
    demoMode: e.DEMO_MODE,
    tunnelHooksOnly: e.TUNNEL_HOOKS_ONLY,
    portalFake: e.PORTAL_FAKE,
    allowNoScanner: e.ALLOW_NO_SCANNER,
    auditRetentionMonths: e.AUDIT_RETENTION_MONTHS,
    webDist: path.resolve(e.WEB_DIST),
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    cookieName: isProd ? '__Host-kph_session' : 'kph_session',
    oidc: {
      googleEnabled: !!(oidcId && oidcSecret && oidcDomain),
      googleClientId: oidcId || undefined,
      googleClientSecret: oidcSecret || undefined,
      allowedDomain: oidcDomain || undefined,
      discoveryUrl: e.OIDC_GOOGLE_DISCOVERY_URL,
    },
  };
}

function load(): Config {
  // server/.env is loaded only in development and never overrides real environment variables.
  if ((process.env.NODE_ENV ?? 'development') === 'development') {
    const f = path.join(SERVER_ROOT, '.env');
    if (existsSync(f)) process.loadEnvFile(f);
  }
  return parseConfig(process.env);
}

export const config: Config = load();
