import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Download, Eye, FileText, Film, Image as ImageIcon, Paperclip, X } from 'lucide-solid';
import { useAuth } from '../lib/auth';
import { formatBytes, formatNumber } from '../lib/format';
import { extOf, mediaKind, type MediaKind } from '../lib/quality';
import { blobSource } from '../lib/source';
import type { CaseFile } from '../lib/types';
import { uploadCaseFiles, type FileStatus, type UploadSpec, type UploadTarget } from '../lib/upload';
import { Badge, Button, Dialog, ProgressBar } from './Common';

export interface Pending { key: string; file: File; kind: MediaKind; previewUrl: string | null }

interface PendingOptions {
  exts: string[];
  maxFiles: number;
  /** Number of files that already exist (counts towards the limit). */
  existing?: number;
  maxBytes: (ext: string) => number;
}

/**
 * Files chosen but not yet uploaded, with local previews for photos. Nothing leaves the browser until the caller uploads.
 * `opts` may be an object or a function returning one (read when files are added, so it can follow signals).
 * The result has the getters `pending` and `problems`: read them inside JSX or an effect, and do not destructure the result.
 */
export function usePending(opts: PendingOptions | (() => PendingOptions)) {
  const [pending, setPending] = createSignal<Pending[]>([]);
  const [problems, setProblems] = createSignal<string[]>([]);
  const urls = new Set<string>();

  onCleanup(() => { urls.forEach((u) => URL.revokeObjectURL(u)); urls.clear(); });

  const add = (files: FileList | File[]) => {
    const o = typeof opts === 'function' ? opts() : opts;
    const msgs: string[] = [];
    setPending((prev) => {
      const next = [...prev];
      for (const file of Array.from(files)) {
        const ext = extOf(file.name);
        if (!o.exts.includes(ext)) { msgs.push('One file was skipped because its type is not accepted.'); continue; }
        if (file.size === 0) { msgs.push('One empty file was skipped.'); continue; }
        if (file.size > o.maxBytes(ext)) { msgs.push(`One file was skipped because it is larger than ${formatBytes(o.maxBytes(ext))}.`); continue; }
        if ((o.existing ?? 0) + next.length >= o.maxFiles) { msgs.push(`You can attach at most ${formatNumber(o.maxFiles)} files.`); break; }
        const key = `${file.name}|${file.size}|${file.lastModified}`;
        if (next.some((p) => p.key === key)) continue;
        const kind = mediaKind(ext);
        let previewUrl: string | null = null;
        if (kind === 'image') { previewUrl = URL.createObjectURL(file); urls.add(previewUrl); }
        next.push({ key, file, kind, previewUrl });
      }
      return next;
    });
    setProblems([...new Set(msgs)]);
  };

  const remove = (key: string) => {
    setPending((prev) => {
      const gone = prev.find((p) => p.key === key);
      if (gone?.previewUrl) { URL.revokeObjectURL(gone.previewUrl); urls.delete(gone.previewUrl); }
      return prev.filter((p) => p.key !== key);
    });
  };

  const clear = () => {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls.clear();
    setPending([]);
    setProblems([]);
  };

  return {
    get pending() { return pending(); },
    get problems() { return problems(); },
    add, remove, clear,
  };
}

/** Upload chosen files to a claim or shipment. Resolves when every file has finished or failed. */
export async function uploadPending(target: UploadTarget, pending: Pending[], onFile: (key: string, s: FileStatus) => void, timeoutMs = 3 * 60_000): Promise<boolean> {
  const specs: UploadSpec[] = pending.map((p) => ({ key: p.key, name: p.file.name, source: blobSource(p.file), arch: null, step: null, template: false }));
  const res = await uploadCaseFiles(target, specs, { onFile, timeoutMs });
  return res.ok;
}

function KindIcon(props: { kind: MediaKind }) {
  const Icon = () => (props.kind === 'video' ? Film : props.kind === 'image' ? ImageIcon : FileText);
  return <Dynamic component={Icon()} size={22} aria-hidden="true" />;
}

const PHASE_TEXT: Record<string, string> = { queued: 'Waiting', uploading: 'Uploading', processing: 'Checking', ready: 'Done', rejected: 'Not accepted', error: 'Failed' };

export function AttachmentPicker(props: {
  pending: Pending[];
  problems: string[];
  status: Record<string, FileStatus>;
  onAdd: (f: FileList) => void;
  onRemove: (key: string) => void;
  busy?: boolean;
  accept: string;
  label: string;
  hint: string;
}) {
  let input!: HTMLInputElement;
  const [over, setOver] = createSignal(false);
  const total = () => props.pending.length;
  const overall = createMemo(() => {
    if (!total()) return 0;
    let sum = 0;
    for (const p of props.pending) {
      const s = props.status[p.key];
      if (!s) continue;
      sum += s.phase === 'ready' || s.phase === 'processing' || s.phase === 'rejected' ? 1 : s.total ? s.sent / s.total : 0;
    }
    return sum / total();
  });

  return (
    <div class="stack-sm">
      <div
        class={`dropzone dropzone-compact${over() ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!props.busy && e.dataTransfer && e.dataTransfer.files.length) props.onAdd(e.dataTransfer.files); }}
      >
        <Paperclip size={26} aria-hidden="true" />
        <p><strong>{props.label}</strong></p>
        <p class="muted small">{props.hint}</p>
        <input ref={input} type="file" hidden multiple accept={props.accept} aria-label={props.label} onChange={(e) => { if (e.currentTarget.files?.length) props.onAdd(e.currentTarget.files); e.currentTarget.value = ''; }} />
        <Button disabled={props.busy} onClick={() => input.click()}>Choose files</Button>
      </div>
      <For each={props.problems}>{(p) => <p class="field-error">{p}</p>}</For>
      <Show when={props.pending.length}>
        <ul class="attach-list">
          <For each={props.pending}>
            {(p) => {
              const s = () => props.status[p.key];
              return (
                <li class="attach-item">
                  <span class="attach-thumb">
                    {p.previewUrl ? <img src={p.previewUrl} alt="" /> : <KindIcon kind={p.kind} />}
                  </span>
                  <span class="attach-meta">
                    <span class="attach-name">{p.file.name}</span>
                    <span class="muted small">{formatBytes(p.file.size)}</span>
                    <Show when={s()}>
                      {(st) => (
                        <>
                          <ProgressBar label={`Progress for ${p.file.name}`} value={st().phase === 'ready' || st().phase === 'processing' ? 1 : st().total ? st().sent / st().total : 0} />
                          <span class={`small${st().phase === 'error' || st().phase === 'rejected' ? ' field-error' : ' muted'}`}>{st().error ?? PHASE_TEXT[st().phase] ?? ''}</span>
                        </>
                      )}
                    </Show>
                  </span>
                  <Show when={!props.busy && !s()}>
                    <button type="button" class="icon-btn" aria-label={`Remove ${p.file.name}`} onClick={() => props.onRemove(p.key)}><X size={18} aria-hidden="true" /></button>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
        <Show when={props.busy}>
          <div aria-live="polite"><ProgressBar label="Upload progress" value={overall()} /><p class="small muted">Uploading {formatNumber(total())} {total() === 1 ? 'file' : 'files'}. Keep this page open.</p></div>
        </Show>
      </Show>
    </div>
  );
}

/** Evidence files of a claim. Files are named by type, never by their own file name, and only loaded when opened. */
export function EvidenceGallery(props: { files: CaseFile[] }) {
  const { can } = useAuth();
  const [open, setOpen] = createSignal<{ file: CaseFile; label: string; kind: MediaKind } | null>(null);
  const rows = createMemo(() => {
    const counts: Record<string, number> = {};
    return props.files.map((f) => {
      const kind = mediaKind(f.ext || extOf(f.name ?? ''));
      counts[kind] = (counts[kind] ?? 0) + 1;
      const noun = kind === 'image' ? 'Photo' : kind === 'video' ? 'Video' : kind === 'pdf' ? 'Document' : 'File';
      return { f, kind, label: `${noun} ${counts[kind]}` };
    });
  });
  return (
    <Show when={rows().length} fallback={<p class="muted">No photos or videos yet.</p>}>
      <ul class="attach-list">
        <For each={rows()}>
          {(r) => (
            <li class="attach-item">
              <span class="attach-thumb"><KindIcon kind={r.kind} /></span>
              <span class="attach-meta">
                <span class="attach-name">{r.label}</span>
                <span class="muted small">{formatBytes(r.f.size)}</span>
              </span>
              <span class="row" style={{ gap: '6px', 'flex-wrap': 'nowrap' }}>
                <Show when={r.f.state !== 'ready'}><Badge tone={r.f.state === 'rejected' ? 'bad' : 'info'}>{r.f.state === 'rejected' ? 'Rejected' : 'Checking'}</Badge></Show>
                <Show when={r.f.state === 'ready' && (r.kind === 'image' || r.kind === 'video')}>
                  <Button size="sm" onClick={() => setOpen({ file: r.f, label: r.label, kind: r.kind })} aria-label={`View ${r.label}`}><Eye size={14} aria-hidden="true" /> View</Button>
                </Show>
                <Show when={r.f.state === 'ready' && can('file.download')}><a class="btn btn-sm" href={`/api/files/${r.f.id}/download`} aria-label={`Download ${r.label}`}><Download size={14} aria-hidden="true" /></a></Show>
              </span>
            </li>
          )}
        </For>
      </ul>
      <Dialog open={!!open()} title={open()?.label ?? 'Evidence'} onClose={() => setOpen(null)} wide footer={<Button onClick={() => setOpen(null)}>Close</Button>}>
        <Show when={open()}>
          {(o) => (
            <>
              <Show when={o().kind === 'image'}><img class="evidence-media" src={`/api/files/${o().file.id}/content`} alt={`${o().label}, shown large`} /></Show>
              <Show when={o().kind === 'video'}>
                <video class="evidence-media" controls preload="metadata" src={`/api/files/${o().file.id}/content`} aria-label={o().label}>
                  Your browser cannot play this video. Download it instead.
                </video>
              </Show>
            </>
          )}
        </Show>
        <p class="small muted">Opening evidence is recorded in the access log.</p>
      </Dialog>
    </Show>
  );
}
