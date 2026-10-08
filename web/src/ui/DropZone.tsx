import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileArchive, FolderUp, UploadCloud } from 'lucide-react';
import { snapshotDrop } from '../lib/intake';
import { Button } from './Common';

export interface DropHandlers {
  onSnapshot: (snap: ReturnType<typeof snapshotDrop>) => void;
  onList: (list: FileList) => void;
}

const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes('Files');

/**
 * Makes the whole page a drop target. Files dropped anywhere are handed to `onSnapshot` (read synchronously, as the browser requires).
 * Returns true while files are being dragged over the page, so the page can show its overlay.
 */
export function usePageDrop(onSnapshot: DropHandlers['onSnapshot'], enabled = true): boolean {
  const [dragging, setDragging] = useState(false);
  const handler = useRef(onSnapshot);
  handler.current = onSnapshot;
  useEffect(() => {
    if (!enabled) { setDragging(false); return undefined; }
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
      if (e.dataTransfer) handler.current(snapshotDrop(e.dataTransfer));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [enabled]);
  return dragging;
}

/** Full page veil shown while files are dragged over the page. It does not take part in the drop itself. */
export function PageDropOverlay({ show, text = 'Drop to add cases' }: { show: boolean; text?: string }) {
  if (!show) return null;
  return (
    <div className="drop-overlay" role="presentation" aria-hidden="true">
      <div className="drop-overlay-card">
        <UploadCloud size={48} aria-hidden="true" />
        <strong>{text}</strong>
      </div>
    </div>
  );
}

/**
 * The drop zone. Full size while there is nothing to show yet, compact (one row, about 80 px) once cases are listed. `pinned` keeps it at the
 * top of the page while the page scrolls. Dropping is handled by usePageDrop, so this component only shows the state and the pick buttons.
 */
export function DropZone({ onList, busy, title, compact, pinned, active, children }: Pick<DropHandlers, 'onList'> & { busy?: boolean; title: string; compact?: boolean; pinned?: boolean; active?: boolean; children?: ReactNode }) {
  const dirRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => { if (e.target.files?.length) onList(e.target.files); e.target.value = ''; };
  const zone = (
    <div className={`dropzone${compact ? ' dropzone-bar' : ''}${active ? ' over' : ''}`} data-testid="dropzone">
      <input ref={dirRef} type="file" hidden aria-label="Choose a folder" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={pick} />
      <input ref={fileRef} type="file" hidden multiple aria-label="Choose files or zip files" onChange={pick} />
      <FolderUp size={compact ? 24 : 36} aria-hidden="true" />
      {compact ? (
        <div className="dropzone-text">
          <strong>{title}</strong>
          {children ? <span className="muted small">{children}</span> : null}
        </div>
      ) : (
        <>
          <h2>{title}</h2>
          {children ? <p className="muted">{children}</p> : null}
        </>
      )}
      <div className="row" style={{ justifyContent: 'center' }}>
        <Button variant="primary" size={compact ? 'sm' : undefined} disabled={busy} onClick={() => dirRef.current?.click()}><FolderUp size={16} aria-hidden="true" /> Choose a folder</Button>
        <Button size={compact ? 'sm' : undefined} disabled={busy} onClick={() => fileRef.current?.click()}><FileArchive size={16} aria-hidden="true" /> Choose files or a zip</Button>
      </div>
    </div>
  );
  return pinned ? <div className="dropzone-pin">{zone}</div> : zone;
}
