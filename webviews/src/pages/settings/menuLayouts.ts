// Settings > Menus: the edits the page makes to a right-click menu's arrangement (Swift
// `ContextMenuLayout`). The app sends each menu's rows and its arrangement already normalized
// (every generated top-level row named once), so these edits keep that shape and the page saves
// the whole layout. What the app draws for a layout is decided in Swift; `view` shows the same:
// the top level in order, More with the rows moved into it and its own rows that stayed, and each
// folder's rows that were not moved out.
import type { ContextMenuState, MenuLayout, MenuRow } from "./ops";

export const SEPARATOR = "-";
export const MORE = "folder:more";

/** A row of the editor's top level: a menu row, or a separator at its index in `top`. */
export type TopItem = { kind: "row"; row: MenuRow; index: number } | { kind: "separator"; index: number };

export type MenuView = {
  top: TopItem[];
  /** More's rows: the ones moved into it, then its generated rows (and folders) that stayed. */
  more: MenuRow[];
  /** A folder's rows that stayed in it, by folder key (More's are in `more`). */
  folders: Map<string, MenuRow[]>;
  hidden: MenuRow[];
};

function rowsByKey(menu: ContextMenuState): Map<string, MenuRow> {
  return new Map(menu.rows.map((row) => [row.key, row]));
}

/** The rows the layout places itself: named at the top level, moved into More, or hidden. */
function placed(layout: MenuLayout): Set<string> {
  return new Set([...layout.top.filter((key) => key !== SEPARATOR), ...layout.more, ...layout.hidden]);
}

export function view(menu: ContextMenuState, layout: MenuLayout): MenuView {
  const rows = rowsByKey(menu);
  const taken = placed(layout);
  const stayed = (home: string) => menu.rows.filter((row) => row.home === home && !taken.has(row.key));
  const folders = new Map<string, MenuRow[]>();
  for (const row of menu.rows) if (row.kind === "folder" && row.key !== MORE) folders.set(row.key, stayed(row.key));
  const top: TopItem[] = layout.top.flatMap((key, index): TopItem[] => {
    if (key === SEPARATOR) return [{ kind: "separator", index }];
    const row = rows.get(key);
    return row ? [{ kind: "row", row, index }] : [];
  });
  const more = [...layout.more.flatMap((key) => rows.get(key) ?? []), ...stayed(MORE)];
  const hidden = layout.hidden.flatMap((key) => rows.get(key) ?? []);
  return { top, more, folders, hidden };
}

/** Whether `layout` is the app's own arrangement (Reset has nothing to do). */
export function isGenerated(menu: ContextMenuState, layout: MenuLayout): boolean {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((key, index) => key === b[index]);
  return same(layout.top, menu.generated.top) && layout.more.length === 0 && layout.hidden.length === 0;
}

function without(list: string[], key: string): string[] {
  return list.filter((item) => item !== key);
}

/** Moves the top-level entry at `from` to `to` (an index in `top` after the move). */
export function moveTop(layout: MenuLayout, from: number, to: number): MenuLayout {
  const top = [...layout.top];
  const [moved] = top.splice(from, 1);
  if (moved === undefined) return layout;
  top.splice(Math.max(0, Math.min(to, top.length)), 0, moved);
  return { ...layout, top };
}

/**
 * Puts `key` on the top level at `at`; by default just before the top-level row its folder
 * shows as (a row of More lands above More), else at the end. It leaves More and Hidden.
 */
export function promote(menu: ContextMenuState, layout: MenuLayout, key: string, at?: number): MenuLayout {
  const rows = rowsByKey(menu);
  const top = without(layout.top, key);
  let position = at;
  if (position === undefined) {
    let home = rows.get(key)?.home ?? null;
    while (home !== null && !top.includes(home)) home = rows.get(home)?.home ?? null;
    position = home === null ? top.length : top.indexOf(home);
  }
  top.splice(Math.max(0, Math.min(position, top.length)), 0, key);
  return { top, more: without(layout.more, key), hidden: without(layout.hidden, key) };
}

/** Moves `key` into More, after the rows already moved there. */
export function demote(layout: MenuLayout, key: string): MenuLayout {
  if (key === MORE) return layout;
  return {
    top: without(layout.top, key),
    more: [...without(layout.more, key), key],
    hidden: without(layout.hidden, key),
  };
}

/** Leaves `key` out of the menu everywhere. */
export function hide(layout: MenuLayout, key: string): MenuLayout {
  return { top: without(layout.top, key), more: without(layout.more, key), hidden: [...without(layout.hidden, key), key] };
}

/**
 * Shows a hidden row again where the app puts it: a top-level row after the row it follows in
 * the app's own menu (or first), any other row back in its folder.
 */
export function show(menu: ContextMenuState, layout: MenuLayout, key: string): MenuLayout {
  const next = { ...layout, hidden: without(layout.hidden, key) };
  const generated = menu.generated.top;
  const at = generated.indexOf(key);
  if (at < 0) return next;
  const anchor = generated
    .slice(0, at)
    .reverse()
    .find((item) => item !== SEPARATOR && next.top.includes(item));
  const top = [...next.top];
  top.splice(anchor === undefined ? 0 : top.indexOf(anchor) + 1, 0, key);
  return { ...next, top };
}

/** Adds a separator at `at` in the top level (the end by default). */
export function addSeparator(layout: MenuLayout, at: number = layout.top.length): MenuLayout {
  const top = [...layout.top];
  top.splice(at, 0, SEPARATOR);
  return { ...layout, top };
}

/** Removes the top-level entry at `index` when it is a separator. */
export function removeSeparator(layout: MenuLayout, index: number): MenuLayout {
  if (layout.top[index] !== SEPARATOR) return layout;
  return { ...layout, top: layout.top.filter((_, item) => item !== index) };
}
