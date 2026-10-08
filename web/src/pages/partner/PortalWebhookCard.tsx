import { createSignal, Show } from 'solid-js';
import { createMutation, useQueryClient } from '@tanstack/solid-query';
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
export function PortalWebhookCard(props: { webhook: PortalWebhookInfo; locked?: boolean }) {
  const qc = useQueryClient();
  const [reveal, setReveal] = createSignal<{ url: string; secret: string; rotated: boolean } | null>(null);
  const [confirm, setConfirm] = createSignal<'rotate' | 'delete' | null>(null);
  const [flash, setFlash] = createSignal<Flash>(null);
  const locked = () => props.locked ?? false;
  const refresh = () => qc.invalidateQueries({ queryKey: ['portal-api'] });

  const make = createMutation(() => ({
    mutationFn: () => api<{ url: string; secret: string; rotated: boolean }>('/api/org/portal-api/webhook', { method: 'POST', body: {} }),
    onSuccess: (r: { url: string; secret: string; rotated: boolean }) => { setConfirm(null); setReveal({ url: r.url, secret: r.secret, rotated: r.rotated }); refresh(); },
    onError: (e: unknown) => { setConfirm(null); setFlash({ tone: 'bad', text: errorText(e) }); },
  }));
  const remove = createMutation(() => ({
    mutationFn: () => api('/api/org/portal-api/webhook', { method: 'DELETE' }),
    onSuccess: () => { setConfirm(null); setFlash({ tone: 'good', text: 'The address was removed. The portal can no longer send instant updates to the Hub.' }); refresh(); },
    onError: (e: unknown) => { setConfirm(null); setFlash({ tone: 'bad', text: errorText(e) }); },
  }));

  const closeReveal = () => setReveal(null);

  return (
    <Card
      title="Instant updates from the K Line portal"
      actions={props.webhook.configured
        ? <Badge tone={props.webhook.receivedCount > 0 ? 'good' : 'neutral'}>{props.webhook.receivedCount > 0 ? 'Receiving' : 'Waiting for the portal'}</Badge>
        : <Badge>Not set up</Badge>}
    >
      <p class="muted">
        Without this, the Hub asks the portal for news every 10 minutes. With it, the portal tells the Hub the moment a case changes, so production and shipping updates show up within seconds.
        The Hub never trusts the message itself. It only uses it as a reminder to check the portal, and it never keeps what is in the message.
      </p>
      <ol class="stack-sm" style={{ 'padding-left': '20px', margin: '12px 0' }}>
        <li>Create or rotate the address and secret here.</li>
        <li>In the K Line portal, open your avatar menu, then API Webhooks, then Add Webhook.</li>
        <li>Paste the address as the URL and the secret as the Secret Token. Choose the Case triggers (insert and update).</li>
        <li>Save, then press Test in the portal. This page shows when the last message arrived.</li>
      </ol>

      <Show when={flash()}>{(f) => <Notice tone={f().tone}>{f().text}</Notice>}</Show>
      <Show when={locked()}><Notice tone="info" title="Not available until K Line approves your company">You cannot set up instant updates yet.</Notice></Show>
      <Show when={props.webhook.publicUrlWarning}>
        <Notice tone="warn" title="The portal cannot reach this Hub address yet">
          The portal needs an https address that it can reach from the internet. On your own computer, use a tunnel such as cloudflared or ngrok and set PUBLIC_URL to its address. On the production server this is your real address.
        </Notice>
      </Show>

      <Show
        when={props.webhook.configured && props.webhook.url}
        fallback={
          <div class="row" style={{ 'margin-top': '12px' }}>
            <Button variant="primary" loading={make.isPending} disabled={locked()} onClick={() => { setFlash(null); make.mutate(); }}>Create address and secret</Button>
            <IfMfa><span class="small muted">You will be asked for your authenticator code.</span></IfMfa>
          </div>
        }
      >
        <div class="stack" style={{ 'margin-top': '12px' }}>
          <div>
            <div class="small muted">Address for the portal (URL)</div>
            <div class="key-box" data-testid="portal-hook-url">{props.webhook.url}</div>
            <CopyButton text={props.webhook.url ?? ''} label="Copy" what="address" />
          </div>
          <dl class="facts">
            <dt>Last message</dt>
            <dd>{props.webhook.lastReceivedAt ? `${relativeAge(props.webhook.lastReceivedAt)} (${formatDateTime(props.webhook.lastReceivedAt)})` : 'Nothing has arrived yet'}</dd>
            <dt>Messages received</dt>
            <dd>{formatNumber(props.webhook.receivedCount)}</dd>
          </dl>
          <Show when={props.webhook.lastResult}>{(r) => <Notice tone={r() === 'bad_secret' ? 'bad' : 'info'}>{RESULT_TEXT[r()]}</Notice>}</Show>
          <div class="row">
            <Button onClick={() => { setFlash(null); setConfirm('rotate'); }} disabled={locked()}>Make a new secret</Button>
            <Button variant="danger" onClick={() => { setFlash(null); setConfirm('delete'); }} disabled={locked()}>Remove the address</Button>
          </div>
          <p class="small muted"><IfMfa>You will be asked for your authenticator code. </IfMfa>The address stays the same when you make a new secret, but the old secret stops working at once.</p>
        </div>
      </Show>
      <p class="small muted" style={{ 'margin-top': '12px' }}>The Hub still checks the portal every 10 minutes as a backup, in case a message is lost on the way.</p>

      <Dialog
        open={!!reveal()}
        title={reveal()?.rotated ? 'Copy your new secret now' : 'Copy your address and secret now'}
        onClose={closeReveal}
        dismissible={false}
        wide
        footer={<Button variant="primary" onClick={closeReveal}>I have saved it</Button>}
      >
        <div class="stack">
          <Notice tone="warn" title="You cannot see the secret again">
            This is the only time the secret is shown. The Hub keeps it encrypted and cannot show it to you later. If you lose it, make a new one.
            {reveal()?.rotated ? ' The old secret no longer works, so update the Secret Token in the portal.' : ''}
          </Notice>
          <div>
            <div class="small muted">Address (URL)</div>
            <div class="key-box">{reveal()?.url}</div>
            <CopyButton text={reveal()?.url ?? ''} label="Copy" what="address" />
          </div>
          <div>
            <div class="small muted">Secret (Secret Token)</div>
            <div class="key-box" data-testid="new-secret">{reveal()?.secret}</div>
            <CopyButton text={reveal()?.secret ?? ''} label="Copy" what="secret" />
          </div>
        </div>
      </Dialog>

      <Dialog
        open={confirm() === 'rotate'}
        title="Make a new secret?"
        onClose={() => setConfirm(null)}
        footer={<><Button onClick={() => setConfirm(null)}>Cancel</Button><Button variant="primary" loading={make.isPending} onClick={() => make.mutate()}>Make a new secret</Button></>}
      >
        <p>The old secret stops working at once. Until you paste the new one into the portal, the portal messages are refused and the Hub relies on its 10 minute check.</p>
      </Dialog>

      <Dialog
        open={confirm() === 'delete'}
        title="Remove the address?"
        onClose={() => setConfirm(null)}
        footer={<><Button onClick={() => setConfirm(null)}>Keep it</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Remove address</Button></>}
      >
        <p>The portal can no longer send instant updates to the Hub. You can also delete the webhook in the portal. The Hub keeps checking the portal every 10 minutes.</p>
      </Dialog>
    </Card>
  );
}
