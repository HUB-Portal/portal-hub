import { createContext, createMemo, type JSX, onCleanup, Show, useContext } from 'solid-js';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { Navigate, useLocation } from '@solidjs/router';
import type { Permission } from '@shared/roles';
import { api, ApiError, onUnauthenticated, setCsrf } from './api';
import { MENU_KEYS, type MenuKey, type MenuVisible } from '@shared/menu';
import type { Me, OrgInfo } from './types';

/**
 * The signed in person. `me`, `loading` and `isKline` are accessors (call them: `me()`), and `can` reads them, so anything that calls them
 * inside JSX or an effect updates when the person signs in, signs out or changes. Never copy their values into a variable at the top of a component.
 */
interface AuthValue {
  me: () => Me | null;
  loading: () => boolean;
  can: (p: Permission) => boolean;
  refresh: () => Promise<Me | null>;
  signOut: () => Promise<void>;
  isKline: () => boolean;
}

const Ctx = createContext<AuthValue>();

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

export function AuthProvider(props: { children: JSX.Element }) {
  const qc = useQueryClient();
  const q = createQuery(() => ({ queryKey: ['me'], queryFn: fetchMe, staleTime: 60_000, retry: false, refetchOnWindowFocus: true }));
  const me = () => q.data ?? null;

  const off = onUnauthenticated(() => { qc.setQueryData(['me'], null); qc.removeQueries({ predicate: (x) => x.queryKey[0] !== 'me' }); });
  onCleanup(off);

  const permissions = createMemo(() => new Set<string>(me()?.permissions ?? []));

  const value: AuthValue = {
    me,
    loading: () => q.isLoading,
    can: (p) => permissions().has(p),
    isKline: () => me()?.org?.kind === 'kline',
    async refresh() {
      const m = await qc.fetchQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 0 });
      return m ?? null;
    },
    async signOut() {
      try { await api('/api/auth/logout', { method: 'POST', body: {}, quiet401: true }); } catch { /* the session may already be gone */ }
      setCsrf(null);
      // Do not use qc.clear(): it detaches the sign in query from the cache, so the app would keep its old signed in answer
      // and the sign in page would send the person straight back. Empty everything else and mark the person as signed out.
      await qc.cancelQueries();
      qc.removeQueries({ predicate: (x) => x.queryKey[0] !== 'me' });
      qc.setQueryData(['me'], null);
    },
  };

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
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
 * The result is reactive: read `claims`, `spec`, `materials` and `ready` inside JSX or an effect, and do not destructure it.
 */
export function useMenu(enabled: () => boolean = () => true): MenuVisible & { ready: boolean } {
  const { me, can, isKline } = useAuth();
  const seesAll = () => isKline() || can('org.edit');
  const q = createQuery(() => ({
    queryKey: ['org'],
    enabled: enabled() && !seesAll() && me()?.stage === 'full' && can('org.read'),
    queryFn: () => api<OrgInfo>('/api/org'),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  }));
  const state = createMemo(() => {
    if (seesAll()) return { ...MENU_ALL, ready: true };
    const m = q.data?.menu;
    const known = !!m && MENU_KEYS.every((k) => typeof m[k] === 'boolean');
    return { ...(known ? m : MENU_NONE), ready: known || q.isError || !can('org.read') } as MenuVisible & { ready: boolean };
  });
  return {
    get claims() { return state().claims; },
    get spec() { return state().spec; },
    get materials() { return state().materials; },
    get ready() { return state().ready; },
  };
}

export function homeFor(me: Me | null): string {
  if (!me) return '/login';
  if (me.stage === 'password') return '/mfa';
  if (me.stage === 'mfa_setup') return '/mfa-setup';
  return me.org?.kind === 'kline' ? '/console' : '/portal';
}

interface GuardProps {
  stage?: 'password' | 'mfa_setup' | 'full' | 'anon';
  perm?: Permission;
  /** Optional menu item that must be switched on for this person (visibility only). Sends people to the overview when it is off. */
  menu?: MenuKey;
  /** Allowed when the person has at least one of these. */
  anyOf?: Permission[];
  kind?: 'partner' | 'kline';
  children: JSX.Element;
}

/** Guard by sign in stage and optional permission. */
export function Guard(props: GuardProps) {
  const { me, loading, can } = useAuth();
  const loc = useLocation();
  const visible = useMenu(() => !!props.menu);
  const stage = () => props.stage ?? 'full';
  const denied = () => (!!props.perm && !can(props.perm)) || (!!props.anyOf && !props.anyOf.some((p) => can(p)));
  const waitingForMenu = () => !!props.menu && me()?.org?.kind === 'partner' && !visible.ready;
  const menuOff = () => !!props.menu && me()?.org?.kind === 'partner' && visible.ready && !visible[props.menu];

  return (
    <Show when={!loading()} fallback={<div class="page-loading" role="status">Loading</div>}>
      <Show
        when={stage() !== 'anon'}
        fallback={<Show when={me() && me()!.stage === 'full'} fallback={props.children}><Navigate href={homeFor(me())} /></Show>}
      >
        <Show when={me()} fallback={<Navigate href="/login" state={{ from: loc.pathname + loc.search }} />}>
          <Show when={me()!.stage === stage()} fallback={<Navigate href={homeFor(me())} />}>
            <Show when={!props.kind || me()!.org?.kind === props.kind} fallback={<Navigate href={homeFor(me())} />}>
              <Show when={!waitingForMenu()} fallback={<div class="page-loading" role="status">Loading</div>}>
                <Show when={!menuOff()} fallback={<Navigate href="/portal" />}>
                  <Show
                    when={!denied()}
                    fallback={
                      <div class="page">
                        <div class="notice notice-warn" role="alert">
                          <strong>You do not have access to this page.</strong> Ask an administrator in your organisation if you need it.
                        </div>
                      </div>
                    }
                  >
                    {props.children}
                  </Show>
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </Show>
    </Show>
  );
}
