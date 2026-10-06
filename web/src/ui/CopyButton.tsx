import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './Common';

/** Copies text to the clipboard and says so in words. Nothing is logged or stored. */
export function CopyButton({ text, label = 'Copy', what = 'Text', size }: { text: string; label?: string; what?: string; size?: 'sm' }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setState('ok'); } catch { setState('fail'); }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 4000);
  }
  return (
    <span className="row" style={{ gap: 8 }}>
      <Button size={size} onClick={copy} aria-label={`${label} ${what.toLowerCase()}`}>
        {state === 'ok' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />} {label}
      </Button>
      <span role="status" className="small">{state === 'ok' ? 'Copied.' : state === 'fail' ? 'Copying was blocked. Select the text and copy it by hand.' : ''}</span>
    </span>
  );
}
