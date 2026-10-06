import { useMemo } from 'react';
import { apiBaseUrl, curlSnippets, NODE_VERIFY, PYTHON_VERIFY, STATUS_MAP } from '../../../lib/integrations';
import { Badge, Card, Notice } from '../../../ui/Common';
import { CopyButton } from '../../../ui/CopyButton';

function Snippet({ title, text, language }: { title: string; text: string; language: string }) {
  return (
    <div className="stack-sm">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>{title}</h3>
        <CopyButton size="sm" text={text} label="Copy" what={title} />
      </div>
      <pre className="code-block" tabIndex={0} aria-label={`${title}, ${language}`}>{text}</pre>
    </div>
  );
}

export function DeveloperTab() {
  const base = useMemo(apiBaseUrl, []);
  const curls = useMemo(() => curlSnippets(base), [base]);
  return (
    <>
      <Card title="Connect a system">
        <p className="muted">A short guide for the person who builds the connection. Keys and webhooks are made on the other tabs.</p>
        <div className="stack-sm">
          <div className="label">Base address</div>
          <div className="row">
            <code className="key-box" style={{ userSelect: 'all' }}>{base}</code>
            <CopyButton size="sm" text={base} what="base address" />
          </div>
        </div>
        <ul className="stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
          <li>Send your key as a Bearer token: <code className="code-tag">Authorization: Bearer kph_...</code>. Sign in cookies do not work here.</li>
          <li>Lists are paged with <code className="code-tag">page</code> and <code className="code-tag">page_size</code> (up to 100). Dates look like 2026-09-24. Times are in UTC.</li>
          <li>Errors come back as JSON with a <code className="code-tag">code</code> and a <code className="code-tag">message</code>. Quote the <code className="code-tag">X-Request-Id</code> header if you contact support.</li>
          <li>Patient names are only in the answers when the key has the Read patient names permission.</li>
        </ul>
        {curls.map((c) => <Snippet key={c.title} title={c.title} text={c.text} language="shell" />)}
        <Notice tone="info" title="Full documentation">
          Every endpoint, with examples, is in the file <span className="mono">docs/integration/PARTNER_API.md</span> that comes with the platform. Ask K Line support for a copy if you do not have it.
        </Notice>
      </Card>

      <Card title="Check webhook signatures">
        <p className="muted">
          Every message has an <code className="code-tag">x-kph-signature</code> header like <code className="code-tag">t=1790000000,v1=ab12...</code>. It is a SHA-256 HMAC, made with your signing secret, of the timestamp, a full stop and the raw request body. Always check it, and refuse messages older than 5 minutes. Use <code className="code-tag">x-kph-delivery</code> to ignore a message you already handled.
        </p>
        <Snippet title="Node.js" text={NODE_VERIFY} language="JavaScript" />
        <Snippet title="Python" text={PYTHON_VERIFY} language="Python" />
        <p className="small muted">Your system should answer with a status from 200 to 299 within 10 seconds. Redirects are not followed. Failed messages are tried again after 1, 5, 30, 120, 360, 720 and 1,440 minutes, then we give up.</p>
      </Card>

      <Card title="How statuses line up">
        <p className="muted">The portal shows four statuses. The API gives the same idea in <code className="code-tag">simple_status</code>, and the exact step in <code className="code-tag">status</code>.</p>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Status mapping</caption>
            <thead><tr><th>Shown in the portal</th><th><code>simple_status</code></th><th><code>status</code> can be</th><th>What it means</th></tr></thead>
            <tbody>
              {STATUS_MAP.map((r) => (
                <tr key={r.api}>
                  <td><Badge tone={r.api === 'draft' ? 'neutral' : r.api === 'shipped' ? 'good' : 'info'}>{r.simple}</Badge></td>
                  <td className="mono">{r.api}</td>
                  <td className="mono small">{r.hub}</td>
                  <td>{r.text}</td>
                </tr>
              ))}
              <tr>
                <td><Badge tone="bad">Cancelled</Badge></td>
                <td className="mono">cancelled</td>
                <td className="mono small">cancelled</td>
                <td>The case was cancelled and will not be made.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
