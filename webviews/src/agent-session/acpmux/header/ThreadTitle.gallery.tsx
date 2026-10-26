// l10n-allow-file: gallery-only sample labels, not shipped UI.
import { componentEntry } from "../../../gallery/format";
import type { Play } from "../../../gallery/play";
import type { ChatMenuItem } from "./ChatHeaderTools";
import { ThreadTitle } from "./ThreadTitle";

const menuRows = (): ChatMenuItem[] => [
  { key: "rename", label: "Rename", icon: "action.edit", shortcutAction: "renameTab", onSelect: () => undefined },
  { key: "fork", label: "Fork", icon: "agent.fork", shortcutAction: "chat.fork", onSelect: () => undefined },
  {
    key: "move",
    label: "Move to machine",
    icon: "machine.remote",
    children: [
      { key: "local", label: "This Mac", onSelect: () => undefined },
      { key: "remote", label: "Build Mac", onSelect: () => undefined },
    ],
  },
  {
    key: "open",
    label: "Open in",
    icon: "app.open.external",
    children: [
      { key: "browser", label: "Browser", onSelect: () => undefined },
      { key: "terminal", label: "Terminal", onSelect: () => undefined },
      { key: "window", label: "New window", onSelect: () => undefined },
    ],
  },
  { key: "archive", label: "Archive", icon: "inbox", onSelect: () => undefined },
  { key: "delete", label: "Delete", icon: "tab.close", disabled: true },
];

function TitleMenuGallery({ title }: { title: string }) {
  return (
    <div className="acpmux-shell acpmux-thread-title-gallery">
      <header className="acpmux-header">
        <div className="acpmux-header-status-slot">
          <ThreadTitle title={title} menu={menuRows} />
        </div>
        <div className="acpmux-header-tools" />
      </header>
      <main className="acpmux-thread-title-gallery-copy">
        <p>Click the title to rename, fork, move or open this chat.</p>
        <p className="acpmux-muted">Delete stays disabled until the host exposes a real chat-delete action.</p>
      </main>
    </div>
  );
}

const open: Play = async (ctx) => {
  await ctx.click({ selector: ".acpmux-thread-title-trigger" });
  await ctx.waitFor(() => ctx.document.querySelector('[role="menu"]'));
};

export default componentEntry<{ title: string }>({
  id: "agent-pane.thread-title",
  title: "Chat title menu",
  area: "Agent pane",
  pane: true,
  height: 240,
  widths: { narrow: 360, normal: 520, wide: 760 },
  anchors: [{ selector: ".acpmux-thread-title-gallery" }],
  covers: [
    "agent-session/acpmux/header/ThreadTitle.tsx#ThreadTitle",
    "agent-session/acpmux/header/ChatHeaderTools.tsx#ChatMenu",
  ],
  styles: () => Promise.all([import("../styles.css"), import("./header.css"), import("./ThreadTitle.gallery.css")]),
  load: async () => TitleMenuGallery,
  variants: {
    short: {
      props: { title: "Phone to computer connection" },
      play: open,
      note: "The title is a button with a chevron; click opens the instant glass action menu.",
    },
    long: {
      props: { title: "Investigate the flaky reconnect path across the build fleet" },
      play: open,
      note: "Long titles ellipsize inside the control while the chevron and header stay in place.",
    },
    remote: {
      props: { title: "Review remote agent output" },
      play: open,
      note: "Move to machine and Open in use nested submenus, matching the existing header menu grid.",
    },
  },
});

