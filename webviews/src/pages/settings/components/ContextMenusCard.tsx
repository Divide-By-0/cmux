// Settings > Menus: every right-click menu, arranged by the person (Swift `ContextMenuLayout`,
// cmux.json `contextMenus`). The list names each menu; the editor draws the chosen menu's top
// level as a menu, with More and the other submenus open beneath their rows. Rows reorder by
// dragging their grip (menuDrag.ts: pointer events, so the save is the person's gesture) or by
// their buttons, move into More or out of any submenu to the top level, hide, and take
// separators; Reset brings back the app's own menu. Customize Menu… at the end of a menu opens
// this page on it (`?focus=<menu>`).
import { useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { useSettingsRouter, useSettingsState, useStore } from "../context";
import { Switch } from "../editors/ToggleEditor";
import { Icon } from "../icons";
import { DRAG_THRESHOLD, dropTarget, isNoMove, lineOffset, rowBoxes, type DropTarget } from "../menuDrag";
import {
  MORE,
  addSeparator,
  demote,
  hide,
  isGenerated,
  moveTop,
  promote,
  removeSeparator,
  show,
  view,
  type TopItem,
} from "../menuLayouts";
import type { ContextMenuState, MenuLayout, MenuRow } from "../ops";
import { sectionHref } from "../router";
import { t } from "../strings";
import { ResetSpacer } from "./ResetButton";

const AREAS = ["workspace", "tabs", "terminal", "browser", "other"] as const;

/** What a drag carries: a top-level entry by index, or a row from More or a submenu by key. */
type Drag = { from: "top"; index: number } | { from: "child"; key: string };

/** A press on a grip: a drag once the pointer travels `DRAG_THRESHOLD`; where it would drop. */
type Dragging = { source: Drag; startY: number; dy: number; active: boolean; target: DropTarget | null; line: number | null };

const sameSource = (a: Drag, b: Drag) =>
  a.from === "top" ? b.from === "top" && a.index === b.index : b.from === "child" && a.key === b.key;

/** A row's SF Symbol (`symbol/<name>`, a template PNG) inked like the row's text: the image is an
 * alpha mask over a `currentColor` rect, as a macOS menu draws its template icons. */
function RowIcon({ symbol }: { symbol: string | null }) {
  const mask = useId();
  if (!symbol) return <span className="menu-row-icon" aria-hidden="true" />;
  const href = `symbol/${encodeURIComponent(encodeURIComponent(symbol))}`;
  return (
    <svg className="menu-row-icon" data-symbol={symbol} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <mask id={mask} style={{ maskType: "alpha" }}>
        <image href={href} width="16" height="16" preserveAspectRatio="xMidYMid meet" />
      </mask>
      <rect width="16" height="16" fill="currentColor" mask={`url(#${mask})`} />
    </svg>
  );
}

/** A row's button: its tooltip names the action only; its accessible name adds the row. */
function ActionButton({
  icon,
  action,
  row,
  onClick,
  disabled = false,
  iconClass,
}: {
  icon: string;
  action: string;
  row?: string;
  onClick: () => void;
  disabled?: boolean;
  iconClass?: string;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={row ? `${action}: ${row}` : action}
      title={action}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} className={iconClass} />
    </button>
  );
}

export function ContextMenusCard({ focus }: { focus: string | null }) {
  const store = useStore();
  const state = useSettingsState().host?.context_menus;
  const router = useSettingsRouter();
  const toggleId = useId();
  // The layout just saved, shown until the host lists bring it back, and the last write's refusal.
  const [pending, setPending] = useState<{ menu: string; layout: MenuLayout } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set([MORE]));
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const list = useRef<HTMLOListElement>(null);
  if (!state || state.menus.length === 0) return null;

  // The chosen menu is the route's focus: Customize Menu… opens `?focus=<menu>`, and picking a menu
  // here replaces it, so a later Customize Menu… always changes the route and selects its menu.
  const menu = state.menus.find((item) => item.id === focus) ?? state.menus[0]!;
  const hasMore = menu.rows.some((row) => row.key === MORE);
  const layout = pending?.menu === menu.id ? pending.layout : menu.layout;
  const shown = view(menu, layout);
  const generated = isGenerated(menu, layout);

  const save = (next: MenuLayout) => {
    const write = { menu: menu.id, layout: next };
    setPending(write);
    setFailure(null);
    store
      .setContextMenuLayout(menu.id, isGenerated(menu, next) ? null : next)
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)))
      .finally(() => setPending((current) => (current === write ? null : current)));
  };
  const toggleOpen = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Drops `source` on `target`: into More, or before top-level index `slot`. */
  const commit = (source: Drag, target: DropTarget) => {
    if ("intoMore" in target) {
      const key = source.from === "top" ? layout.top[source.index] : source.key;
      if (key && key !== "-" && key !== MORE) save(demote(layout, key));
    } else if (source.from === "top") {
      if (!isNoMove(source.index, target.slot)) save(moveTop(layout, source.index, source.index < target.slot ? target.slot - 1 : target.slot));
    } else save(promote(menu, layout, source.key, target.slot));
  };
  /** A grip's pointer handlers: capture on press, follow the pointer, save on release. */
  const grip = (source: Drag) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDragging({ source, startY: event.clientY, dy: 0, active: false, target: null, line: null });
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const element = list.current;
      if (!dragging || !sameSource(dragging.source, source) || !element) return;
      const dy = event.clientY - dragging.startY;
      if (!dragging.active && Math.abs(dy) < DRAG_THRESHOLD) return;
      const rows = rowBoxes(element);
      const moving = source.from === "top" ? layout.top[source.index] : source.key;
      const canEnterMore = hasMore && moving !== MORE && moving !== "-";
      let target: DropTarget | null = dropTarget(rows, event.clientY, layout.top.length, canEnterMore);
      if ("slot" in target && source.from === "top" && isNoMove(source.index, target.slot)) target = null;
      const line = target ? lineOffset(rows, target, element.getBoundingClientRect().top) : null;
      setDragging({ ...dragging, dy, active: true, target, line });
    },
    onPointerUp: () => {
      const done = dragging;
      setDragging(null);
      if (done?.active && done.target) commit(done.source, done.target);
    },
    onPointerCancel: () => setDragging(null),
  });
  /** A dragged row follows the pointer; the rest stay put, so nothing reflows mid-drag. */
  const lifted = (source: Drag) =>
    dragging?.active && sameSource(dragging.source, source)
      ? { "data-dragging": "", style: { transform: `translateY(${dragging.dy}px)` } }
      : {};
  const gripHandle = (source: Drag) => (
    <span className="menu-row-grip" aria-hidden="true" {...grip(source)}>
      <Icon name="grip" />
    </span>
  );

  const childRow = (row: MenuRow) => (
    <li key={row.key} className="menu-row menu-child" data-key={row.key} {...lifted({ from: "child", key: row.key })}>
      {gripHandle({ from: "child", key: row.key })}
      <RowIcon symbol={row.symbol} />
      <span className="menu-row-title">{row.title}</span>
      {row.kind !== "item" && <span className="menu-row-chevron" aria-hidden="true">›</span>}
      <span className="menu-row-actions">
        <ActionButton icon="arrow.up.to.line" action={t("settingsWindow.menus.moveToTop")} row={row.title} onClick={() => save(promote(menu, layout, row.key))} />
        <ActionButton icon="eye.slash" action={t("settingsWindow.menus.hide")} row={row.title} onClick={() => save(hide(layout, row.key))} />
      </span>
    </li>
  );

  const children = (key: string): ReactNode => {
    const rows = key === MORE ? shown.more : (shown.folders.get(key) ?? []);
    return (
      <ul className="menu-children" data-folder={key}>
        {rows.length === 0 ? <li className="menu-empty">{t("settingsWindow.menus.emptyFolder")}</li> : null}
        {rows.map((row) => (
          <FragmentRows key={row.key}>
            {childRow(row)}
            {row.kind === "folder" && (shown.folders.get(row.key)?.length ?? 0) > 0 ? (
              <li className="menu-nested">{children(row.key)}</li>
            ) : null}
          </FragmentRows>
        ))}
      </ul>
    );
  };

  const topRow = (item: TopItem, position: number, count: number) => {
    const title = item.kind === "row" ? item.row.title : t("settingsWindow.menus.separator");
    const up = (
      <ActionButton icon="chevron" iconClass="icon-up" action={t("settingsPage.moveUp")} row={title} disabled={position === 0} onClick={() => save(moveTop(layout, item.index, item.index - 1))} />
    );
    const down = (
      <ActionButton icon="chevron" action={t("settingsPage.moveDown")} row={title} disabled={position === count - 1} onClick={() => save(moveTop(layout, item.index, item.index + 1))} />
    );
    const source: Drag = { from: "top", index: item.index };
    if (item.kind === "separator") {
      const id = `sep-${item.index}`;
      return (
        <li key={id} className="menu-row menu-separator" data-top-index={item.index} {...lifted(source)}>
          {gripHandle(source)}
          <span className="menu-separator-line" aria-label={t("settingsWindow.menus.separator")} role="separator" />
          <span className="menu-row-actions">
            {up}
            {down}
            <ActionButton icon="xmark" action={t("settingsWindow.menus.removeSeparator")} onClick={() => save(removeSeparator(layout, item.index))} />
          </span>
        </li>
      );
    }
    const { row } = item;
    const folder = row.kind === "folder";
    const isMore = row.key === MORE;
    const expanded = folder && open.has(row.key);
    const intoMore = isMore && dragging?.active === true && dragging.target !== null && "intoMore" in dragging.target;
    return (
      <FragmentRows key={row.key}>
        <li
          className="menu-row"
          data-key={row.key}
          data-top-index={item.index}
          data-folder={folder ? "" : undefined}
          data-drop-into={intoMore ? "" : undefined}
          {...lifted(source)}
        >
          {gripHandle(source)}
          <RowIcon symbol={row.symbol} />
          {folder ? (
            <button type="button" className="menu-row-title menu-disclosure" aria-expanded={expanded} onClick={() => toggleOpen(row.key)}>
              {row.title}
            </button>
          ) : (
            <span className="menu-row-title">{row.title}</span>
          )}
          {row.kind !== "item" && <span className="menu-row-chevron" aria-hidden="true">›</span>}
          <span className="menu-row-actions">
            {up}
            {down}
            {isMore || !hasMore ? null : (
              <ActionButton icon="arrow.down.to.more" action={t("settingsWindow.menus.moveToMore")} row={row.title} onClick={() => save(demote(layout, row.key))} />
            )}
            <ActionButton icon="eye.slash" action={t("settingsWindow.menus.hide")} row={row.title} onClick={() => save(hide(layout, row.key))} />
          </span>
        </li>
        {expanded ? <li className="menu-nested">{children(row.key)}</li> : null}
      </FragmentRows>
    );
  };

  const areaTitle = (area: string) => t(`settingsWindow.menus.area.${area}`);

  return (
    <>
      <section className="group" data-card="context-menus-options">
        <div className="rows">
          <div className="row" tabIndex={-1}>
            <div className="row-main">
              <div className="row-label">
                <div className="row-title" id={toggleId}>
                  {t("settingsWindow.menus.customizeItem.title")}
                </div>
                <div className="row-help">{t("settingsWindow.menus.customizeItem.help")}</div>
              </div>
              <div className="row-control">
                <Switch
                  checked={state.show_customize_item}
                  disabled={false}
                  labelId={toggleId}
                  onToggle={(next) => {
                    setFailure(null);
                    store.setShowCustomizeMenuItem(next).catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
                  }}
                />
                <ResetSpacer />
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="group menus-editor" data-card="context-menus" data-menu={menu.id}>
        <nav className="menus-list" aria-label={t("settingsWindow.menus.listLabel")}>
          {AREAS.map((area) => {
            const menus = state.menus.filter((item) => item.area === area);
            if (menus.length === 0) return null;
            return (
              <div key={area} className="menus-area">
                <div className="menus-area-title">{areaTitle(area)}</div>
                {menus.map((item: ContextMenuState) => (
                  <button
                    key={item.id}
                    type="button"
                    className="menus-list-item"
                    data-menu={item.id}
                    aria-current={item.id === menu.id ? "true" : undefined}
                    onClick={() => router.history.replace(sectionHref("menus", item.id))}
                  >
                    <span>{item.title}</span>
                    {item.customized ? <span className="menus-edited" title={t("settingsWindow.menus.edited")} /> : null}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="menus-detail">
          <header className="menus-detail-header">
            <h3 className="menus-detail-title">{menu.title}</h3>
            <span className="menus-detail-spacer" />
            <button type="button" className="button" data-action="add-separator" onClick={() => save(addSeparator(layout))}>
              {t("settingsWindow.menus.addSeparator")}
            </button>
            <button type="button" className="button" data-action="reset" disabled={generated} onClick={() => save(menu.generated)}>
              {t("settingsWindow.menus.reset")}
            </button>
          </header>
          <p className="row-help menus-help">{t("settingsWindow.menus.help")}</p>
          {failure ? (
            <p className="menus-failure" role="alert" data-failure="">
              {failure}
            </p>
          ) : null}
          <ol className="menu-preview" data-menu-preview="" data-reordering={dragging?.active ? "" : undefined} ref={list}>
            {shown.top.map((item, position) => topRow(item, position, shown.top.length))}
            {dragging?.active && dragging.line !== null ? (
              <li className="menu-drop-line" aria-hidden="true" data-drop-line="" style={{ transform: `translateY(${dragging.line}px)` }} />
            ) : null}
          </ol>
          {shown.hidden.length > 0 ? (
            <div className="menus-hidden" data-hidden="">
              <div className="menus-area-title">{t("settingsWindow.menus.hidden")}</div>
              <ul className="menu-children">
                {shown.hidden.map((row) => (
                  <li key={row.key} className="menu-row menu-child" data-key={row.key}>
                    <RowIcon symbol={row.symbol} />
                    <span className="menu-row-title">{row.title}</span>
                    <span className="menu-row-actions">
                      <ActionButton icon="eye" action={t("settingsWindow.menus.show")} row={row.title} onClick={() => save(show(menu, layout, row.key))} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}

function FragmentRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
