import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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
  const manage = can('integration.manage');
  const exporting = can('export.run');
  const org = useQuery({ queryKey: ['org'], queryFn: () => api<OrgInfo>('/api/org'), enabled: manage });
  const locked = org.data?.status === 'onboarding';

  const tabs = useMemo<TabDef[]>(() => [
    ...(manage ? [{ id: 'keys', label: 'API keys' }, { id: 'webhooks', label: 'Webhooks' }] : []),
    ...(exporting ? [{ id: 'exports', label: 'Exports' }] : []),
    ...(manage ? [{ id: 'developer', label: 'Developer notes' }] : []),
  ], [manage, exporting]);

  const asked = params.get('tab') ?? '';
  const active = tabs.find((t) => t.id === asked)?.id ?? tabs[0]?.id ?? '';
  const select = (id: string) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', id); return n; }, { replace: true });

  return (
    <div className="page">
      <PageHeader
        title="ERP and API"
        subtitle={manage ? 'Connect your own systems: keys, webhooks and CSV exports.' : 'Download your cases as CSV files.'}
      />
      {tabs.length === 0 ? <Notice tone="warn">You do not have access to anything on this page.</Notice> : null}
      {tabs.length ? <Tabs tabs={tabs} active={active} onChange={select} label="ERP and API sections" idPrefix={PREFIX} /> : null}
      {active === 'keys' ? <TabPanel id="keys" idPrefix={PREFIX}><ApiKeysTab locked={locked} /></TabPanel> : null}
      {active === 'webhooks' ? <TabPanel id="webhooks" idPrefix={PREFIX}><WebhooksTab locked={locked} /></TabPanel> : null}
      {active === 'exports' ? <TabPanel id="exports" idPrefix={PREFIX}><ExportsTab /></TabPanel> : null}
      {active === 'developer' ? <TabPanel id="developer" idPrefix={PREFIX}><DeveloperTab /></TabPanel> : null}
    </div>
  );
}
