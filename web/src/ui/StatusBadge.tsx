import { mergeProps, Show } from 'solid-js';
import type { CaseItem } from '../lib/types';
import { simpleStatusLabel, simpleStatusOf, simpleStatusTone, statusLabel } from '../lib/format';
import { Badge } from './Common';

/**
 * The status shown in lists: Draft, Submitted, Production, Shipped (or Cancelled).
 * A small caption gives the detail: "On hold", the factory stage, and for K Line staff the detailed status when it differs.
 */
export function StatusBadge(input: { c: Pick<CaseItem, 'status' | 'simpleStatus' | 'stageLabel'>; staff?: boolean }) {
  const props = mergeProps({ staff: false }, input);
  const simple = () => simpleStatusOf(props.c);
  const caption = (): string | null => {
    const c = props.c;
    if (c.status === 'on_hold') return 'On hold';
    if (simple() === 'production' && c.stageLabel) return c.stageLabel;
    if (props.staff && ['ready', 'received', 'delivered'].includes(c.status)) return statusLabel(c.status);
    return null;
  };
  return (
    <>
      <Badge tone={simpleStatusTone(simple())}>{simpleStatusLabel(simple())}</Badge>
      <Show when={caption()}><div class="muted small">{caption()}</div></Show>
    </>
  );
}
