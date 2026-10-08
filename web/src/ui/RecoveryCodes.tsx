import { createSignal, For } from 'solid-js';
import { Copy, Download } from 'lucide-solid';
import { downloadTextFile } from '../lib/format';
import { Button, Notice } from './Common';

export function RecoveryCodes(props: { codes: string[] }) {
  const [copied, setCopied] = createSignal<'ok' | 'fail' | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.codes.join('\n'));
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }
  return (
    <div class="stack">
      <Notice tone="warn" title="Save these codes now">
        We show them only once. Each code works one time if you lose your phone.
      </Notice>
      <ul class="recovery" aria-label="Recovery codes">
        <For each={props.codes}>{(c) => <li>{c}</li>}</For>
      </ul>
      <div class="row">
        <Button onClick={copy}><Copy size={16} aria-hidden="true" /> Copy codes</Button>
        <Button onClick={() => downloadTextFile('portal-hub-recovery-codes.txt', `Portal Hub recovery codes\n\n${props.codes.join('\n')}\n`)}>
          <Download size={16} aria-hidden="true" /> Download as text file
        </Button>
        <span role="status" class="small muted">{copied() === 'ok' ? 'Copied.' : copied() === 'fail' ? 'Copying was blocked. Select the codes and copy them by hand.' : ''}</span>
      </div>
    </div>
  );
}
