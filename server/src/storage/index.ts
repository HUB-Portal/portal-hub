import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { config } from '../config';

/**
 * Object storage for encrypted chunk objects. Keys are opaque (`f/<random>/<index>`): never patient data,
 * never original file names. Only ciphertext is ever stored here.
 */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Readable>;
  getBuffer(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Deletes every object whose key starts with `prefix` (which must end with "/"). */
  deletePrefix(prefix: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

const KEY_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

export function assertKey(key: string): void {
  if (!KEY_RE.test(key) || key.length > 200) throw new Error('Invalid storage key');
}
function assertPrefix(prefix: string): void {
  if (!prefix.endsWith('/') || !KEY_RE.test(prefix.slice(0, -1))) throw new Error('Invalid storage prefix');
}

/** New random storage prefix for a file: `f/<32 hex>`. */
export function newStoragePrefix(): string {
  return `f/${randomBytes(16).toString('hex')}`;
}
export const chunkKey = (prefix: string, idx: number): string => `${prefix}/${idx}`;

// ---------------------------------------------------------------------------
export class FsStorage implements Storage {
  constructor(private root: string) {
    this.root = path.resolve(root);
  }
  private file(key: string): string {
    assertKey(key);
    const p = path.resolve(this.root, ...key.split('/'));
    if (!p.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return p + '.bin';
  }
  async put(key: string, data: Buffer): Promise<void> {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, f);
  }
  async get(key: string): Promise<Readable> {
    return createReadStream(this.file(key));
  }
  async getBuffer(key: string): Promise<Buffer> {
    return readFile(this.file(key));
  }
  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
  async deletePrefix(prefix: string): Promise<void> {
    assertPrefix(prefix);
    const dir = path.resolve(this.root, ...prefix.slice(0, -1).split('/'));
    if (!dir.startsWith(this.root + path.sep)) throw new Error('Invalid storage prefix');
    await rm(dir, { recursive: true, force: true });
  }
  async exists(key: string): Promise<boolean> {
    try {
      await access(this.file(key));
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
/** Minimal shape of the S3 client we use, so tests can pass a fake. */
export interface S3Like {
  send(command: any): Promise<any>;
}

export class S3Storage implements Storage {
  private cmds: Promise<typeof import('@aws-sdk/client-s3')> | undefined;
  constructor(
    private client: S3Like,
    private bucket: string,
    private loadCommands: () => Promise<typeof import('@aws-sdk/client-s3')> = () => import('@aws-sdk/client-s3'),
  ) {}
  private c() {
    return (this.cmds ??= this.loadCommands());
  }
  async put(key: string, data: Buffer): Promise<void> {
    assertKey(key);
    const { PutObjectCommand } = await this.c();
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: 'application/octet-stream' }));
  }
  async get(key: string): Promise<Readable> {
    assertKey(key);
    const { GetObjectCommand } = await this.c();
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = r.Body;
    if (!body) throw new Error('Object not found');
    return body instanceof Readable ? body : Readable.fromWeb(body);
  }
  async getBuffer(key: string): Promise<Buffer> {
    const s = await this.get(key);
    const parts: Buffer[] = [];
    for await (const p of s) parts.push(Buffer.from(p));
    return Buffer.concat(parts);
  }
  async delete(key: string): Promise<void> {
    assertKey(key);
    const { DeleteObjectCommand } = await this.c();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async deletePrefix(prefix: string): Promise<void> {
    assertPrefix(prefix);
    const { ListObjectsV2Command, DeleteObjectsCommand } = await this.c();
    let token: string | undefined;
    do {
      const l = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys: { Key: string }[] = (l.Contents ?? []).map((o: any) => ({ Key: o.Key as string }));
      if (keys.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
      token = l.IsTruncated ? l.NextContinuationToken : undefined;
    } while (token);
  }
  async exists(key: string): Promise<boolean> {
    assertKey(key);
    const { HeadObjectCommand } = await this.c();
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
let instance: Storage | undefined;

export async function createStorage(cfg = config): Promise<Storage> {
  if (cfg.storageDriver === 's3') {
    const { S3Client } = await import('@aws-sdk/client-s3');
    if (!cfg.s3.bucket) throw new Error('S3_BUCKET is not configured');
    const client = new S3Client({
      region: cfg.s3.region,
      endpoint: cfg.s3.endpoint,
      forcePathStyle: cfg.s3.forcePathStyle,
      credentials: cfg.s3.accessKeyId && cfg.s3.secretAccessKey ? { accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey } : undefined,
    });
    return new S3Storage(client, cfg.s3.bucket);
  }
  return new FsStorage(cfg.storageDir);
}

/** Shared instance for the process. */
export async function storage(): Promise<Storage> {
  return (instance ??= await createStorage());
}
/** Tests may swap the driver. */
export function setStorage(s: Storage | undefined): void {
  instance = s;
}
