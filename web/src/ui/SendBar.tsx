import { plural } from '../lib/format';
import { Button } from './Common';

/**
 * The bar at the bottom of Direct manufacturing: how many cases are uploaded and ready, and the one button that sends them to K Line.
 * It shows what it is given and decides nothing. Nothing about a case's files or checks stops it from being sent.
 */
export function SendBar(props: {
  ready: number;
  sendable: number;
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
        <span class="small muted">Check the names, then send. A case stays a draft until you do.</span>
      </div>
      <Button variant="primary" disabled={props.sendable === 0 || props.blocked} onClick={props.onSend}>Send {plural(props.sendable, 'case')} to K Line</Button>
    </div>
  );
}
