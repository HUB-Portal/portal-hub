// Types and shared queries for the K Line staff console. Response shapes follow docs/PHASE3_CONTRACT.md.
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';
import type { CaseItem } from './types';

export interface ConsoleOverview {
  intakeWaiting: number;
  readyForMes: { count: number; waitingOver4h: number };
  inProduction: number;
  shippedLast7Days: number;
  openClaims: number;
  lateCases: number;
  siteLoad: { siteCode: string; name?: string; ready: number; inProduction: number }[];
  mesHealth: { lastEventAt: string | null; events24h: number; errors24h: number };
  security: { failedSignIns24h: number; malwareFiles24h: number };
  partners: { id: string; name: string; code: string; status: string; country?: string | null; dpaOnFile: boolean; sccOnFile: boolean; siteCodes: string[] }[];
  newSignups: number;
}

export interface ConsoleCaseList { items: CaseItem[]; total: number; page: number; pageSize: number }

export interface SiteRow {
  id: string;
  code: string;
  name: string;
  country: string;
  inEea: boolean;
  hasAdequacy: boolean;
  active: boolean;
  city?: string | null;
  openCases?: number;
}

export function useOverview(enabled = true) {
  return useQuery({ queryKey: ['console-overview'], queryFn: () => api<ConsoleOverview>('/api/console/overview'), enabled, staleTime: 30_000 });
}

/** All sites; only for users with admin.sites. */
export function useSites() {
  const { can } = useAuth();
  return useQuery({ queryKey: ['sites'], queryFn: () => api<{ items: SiteRow[] }>('/api/sites'), select: (d) => ({ sites: d.items }), enabled: can('admin.sites'), staleTime: 60_000 });
}

/** Partner and site options for filters. Staff who can manage partners read the partner list, others use the overview. */
export function useFilterOptions() {
  const { can } = useAuth();
  const adminPartners = can('admin.partners');
  const ov = useOverview(can('case.read') && !adminPartners);
  const list = useQuery({
    queryKey: ['partners'],
    queryFn: () => api<{ items: { id: string; name: string; code: string; status: string }[] }>('/api/partners'),
    enabled: adminPartners,
    staleTime: 60_000,
  });
  const sites = useSites();
  const partners = adminPartners ? (list.data?.items ?? []) : (ov.data?.partners ?? []);
  const siteCodes = sites.data?.sites.map((s) => s.code) ?? ov.data?.siteLoad.map((s) => s.siteCode) ?? [];
  return { partners, siteCodes };
}
