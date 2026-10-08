import type { JSX } from 'solid-js';
import { Button, Dialog, Notice } from './Common';
import { CopyButton } from './CopyButton';

/**
 * Shows a new secret (API key or webhook signing secret) exactly once.
 * The parent keeps the value only in memory and must clear it in onClose.
 */
export function SecretReveal(props: {
  open: boolean;
  title: string;
  subject: string;
  secret: string;
  kindLabel: string;
  children?: JSX.Element;
  onClose: () => void;
}) {
  return (
    <Dialog open={props.open} title={props.title} onClose={props.onClose} dismissible={false} wide footer={<Button variant="primary" onClick={props.onClose}>I have saved it</Button>}>
      <div class="stack">
        <Notice tone="warn" title="You cannot see it again">
          This is the only time the {props.kindLabel} is shown. We keep only a fingerprint. If you lose it, you will need to make a new one.
        </Notice>
        <p>For <strong>{props.subject}</strong></p>
        <div class="key-box" data-testid="new-secret">{props.secret}</div>
        <CopyButton text={props.secret} label="Copy" what={props.kindLabel} />
        {props.children}
      </div>
    </Dialog>
  );
}
