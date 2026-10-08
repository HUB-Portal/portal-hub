import { createEffect, onCleanup } from 'solid-js';

/** Asks the browser to confirm before the tab is closed or left, while `active()` is true (for example while files are still uploading). */
export function useLeaveWarning(active: () => boolean): void {
  createEffect(() => {
    if (!active()) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    onCleanup(() => window.removeEventListener('beforeunload', warn));
  });
}
