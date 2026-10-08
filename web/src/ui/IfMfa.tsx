import { type JSX, Show } from 'solid-js';
import { useMfaRequired } from '../lib/orgApi';

/** Shows its children only while two factor sign in is switched on (MFA_REQUIRED on the server). */
export function IfMfa(props: { children: JSX.Element }) {
  const mfa = useMfaRequired();
  return <Show when={mfa()}>{props.children}</Show>;
}
