import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import path from 'node:path';

const DEFAULT_APP_PASSWORD = 'kph_test_app_password_local_only';

/**
 * Connection strings for the throw away test database (kph_test) on the docker Postgres.
 * The app role is cluster wide, so the password is taken from server/.env when present to avoid changing the dev password.
 */
export function testUrls() {
  const host = process.env.KPH_TEST_PG ?? 'localhost:5433';
  const ownerCreds = process.env.KPH_TEST_OWNER ?? 'kph_owner:kph_owner_dev_password';
  let appPassword = DEFAULT_APP_PASSWORD;
  const envFile = path.resolve(import.meta.dirname, '..', '.env');
  if (existsSync(envFile)) {
    try {
      const url = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL;
      if (url) appPassword = decodeURIComponent(new URL(url).password) || appPassword;
    } catch {
      /* fall back to default */
    }
  }
  return {
    adminUrl: `postgres://${ownerCreds}@${host}/postgres`,
    ownerUrl: `postgres://${ownerCreds}@${host}/kph_test`,
    appUrl: `postgres://kph_app:${encodeURIComponent(appPassword)}@${host}/kph_test`,
  };
}
