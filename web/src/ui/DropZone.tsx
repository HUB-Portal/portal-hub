import { createEffect, createSignal, type JSX, onCleanup, Show } from 'solid-js';
import { FileArchive, FolderUp, UploadCloud } from 'lucide-solid';
import { snapshotDrop } from '../lib/intake';
import { Button } from './Common';

export interface DropHandlers {
  onSnapshot: (snap: ReturnType<typeof snapshotDrop>) => void;
  onList: (list: FileList) => void;
}

const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes('Files');

/**
 * Makes the whole page a drop target. Files dropped anywhere are handed to `onSnapshot` (read synchronously, as the browser requires).
 * Returns an accessor that reads true while files are being dragged over the page, so the page can show its overlay.
 */
export function usePageDrop(onSnapshot: DropHandlers['onSnapshot'], enabled: () => boolean = () => true): () => boolean {
  const [dragging, setDragging] = createSignal(false);
  createEffect(() => {
    if (!enabled()) { setDragging(false); return; }
    // dragenter and dragleave fire for every child element, so a counter tells when the drag really left the window.
    let depth = 0;
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; depth++; setDragging(true); };
    const over = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (e.dataTransfer) onSnapshot(snapshotDrop(e.dataTransfer));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    onCleanup(() => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    });
  });
  return dragging;
}

/** Full page veil shown while files are dragged over the page. It does not take part in the drop itself. */
export function PageDropOverlay(props: { show: boolean; text?: string }) {
  return (
    <Show when={props.show}>
      <div class="drop-overlay" role="presentation" aria-hidden="true">
        <div class="drop-overlay-card">
          <UploadCloud size={48} aria-hidden="true" />
          <strong>{props.text ?? 'Drop to add cases'}</strong>
        </div>
      </div>
    </Show>
  );
}

/**
 * The drop zone. Full size while there is nothing to show yet, compact (one row, about 80 px) once cases are listed. `pinned` keeps it at the
 * top of the page while the page scrolls. Dropping is handled by usePageDrop, so this component only shows the state and the pick buttons.
 */
export function DropZone(props: Pick<DropHandlers, 'onList'> & { busy?: boolean; title: string; compact?: boolean; pinned?: boolean; active?: boolean; children?: JSX.Element }) {
  let dirRef!: HTMLInputElement;
  let fileRef!: HTMLInputElement;
  const pick = (e: Event & { currentTarget: HTMLInputElement }) => {
    const input = e.currentTarget;
    if (input.files?.length) props.onList(input.files);
    input.value = '';
  };
  const zone = () => (
    <div class={`dropzone${props.compact ? ' dropzone-bar' : ''}${props.active ? ' over' : ''}`} data-testid="dropzone">
      <input ref={dirRef} type="file" hidden aria-label="Choose a folder" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={pick} />
      <input ref={fileRef} type="file" hidden multiple aria-label="Choose files or zip files" onChange={pick} />
      <FolderUp size={props.compact ? 24 : 36} aria-hidden="true" />
      <Show
        when={props.compact}
        fallback={
          <>
            <h2>{props.title}</h2>
            <Show when={props.children}><p class="muted">{props.children}</p></Show>
          </>
        }
      >
        <div class="dropzone-text">
          <strong>{props.title}</strong>
          <Show when={props.children}><span class="muted small">{props.children}</span></Show>
        </div>
      </Show>
      <div class="row" style={{ 'justify-content': 'center' }}>
        <Button variant="primary" size={props.compact ? 'sm' : undefined} disabled={props.busy} onClick={() => dirRef.click()}><FolderUp size={16} aria-hidden="true" /> Choose a folder</Button>
        <Button size={props.compact ? 'sm' : undefined} disabled={props.busy} onClick={() => fileRef.click()}><FileArchive size={16} aria-hidden="true" /> Choose files or a zip</Button>
      </div>
    </div>
  );
  return <Show when={props.pinned} fallback={zone()}><div class="dropzone-pin">{zone()}</div></Show>;
}
