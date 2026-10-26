// Settings > Menus: every right-click menu, arranged by the person (Swift `ContextMenuLayout`,
// cmux.json `contextMenus`). The list names each menu; the editor draws the chosen menu's top
// level as a menu, with More and the other submenus open beneath their rows. Rows reorder by
// drag or by their buttons, move into More or out of any submenu to the top level, hide, and take
// separators; Reset brings back the app's own menu. Customize Menu… at the end of a menu opens
// this page on it (`?focus=<menu>`).
import { useId, useState, type DragEvent, type ReactNode } from "react";
import { useSettingsRouter, useSettingsState, useStore } from "../context";
import { Switch } from "../editors/ToggleEditor";
import { Icon } from "../icons";
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

function RowIcon({ symbol }: { symbol: string | null }) {
  if (!symbol) return <span className="menu-row-icon" aria-hidden="true" />;
  const url = `url("symbol/${encodeURIComponent(encodeURIComponent(symbol))}")`;
  return <span className="menu-row-icon" data-symbol={symbol} style={{ maskImage: url, WebkitMaskImage: url }} aria-hidden="true" />;
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled = false,
  iconClass,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  iconClass?: string;
}) {
  return (
    <button type="button" className="icon-button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
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
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
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

  const endDrag = () => {
    setDrag(null);
    setDropAt(null);
  };
  const dropTarget = (id: string, onDrop: (drag: Drag) => void) => ({
    "data-drop": dropAt === id ? "" : undefined,
    onDragOver: (event: DragEvent) => {
      if (!drag) return;
      event.preventDefault();
      if (dropAt !== id) setDropAt(id);
    },
    onDragLeave: () => setDropAt((current) => (current === id ? null : current)),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      if (drag) onDrop(drag);
      endDrag();
    },
  });
  const dragSource = (source: Drag) => ({
    draggable: true,
    "data-dragging": drag && JSON.stringify(drag) === JSON.stringify(source) ? "" : undefined,
    onDragStart: (event: DragEvent) => {
      // A synthetic drag (tests, automation) carries no data transfer.
      const transfer = event.dataTransfer as DataTransfer | null;
      if (transfer) {
        transfer.effectAllowed = "move";
        transfer.setData("text/plain", source.from === "top" ? String(source.index) : source.key);
      }
      setDrag(source);
    },
    onDragEnd: endDrag,
  });
  /** Drops `dragged` before top-level position `index`. */
  const insertAt = (dragged: Drag, index: number) => {
    if (dragged.from === "top") save(moveTop(layout, dragged.index, dragged.index < index ? index - 1 : index));
    else save(promote(menu, layout, dragged.key, index));
  };

  const childRow = (row: MenuRow) => (
    <li key={row.key} className="menu-row menu-child" data-key={row.key} {...dragSource({ from: "child", key: row.key })}>
      <span className="menu-row-grip" aria-hidden="true">
        <Icon name="grip" />
      </span>
      <RowIcon symbol={row.symbol} />
      <span className="menu-row-title">{row.title}</span>
      {row.kind !== "item" && <span className="menu-row-chevron" aria-hidden="true">›</span>}
      <span className="menu-row-actions">
        <ActionButton icon="arrow.up.to.line" label={`${t("settingsWindow.menus.moveToTop")} ${row.title}`} onClick={() => save(promote(menu, layout, row.key))} />
        <ActionButton icon="eye.slash" label={`${t("settingsWindow.menus.hide")} ${row.title}`} onClick={() => save(hide(layout, row.key))} />
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
    const up = (
      <ActionButton icon="chevron" iconClass="icon-up" label={t("settingsPage.moveUp")} disabled={position === 0} onClick={() => save(moveTop(layout, item.index, item.index - 1))} />
    );
    const down = (
      <ActionButton icon="chevron" label={t("settingsPage.moveDown")} disabled={position === count - 1} onClick={() => save(moveTop(layout, item.index, item.index + 1))} />
    );
    if (item.kind === "separator") {
      const id = `sep-${item.index}`;
      return (
        <li key={id} className="menu-row menu-separator" data-index={item.index} {...dragSource({ from: "top", index: item.index })} {...dropTarget(id, (dragged) => insertAt(dragged, item.index))}>
          <span className="menu-row-grip" aria-hidden="true">
            <Icon name="grip" />
          </span>
          <span className="menu-separator-line" aria-label={t("settingsWindow.menus.separator")} role="separator" />
          <span className="menu-row-actions">
            {up}
            {down}
            <ActionButton icon="xmark" label={t("settingsWindow.menus.removeSeparator")} onClick={() => save(removeSeparator(layout, item.index))} />
          </span>
        </li>
      );
    }
    const { row } = item;
    const folder = row.kind === "folder";
    const isMore = row.key === MORE;
    const expanded = folder && open.has(row.key);
    // Dropping a row on More moves it into More; on any other row, before that row.
    const onDrop = (dragged: Drag) => {
      if (isMore && dragged.from === "top" && layout.top[dragged.index] !== MORE) {
        const key = layout.top[dragged.index]!;
        if (key !== "-") save(demote(layout, key));
      } else insertAt(dragged, item.index);
    };
    return (
      <FragmentRows key={row.key}>
        <li className="menu-row" data-key={row.key} data-folder={folder ? "" : undefined} {...dragSource({ from: "top", index: item.index })} {...dropTarget(row.key, onDrop)}>
          <span className="menu-row-grip" aria-hidden="true">
            <Icon name="grip" />
          </span>
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
              <ActionButton icon="arrow.down.to.more" label={`${t("settingsWindow.menus.moveToMore")} ${row.title}`} onClick={() => save(demote(layout, row.key))} />
            )}
            <ActionButton icon="eye.slash" label={`${t("settingsWindow.menus.hide")} ${row.title}`} onClick={() => save(hide(layout, row.key))} />
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
          <ol className="menu-preview" data-menu-preview="">
            {shown.top.map((item, position) => topRow(item, position, shown.top.length))}
            <li className="menu-drop-end" {...dropTarget("end", (dragged) => insertAt(dragged, layout.top.length))} aria-hidden="true" />
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
                      <ActionButton icon="eye" label={`${t("settingsWindow.menus.show")} ${row.title}`} onClick={() => save(show(menu, layout, row.key))} />
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
