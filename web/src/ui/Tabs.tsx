import { For, type JSX } from 'solid-js';

export interface TabDef { id: string; label: string }

/** Accessible tab list: arrow keys, Home and End move between tabs. The caller renders the panel with TabPanel. */
export function Tabs(props: { tabs: TabDef[]; active: string; onChange: (id: string) => void; label: string; idPrefix: string }) {
  const refs: Record<string, HTMLButtonElement | undefined> = {};
  function onKey(e: KeyboardEvent, i: number) {
    const tabs = props.tabs;
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const t = tabs[next]!;
    props.onChange(t.id);
    refs[t.id]?.focus();
  }
  return (
    <div class="tabs tabs-bar" role="tablist" aria-label={props.label}>
      <For each={props.tabs}>
        {(t, i) => (
          <button
            ref={(el) => { refs[t.id] = el; }}
            id={`${props.idPrefix}-tab-${t.id}`}
            type="button"
            role="tab"
            class="tab"
            aria-selected={props.active === t.id}
            aria-controls={`${props.idPrefix}-panel-${t.id}`}
            tabIndex={props.active === t.id ? 0 : -1}
            onClick={() => props.onChange(t.id)}
            onKeyDown={(e) => onKey(e, i())}
          >
            {t.label}
          </button>
        )}
      </For>
    </div>
  );
}

export function TabPanel(props: { id: string; idPrefix: string; children: JSX.Element }) {
  return <div role="tabpanel" id={`${props.idPrefix}-panel-${props.id}`} aria-labelledby={`${props.idPrefix}-tab-${props.id}`} class="stack-lg">{props.children}</div>;
}
