import { Link } from 'react-router-dom';
import { Notice } from './Common';

/** Explains a feature that stays locked until K Line approves the company. `what` finishes the sentence "You cannot ... yet". */
export function LockedNotice({ what, tone = 'warn' }: { what: string; tone?: 'warn' | 'info' }) {
  return (
    <Notice
      tone={tone}
      title="Not available until K Line approves your company"
      action={<Link className="btn btn-sm" to="/portal/getting-started">See what is left</Link>}
    >
      You cannot {what} yet. K Line checks every new company first. You can still finish your company profile and read the production specification while you wait.
    </Notice>
  );
}
