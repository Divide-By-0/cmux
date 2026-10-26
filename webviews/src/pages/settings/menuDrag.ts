// Settings > Menus: reordering by pointer. A row is dragged by its grip with pointer events and
// pointer capture, never HTML5 drag and drop: a native drag runs in AppKit's drag loop, so the
// web view sees no mouse-up and the drop's save is not the person's gesture (the host refuses
// it), and per-row dragenter/dragleave made the drop line blink. Here the drop place comes from
// the pointer's height over the top-level rows, one line marks it, and the save runs on the
// pointer-up the web view does see.

/** A top-level row's place and size, from top to bottom: its index in the layout's `top`. */
export type RowBox = { index: number; top: number; bottom: number; isMore: boolean };

/** Where a drop lands: before top-level index `slot` (`top.length` for the end), or into More. */
export type DropTarget = { slot: number } | { intoMore: true };

/** Pointer travel before a press on a grip becomes a drag (a plain click on it does nothing). */
export const DRAG_THRESHOLD = 4;

/**
 * The drop target at pointer height `y` over `rows` (sorted top to bottom), for a layout of
 * `count` top-level entries. The middle half of the More row drops into More (`canEnterMore`);
 * elsewhere a row's upper half drops before it and its lower half after it.
 */
export function dropTarget(rows: RowBox[], y: number, count: number, canEnterMore: boolean): DropTarget {
  for (const row of rows) {
    const height = row.bottom - row.top;
    if (row.isMore && canEnterMore && y >= row.top + height / 4 && y <= row.bottom - height / 4) return { intoMore: true };
    if (y < row.top + height / 2) return { slot: row.index };
  }
  return { slot: count };
}

/** Whether dropping top-level entry `from` before `slot` leaves it where it is. */
export function isNoMove(from: number, slot: number): boolean {
  return slot === from || slot === from + 1;
}

/** The drop line's height inside the list for `target`: the top of the row it goes before, or the end. */
export function lineOffset(rows: RowBox[], target: DropTarget, listTop: number): number | null {
  if (!("slot" in target)) return null;
  const before = rows.find((row) => row.index === target.slot);
  if (before) return before.top - listTop;
  const last = rows.at(-1);
  return last ? last.bottom - listTop : 0;
}

/** The top-level rows of `list` (each carries `data-top-index`), as boxes in page coordinates. */
export function rowBoxes(list: HTMLElement): RowBox[] {
  return [...list.querySelectorAll<HTMLElement>(":scope > [data-top-index]")].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      index: Number(element.dataset.topIndex),
      top: rect.top,
      bottom: rect.bottom,
      isMore: element.dataset.key === "folder:more",
    };
  });
}
