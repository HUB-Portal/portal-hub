# The web app is written in SolidJS

The web app (`web/`) was React 18. It is now SolidJS 1.9 with `@solidjs/router`, `@tanstack/solid-query` and `lucide-solid`. This file says how code is written in it, so new pages read like the ported ones. The server, the shared rules (`shared/`) and the styles (`styles/app.css`, the class names) did not change.

| Was | Is |
|---|---|
| `react`, `react-dom` | `solid-js`, `solid-js/web` |
| `react-router-dom` | `@solidjs/router` |
| `@tanstack/react-query` | `@tanstack/solid-query` |
| `lucide-react` | `lucide-solid` (same icon names, same `size` prop) |
| `@vitejs/plugin-react` | `vite-plugin-solid` |

## The one idea that matters

A Solid component function runs **once**. What changes later is not the function but the expressions in the JSX and inside `createEffect` / `createMemo`, and only when they call a signal, a store property or a prop. So:

* **Never destructure props.** `function Badge({ tone })` loses updates. Write `props.tone`. To split off some props use `splitProps(props, ['a', 'b'])`, to give defaults use `mergeProps({ tone: 'neutral' }, props)`.
* **Never copy a reactive value into a plain variable at the top of the component** (`const name = me()?.user.name`). Read it where it is used (in the JSX) or wrap it: `const name = () => me()?.user.name`.
* **No early `return` for a state** (`if (loading) return <Spinner />`). It runs once. Use `<Show when={...} fallback={...}>`, `<Switch>/<Match>`.
* **Lists** use `<For each={list()}>{(item, i) => ...}</For>` (keyed by item) or `<Index>`. No `.map()` in JSX for lists that change, and no `key=`.
* **Conditionals** in JSX (`{a() ? <X/> : <Y/>}`, `{a() && <X/>}`) do work, they are reactive. Use `<Show>` when the branch is big or you need the narrowed value (`<Show when={user()}>{(u) => <b>{u().name}</b>}</Show>`).

## Hook to primitive

| React | Solid |
|---|---|
| `const [x, setX] = useState(v)` | `const [x, setX] = createSignal(v)`; read with `x()`. `setX(v)` or `setX((p) => ...)` |
| list or object state edited by field | `createStore` (`import { createStore, produce } from 'solid-js/store'`) |
| `useEffect(fn, [dep])` | `createEffect(() => { dep(); ... })` (tracks what it reads). `createEffect(on(dep, fn))` to track one thing only. |
| `useEffect(fn, [])` and its cleanup | `onMount(fn)` and `onCleanup(fn)` |
| `useMemo(() => v, [deps])` | `const v = createMemo(() => ...)`, read `v()` |
| `useCallback` | not needed: define a plain function |
| `useRef` for a DOM node | `let el!: HTMLDivElement;` and `<div ref={el}>` (or `ref={(e) => ...}`) |
| `useRef` for a value that does not render | a plain `let` variable in the component |
| `useId()` | `createUniqueId()` |
| `useContext`, `createContext` | same names, from `solid-js` |
| `React.lazy`, `Suspense` | `lazy`, `Suspense` from `solid-js` |
| `children: ReactNode` | `children: JSX.Element` (`import type { JSX } from 'solid-js'`). Use `props.children`. |
| `className`, `htmlFor` | `class`, `for` |
| `<input onChange>` for typing | `<input onInput={(e) => set(e.currentTarget.value)}>`. Solid's `onChange` is the native one and fires on blur. For `<select>` and checkboxes `onChange` is right. |
| `value={x}` | `value={x()}`. For a `<select>`, set `value` on the select and keep the options plain. |
| `autoFocus`, `readOnly`, `maxLength`, `tabIndex`, `colSpan` | `autofocus`, `readOnly`/`readonly`, `maxLength`/`maxlength`, `tabIndex`, `colSpan`: the compiler tells you which one the types accept |
| `style={{ justifyContent: 'x' }}` | `style={{ 'justify-content': 'x' }}` (kebab-case keys) |
| `e.target.value` | `e.currentTarget.value` (the typed element) |
| `dangerouslySetInnerHTML` | `innerHTML` |
| `aria-*`, `data-*`, `role`, `id` | same |

`onClick` and the other handlers keep their names. A handler may be written `onClick={handler}` or `onClick={() => ...}`.

## Queries and mutations (`@tanstack/solid-query`)

The options go in a function, so they can depend on signals and route params:

```tsx
const params = useParams();
const q = createQuery(() => ({ queryKey: ['case', params.id], queryFn: () => api<CaseDetail>(`/api/cases/${params.id}`), enabled: !!params.id }));
// in JSX: q.isLoading, q.data?.case, q.isError, q.error  (read them inside JSX or an effect, do not destructure q)
const save = createMutation(() => ({ mutationFn: (body: Body) => api('/api/x', { method: 'PUT', body }), onSuccess: () => qc.invalidateQueries({ queryKey: ['x'] }) }));
// save.mutate(body), save.isPending, save.error
const qc = useQueryClient();
```

`createInfiniteQuery(() => ({...}))` the same way. Shared query hooks in `lib/` keep their React names (`useProfile`, `useCaseCounts`, `usePublicConfig`, `useOnboarding`, `useBrands`, `useOverview`, `useSites`, `useFilterOptions`, `useSpecPartners`, `useUserCaseAddress`, `useOrgLogo`). In Solid an argument that can change is passed as a function: `useCaseCounts(() => !isKline() && can('case.read'))`. They return a query (or an object with getters), so read their fields in JSX.

## Auth (`lib/auth.tsx`)

`const { me, loading, can, isKline, refresh, signOut } = useAuth();` Here `me`, `loading` and `isKline` are **accessors**: call them (`me()?.org?.kind`). `can('x.y')` is a function that reads them, so it is reactive when called in JSX or an effect. `useMenu(enabled?: () => boolean)` returns an object with the getters `claims`, `spec`, `materials`, `ready` (read as `menu.claims`, do not destructure). `useMfaRequired()` returns an accessor: `const mfa = useMfaRequired(); ... mfa()`. `<IfMfa>` still exists.

## Router (`@solidjs/router`)

| React Router | Solid router |
|---|---|
| `Link to=` | `A href=` (`import { A } from '@solidjs/router'`) |
| `NavLink` | `A` (adds `aria-current="page"` when active; `end` for exact) |
| `Navigate to= replace` | `Navigate href=` |
| `useNavigate()` | same; `nav('/x', { replace: true })` |
| `useParams()` | same; reactive: `params.id` inside JSX/effects/query options |
| `useSearchParams()` | same; `const [sp, setSp] = useSearchParams();` `sp.status` is a string or undefined; `setSp({ status: 'x' })` merges, `setSp({ status: undefined })` removes |
| `useLocation()` | same; `loc.pathname`, `loc.search`, `loc.state` |
| `<Outlet />` | the layout component's `props.children` |

## Icons

`import { Lock, Trash2 } from 'lucide-solid';` and use as `<Lock size={14} aria-hidden="true" />`. A class goes in `class=`. To pick an icon in a variable use `<Dynamic component={Icon} size={18} />` (`import { Dynamic } from 'solid-js/web'`).

## Layout of the code

* `lib/*.ts`: no UI. Pure rules (`bulkRows.ts`), the server gateway behind an interface (`bulkGateway.ts`), and the reactive work in `createXxx` / `useXxx` functions (`useBulkUploader.ts`, `useDetailSync.ts`).
* `ui/*.tsx`: small components that show what they are given.
* `pages/**`: one component per route, composing the above.
* Keep the CSS class names: the stylesheet did not change.
