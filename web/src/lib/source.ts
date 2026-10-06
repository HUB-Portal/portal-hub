// A file source hands out data in ordered chunks. Files use slices; zip entries are inflated lazily as they are read.

export interface Chunk { idx: number; data: Uint8Array }

export interface FileSource {
  size: number;
  /** Yields chunks of `chunkSize` bytes in order (the last one may be shorter), skipping the indexes in `skip`. */
  chunks(chunkSize: number, skip?: ReadonlySet<number>): AsyncGenerator<Chunk>;
}

export function blobSource(blob: Blob): FileSource {
  return {
    size: blob.size,
    async *chunks(chunkSize, skip) {
      const count = Math.max(1, Math.ceil(blob.size / chunkSize));
      for (let idx = 0; idx < count; idx++) {
        if (skip?.has(idx)) continue;
        const data = new Uint8Array(await blob.slice(idx * chunkSize, Math.min(blob.size, (idx + 1) * chunkSize)).arrayBuffer());
        yield { idx, data };
      }
    },
  };
}

/** Read a whole source into memory. Only for small files such as instructions. */
export async function readAll(src: FileSource, maxBytes = 16 * 1024 * 1024): Promise<Uint8Array> {
  if (src.size > maxBytes) throw new Error('File is too large to read here.');
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const c of src.chunks(4 * 1024 * 1024)) { parts.push(c.data); total += c.data.length; }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface SourceFile {
  /** Path relative to the dropped item, using "/". */
  path: string;
  size: number;
  source: FileSource;
}
