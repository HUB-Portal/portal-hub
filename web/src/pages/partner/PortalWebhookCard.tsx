import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../../lib/api';
import { formatDateTime, formatNumber, relativeAge } from '../../lib/format';
import { Badge, Button, Card, Dialog, Notice } from '../../ui/Common';
import { CopyButton } from '../../ui/CopyButton';
import { IfMfa } from '../../ui/IfMfa';

export interface PortalWebhookInfo {
  configured: boolean;
  url: string | null;
  lastReceivedAt: string | null;
  receivedCount: number;
  lastResult: 'ok' | 'ignored' | 'bad_secret' | null;
  publicUrlWarning: boolean;
}

type Flash = { tone: 'good' | 'bad'; text: string } | null;

const RESULT_TEXT: Record<string, string> = {
  ok: 'The last message was about one of your cases, so the Hub checked the portal for it.',
  ignored: 'The last message needed no action. The Test button in the portal sends a message like this, so that is a good sign.',
  bad_secret: 'The last message had the wrong secret and was refused. Check the Secret Token in the portal, or make a new secret here.',
};

/**
 * Instant updates from the K Line portal. The portal calls an address of ours when a case changes; the Hub then reads the real status
 * from the portal. The secret is shown once and held only in memory until the dialog is closed.
 */
export function PortalWebhookCard({ webhook, locked = false }: { webhook: PortalWebhookInfo; locked?: boolean }) {
  const qc = useQueryClient();
  const [reveal, setReveal] = useState<{ url: string; secret: string; rotated: boolean } | null>(null);
  const [confirm, setConfirm] = useState<'rotate' | 'delete' | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['portal-api'] });

  const make = useMutation({
    mutationFn: () => api<{ url: string; secret: string; rotated: boolean }>('/api/org/portal-api/webhook', { method: 'POST', body: {} }),
    onSuccess: (r) => { setConfirm(null); setReveal({ url: r.url, secret: r.secret, rotated: r.rotated }); refresh(); },
    onError: (e) => { setConfirm(null); setFlash({ tone: 'bad', text: errorText(e) }); },
  });
  const remove = useMutation({
    mutationFn: () => api('/api/org/portal-api/webhook', { method: 'DELETE' }),
    onSuccess: () => { setConfirm(null); setFlash({ tone: 'good', text: 'The address was removed. The portal can no longer send instant updates to the Hub.' }); refresh(); },
    onError: (e) => { setConfirm(null); setFlash({ tone: 'bad', text: errorText(e) }); },
  });

  const closeReveal = () => setReveal(null);

  return (
    <Card
      title="Instant updates from the K Line portal"
      actions={webhook.configured
        ? <Badge tone={webhook.receivedCount > 0 ? 'good' : 'neutral'}>{webhook.receivedCount > 0 ? 'Receiving' : 'Waiting for the portal'}</Badge>
        : <Badge>Not set up</Badge>}
    >
      <p className="muted">
        Without this, the Hub asks the portal for news every 10 minutes. With it, the portal tells the Hub the moment a case changes, so production and shipping updates show up within seconds.
        The Hub never trusts the message itself. It only uses it as a reminder to check the portal, and it never keeps what is in the message.
      </p>
      <ol className="stack-sm" style={{ paddingLeft: 20, margin: '12px 0' }}>
        <li>Create or rotate the address and secret here.</li>
        <li>In the K Line portal, open your avatar menu, then API Webhooks, then Add Webhook.</li>
        <li>Paste the address as the URL and the secret as the Secret Token. Choose the Case triggers (insert and update).</li>
        <li>Save, then press Test in the portal. This page shows when the last message arrived.</li>
      </ol>

      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}
      {locked ? <Notice tone="info" title="Not available until K Line approves your company">You cannot set up instant updates yet.</Notice> : null}
      {webhook.publicUrlWarning ? (
        <Notice tone="warn" title="The portal cannot reach this Hub address yet">
          The portal needs an https address that it can reach from the internet. On your own computer, use a tunnel such as cloudflared or ngrok and set PUBLIC_URL to its address. On the production server this is your real address.
        </Notice>
      ) : null}

      {webhook.configured && webhook.url ? (
        <div className="stack" style={{ marginTop: 12 }}>
          <div>
            <div className="small muted">Address for the portal (URL)</div>
            <div className="key-box" data-testid="portal-hook-url">{webhook.url}</div>
            <CopyButton text={webhook.url} label="Copy" what="address" />
          </div>
          <dl className="facts">
            <dt>Last message</dt>
            <dd>{webhook.lastReceivedAt ? `${relativeAge(webhook.lastReceivedAt)} (${formatDateTime(webhook.lastReceivedAt)})` : 'Nothing has arrived yet'}</dd>
            <dt>Messages received</dt>
            <dd>{formatNumber(webhook.receivedCount)}</dd>
          </dl>
          {webhook.lastResult ? <Notice tone={webhook.lastResult === 'bad_secret' ? 'bad' : 'info'}>{RESULT_TEXT[webhook.lastResult]}</Notice> : null}
          <div className="row">
            <Button onClick={() => { setFlash(null); setConfirm('rotate'); }} disabled={locked}>Make a new secret</Button>
            <Button variant="danger" onClick={() => { setFlash(null); setConfirm('delete'); }} disabled={locked}>Remove the address</Button>
          </div>
          <p className="small muted"><IfMfa>You will be asked for your authenticator code. </IfMfa>The address stays the same when you make a new secret, but the old secret stops working at once.</p>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 12 }}>
          <Button variant="primary" loading={make.isPending} disabled={locked} onClick={() => { setFlash(null); make.mutate(); }}>Create address and secret</Button>
          <IfMfa><span className="small muted">You will be asked for your authenticator code.</span></IfMfa>
        </div>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>The Hub still checks the portal every 10 minutes as a backup, in case a message is lost on the way.</p>

      <Dialog
        open={!!reveal}
        title={reveal?.rotated ? 'Copy your new secret now' : 'Copy your address and secret now'}
        onClose={closeReveal}
        dismissible={false}
        wide
        footer={<Button variant="primary" onClick={closeReveal}>I have saved it</Button>}
      >
        <div className="stack">
          <Notice tone="warn" title="You cannot see the secret again">
            This is the only time the secret is shown. The Hub keeps it encrypted and cannot show it to you later. If you lose it, make a new one.
            {reveal?.rotated ? ' The old secret no longer works, so update the Secret Token in the portal.' : ''}
          </Notice>
          <div>
            <div className="small muted">Address (URL)</div>
            <div className="key-box">{reveal?.url}</div>
            <CopyButton text={reveal?.url ?? ''} label="Copy" what="address" />
          </div>
          <div>
            <div className="small muted">Secret (Secret Token)</div>
            <div className="key-box" data-testid="new-secret">{reveal?.secret}</div>
            <CopyButton text={reveal?.secret ?? ''} label="Copy" what="secret" />
          </div>
        </div>
      </Dialog>

      <Dialog
        open={confirm === 'rotate'}
        title="Make a new secret?"
        onClose={() => setConfirm(null)}
        footer={<><Button onClick={() => setConfirm(null)}>Cancel</Button><Button variant="primary" loading={make.isPending} onClick={() => make.mutate()}>Make a new secret</Button></>}
      >
        <p>The old secret stops working at once. Until you paste the new one into the portal, the portal messages are refused and the Hub relies on its 10 minute check.</p>
      </Dialog>

      <Dialog
        open={confirm === 'delete'}
        title="Remove the address?"
        onClose={() => setConfirm(null)}
        footer={<><Button onClick={() => setConfirm(null)}>Keep it</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Remove address</Button></>}
      >
        <p>The portal can no longer send instant updates to the Hub. You can also delete the webhook in the portal. The Hub keeps checking the portal every 10 minutes.</p>
      </Dialog>
    </Card>
  );
}
