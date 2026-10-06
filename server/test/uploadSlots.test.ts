import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { SYSTEM, closePools, tx } from '../src/db';
import { seedDemo } from '../src/demo/seed';
import { Client, cubeStl } from './helpers';

let app: FastifyInstance;
let up: Client;

const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);

beforeAll(async () => {
  await seedDemo({ force: true });
  app = await buildApp({ logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  await app.ready();
  up = await new Client(app).full('upload@acme.demo');
});

afterAll(async () => {
  await app.close();
  await closePools();
});

describe('files with the same name and size in different slots', () => {
  it('stores both Upper/Step 01.stl and Lower/Step 01.stl, and still resumes the same file', async () => {
    const created = await up.call('POST', '/api/cases', { caseId: 'SLOT-1' });
    expect(created.status).toBe(201);
    const caseId = created.json.case.id as string;
    const model = cubeStl(30); // the same bytes, so the same name and the same size

    const upper = await up.uploadFile(caseId, 'Step 01.stl', model, { arch: 'upper', step: 1 });
    const lower = await up.uploadFile(caseId, 'Step 01.stl', model, { arch: 'lower', step: 1 });
    expect(lower.fileId).not.toBe(upper.fileId);

    const rows = await q(`SELECT arch, step, state FROM files WHERE case_id = $1 AND kind = 'stl' ORDER BY arch`, [caseId]);
    expect(rows.map((r) => `${r.arch}:${r.step}:${r.state}`)).toEqual(['lower:1:ready', 'upper:1:ready']);

    // asking again for the same slot resumes the file that is already there
    const again = await up.call('POST', '/api/uploads', { purpose: 'case', caseId, name: 'Step 01.stl', size: model.length, arch: 'upper', step: 1 });
    expect(again.status).toBe(200);
    expect(again.json.fileId).toBe(upper.fileId);
    expect((await q(`SELECT count(*)::int AS n FROM files WHERE case_id = $1 AND kind = 'stl'`, [caseId]))[0].n).toBe(2);

    // a template is a separate slot as well
    const tmpl = await up.uploadFile(caseId, 'Step 01.stl', model, { arch: 'upper', step: 1, template: true });
    expect(tmpl.fileId).not.toBe(upper.fileId);
  });
});
