import { Index, Show } from 'solid-js';
import { formatBytes } from '../lib/format';
import { isUploadable } from '../lib/upload';
import type { MapFile } from '../lib/review';

/** The files of a case: which ones are sent. Arch, step and template are not asked for. */
export function FileMapTable(props: { files: MapFile[]; onChange: (files: MapFile[]) => void; idPrefix: string; readOnly?: boolean }) {
  function patch(i: number, p: Partial<MapFile>) {
    props.onChange(props.files.map((f, n) => (n === i ? { ...f, ...p } : f)));
  }
  return (
    <div class="table-wrap" style={{ 'max-height': '420px', 'overflow-y': 'auto' }}>
      <table class="table">
        <thead>
          <tr><th>Send</th><th>File</th><th>Type</th><th class="num">Size</th></tr>
        </thead>
        <tbody>
          {/* Index keeps the row while one of its values is edited. */}
          <Index each={props.files}>
            {(f, i) => {
              const ok = () => isUploadable(f());
              const id = () => `${props.idPrefix}-${i}`;
              return (
                <tr>
                  <td>
                    <input type="checkbox" id={`${id()}-send`} checked={!f().skip && ok()} disabled={!ok() || props.readOnly} onChange={(e) => patch(i, { skip: !e.currentTarget.checked })} aria-label={`Send ${f().name}`} />
                  </td>
                  <td style={{ 'overflow-wrap': 'anywhere' }}>
                    {f().name}
                    <Show when={!ok()}><div class="small muted">{f().kind === 'instructions' ? 'Read as instructions, not uploaded' : 'This type is not accepted'}</div></Show>
                  </td>
                  <td>{f().kind === 'stl' ? 'Model' : f().kind === 'pts' ? 'Trim line' : f().kind === 'instructions' ? 'Instructions' : f().kind === 'image' ? 'Image' : f().kind.toUpperCase()}</td>
                  <td class="num nowrap">{formatBytes(f().size)}</td>
                </tr>
              );
            }}
          </Index>
        </tbody>
      </table>
    </div>
  );
}
