import { Index, Show } from 'solid-js';
import { formatBytes } from '../lib/format';
import { isUploadable } from '../lib/upload';
import type { MapFile } from '../lib/review';

/** Editable file mapping: arch, step and template for each file. */
export function FileMapTable(props: { files: MapFile[]; onChange: (files: MapFile[]) => void; idPrefix: string; readOnly?: boolean }) {
  function patch(i: number, p: Partial<MapFile>) {
    props.onChange(props.files.map((f, n) => (n === i ? { ...f, ...p } : f)));
  }
  return (
    <div class="table-wrap" style={{ 'max-height': '420px', 'overflow-y': 'auto' }}>
      <table class="table">
        <thead>
          <tr><th>Send</th><th>File</th><th>Type</th><th>Arch</th><th>Step</th><th>Template</th><th class="num">Size</th></tr>
        </thead>
        <tbody>
          {/* Index keeps the row (and the focus in its step field) while one of its values is edited. */}
          <Index each={props.files}>
            {(f, i) => {
              const ok = () => isUploadable(f());
              const id = () => `${props.idPrefix}-${i}`;
              const isModel = () => f().kind === 'stl' || f().kind === 'pts';
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
                  <td>
                    <Show when={isModel()} fallback={<span class="muted">Not needed</span>}>
                      <select id={`${id()}-arch`} aria-label={`Arch for ${f().name}`} value={f().arch ?? ''} disabled={props.readOnly} onChange={(e) => patch(i, { arch: (e.currentTarget.value || null) as MapFile['arch'] })}>
                        <option value="">Not set</option><option value="upper">Upper</option><option value="lower">Lower</option>
                      </select>
                    </Show>
                  </td>
                  <td style={{ width: '90px' }}>
                    <Show when={isModel()}>
                      <input id={`${id()}-step`} type="number" min={0} max={999} aria-label={`Step for ${f().name}`} value={f().step ?? ''} disabled={props.readOnly} onInput={(e) => patch(i, { step: e.currentTarget.value === '' ? null : Math.max(0, Math.floor(Number(e.currentTarget.value))) })} />
                    </Show>
                  </td>
                  <td>
                    <Show when={isModel()}>
                      <input type="checkbox" id={`${id()}-tpl`} checked={f().template} disabled={props.readOnly} onChange={(e) => patch(i, { template: e.currentTarget.checked })} aria-label={`${f().name} is a template`} />
                    </Show>
                  </td>
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
