import { plural } from '../lib/format';
import { Button, Toggle } from './Common';

/**
 * The bar at the bottom of Direct manufacturing: how many cases are uploaded and ready, the one button that sends them to K Line, and the
 * confirmation for the cases whose checks gave warnings. It shows what it is given and decides nothing.
 */
export function SendBar({ ready, sendable, withWarnings, ack, onAck, working, allSent, blocked, onSend }: {
  ready: number;
  sendable: number;
  withWarnings: number;
  ack: boolean;
  onAck: (v: boolean) => void;
  working: boolean;
  allSent: boolean;
  blocked: boolean;
  onSend: () => void;
}) {
  const headline = ready ? `${plural(ready, 'case')} uploaded and ready to send` : working ? 'Uploading. You can keep dropping more cases.' : allSent ? 'All cases were sent to K Line.' : 'Nothing is ready to send yet.';
  return (
    <div className="send-bar" role="region" aria-label="Send to K Line">
      <div className="send-bar-text">
        <strong>{headline}</strong>
        {withWarnings
          ? <Toggle checked={ack} onChange={onAck} label={`Also send the ${plural(withWarnings, 'case')} with warnings`} hint="You confirm you have read the warnings. Your confirmation is stored with each case." />
          : <span className="small muted">Check the names, then send. A case stays a draft until you do.</span>}
      </div>
      <Button variant="primary" disabled={sendable === 0 || blocked} onClick={onSend}>Send {plural(sendable, 'case')} to K Line</Button>
    </div>
  );
}
