// Settings > Menus (ContextMenusCard): the person arranges each right-click menu. Customize
// Menu… opens the page on its menu; rows move out of More to the top level, into More, hide and
// show again where the app puts them; separators add and go; Reset saves no layout; rows reorder
// by drag. Every change saves the whole layout through cmux.settings.context_menus.set.
import { afterAll, expect, test } from "bun:test";
import { installDom } from "./testDom";

const restore = installDom();
afterAll(() => restore());
const { renderPage, settle, click, fire, ops } = await import("./testing");

type Layout = { top: string[]; more: string[]; hidden: string[] };
const SET = "cmux.settings.context_menus.set";

const editor = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-card="context-menus"]')!;
const topKeys = (container: HTMLElement) =>
  [...editor(container).querySelectorAll<HTMLElement>(".menu-preview > .menu-row")].map((row) =>
    row.classList.contains("menu-separator") ? "-" : row.dataset.key!,
  );
const row = (container: HTMLElement, key: string) =>
  editor(container).querySelector<HTMLElement>(`.menu-row[data-key="${key}"]`)!;
const button = (element: HTMLElement, label: string) =>
  [...element.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label")?.startsWith(label))!;
const lastSaved = (provider: Parameters<typeof ops>[0]) => (ops(provider, SET).at(-1) as { menu: string; layout: Layout | null });

test("Customize Menu… opens Settings > Menus on its menu", async () => {
  const page = await renderPage({ path: "/settings/menus?focus=tab" });
  await settle();
  expect(editor(page.container).dataset.menu).toBe("tab");
  expect(editor(page.container).querySelector(".menus-detail-title")?.textContent).toBe("Tab");
  // Another menu from the list.
  await click(editor(page.container).querySelector<HTMLElement>('.menus-list-item[data-menu="terminalSelection"]')!);
  expect(editor(page.container).dataset.menu).toBe("terminalSelection");
  page.unmount();
});

test("a row in More moves to the top level, just above More, and saves the menu", async () => {
  const page = await renderPage({ path: "/settings/menus?focus=workspaceRow" });
  await settle();
  // More is open: its rows show beneath it.
  expect(row(page.container, "workspace.copyPath").closest('[data-folder="folder:more"]')).not.toBeNull();
  await click(button(row(page.container, "workspace.copyPath"), "Move to Top Level"));
  const saved = lastSaved(page.provider);
  expect(saved.menu).toBe("workspaceRow");
  expect(saved.layout?.top.indexOf("workspace.copyPath")).toBe(saved.layout!.top.indexOf("folder:more") - 1);
  expect(topKeys(page.container)).toContain("workspace.copyPath");
  // Marked as edited in the list.
  expect(editor(page.container).querySelector('.menus-list-item[data-menu="workspaceRow"] .menus-edited')).not.toBeNull();
  page.unmount();
});

test("a row moves into More and a row in a folder moves out of it", async () => {
  const page = await renderPage({ path: "/settings/menus?focus=workspaceRow" });
  await settle();
  await click(button(row(page.container, "renameWorkspace"), "Move to More"));
  expect(lastSaved(page.provider).layout?.more).toEqual(["renameWorkspace"]);
  expect(topKeys(page.container)).not.toContain("renameWorkspace");
  // Move ▸ opens to show its rows; Move to Top lands above it.
  await click(row(page.container, "folder:move").querySelector<HTMLElement>(".menu-disclosure")!);
  await click(button(row(page.container, "palette.moveWorkspaceToTop"), "Move to Top Level"));
  const top = lastSaved(page.provider).layout!.top;
  expect(top.indexOf("palette.moveWorkspaceToTop")).toBe(top.indexOf("folder:move") - 1);
  page.unmount();
});

test("a hidden row leaves the menu and Show puts it back where the app puts it", async () => {
  const page = await renderPage({ path: "/settings/menus?focus=workspaceRow" });
  await settle();
  await click(button(row(page.container, "workspace.duplicate"), "Hide"));
  expect(lastSaved(page.provider).layout?.hidden).toEqual(["workspace.duplicate"]);
  expect(topKeys(page.container)).not.toContain("workspace.duplicate");
  const hidden = editor(page.container).querySelector<HTMLElement>("[data-hidden]")!;
  await click(button(hidden, "Show"));
  // Back after New Workspace Below, as generated: the menu is the app's again, so no layout.
  expect(lastSaved(page.provider).layout).toBeNull();
  const keys = topKeys(page.container);
  expect(keys.indexOf("workspace.duplicate")).toBe(keys.indexOf("workspace.newBelow") + 1);
  page.unmount();
});

test("separators add and go, and Reset brings back the app's menu", async () => {
  const page = await renderPage({ path: "/settings/menus?focus=terminalSelection" });
  await settle();
  const reset = () => editor(page.container).querySelector<HTMLButtonElement>('[data-action="reset"]')!;
  expect(reset().disabled).toBe(true);
  await click(editor(page.container).querySelector<HTMLElement>('[data-action="add-separator"]')!);
  expect(lastSaved(page.provider).layout?.top.at(-1)).toBe("-");
  expect(reset().disabled).toBe(false);
  const separators = editor(page.container).querySelectorAll<HTMLElement>(".menu-separator");
  await click(button(separators[0]!, "Remove Separator"));
  expect(lastSaved(page.provider).layout?.top).toEqual(["copy", "paste", "splitRight", "splitDown", "-", "clearTerminal", "-"]);
  await click(reset());
  expect(lastSaved(page.provider).layout).toBeNull();
  expect(topKeys(page.container)).toEqual(["copy", "paste", "-", "splitRight", "splitDown", "-", "clearTerminal"]);
  page.unmount();
});

test("dragging a row onto another puts it before that row; onto More, into More", async () => {
  const page = await renderPage({ path: "/settings/menus?focus=terminalSelection" });
  await settle();
  await fire(row(page.container, "clearTerminal"), "dragstart");
  await fire(row(page.container, "copy"), "dragover");
  await fire(row(page.container, "copy"), "drop");
  expect(lastSaved(page.provider).layout?.top.slice(0, 2)).toEqual(["clearTerminal", "copy"]);

  const workspace = await renderPage({ path: "/settings/menus?focus=workspaceRow" });
  await settle();
  await fire(row(workspace.container, "palette.toggleWorkspacePin"), "dragstart");
  await fire(row(workspace.container, "folder:more"), "dragover");
  await fire(row(workspace.container, "folder:more"), "drop");
  expect(lastSaved(workspace.provider).layout?.more).toEqual(["palette.toggleWorkspacePin"]);
  workspace.unmount();
  page.unmount();
});

test("the Customize Menu… switch turns the row off in every menu", async () => {
  const page = await renderPage({ path: "/settings/menus" });
  await settle();
  const toggle = page.container.querySelector<HTMLElement>('[data-card="context-menus-options"] [role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await click(toggle);
  expect(ops(page.provider, "cmux.settings.context_menus.show_item")).toEqual([{ show: false }]);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  page.unmount();
});
