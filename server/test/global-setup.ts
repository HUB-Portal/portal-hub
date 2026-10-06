import pg from 'pg';
import { migrate } from '../src/db/migrate';
import { testUrls } from './testdb';

export default async function setup(): Promise<void> {
  const u = testUrls();
  const admin = new pg.Client({ connectionString: u.adminUrl });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE IF EXISTS kph_test WITH (FORCE)');
    await admin.query('CREATE DATABASE kph_test');
  } finally {
    await admin.end();
  }
  await migrate({ ownerUrl: u.ownerUrl, appUrl: u.appUrl });
}
