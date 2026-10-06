import type { CaseItem } from '../lib/types';
import { simpleStatusLabel, simpleStatusOf, simpleStatusTone, statusLabel } from '../lib/format';
import { Badge } from './Common';

/**
 * The status shown in lists: Draft, Submitted, Production, Shipped (or Cancelled).
 * A small caption gives the detail: "On hold", the factory stage, and for K Line staff the detailed status when it differs.
 */
export function StatusBadge({ c, staff = false }: { c: Pick<CaseItem, 'status' | 'simpleStatus' | 'stageLabel'>; staff?: boolean }) {
  const simple = simpleStatusOf(c);
  let caption: string | null = null;
  if (c.status === 'on_hold') caption = 'On hold';
  else if (simple === 'production' && c.stageLabel) caption = c.stageLabel;
  else if (staff && ['ready', 'received', 'delivered'].includes(c.status)) caption = statusLabel(c.status);
  return (
    <>
      <Badge tone={simpleStatusTone(simple)}>{simpleStatusLabel(simple)}</Badge>
      {caption ? <div className="muted small">{caption}</div> : null}
    </>
  );
}
