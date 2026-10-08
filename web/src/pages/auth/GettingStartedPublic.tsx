import { Show } from 'solid-js';
import { A } from '@solidjs/router';
import { homeFor, useAuth } from '../../lib/auth';
import { usePublicConfig } from '../../lib/orgApi';
import { GettingStarted } from '../shared/GettingStarted';
import { AuthLayout } from './AuthLayout';

export default function GettingStartedPublic() {
  const { me } = useAuth();
  const config = usePublicConfig();
  const signedIn = () => me()?.stage === 'full';
  return (
    <AuthLayout title="Getting started" xwide>
      <GettingStarted />
      <div class="row">
        <Show
          when={signedIn()}
          fallback={
            <>
              <Show when={config.data?.signupEnabled}><A class="btn btn-primary" href="/register">Register your company</A></Show>
              <A class={config.data?.signupEnabled ? 'btn' : 'btn btn-primary'} href="/login">Sign in</A>
            </>
          }
        >
          <A class="btn btn-primary" href={homeFor(me())}>Go to the portal</A>
        </Show>
      </div>
    </AuthLayout>
  );
}
