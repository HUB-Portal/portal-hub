import { createMemo, createSignal, For, Show } from 'solid-js';
import { Paperclip } from 'lucide-solid';
import { parseFileName } from '@shared/filenames';
import { formatNumber } from '../lib/format';
import { readFileList } from '../lib/intake';
import { usePublicConfig } from '../lib/orgApi';
import { isUploadable, uploadCaseFiles, type FileStatus, type UploadSpec } from '../lib/upload';
import { Button, ProgressBar } from './Common';

/** Case statuses in which a partner may still add documents. From production on, late files could change aligners that are already being made. */
const LATE_STATUSES = ['received', 'in_production', 'shipped', 'delivered', 'cancelled'];
export const canAddDocuments = (status: string): boolean => !LATE_STATUSES.includes(status);

/**
 * Paperclip "Add documents" for a case that is already uploaded (review of 8 Oct 2026, R6). The files attach to the existing case and show in its
 * timeline. Once the case is in production the button is replaced by "Contact K Line".
 */
export function AddDocuments(props: { caseId: string; status: string; onDone?: () => void; compact?: boolean }) {
  let ref!: HTMLInputElement;
  const config = usePublicConfig();
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal<Record<string, FileStatus>>({});
  const [notes, setNotes] = createSignal<string[]>([]);

  async function run(list: FileList | null) {
    if (!list || !list.length) return;
    setBusy(true);
    setNotes([]);
    setProgress({});
    // Read what the case is before the first await: the props may change while the files are sent.
    const caseId = props.caseId;
    try {
      const read = await readFileList(list);
      const specs: UploadSpec[] = [];
      let skipped = 0;
      for (const f of read.files) {
        const segs = f.path.split('/');
        const parsed = parseFileName(f.path, segs.slice(1, -1));
        if (!isUploadable(parsed)) { skipped++; continue; }
        specs.push({ key: f.path, name: segs[segs.length - 1]!, source: f.source, arch: parsed.arch, step: parsed.step, template: parsed.template });
      }
      const n = [...read.notes];
      if (skipped) n.push(`${formatNumber(skipped)} ${skipped === 1 ? 'file was' : 'files were'} skipped because the type is not accepted.`);
      setNotes(n);
      const result = await uploadCaseFiles(caseId, specs, { onFile: (k, s) => setProgress((prev) => ({ ...prev, [k]: s })) });
      if (!result.ok) setNotes((prev) => [...prev, 'Some files did not upload. Try them again.']);
    } finally {
      setBusy(false);
      props.onDone?.();
    }
  }

  const entries = createMemo(() => Object.values(progress()));
  const done = () => entries().filter((s) => s.phase === 'ready').length;
  return (
    <Show
      when={canAddDocuments(props.status)}
      fallback={
        <Show
          when={config.data?.supportEmail}
          fallback={<span class="small muted">Contact K Line to add documents</span>}
        >
          {(email) => <a class="btn btn-sm" href={`mailto:${email()}?subject=${encodeURIComponent('Documents for a case in production')}`}>Contact K Line</a>}
        </Show>
      }
    >
      <span class="add-docs">
        <input ref={ref} type="file" multiple hidden aria-label="Choose documents to add" onChange={(e) => { const input = e.currentTarget; void run(input.files); input.value = ''; }} />
        <Button size="sm" loading={busy()} onClick={() => ref.click()} aria-label="Add documents" title="Add documents to this case">
          <Paperclip size={14} aria-hidden="true" />{props.compact ? null : ' Add documents'}
        </Button>
        <Show when={entries().length}>
          <span class="add-docs-progress" aria-live="polite">
            <span class="small muted">{formatNumber(done())} of {formatNumber(entries().length)} files done</span>
            <ProgressBar label="Documents upload progress" value={entries().reduce((a, s) => a + (s.phase === 'ready' || s.phase === 'rejected' ? 1 : s.total ? s.sent / s.total : 0), 0) / entries().length} />
          </span>
        </Show>
        <For each={notes()}>{(n) => <span class="small muted">{n}</span>}</For>
      </span>
    </Show>
  );
}
