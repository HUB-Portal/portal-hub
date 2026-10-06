import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import type { Permission } from '@shared/roles';
import { api, ApiError, onUnauthenticated, setCsrf } from './api';
import { MENU_KEYS, type MenuKey, type MenuVisible } from '@shared/menu';
import type { Me, OrgInfo } from './types';

interface AuthValue {
  me: Me | null;
  loading: boolean;
  can: (p: Permission) => boolean;
  refresh: () => Promise<Me | null>;
  signOut: () => Promise<void>;
  isKline: boolean;
}

const Ctx = createContext<AuthValue | null>(null);

async function fetchMe(): Promise<Me | null> {
  try {
    const me = await api<Me>('/api/auth/me', { quiet401: true });
    setCsrf(me.csrfToken);
    return me;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { setCsrf(null); return null; }
    throw e;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 60_000, retry: false, refetchOnWindowFocus: true });
  const me = q.data ?? null;

  useEffect(() => onUnauthenticated(() => { qc.setQueryData(['me'], null); qc.removeQueries({ predicate: (x) => x.queryKey[0] !== 'me' }); }), [qc]);

  const refresh = useCallback(async () => {
    const m = await qc.fetchQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 0 });
    return m ?? null;
  }, [qc]);

  const signOut = useCallback(async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: {}, quiet401: true }); } catch { /* the session may already be gone */ }
    setCsrf(null);
    // Do not use qc.clear(): it detaches the sign in query from the cache, so the app would keep its old signed in answer
    // and the sign in page would send the person straight back. Empty everything else and mark the person as signed out.
    await qc.cancelQueries();
    qc.removeQueries({ predicate: (x) => x.queryKey[0] !== 'me' });
    qc.setQueryData(['me'], null);
  }, [qc]);

  const value = useMemo<AuthValue>(() => {
    const perms = new Set<string>(me?.permissions ?? []);
    return { me, loading: q.isLoading, can: (p) => perms.has(p), refresh, signOut, isKline: me?.org?.kind === 'kline' };
  }, [me, q.isLoading, refresh, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider is missing');
  return v;
}

const MENU_ALL: MenuVisible = { claims: true, spec: true, materials: true };
const MENU_NONE: MenuVisible = { claims: false, spec: false, materials: false };

/**
 * Menu visibility for the signed in person (GET /api/org, field `menu`). VISIBILITY ONLY: this decides what the menu and the
 * pages show. The server still enforces every permission. K Line staff and company administrators always see everything.
 * `ready` is false while a non administrator's answer is still loading, so guards wait instead of redirecting too early.
 */
export function useMenu(enabled = true): MenuVisible & { ready: boolean } {
  const { me, can, isKline } = useAuth();
  const seesAll = isKline || can('org.edit');
  const q = useQuery({
    queryKey: ['org'],
    enabled: enabled && !seesAll && me?.stage === 'full' && can('org.read'),
    queryFn: () => api<OrgInfo>('/api/org'),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  if (seesAll) return { ...MENU_ALL, ready: true };
  const m = q.data?.menu;
  const known = !!m && MENU_KEYS.every((k) => typeof m[k] === 'boolean');
  return { ...(known ? m : MENU_NONE), ready: known || q.isError || !can('org.read') };
}

export function homeFor(me: Me | null): string {
  if (!me) return '/login';
  if (me.stage === 'password') return '/mfa';
  if (me.stage === 'mfa_setup') return '/mfa-setup';
  return me.org?.kind === 'kline' ? '/console' : '/portal';
}

/** Guard by sign in stage and optional permission. */
export function Guard({ stage = 'full', perm, anyOf, kind, menu, children }: { stage?: 'password' | 'mfa_setup' | 'full' | 'anon'; perm?: Permission; /** Optional menu item that must be switched on for this person (visibility only). Sends people to the overview when it is off. */ menu?: MenuKey; /** Allowed when the person has at least one of these. */ anyOf?: Permission[]; kind?: 'partner' | 'kline'; children: ReactNode }) {
  const { me, loading, can } = useAuth();
  const loc = useLocation();
  const visible = useMenu(!!menu);
  if (loading) return <div className="page-loading" role="status">Loading</div>;
  if (stage === 'anon') {
    if (me && me.stage === 'full') return <Navigate to={homeFor(me)} replace />;
    return <>{children}</>;
  }
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (me.stage !== stage) return <Navigate to={homeFor(me)} replace />;
  if (kind && me.org?.kind !== kind) return <Navigate to={homeFor(me)} replace />;
  if (menu && me.org?.kind === 'partner') {
    if (!visible.ready) return <div className="page-loading" role="status">Loading</div>;
    if (!visible[menu]) return <Navigate to="/portal" replace />;
  }
  if ((perm && !can(perm)) || (anyOf && !anyOf.some((p) => can(p)))) {
    return (
      <div className="page">
        <div className="notice notice-warn" role="alert">
          <strong>You do not have access to this page.</strong> Ask an administrator in your organisation if you need it.
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
