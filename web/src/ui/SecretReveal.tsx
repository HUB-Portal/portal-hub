import type { ReactNode } from 'react';
import { Button, Dialog, Notice } from './Common';
import { CopyButton } from './CopyButton';

/**
 * Shows a new secret (API key or webhook signing secret) exactly once.
 * The parent keeps the value only in memory and must clear it in onClose.
 */
export function SecretReveal({ open, title, subject, secret, kindLabel, children, onClose }: {
  open: boolean;
  title: string;
  subject: string;
  secret: string;
  kindLabel: string;
  children?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} title={title} onClose={onClose} dismissible={false} wide footer={<Button variant="primary" onClick={onClose}>I have saved it</Button>}>
      <div className="stack">
        <Notice tone="warn" title="You cannot see it again">
          This is the only time the {kindLabel} is shown. We keep only a fingerprint. If you lose it, you will need to make a new one.
        </Notice>
        <p>For <strong>{subject}</strong></p>
        <div className="key-box" data-testid="new-secret">{secret}</div>
        <CopyButton text={secret} label="Copy" what={kindLabel} />
        {children}
      </div>
    </Dialog>
  );
}
