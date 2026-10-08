import { createEffect, createSignal, mergeProps, on, Show } from 'solid-js';
import { logoUrl } from '../lib/orgApi';

/**
 * The company logo, loaded with the session cookie from /api/org/logo. When the image cannot be loaded the component
 * renders nothing, so the page falls back to the plain company name. `src` replaces the address, for previews.
 */
export function OrgLogoImage(input: { name: string; version?: string; src?: string; className?: string; onFailed?: () => void }) {
  const props = mergeProps({ className: 'topbar-logo' }, input);
  const url = () => props.src ?? logoUrl(props.version ?? '0');
  const [failed, setFailed] = createSignal(false);
  createEffect(on(url, () => setFailed(false)));
  return (
    <Show when={!failed()}>
      <img class={props.className} src={url()} alt={`${props.name} logo`} loading="eager" decoding="async" onError={() => { setFailed(true); props.onFailed?.(); }} />
    </Show>
  );
}
