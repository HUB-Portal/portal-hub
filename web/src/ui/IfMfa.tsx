import type { ReactNode } from 'react';
import { useMfaRequired } from '../lib/orgApi';

/** Shows its children only while two factor sign in is switched on (MFA_REQUIRED on the server). */
export function IfMfa({ children }: { children: ReactNode }) {
  return useMfaRequired() ? <>{children}</> : null;
}
