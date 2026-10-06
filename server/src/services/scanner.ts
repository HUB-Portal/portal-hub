import net from 'node:net';
import { config } from '../config';

export type ScanStatus = 'clean' | 'infected' | 'error' | 'skipped';

export interface ScanResult {
  status: ScanStatus;
  /** Signature name when infected. Never contains patient data. */
  signature?: string;
  /** Short reason when status is error. */
  reason?: string;
}

export interface Scanner {
  readonly driver: 'clamav' | 'none';
  scan(chunks: AsyncIterable<Buffer>): Promise<ScanResult>;
  /** True when the scanner is reachable (used by health checks and tests). */
  ping(): Promise<boolean>;
}

/** Development driver: nothing is scanned. Production refuses to start with it unless ALLOW_NO_SCANNER is set. */
export class NoScanner implements Scanner {
  readonly driver = 'none' as const;
  async scan(chunks: AsyncIterable<Buffer>): Promise<ScanResult> {
    for await (const _ of chunks) void _; // drain so upstream hashing and decryption still run
    return { status: 'skipped' };
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

export interface ClamdOptions {
  host: string;
  port: number;
  /** No data for this long aborts the scan. */
  timeoutMs?: number;
  connectTimeoutMs?: number;
}

/** ClamAV clamd over TCP using the INSTREAM command. */
export class ClamdScanner implements Scanner {
  readonly driver = 'clamav' as const;
  constructor(private opts: ClamdOptions) {}

  private connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: this.opts.host, port: this.opts.port });
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error('scanner_connect_timeout'));
      }, this.opts.connectTimeoutMs ?? 10_000);
      s.once('connect', () => {
        clearTimeout(t);
        s.setTimeout(this.opts.timeoutMs ?? 120_000);
        resolve(s);
      });
      s.once('error', () => {
        clearTimeout(t);
        reject(new Error('scanner_unreachable'));
      });
    });
  }

  async ping(): Promise<boolean> {
    let s: net.Socket | undefined;
    try {
      s = await this.connect();
      const reply = await this.command(s, 'zPING\0');
      return reply.trim() === 'PONG';
    } catch {
      return false;
    } finally {
      s?.destroy();
    }
  }

  private command(s: net.Socket, cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      s.on('data', (d) => {
        parts.push(d);
        const all = Buffer.concat(parts);
        if (all.includes(0)) resolve(all.subarray(0, all.indexOf(0)).toString('utf8'));
      });
      s.once('end', () => resolve(Buffer.concat(parts).toString('utf8').replace(/\0/g, '')));
      s.once('timeout', () => reject(new Error('scanner_timeout')));
      s.once('error', () => reject(new Error('scanner_unreachable')));
      s.write(cmd);
    });
  }

  async scan(chunks: AsyncIterable<Buffer>): Promise<ScanResult> {
    let s: net.Socket;
    try {
      s = await this.connect();
    } catch (e) {
      return { status: 'error', reason: (e as Error).message };
    }
    try {
      const reply = new Promise<string>((resolve, reject) => {
        const parts: Buffer[] = [];
        s.on('data', (d) => {
          parts.push(d);
          const all = Buffer.concat(parts);
          if (all.includes(0)) resolve(all.subarray(0, all.indexOf(0)).toString('utf8'));
        });
        s.once('end', () => resolve(Buffer.concat(parts).toString('utf8').replace(/\0/g, '')));
        s.once('timeout', () => reject(new Error('scanner_timeout')));
        s.once('error', () => reject(new Error('scanner_unreachable')));
      });
      reply.catch(() => undefined); // handled below; avoids an unhandled rejection while we are still writing

      const write = (b: Buffer) =>
        new Promise<void>((resolve, reject) => {
          if (s.destroyed) return reject(new Error('scanner_unreachable'));
          s.write(b, (err) => (err ? reject(new Error('scanner_unreachable')) : resolve()));
        });

      await write(Buffer.from('zINSTREAM\0'));
      try {
        for await (const chunk of chunks) {
          const PIECE = 1024 * 1024;
          for (let off = 0; off < chunk.length; off += PIECE) {
            const piece = chunk.subarray(off, off + PIECE);
            const len = Buffer.alloc(4);
            len.writeUInt32BE(piece.length);
            await write(Buffer.concat([len, piece]));
          }
        }
        await write(Buffer.alloc(4)); // zero length terminates the stream
      } catch (e) {
        // clamd may have answered early (for example a size limit error) and closed the socket
        const early = await Promise.race([reply, new Promise<string>((r) => setTimeout(() => r(''), 200))]).catch(() => '');
        if (early) return parseClamReply(early);
        throw e;
      }
      return parseClamReply(await reply);
    } catch (e) {
      const msg = (e as Error).message;
      return { status: 'error', reason: /^scanner_/.test(msg) ? msg : 'scanner_failed' };
    } finally {
      s.destroy();
    }
  }
}

export function parseClamReply(reply: string): ScanResult {
  const r = reply.trim();
  if (/\bOK$/.test(r)) return { status: 'clean' };
  const found = /:\s*(.+?)\s+FOUND$/.exec(r);
  if (found) return { status: 'infected', signature: found[1]!.slice(0, 120) };
  if (/size limit exceeded/i.test(r)) return { status: 'error', reason: 'scanner_size_limit' };
  return { status: 'error', reason: 'scanner_error' };
}

let instance: Scanner | undefined;

export function createScanner(): Scanner {
  if (config.scanner === 'none') return new NoScanner();
  return new ClamdScanner({ host: config.clamav.host, port: config.clamav.port });
}
export function scanner(): Scanner {
  return (instance ??= createScanner());
}
/** Tests may swap the scanner. */
export function setScanner(s: Scanner | undefined): void {
  instance = s;
}
