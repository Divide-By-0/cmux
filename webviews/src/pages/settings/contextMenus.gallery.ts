// l10n-allow-file: gallery fixtures, not shipped UI.
// Settings > Menus (ContextMenusCard): the list of right-click menus beside the chosen menu drawn
// as a menu, More open beneath its row, Hidden rows after it.
import { settingsPageEntry, type PageFixtureStep, type SettingsPageVariant } from "../../gallery/format";
import { mockContextMenus, setMockMenuLayout } from "./mockMenus";

const shown: PageFixtureStep = { selector: '[data-card="context-menus"]', action: "wait" };
const base = mockContextMenus();
const variant = (focus: string, note: string, menus = base): SettingsPageVariant => ({
  section: "menus",
  focus,
  host: { context_menus: menus },
  steps: [shown],
  note,
});

const customized = setMockMenuLayout(base, "workspaceRow", {
  top: ["workspace.copyPath", "renameWorkspace", "-", "palette.toggleWorkspacePin", "palette.workspaceColor", "workspace.newBelow", "folder:move", "-", "moveWorkspaceToGroup", "-", "folder:more", "-", "closeWorkspace"],
  more: ["palette.markWorkspaceUnread"],
  hidden: ["workspace.duplicate"],
});

export default settingsPageEntry({
  id: "pages.settings-menus",
  title: "Settings Menus",
  area: "Settings",
  height: 760,
  covers: ["pages/settings/components/ContextMenusCard.tsx", "pages/settings/menuLayouts.ts"],
  anchors: [{ selector: '[data-card="context-menus"]' }],
  variants: {
    generated: variant("workspaceRow", "The Workspace menu as the app makes it: More open beneath its row, Reset off."),
    customized: variant(
      "workspaceRow",
      "Copy Path promoted out of More to the top, Rename after it, Mark as Unread moved into More, Duplicate hidden; the list marks Workspace as edited.",
      customized,
    ),
    terminal: variant("terminalSelection", "Customize Menu… from a terminal opens the Terminal menu."),
  },
});
