import { useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { downloadTextFile } from '../lib/format';
import { Button, Notice } from './Common';

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }
  return (
    <div className="stack">
      <Notice tone="warn" title="Save these codes now">
        We show them only once. Each code works one time if you lose your phone.
      </Notice>
      <ul className="recovery" aria-label="Recovery codes">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="row">
        <Button onClick={copy}><Copy size={16} aria-hidden="true" /> Copy codes</Button>
        <Button onClick={() => downloadTextFile('portal-hub-recovery-codes.txt', `Portal Hub recovery codes\n\n${codes.join('\n')}\n`)}>
          <Download size={16} aria-hidden="true" /> Download as text file
        </Button>
        <span role="status" className="small muted">{copied === 'ok' ? 'Copied.' : copied === 'fail' ? 'Copying was blocked. Select the codes and copy them by hand.' : ''}</span>
      </div>
    </div>
  );
}
