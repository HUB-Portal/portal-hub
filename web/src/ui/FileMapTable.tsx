import { formatBytes } from '../lib/format';
import { isUploadable } from '../lib/upload';
import type { MapFile } from '../lib/review';

/** Editable file mapping: arch, step and template for each file. */
export function FileMapTable({ files, onChange, idPrefix, readOnly }: { files: MapFile[]; onChange: (files: MapFile[]) => void; idPrefix: string; readOnly?: boolean }) {
  function patch(i: number, p: Partial<MapFile>) {
    onChange(files.map((f, n) => (n === i ? { ...f, ...p } : f)));
  }
  return (
    <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
      <table className="table">
        <thead>
          <tr><th>Send</th><th>File</th><th>Type</th><th>Arch</th><th>Step</th><th>Template</th><th className="num">Size</th></tr>
        </thead>
        <tbody>
          {files.map((f, i) => {
            const ok = isUploadable(f);
            const id = `${idPrefix}-${i}`;
            const isModel = f.kind === 'stl' || f.kind === 'pts';
            return (
              <tr key={f.path}>
                <td>
                  <input type="checkbox" id={`${id}-send`} checked={!f.skip && ok} disabled={!ok || readOnly} onChange={(e) => patch(i, { skip: !e.target.checked })} aria-label={`Send ${f.name}`} />
                </td>
                <td style={{ overflowWrap: 'anywhere' }}>
                  {f.name}
                  {!ok ? <div className="small muted">{f.kind === 'instructions' ? 'Read as instructions, not uploaded' : 'This type is not accepted'}</div> : null}
                </td>
                <td>{f.kind === 'stl' ? 'Model' : f.kind === 'pts' ? 'Trim line' : f.kind === 'instructions' ? 'Instructions' : f.kind === 'image' ? 'Image' : f.kind.toUpperCase()}</td>
                <td>
                  {isModel ? (
                    <select id={`${id}-arch`} aria-label={`Arch for ${f.name}`} value={f.arch ?? ''} disabled={readOnly} onChange={(e) => patch(i, { arch: (e.target.value || null) as MapFile['arch'] })}>
                      <option value="">Not set</option><option value="upper">Upper</option><option value="lower">Lower</option>
                    </select>
                  ) : <span className="muted">Not needed</span>}
                </td>
                <td style={{ width: 90 }}>
                  {isModel ? (
                    <input id={`${id}-step`} type="number" min={0} max={999} aria-label={`Step for ${f.name}`} value={f.step ?? ''} disabled={readOnly} onChange={(e) => patch(i, { step: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))) })} />
                  ) : null}
                </td>
                <td>
                  {isModel ? <input type="checkbox" id={`${id}-tpl`} checked={f.template} disabled={readOnly} onChange={(e) => patch(i, { template: e.target.checked })} aria-label={`${f.name} is a template`} /> : null}
                </td>
                <td className="num nowrap">{formatBytes(f.size)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
