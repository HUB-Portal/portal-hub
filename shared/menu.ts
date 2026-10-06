/**
 * Menu visibility (VISIBILITY ONLY, never access control).
 *
 * Administrators of a partner company choose which optional menu items the other people of their company see.
 * This changes what the web app shows. It never changes a role, a permission or a server route: a person who
 * can reach an API route by role still can, and a person who may not still gets 403.
 */
export const MENU_KEYS = ['claims', 'spec', 'materials'] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

/** `admins` (the default): only company administrators see the item. `everyone`: everybody whose role allows it sees it. */
export const MENU_VALUES = ['admins', 'everyone'] as const;
export type MenuValue = (typeof MENU_VALUES)[number];

/** What the current person sees in the menu. */
export type MenuVisible = Record<MenuKey, boolean>;
/** What the company administrators have set. */
export type MenuSetting = Record<MenuKey, MenuValue>;

export const MENU_LABEL: Record<MenuKey, string> = { claims: 'Quality claims', spec: 'Production spec', materials: 'Materials' };
