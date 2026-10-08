import { useCallback, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { parseFileName } from '@shared/filenames';
import { formatBytes, formatNumber } from '../lib/format';
import type { IntakeResult } from '../lib/intake';
import { useLeaveWarning } from '../lib/useLeaveWarning';
import { isUploadable, uploadCaseFiles, type FileStatus, type UploadSpec } from '../lib/upload';
import { Badge, Button, ProgressBar } from './Common';

export interface UploadEntry { spec: UploadSpec; status: FileStatus }

/**
 * Uploads files into an existing draft case, one list entry per file with its own progress (review of 8 Oct 2026, R2 and R5). The upload
 * resumes and retries by itself (see lib/upload). A file that still fails stays in the list as Failed with a Retry button, and a warning
 * stops the tab from being closed in the middle of an upload.
 */
export function useCaseUploader(caseId: string, onDone: () => void) {
  const [entries, setEntries] = useState<Record<string, UploadEntry>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [running, setRunning] = useState(0);
  const specs = useRef(new Map<string, UploadSpec>());

  const run = useCallback(async (list: UploadSpec[]) => {
    if (!list.length) return;
    setRunning((n) => n + 1);
    setEntries((prev) => {
      const next = { ...prev };
      for (const s of list) next[s.key] = { spec: s, status: { phase: 'queued', sent: 0, total: s.source.size } };
      return next;
    });
    try {
      await uploadCaseFiles(caseId, list, { onFile: (k, status) => setEntries((prev) => (prev[k] ? { ...prev, [k]: { ...prev[k]!, status } } : prev)) });
    } finally {
      setRunning((n) => n - 1);
      onDone();
    }
  }, [caseId, onDone]);

  /** Reads what was dropped or picked and starts uploading it right away. Every call adds to the list. */
  const add = useCallback(async (read: Promise<IntakeResult>) => {
    const r = await read;
    const list: UploadSpec[] = [];
    let skipped = 0;
    for (const f of r.files) {
      const segs = f.path.split('/');
      const parsed = parseFileName(f.path, segs.slice(1, -1));
      if (!isUploadable(parsed)) { skipped++; continue; }
      const key = `${Date.now()}-${list.length}-${f.path}`;
      const spec: UploadSpec = { key, name: segs[segs.length - 1]!, source: f.source, arch: parsed.arch, step: parsed.step, template: parsed.template };
      specs.current.set(key, spec);
      list.push(spec);
    }
    const n = [...r.notes];
    if (skipped) n.push(`${formatNumber(skipped)} ${skipped === 1 ? 'file was' : 'files were'} skipped because the type is not accepted.`);
    setNotes(n);
    await run(list);
  }, [run]);

  const retry = useCallback((keys?: string[]) => {
    const failed = Object.values(entries).filter((e) => (e.status.phase === 'error') && (!keys || keys.includes(e.spec.key))).map((e) => e.spec);
    void run(failed);
  }, [entries, run]);

  const busy = running > 0;
  useLeaveWarning(busy);

  return { entries: Object.values(entries), notes, busy, add, retry, clear: () => setEntries({}) };
}

const PHASE_TEXT: Record<FileStatus['phase'], string> = { queued: 'Waiting', uploading: 'Uploading', processing: 'Checking', ready: 'Uploaded', rejected: 'Did not pass the checks', error: 'Failed' };
const phaseTone = (p: FileStatus['phase']) => (p === 'ready' ? 'good' : p === 'rejected' || p === 'error' ? 'bad' : 'info');

/** The list of files being added to a case: progress per file and in total, and Retry for the ones that failed. */
export function UploadList({ uploader }: { uploader: ReturnType<typeof useCaseUploader> }) {
  const { entries, notes, busy, retry, clear } = uploader;
  if (!entries.length && !notes.length) return null;
  const done = entries.filter((e) => e.status.phase === 'ready' || e.status.phase === 'rejected').length;
  const failed = entries.filter((e) => e.status.phase === 'error');
  const total = entries.reduce((a, e) => a + e.status.total, 0);
  const sent = entries.reduce((a, e) => a + (e.status.phase === 'ready' || e.status.phase === 'rejected' || e.status.phase === 'processing' ? e.status.total : e.status.sent), 0);
  return (
    <div className="stack-sm upload-list" aria-live="polite">
      {notes.map((n) => <p key={n} className="small muted">{n}</p>)}
      {entries.length ? (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{formatNumber(done)} of {formatNumber(entries.length)} files done{busy ? '' : failed.length ? `, ${formatNumber(failed.length)} failed` : ''}</strong>
            <span className="row" style={{ gap: 8 }}>
              {failed.length ? <Button size="sm" onClick={() => retry()}><RefreshCw size={14} aria-hidden="true" /> Retry {failed.length === 1 ? 'the failed file' : `${formatNumber(failed.length)} failed files`}</Button> : null}
              {!busy ? <Button size="sm" variant="ghost" onClick={clear}>Clear list</Button> : null}
            </span>
          </div>
          <ProgressBar label="Total upload progress" value={total ? sent / total : 0} />
          <ul className="upload-files">
            {entries.map((e) => (
              <li key={e.spec.key}>
                <span className="upload-name">{e.spec.name}</span>
                <span className="small muted">{e.status.phase === 'uploading' ? `${Math.round((e.status.sent / Math.max(1, e.status.total)) * 100)}% of ${formatBytes(e.status.total)}` : formatBytes(e.status.total)}</span>
                <Badge tone={phaseTone(e.status.phase)}>{PHASE_TEXT[e.status.phase]}</Badge>
                {e.status.phase === 'error' ? <><span className="field-error small">{e.status.error}</span><Button size="sm" onClick={() => retry([e.spec.key])}><RefreshCw size={12} aria-hidden="true" /> Retry</Button></> : null}
                {e.status.phase === 'rejected' && e.status.error ? <span className="field-error small">{e.status.error}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
