import { useRef, useState, type ReactNode } from 'react';
import { FileArchive, FilePlus2, FolderPlus, FolderUp } from 'lucide-react';
import { snapshotDrop } from '../lib/intake';
import { Button } from './Common';

export interface DropHandlers {
  onSnapshot: (snap: ReturnType<typeof snapshotDrop>) => void;
  onList: (list: FileList) => void;
}

/** Two buttons that add more folders, files or zips to a list that is already on screen. */
export function AddMoreButtons({ onList, busy }: { onList: (list: FileList) => void; busy?: boolean }) {
  const dirRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => { if (e.target.files?.length) onList(e.target.files); e.target.value = ''; };
  return (
    <div className="row">
      <input ref={dirRef} type="file" hidden aria-label="Add another folder" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={pick} />
      <input ref={fileRef} type="file" hidden multiple aria-label="Add more files or zip files" onChange={pick} />
      <Button size="sm" disabled={busy} onClick={() => dirRef.current?.click()}><FolderPlus size={14} aria-hidden="true" /> Add a folder</Button>
      <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}><FilePlus2 size={14} aria-hidden="true" /> Add files or a zip</Button>
    </div>
  );
}

export function DropZone({ onSnapshot, onList, busy, title, children }: DropHandlers & { busy?: boolean; title: string; children?: ReactNode }) {
  const [over, setOver] = useState(false);
  const dirRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (busy) return;
        onSnapshot(snapshotDrop(e.dataTransfer));
      }}
    >
      <FolderUp size={36} aria-hidden="true" />
      <h2>{title}</h2>
      {children ? <p className="muted">{children}</p> : null}
      <div className="row" style={{ justifyContent: 'center' }}>
        <input ref={dirRef} type="file" hidden aria-label="Choose a folder" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(e) => { if (e.target.files?.length) onList(e.target.files); e.target.value = ''; }} />
        <input ref={fileRef} type="file" hidden multiple aria-label="Choose files or zip files" onChange={(e) => { if (e.target.files?.length) onList(e.target.files); e.target.value = ''; }} />
        <Button variant="primary" disabled={busy} onClick={() => dirRef.current?.click()}><FolderUp size={16} aria-hidden="true" /> Choose a folder</Button>
        <Button disabled={busy} onClick={() => fileRef.current?.click()}><FileArchive size={16} aria-hidden="true" /> Choose files or a zip</Button>
      </div>
    </div>
  );
}
