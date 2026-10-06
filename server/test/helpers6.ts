import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { createApiKey } from '../src/auth/apikeys';
import { SYSTEM, tx } from '../src/db';

let ipCounter = 1;

export const q = <T = any>(sql: string, params: unknown[] = []) => tx(SYSTEM, async (c) => (await c.query(sql, params)).rows as T[]);

export interface ApiResult {
  status: number;
  json: any;
  headers: Record<string, any>;
  text: string;
}

/** Calls the app with a Bearer key (or none) and optional cookie, from a fresh address unless one is given. */
export async function api(app: FastifyInstance, key: string | null, method: string, url: string, body?: unknown, opts: { cookie?: string; ip?: string; headers?: Record<string, string> } = {}): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await app.inject({ method: method as any, url, payload: body as any, headers, remoteAddress: opts.ip ?? `10.6.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}` });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.statusCode, json, headers: res.headers as Record<string, any>, text: res.body };
}

/** Creates a partner key directly (no step up needed). */
export async function mkKey(orgId: string, scopes: string[], extra: { cidrs?: string[]; expiresInDays?: number; name?: string } = {}): Promise<{ id: string; key: string; prefix: string }> {
  const k = await tx({ orgId, bypass: false }, (c) =>
    createApiKey(c, { orgId, orgKind: 'partner', name: extra.name ?? 'phase 6 test', scopes, cidrs: extra.cidrs, expiresInDays: extra.expiresInDays ?? 30 }),
  );
  return { id: k.id, key: k.key, prefix: k.prefix };
}

// ---------------------------------------------------------------------------
// A local web server that plays the partner's endpoint
// ---------------------------------------------------------------------------
export interface Hit {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface Receiver {
  url: string;
  port: number;
  hits: Hit[];
  /** What the next requests get. */
  mode: { status: number; redirectTo?: string; delayMs?: number };
  close(): Promise<void>;
}

export async function startReceiver(): Promise<Receiver> {
  const hits: Hit[] = [];
  const r: Receiver = { url: '', port: 0, hits, mode: { status: 200 }, close: async () => {} };
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', async () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(parts).toString('utf8') });
      if (r.mode.delayMs) await new Promise((x) => setTimeout(x, r.mode.delayMs));
      if (r.mode.redirectTo) {
        res.statusCode = 302;
        res.setHeader('location', r.mode.redirectTo);
        res.end('moved');
        return;
      }
      res.statusCode = r.mode.status;
      res.end('thanks, this answer is never stored');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  r.port = (server.address() as AddressInfo).port;
  r.url = `http://127.0.0.1:${r.port}/hook`;
  r.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return r;
}

/** Minimal RFC 4180 parser for the CSV exports. Strips the byte order mark. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && s[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function csvObjects(text: string): Record<string, string>[] {
  const [head, ...rest] = parseCsv(text);
  return rest.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ''])));
}
