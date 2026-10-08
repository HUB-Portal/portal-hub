import { createMemo, Show } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { createQuery } from '@tanstack/solid-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { OrgInfo } from '../../lib/types';
import { Notice, PageHeader } from '../../ui/Common';
import { TabPanel, Tabs, type TabDef } from '../../ui/Tabs';
import { ApiKeysTab } from './integrations/ApiKeysTab';
import { DeveloperTab } from './integrations/DeveloperTab';
import { ExportsTab } from './integrations/ExportsTab';
import { WebhooksTab } from './integrations/WebhooksTab';

const PREFIX = 'erp';

export default function Integrations() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const manage = () => can('integration.manage');
  const exporting = () => can('export.run');
  const org = createQuery(() => ({ queryKey: ['org'], queryFn: () => api<OrgInfo>('/api/org'), enabled: manage() }));
  const locked = () => org.data?.status === 'onboarding';

  const tabs = createMemo<TabDef[]>(() => [
    ...(manage() ? [{ id: 'keys', label: 'API keys' }, { id: 'webhooks', label: 'Webhooks' }] : []),
    ...(exporting() ? [{ id: 'exports', label: 'Exports' }] : []),
    ...(manage() ? [{ id: 'developer', label: 'Developer notes' }] : []),
  ]);

  const asked = () => (typeof params.tab === 'string' ? params.tab : '');
  const active = () => tabs().find((t) => t.id === asked())?.id ?? tabs()[0]?.id ?? '';
  const select = (id: string) => setParams({ tab: id }, { replace: true });

  return (
    <div class="page">
      <PageHeader
        title="ERP and API"
        subtitle={manage() ? 'Connect your own systems: keys, webhooks and CSV exports.' : 'Download your cases as CSV files.'}
      />
      <Show when={tabs().length === 0}><Notice tone="warn">You do not have access to anything on this page.</Notice></Show>
      <Show when={tabs().length}><Tabs tabs={tabs()} active={active()} onChange={select} label="ERP and API sections" idPrefix={PREFIX} /></Show>
      <Show when={active() === 'keys'}><TabPanel id="keys" idPrefix={PREFIX}><ApiKeysTab locked={locked()} /></TabPanel></Show>
      <Show when={active() === 'webhooks'}><TabPanel id="webhooks" idPrefix={PREFIX}><WebhooksTab locked={locked()} /></TabPanel></Show>
      <Show when={active() === 'exports'}><TabPanel id="exports" idPrefix={PREFIX}><ExportsTab /></TabPanel></Show>
      <Show when={active() === 'developer'}><TabPanel id="developer" idPrefix={PREFIX}><DeveloperTab /></TabPanel></Show>
    </div>
  );
}
