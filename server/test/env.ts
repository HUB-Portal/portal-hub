// Runs before every test file: sets the environment the server config reads.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testUrls } from './testdb';

const u = testUrls();
const key = (n: number) => Buffer.alloc(32, n).toString('base64');

const dist = mkdtempSync(path.join(tmpdir(), 'kph-web-'));
mkdirSync(path.join(dist, 'assets'));
writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>Test app</title></head><body><div id="root">KPH-TEST-INDEX</div></body></html>');
writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log("ok")');

const storageDir = mkdtempSync(path.join(tmpdir(), 'kph-files-'));

Object.assign(process.env, {
  STORAGE_DIR: storageDir,
  NODE_ENV: 'test',
  DATABASE_URL: u.appUrl,
  DATABASE_OWNER_URL: u.ownerUrl,
  MASTER_KEYS: JSON.stringify({ k1: key(1), k2: key(2), b1: key(3) }),
  ACTIVE_KEY_ID: 'k1',
  BLIND_INDEX_KEY_ID: 'b1',
  SCRYPT_LOG_N: '10',
  MFA_REQUIRED: process.env.MFA_REQUIRED ?? 'true',
  DEMO_MODE: 'true',
  PORTAL_FAKE: 'true',
  SCANNER: 'none',
  ALLOW_NO_SCANNER: 'true',
  RUN_WORKER: 'false',
  SIGNUP_ENABLED: 'true',
  SIGNUP_MIN_MS: '20',
  SUPPORT_EMAIL: 'support@hub.test',
  PRIVACY_EMAIL: 'privacy@hub.test',
  WEB_DIST: dist,
  PUBLIC_URL: 'http://localhost:4000',
  LOG_LEVEL: 'info',
});
