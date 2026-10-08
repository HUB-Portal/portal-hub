import { createSignal, mergeProps, onCleanup } from 'solid-js';
import { Check, Copy } from 'lucide-solid';
import { Button } from './Common';

/** Copies text to the clipboard and says so in words. Nothing is logged or stored. */
export function CopyButton(input: { text: string; label?: string; what?: string; size?: 'sm' }) {
  const props = mergeProps({ label: 'Copy', what: 'Text' }, input);
  const [state, setState] = createSignal<'idle' | 'ok' | 'fail'>('idle');
  let timer: number | undefined;
  onCleanup(() => window.clearTimeout(timer));
  async function copy() {
    try { await navigator.clipboard.writeText(props.text); setState('ok'); } catch { setState('fail'); }
    window.clearTimeout(timer);
    timer = window.setTimeout(() => setState('idle'), 4000);
  }
  return (
    <span class="row" style={{ gap: '8px' }}>
      <Button size={props.size} onClick={copy} aria-label={`${props.label} ${props.what.toLowerCase()}`}>
        {state() === 'ok' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />} {props.label}
      </Button>
      <span role="status" class="small">{state() === 'ok' ? 'Copied.' : state() === 'fail' ? 'Copying was blocked. Select the text and copy it by hand.' : ''}</span>
    </span>
  );
}
