import { type JSX, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { BrandMark } from '../../layout/Shell';

export function AuthLayout(props: { title: string; intro?: JSX.Element; children: JSX.Element; wide?: boolean; xwide?: boolean }) {
  return (
    <div class="auth-wrap">
      <main class="auth-card-outer" id="main">
        <div class={`auth-card${props.wide ? ' wide' : ''}${props.xwide ? ' xwide' : ''}`}>
          <BrandMark />
          <div class="stack-sm">
            <h1>{props.title}</h1>
            <Show when={props.intro}><p class="muted">{props.intro}</p></Show>
          </div>
          {props.children}
          <p class="muted small">
            <A href="/privacy">Privacy notice</A>
          </p>
        </div>
      </main>
    </div>
  );
}
