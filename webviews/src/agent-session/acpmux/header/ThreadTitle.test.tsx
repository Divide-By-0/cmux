import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ChatMenuItem } from "./ChatHeaderTools";
import { ThreadTitle } from "./ThreadTitle";

let dom: JSDOM | undefined;
let root: Root | undefined;
const scope = globalThis as Record<string, unknown>;
const saved = new Map<string, unknown>();

function installDom(): HTMLElement {
  dom = new JSDOM("<!doctype html><html><body><main id=root></main></body></html>");
  const requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "Element", "IS_REACT_ACT_ENVIRONMENT"])
    saved.set(key, scope[key]);
  saved.set("requestAnimationFrame", scope.requestAnimationFrame);
  saved.set("cancelAnimationFrame", scope.cancelAnimationFrame);
  Object.assign(scope, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    requestAnimationFrame,
    cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return dom.window.document.getElementById("root")!;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  dom?.window.close();
  dom = undefined;
  for (const [key, value] of saved) {
    if (value === undefined) delete scope[key];
    else scope[key] = value;
  }
  saved.clear();
});

const rows = (): ChatMenuItem[] => [
  { key: "rename", label: "Rename", icon: "action.edit", onSelect: () => undefined },
  { key: "delete", label: "Delete", icon: "tab.close", disabled: true },
];

test("the chat title is a labelled, keyboard-focusable menu trigger", async () => {
  const container = installDom();
  root = createRoot(container);
  await act(async () => {
    root!.render(<ThreadTitle title="Phone to computer connection" menu={rows} />);
  });
  const trigger = container.querySelector<HTMLButtonElement>(".acpmux-thread-title-trigger");
  expect(trigger).not.toBeNull();
  expect(trigger?.getAttribute("aria-label")).toBe("Phone to computer connection");
  expect(trigger?.title).toBe("Phone to computer connection");
  expect(trigger?.textContent).toContain("Phone to computer connection");
  expect(trigger?.querySelector(".acpmux-thread-title-chevron")).not.toBeNull();
});

test("refreshes menu rows before opening and opens from keyboard", async () => {
  const container = installDom();
  root = createRoot(container);
  let refreshed = false;
  const dynamicRows = (): ChatMenuItem[] => [
    { key: "rename", label: refreshed ? "Fresh Rename" : "Stale Rename", icon: "action.edit" },
  ];
  await act(async () => {
    root!.render(
      <ThreadTitle
        title="A chat"
        menu={dynamicRows}
        onMenuOpen={async () => {
          await Promise.resolve();
          refreshed = true;
        }}
      />,
    );
  });
  const trigger = container.querySelector<HTMLButtonElement>(".acpmux-thread-title-trigger")!;
  trigger.focus();
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(container.textContent).toContain("Fresh Rename");
});

