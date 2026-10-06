import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Eye, FileText, Film, Image as ImageIcon, Paperclip, X } from 'lucide-react';
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

/** Files chosen but not yet uploaded, with local previews for photos. Nothing leaves the browser until the caller uploads. */
export function usePending(opts: PendingOptions) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const urls = useRef<Set<string>>(new Set());
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => () => { urls.current.forEach((u) => URL.revokeObjectURL(u)); urls.current.clear(); }, []);

  const add = useCallback((files: FileList | File[]) => {
    const o = optsRef.current;
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
        if (kind === 'image') { previewUrl = URL.createObjectURL(file); urls.current.add(previewUrl); }
        next.push({ key, file, kind, previewUrl });
      }
      return next;
    });
    setProblems([...new Set(msgs)]);
  }, []);

  const remove = useCallback((key: string) => {
    setPending((prev) => {
      const gone = prev.find((p) => p.key === key);
      if (gone?.previewUrl) { URL.revokeObjectURL(gone.previewUrl); urls.current.delete(gone.previewUrl); }
      return prev.filter((p) => p.key !== key);
    });
  }, []);

  const clear = useCallback(() => {
    urls.current.forEach((u) => URL.revokeObjectURL(u));
    urls.current.clear();
    setPending([]);
    setProblems([]);
  }, []);

  return { pending, problems, add, remove, clear };
}

/** Upload chosen files to a claim or shipment. Resolves when every file has finished or failed. */
export async function uploadPending(target: UploadTarget, pending: Pending[], onFile: (key: string, s: FileStatus) => void, timeoutMs = 3 * 60_000): Promise<boolean> {
  const specs: UploadSpec[] = pending.map((p) => ({ key: p.key, name: p.file.name, source: blobSource(p.file), arch: null, step: null, template: false }));
  const res = await uploadCaseFiles(target, specs, { onFile, timeoutMs });
  return res.ok;
}

function KindIcon({ kind }: { kind: MediaKind }) {
  const Icon = kind === 'video' ? Film : kind === 'image' ? ImageIcon : FileText;
  return <Icon size={22} aria-hidden="true" />;
}

const PHASE_TEXT: Record<string, string> = { queued: 'Waiting', uploading: 'Uploading', processing: 'Checking', ready: 'Done', rejected: 'Not accepted', error: 'Failed' };

export function AttachmentPicker({ pending, problems, status, onAdd, onRemove, busy, accept, label, hint }: {
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
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const total = pending.length;
  const overall = useMemo(() => {
    if (!total) return 0;
    let sum = 0;
    for (const p of pending) {
      const s = status[p.key];
      if (!s) continue;
      sum += s.phase === 'ready' || s.phase === 'processing' || s.phase === 'rejected' ? 1 : s.total ? s.sent / s.total : 0;
    }
    return sum / total;
  }, [pending, status, total]);

  return (
    <div className="stack-sm">
      <div
        className={`dropzone dropzone-compact${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy && e.dataTransfer.files.length) onAdd(e.dataTransfer.files); }}
      >
        <Paperclip size={26} aria-hidden="true" />
        <p><strong>{label}</strong></p>
        <p className="muted small">{hint}</p>
        <input ref={input} type="file" hidden multiple accept={accept} aria-label={label} onChange={(e) => { if (e.target.files?.length) onAdd(e.target.files); e.target.value = ''; }} />
        <Button disabled={busy} onClick={() => input.current?.click()}>Choose files</Button>
      </div>
      {problems.map((p) => <p key={p} className="field-error">{p}</p>)}
      {pending.length ? (
        <>
          <ul className="attach-list">
            {pending.map((p) => {
              const s = status[p.key];
              return (
                <li key={p.key} className="attach-item">
                  <span className="attach-thumb">
                    {p.previewUrl ? <img src={p.previewUrl} alt="" /> : <KindIcon kind={p.kind} />}
                  </span>
                  <span className="attach-meta">
                    <span className="attach-name">{p.file.name}</span>
                    <span className="muted small">{formatBytes(p.file.size)}</span>
                    {s ? (
                      <>
                        <ProgressBar label={`Progress for ${p.file.name}`} value={s.phase === 'ready' || s.phase === 'processing' ? 1 : s.total ? s.sent / s.total : 0} />
                        <span className={`small${s.phase === 'error' || s.phase === 'rejected' ? ' field-error' : ' muted'}`}>{s.error ?? PHASE_TEXT[s.phase] ?? ''}</span>
                      </>
                    ) : null}
                  </span>
                  {!busy && !s ? <button type="button" className="icon-btn" aria-label={`Remove ${p.file.name}`} onClick={() => onRemove(p.key)}><X size={18} aria-hidden="true" /></button> : null}
                </li>
              );
            })}
          </ul>
          {busy ? <div aria-live="polite"><ProgressBar label="Upload progress" value={overall} /><p className="small muted">Uploading {formatNumber(total)} {total === 1 ? 'file' : 'files'}. Keep this page open.</p></div> : null}
        </>
      ) : null}
    </div>
  );
}

/** Evidence files of a claim. Files are named by type, never by their own file name, and only loaded when opened. */
export function EvidenceGallery({ files }: { files: CaseFile[] }) {
  const { can } = useAuth();
  const [open, setOpen] = useState<{ file: CaseFile; label: string; kind: MediaKind } | null>(null);
  const counts: Record<string, number> = {};
  const rows = files.map((f) => {
    const kind = mediaKind(f.ext || extOf(f.name ?? ''));
    counts[kind] = (counts[kind] ?? 0) + 1;
    const noun = kind === 'image' ? 'Photo' : kind === 'video' ? 'Video' : kind === 'pdf' ? 'Document' : 'File';
    return { f, kind, label: `${noun} ${counts[kind]}` };
  });
  if (!rows.length) return <p className="muted">No photos or videos yet.</p>;
  return (
    <>
      <ul className="attach-list">
        {rows.map(({ f, kind, label }) => (
          <li key={f.id} className="attach-item">
            <span className="attach-thumb"><KindIcon kind={kind} /></span>
            <span className="attach-meta">
              <span className="attach-name">{label}</span>
              <span className="muted small">{formatBytes(f.size)}</span>
            </span>
            <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              {f.state !== 'ready' ? <Badge tone={f.state === 'rejected' ? 'bad' : 'info'}>{f.state === 'rejected' ? 'Rejected' : 'Checking'}</Badge> : null}
              {f.state === 'ready' && (kind === 'image' || kind === 'video') ? (
                <Button size="sm" onClick={() => setOpen({ file: f, label, kind })} aria-label={`View ${label}`}><Eye size={14} aria-hidden="true" /> View</Button>
              ) : null}
              {f.state === 'ready' && can('file.download') ? <a className="btn btn-sm" href={`/api/files/${f.id}/download`} aria-label={`Download ${label}`}><Download size={14} aria-hidden="true" /></a> : null}
            </span>
          </li>
        ))}
      </ul>
      <Dialog open={!!open} title={open?.label ?? 'Evidence'} onClose={() => setOpen(null)} wide footer={<Button onClick={() => setOpen(null)}>Close</Button>}>
        {open?.kind === 'image' ? <img className="evidence-media" src={`/api/files/${open.file.id}/content`} alt={`${open.label}, shown large`} /> : null}
        {open?.kind === 'video' ? (
          <video className="evidence-media" controls preload="metadata" src={`/api/files/${open.file.id}/content`} aria-label={open.label}>
            Your browser cannot play this video. Download it instead.
          </video>
        ) : null}
        <p className="small muted">Opening evidence is recorded in the access log.</p>
      </Dialog>
    </>
  );
}
