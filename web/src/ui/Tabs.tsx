import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef { id: string; label: string }

/** Accessible tab list: arrow keys, Home and End move between tabs. The caller renders the panel with TabPanel. */
export function Tabs({ tabs, active, onChange, label, idPrefix }: { tabs: TabDef[]; active: string; onChange: (id: string) => void; label: string; idPrefix: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const t = tabs[next]!;
    onChange(t.id);
    refs.current[t.id]?.focus();
  }
  return (
    <div className="tabs tabs-bar" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => { refs.current[t.id] = el; }}
          id={`${idPrefix}-tab-${t.id}`}
          type="button"
          role="tab"
          className="tab"
          aria-selected={active === t.id}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          tabIndex={active === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, idPrefix, children }: { id: string; idPrefix: string; children: ReactNode }) {
  return <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} className="stack-lg">{children}</div>;
}
