import { Show } from 'solid-js';
import { A } from '@solidjs/router';
import { BrandMark } from '../../layout/Shell';
import { usePublicConfig } from '../../lib/orgApi';

export default function Privacy() {
  const config = usePublicConfig();
  return (
    <div class="auth-wrap" style={{ 'align-items': 'start' }}>
      <main id="main" class="auth-card wide" style={{ 'max-width': '760px' }}>
        <BrandMark />
        <h1>Privacy notice</h1>
        <p class="muted">This is a short summary. K Line Europe GmbH provides the full notice and the data processing agreement to each partner.</p>
        <section class="stack-sm">
          <h2>Who we are</h2>
          <p>K Line Europe GmbH runs the Portal Hub so that partner companies can send clear aligner case files for manufacturing. For patient data, the partner is the controller and K Line acts as processor.</p>
        </section>
        <section class="stack-sm">
          <h2>What we keep</h2>
          <p>We keep your account details, the case files you upload, the checks we run on them and a log of who opened what. Patient names are optional, stored encrypted and hidden on screen until someone with permission chooses to show them. Every reveal is logged.</p>
        </section>
        <section class="stack-sm">
          <h2>Where and how</h2>
          <p>Files are encrypted one by one and stored in Germany. This site does not use analytics, advertising or third party fonts and scripts. It sets only the cookie needed to keep you signed in.</p>
        </section>
        <section class="stack-sm">
          <h2>Your rights</h2>
          <p>You can ask for access, correction or removal of your data. <Show when={config.data?.privacyEmail}>{(mail) => <>Write to <a href={`mailto:${mail()}`}>{mail()}</a>. </>}</Show>You can also contact your K Line account team or the privacy contact named in your agreement.</p>
        </section>
        <section class="stack-sm">
          <h2>When you register a company</h2>
          <p>We keep the details you type in the registration form: company name, country, your name, your work email address, and the website and expected volume if you give them. We use them to confirm your email address and to decide whether to approve your company. If you never confirm your email address, we delete the registration after 7 days. If K Line declines a registration, we delete it after 30 days.</p>
          <Show when={config.data?.privacyVersion}><p class="small muted">Version {config.data?.privacyVersion}</p></Show>
        </section>
        <p><A href="/login">Back to sign in</A></p>
      </main>
    </div>
  );
}
