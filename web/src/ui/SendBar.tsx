import { Show } from 'solid-js';
import { plural } from '../lib/format';
import { Button, Toggle } from './Common';

/**
 * The bar at the bottom of Direct manufacturing: how many cases are uploaded and ready, the one button that sends them to K Line, and the
 * confirmation for the cases whose checks gave warnings. It shows what it is given and decides nothing.
 */
export function SendBar(props: {
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
  const headline = () => (props.ready ? `${plural(props.ready, 'case')} uploaded and ready to send` : props.working ? 'Uploading. You can keep dropping more cases.' : props.allSent ? 'All cases were sent to K Line.' : 'Nothing is ready to send yet.');
  return (
    <div class="send-bar" role="region" aria-label="Send to K Line">
      <div class="send-bar-text">
        <strong>{headline()}</strong>
        <Show
          when={props.withWarnings}
          fallback={<span class="small muted">Check the names, then send. A case stays a draft until you do.</span>}
        >
          <Toggle checked={props.ack} onChange={props.onAck} label={`Also send the ${plural(props.withWarnings, 'case')} with warnings`} hint="You confirm you have read the warnings. Your confirmation is stored with each case." />
        </Show>
      </div>
      <Button variant="primary" disabled={props.sendable === 0 || props.blocked} onClick={props.onSend}>Send {plural(props.sendable, 'case')} to K Line</Button>
    </div>
  );
}
