import { For, mergeProps, Show } from 'solid-js';
import { Check } from 'lucide-solid';
import type { StepperStep } from '../lib/types';
import { formatDate } from '../lib/format';
import { Badge } from './Common';

/**
 * Case progress: Draft, Submitted, Production, Shipped. The caption under the current step gives the detail
 * (for example the factory stage). A cancelled case keeps the bar with no current step and shows a Cancelled notice.
 */
export function Stepper(input: { steps: StepperStep[]; cancelled?: boolean; cancelledAt?: string | null }) {
  const props = mergeProps({ cancelled: false }, input);
  return (
    <Show when={props.steps.length}>
      <div class="stepper-wrap">
        <Show when={props.cancelled}>
          <p class="step-cancelled" role="status">
            <Badge tone="bad">Cancelled</Badge>
            <span>This case was cancelled{props.cancelledAt ? ` on ${formatDate(props.cancelledAt)}` : ''}.</span>
          </p>
        </Show>
        <ol class={`stepper${props.cancelled ? ' stepper-cancelled' : ''}`} aria-label="Case progress">
          <For each={props.steps}>
            {(s) => (
              <li class={`step step-${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
                <span class="step-dot" aria-hidden="true">{s.state === 'done' ? <Check size={14} /> : null}</span>
                <span class="step-text">
                  <span class="step-label">{s.label}</span>
                  {s.state === 'current' && s.detail ? <span class="step-detail">{s.detail}</span> : null}
                </span>
                <span class="sr-only">{s.state === 'done' ? ', done' : s.state === 'current' ? `, current step${s.detail ? `, ${s.detail}` : ''}` : ', not reached yet'}</span>
              </li>
            )}
          </For>
        </ol>
      </div>
    </Show>
  );
}
