import { Check } from 'lucide-react';
import type { StepperStep } from '../lib/types';
import { formatDate } from '../lib/format';
import { Badge } from './Common';

/**
 * Case progress: Draft, Submitted, Production, Shipped. The caption under the current step gives the detail
 * (for example the factory stage). A cancelled case keeps the bar with no current step and shows a Cancelled notice.
 */
export function Stepper({ steps, cancelled = false, cancelledAt }: { steps: StepperStep[]; cancelled?: boolean; cancelledAt?: string | null }) {
  if (!steps.length) return null;
  return (
    <div className="stepper-wrap">
      {cancelled ? (
        <p className="step-cancelled" role="status">
          <Badge tone="bad">Cancelled</Badge>
          <span>This case was cancelled{cancelledAt ? ` on ${formatDate(cancelledAt)}` : ''}.</span>
        </p>
      ) : null}
      <ol className={`stepper${cancelled ? ' stepper-cancelled' : ''}`} aria-label="Case progress">
        {steps.map((s) => (
          <li key={s.id} className={`step step-${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
            <span className="step-dot" aria-hidden="true">{s.state === 'done' ? <Check size={14} /> : null}</span>
            <span className="step-text">
              <span className="step-label">{s.label}</span>
              {s.state === 'current' && s.detail ? <span className="step-detail">{s.detail}</span> : null}
            </span>
            <span className="sr-only">{s.state === 'done' ? ', done' : s.state === 'current' ? `, current step${s.detail ? `, ${s.detail}` : ''}` : ', not reached yet'}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
