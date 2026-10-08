import { A } from '@solidjs/router';
import { Notice } from './Common';

/** Explains a feature that stays locked until K Line approves the company. `what` finishes the sentence "You cannot ... yet". */
export function LockedNotice(props: { what: string; tone?: 'warn' | 'info' }) {
  return (
    <Notice
      tone={props.tone ?? 'warn'}
      title="Not available until K Line approves your company"
      action={<A class="btn btn-sm" href="/portal/getting-started">See what is left</A>}
    >
      You cannot {props.what} yet. K Line checks every new company first. You can still finish your company profile and read the production specification while you wait.
    </Notice>
  );
}
