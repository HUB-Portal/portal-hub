import { For } from 'solid-js';
import { apiBaseUrl, curlSnippets, NODE_VERIFY, PYTHON_VERIFY, STATUS_MAP } from '../../../lib/integrations';
import { Badge, Card, Notice } from '../../../ui/Common';
import { CopyButton } from '../../../ui/CopyButton';

function Snippet(props: { title: string; text: string; language: string }) {
  return (
    <div class="stack-sm">
      <div class="row" style={{ 'justify-content': 'space-between' }}>
        <h3>{props.title}</h3>
        <CopyButton size="sm" text={props.text} label="Copy" what={props.title} />
      </div>
      <pre class="code-block" tabIndex={0} aria-label={`${props.title}, ${props.language}`}>{props.text}</pre>
    </div>
  );
}

export function DeveloperTab() {
  const base = apiBaseUrl();
  const curls = curlSnippets(base);
  return (
    <>
      <Card title="Connect a system">
        <p class="muted">A short guide for the person who builds the connection. Keys and webhooks are made on the other tabs.</p>
        <div class="stack-sm">
          <div class="label">Base address</div>
          <div class="row">
            <code class="key-box" style={{ 'user-select': 'all' }}>{base}</code>
            <CopyButton size="sm" text={base} what="base address" />
          </div>
        </div>
        <ul class="stack-sm" style={{ margin: '0', 'padding-left': '20px' }}>
          <li>Send your key as a Bearer token: <code class="code-tag">Authorization: Bearer kph_...</code>. Sign in cookies do not work here.</li>
          <li>Lists are paged with <code class="code-tag">page</code> and <code class="code-tag">page_size</code> (up to 100). Dates look like 2026-09-24. Times are in UTC.</li>
          <li>Errors come back as JSON with a <code class="code-tag">code</code> and a <code class="code-tag">message</code>. Quote the <code class="code-tag">X-Request-Id</code> header if you contact support.</li>
          <li>Patient names are only in the answers when the key has the Read patient names permission.</li>
        </ul>
        <For each={curls}>{(c) => <Snippet title={c.title} text={c.text} language="shell" />}</For>
        <Notice tone="info" title="Full documentation">
          Every endpoint, with examples, is in the file <span class="mono">docs/integration/PARTNER_API.md</span> that comes with the platform. Ask K Line support for a copy if you do not have it.
        </Notice>
      </Card>

      <Card title="Check webhook signatures">
        <p class="muted">
          Every message has an <code class="code-tag">x-kph-signature</code> header like <code class="code-tag">t=1790000000,v1=ab12...</code>. It is a SHA-256 HMAC, made with your signing secret, of the timestamp, a full stop and the raw request body. Always check it, and refuse messages older than 5 minutes. Use <code class="code-tag">x-kph-delivery</code> to ignore a message you already handled.
        </p>
        <Snippet title="Node.js" text={NODE_VERIFY} language="JavaScript" />
        <Snippet title="Python" text={PYTHON_VERIFY} language="Python" />
        <p class="small muted">Your system should answer with a status from 200 to 299 within 10 seconds. Redirects are not followed. Failed messages are tried again after 1, 5, 30, 120, 360, 720 and 1,440 minutes, then we give up.</p>
      </Card>

      <Card title="How statuses line up">
        <p class="muted">The portal shows four statuses. The API gives the same idea in <code class="code-tag">simple_status</code>, and the exact step in <code class="code-tag">status</code>.</p>
        <div class="table-wrap">
          <table class="table">
            <caption class="sr-only">Status mapping</caption>
            <thead><tr><th>Shown in the portal</th><th><code>simple_status</code></th><th><code>status</code> can be</th><th>What it means</th></tr></thead>
            <tbody>
              <For each={STATUS_MAP}>
                {(r) => (
                  <tr>
                    <td><Badge tone={r.api === 'draft' ? 'neutral' : r.api === 'shipped' ? 'good' : 'info'}>{r.simple}</Badge></td>
                    <td class="mono">{r.api}</td>
                    <td class="mono small">{r.hub}</td>
                    <td>{r.text}</td>
                  </tr>
                )}
              </For>
              <tr>
                <td><Badge tone="bad">Cancelled</Badge></td>
                <td class="mono">cancelled</td>
                <td class="mono small">cancelled</td>
                <td>The case was cancelled and will not be made.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
