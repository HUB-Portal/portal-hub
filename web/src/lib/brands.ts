import { createQuery } from '@tanstack/solid-query';
import { api } from './api';

/** The partner's brands, for the brand picker. Quietly empty when the company has none. */
export function useBrands() {
  return createQuery(() => ({
    queryKey: ['brands'],
    retry: false,
    queryFn: async () => {
      const r = await api<any>('/api/org/brands');
      const list: any[] = Array.isArray(r) ? r : (r?.items ?? r?.brands ?? []);
      return list.filter((b) => b?.id && b?.name).map((b) => ({ id: String(b.id), name: String(b.name) }));
    },
  }));
}
