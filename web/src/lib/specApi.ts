import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface SpecPartner {
  orgId: string;
  name: string;
  code: string;
  orgStatus: string;
  activeSpecId: string | null;
  activeVersion: number | null;
  activatedAt: string | null;
  proposed: { id: string; version: number; needsKlineSignature: boolean; needsPartnerSignature: boolean } | null;
  klineDrafts: number;
}

/** K Line staff: every partner with the state of its specification. */
export function useSpecPartners() {
  return useQuery({ queryKey: ['spec-partners'], queryFn: () => api<{ items: SpecPartner[] }>('/api/console/specs/partners'), select: (d) => d.items, staleTime: 30_000 });
}
