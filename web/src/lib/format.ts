import { SIMPLE_STATUS_LABELS, simpleStatus, type SimpleStatus } from '@shared/stages';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(v: string | Date | null | undefined): string {
  if (!v) return 'Not set';
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  if (Number.isNaN(d.getTime())) return 'Not set';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatDateTime(v: string | Date | null | undefined): string {
  if (!v) return 'Not set';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return 'Not set';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(d)}, ${hh}:${mm}`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-GB').format(n);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${formatNumber(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

export function humanise(s: string): string {
  const t = s.replace(/[._]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', submitted: 'Submitted', on_hold: 'On hold', ready: 'Ready for production', received: 'Received',
  in_production: 'In production', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled',
};
export function statusLabel(s: string): string { return STATUS_LABEL[s] ?? humanise(s); }

export type Tone = 'neutral' | 'info' | 'good' | 'warn' | 'bad';

/** The four statuses partners see (Draft, Submitted, Production, Shipped), plus Cancelled. */
export function simpleStatusOf(c: { status: string; simpleStatus?: SimpleStatus }): SimpleStatus {
  return c.simpleStatus ?? simpleStatus(c);
}
export function simpleStatusLabel(s: SimpleStatus): string { return SIMPLE_STATUS_LABELS[s]; }
export function simpleStatusTone(s: SimpleStatus): Tone {
  return s === 'draft' ? 'neutral' : s === 'shipped' ? 'good' : s === 'cancelled' ? 'bad' : 'info';
}

export function statusTone(s: string): Tone {
  switch (s) {
    case 'draft': return 'neutral';
    case 'on_hold': return 'warn';
    case 'cancelled': return 'bad';
    case 'shipped': case 'delivered': return 'good';
    default: return 'info';
  }
}

export function archLabel(a: string | null): string { return a === 'upper' ? 'Upper' : a === 'lower' ? 'Lower' : 'No arch'; }

export function stepLabel(step: number | null, template = false): string {
  if (step === null) return 'No step';
  if (template) return step === 0 ? 'Template' : `Step ${step} template`;
  return `Step ${step}`;
}

const EVENT_LABEL: Record<string, string> = {
  created: 'Case created', submitted: 'Case submitted', resubmitted: 'Case submitted again', files_checked: 'Files checked', documents_added: 'Documents added',
  stage: 'Stage changed', stage_reported: 'Stage reported', on_hold: 'Put on hold', released: 'Released from hold',
  cancelled: 'Case cancelled', routed: 'Approved and sent to a site', rerouted: 'Sent to another site', claim_opened: 'Claim opened',
  replacement_ordered: 'Replacement ordered', rework_ordered: 'Rework ordered', instructions_updated: 'Instructions updated',
  purged: 'Data removed', erased: 'Case data erased', portal_pushed: 'Sent to the K Line customer portal', portal_push_failed: 'Sending to the customer portal failed',
};
export function eventLabel(t: string): string { return EVENT_LABEL[t] ?? humanise(t); }

const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Signed in', 'auth.login_failed': 'Failed sign in', 'auth.logout': 'Signed out',
  'auth.password_changed': 'Password changed', 'auth.password_reset': 'Password reset', 'auth.step_up': 'Confirmed authenticator code',
  'auth.mfa_enrolled': 'Authenticator set up', 'auth.session_revoked': 'Session ended', 'auth.recovery_codes_regenerated': 'Recovery codes replaced',
  'team.invited': 'Team member invited', 'team.roles_changed': 'Roles changed', 'team.disabled': 'Team member disabled',
  'team.enabled': 'Team member enabled', 'team.mfa_reset': 'Authenticator reset', 'team.invite_resent': 'Invitation sent again',
  'team.unlocked': 'Team member unlocked', 'staff.unlocked': 'Staff member unlocked', 'auth.mfa_locked': 'Account locked after wrong codes', 'auth.mfa_failed': 'Wrong authenticator code', 'auth.recovery_failed': 'Wrong recovery code',
  'case.name_revealed': 'Patient name shown', 'case.package_downloaded': 'Production package downloaded', 'case.submitted': 'Case submitted', 'case.resubmitted': 'Case submitted again',
  'case.routed': 'Case sent to a site', 'case.rerouted': 'Case moved to another site', 'case.held': 'Case put on hold', 'case.released': 'Case released from hold', 'case.stage_updated': 'Stage updated by staff', 'case.bags_csv': 'Bag print file downloaded',
  'case.erased': 'Case data erased on request', 'case.purged': 'Case data removed after the retention period', 'case.transfer_blocked': 'Case put on hold: transfer not covered',
  'org.bag_layout_updated': 'Bag layout changed', 'org.logo_changed': 'Company logo changed', 'org.logo_updated': 'Company logo changed', 'org.logo_removed': 'Company logo removed', 'org.brand_logo_updated': 'Brand logo changed', 'org.brand_logo_removed': 'Brand logo removed', 'mes.stage_map_updated': 'Stage map changed', 'mes.events_imported': 'Factory events imported',
  'service_key.created': 'Service key created', 'service_key.revoked': 'Service key revoked', 'site.created': 'Site added', 'site.updated': 'Site changed',
  'partner.settings_updated': 'Partner settings changed', 'partner.sites_updated': 'Partner sites changed', 'partner.agreement_added': 'Agreement recorded', 'partner.agreement_removed': 'Agreement removed', 'partner.activated': 'Partner activated', 'partner.suspended': 'Partner suspended',
  'file.download': 'File downloaded', 'file.view': 'File viewed', 'audit.verified': 'Audit chain checked',
};
export function actionLabel(a: string): string { return ACTION_LABEL[a] ?? humanise(a); }

export const DEMO_PORTAL_TEXT = 'Demo only, nothing was sent to the K Line portal';
export function portalLabel(s: string, demo = false): string {
  if (demo && s === 'pushed') return DEMO_PORTAL_TEXT;
  return ({ not_applicable: 'Not needed', pending: 'Waiting to send', pushing: 'Sending', pushed: 'Sent to portal', failed: 'Sending failed' } as Record<string, string>)[s] ?? humanise(s);
}
export function portalTone(s: string, demo = false): Tone {
  if (demo && s === 'pushed') return 'warn';
  return s === 'pushed' ? 'good' : s === 'failed' ? 'bad' : s === 'pending' || s === 'pushing' ? 'info' : 'neutral';
}

/**
 * One plain status for a case, with what the partner should do next (review of 8 Oct 2026, A2). It replaces the three competing labels a row
 * used to carry (Submitted, Clean, Sending failed). A failed hand over to the K Line portal is K Line's problem and reads as a delay, with no
 * action for the partner, unless the case address is missing.
 */
export function caseStatus(c: { status: string; manufacturingMode?: string; stageLabel?: string | null; checks: { errors: unknown[]; warnings: unknown[] }; portal: { status: string; actionNeeded?: string; demo?: boolean } }): { text: string; tone: Tone; next: string | null } {
  const direct = c.manufacturingMode === 'direct';
  switch (c.status) {
    case 'draft':
      return { text: 'Draft, ready to send', tone: 'info', next: 'Send to K Line' };
    case 'on_hold':
      return { text: 'On hold', tone: 'warn', next: 'Fix what K Line asked for, then send again' };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'neutral', next: null };
    case 'submitted':
    case 'ready':
      if (direct && c.portal.status === 'failed') {
        return c.portal.actionNeeded === 'case_address'
          ? { text: 'Waiting for your shipping address', tone: 'warn', next: 'Add the shipping address' }
          : { text: 'Problem on our side', tone: 'info', next: 'We are fixing it, no action needed' };
      }
      if (direct && c.portal.status === 'pushed') return { text: 'Received, K Line is processing', tone: 'good', next: null };
      return { text: direct ? 'Received, sending to K Line' : 'Submitted', tone: 'info', next: null };
    case 'received':
    case 'in_production':
      return { text: c.stageLabel ? `In production, ${c.stageLabel.toLowerCase()}` : 'In production', tone: 'info', next: null };
    case 'shipped':
      return { text: 'Shipped', tone: 'good', next: null };
    case 'delivered':
      return { text: 'Delivered', tone: 'good', next: null };
    default:
      return { text: humanise(c.status), tone: 'neutral', next: null };
  }
}

export function greeting(name: string, now = new Date()): string {
  const h = now.getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first ? `${part}, ${first}` : part;
}

export function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadTextFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
}

/** Who caused a case event, in plain words. */
export function sourceLabel(v: string | null | undefined): string {
  switch ((v ?? '').toLowerCase()) {
    case 'partner': case 'user': case 'api_key': return 'Partner';
    case 'kline': case 'k_line': case 'staff': return 'K Line';
    case 'system': return 'System';
    case 'mes': case 'service': case 'factory': return 'Factory system';
    default: return v ? humanise(v) : '';
  }
}

/** A short readable line from an audit details object. Never shows nested data. */
export function detailText(d: Record<string, unknown> | null): string {
  if (!d) return '';
  return Object.entries(d)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === 'string')))
    .slice(0, 5)
    .map(([k, v]) => `${humanise(k)}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join('. ');
}

export function relativeAge(v: string | Date | null | undefined, now = Date.now()): string {
  if (!v) return 'Never';
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return 'Never';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${formatNumber(mins)} ${mins === 1 ? 'minute' : 'minutes'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${formatNumber(hrs)} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hrs / 24);
  return `${formatNumber(days)} days ago`;
}

export function isLate(due: string | null | undefined, status: string): boolean {
  if (!due || ['shipped', 'delivered', 'cancelled', 'draft'].includes(status)) return false;
  return due < new Date().toISOString().slice(0, 10);
}
