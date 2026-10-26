import AppKit
@testable import CmuxNextActions
import Testing

/// Settings > Menus: a person's arrangement of a right-click menu (`ContextMenuLayout`) promotes
/// rows out of More, reorders, hides and adds separators, and the menu the registry builds is
/// that arrangement; a row the app adds later still shows where the app puts it.
@MainActor
struct ContextMenuLayoutTests {
    /// Each top-level row as the action it runs, the folder title for a folder, "—" for a separator.
    private func rows(_ menu: NSMenu) -> [String] {
        menu.items.map { item in
            if item.isSeparatorItem { return "—" }
            if ActionRegistry.isCustomizeItem(item) { return "Customize" }
            if let id = ActionRegistry.menuRun(of: item)?.id { return id.rawValue }
            if let folder = MenuFolder.allCases.first(where: { $0.title == item.title }) { return ContextMenuLayout.folderKey(folder) }
            return item.submenu?.items.lazy.compactMap { ActionRegistry.menuRun(of: $0)?.id.rawValue }.first ?? item.title
        }
    }

    private func allActions(_ menu: NSMenu) -> [String] {
        menu.items.flatMap { item in
            (ActionRegistry.menuRun(of: item).map { [$0.id.rawValue] } ?? []) + (item.submenu.map(allActions) ?? [])
        }
    }

    private func more(_ menu: NSMenu) -> NSMenu? {
        menu.items.first { $0.title == MenuFolder.more.title }?.submenu
    }

    private func registry() -> ActionRegistry {
        let registry = ActionRegistry.standard()
        for id: ActionID in ["palette.workspaceColor", "moveWorkspaceToGroup"] { registry.bind(id, invoke: { _ in }) }
        return registry
    }

    private let workspace = ActionTargetRef(kind: .workspace, id: "ws")
    private var generated: [ContextMenuEntry] { ContextMenuCatalog.shared.entries(for: .workspaceRow) }

    /// A row the generated menu shows directly in More.
    private var rowInMore: String {
        let shown = more(registry().makeContextMenu(for: .workspaceRow, target: workspace))?.items.compactMap(ActionRegistry.menuRun(of:))
        return shown!.first!.id.rawValue
    }

    @Test func noLayoutDrawsTheGeneratedMenu() {
        let plain = registry().makeContextMenu(for: .workspaceRow, target: workspace)
        let arranged = registry()
        arranged.contextMenuLayouts[.workspaceRow] = .generated(generated)
        #expect(rows(arranged.makeContextMenu(for: .workspaceRow, target: workspace)) == rows(plain))
        #expect(ContextMenuLayout.generated(generated).isGenerated(for: generated))
    }

    @Test func promotingReorderingHidingAndSeparatorsShapeTheMenu() {
        let registry = registry()
        let promoted = rowInMore
        registry.contextMenuLayouts[.workspaceRow] = ContextMenuLayout(
            top: [promoted, "-", "renameWorkspace", "-", ContextMenuLayout.moreKey, "-", "closeWorkspace"],
            hidden: ["workspace.duplicate"])
        let menu = registry.makeContextMenu(for: .workspaceRow, target: workspace)
        let top = rows(menu)
        // The rows the layout names, in its order, with its separators; every other generated
        // top-level row is new to this layout, so it shows after the row it follows in the app's menu.
        #expect(Array(top.prefix(4)) == [promoted, "—", "renameWorkspace", "palette.toggleWorkspacePin"])
        #expect(top.last == "closeWorkspace")
        // Promoted: out of More, not twice.
        #expect(allActions(menu).filter { $0 == promoted }.count == 1)
        #expect(more(menu).map(allActions)?.contains(promoted) == false)
        // Hidden: nowhere, More included.
        #expect(!allActions(menu).contains("workspace.duplicate"))
    }

    @Test func movingARowIntoMoreLeadsMore() throws {
        let registry = registry()
        var layout = ContextMenuLayout.generated(generated)
        layout.top.removeAll { $0 == "renameWorkspace" }
        layout.more = ["renameWorkspace"]
        registry.contextMenuLayouts[.workspaceRow] = layout
        let menu = registry.makeContextMenu(for: .workspaceRow, target: workspace)
        #expect(!rows(menu).contains("renameWorkspace"))
        let moreMenu = try #require(more(menu))
        #expect(moreMenu.items.first.flatMap(ActionRegistry.menuRun(of:))?.id == "renameWorkspace")
    }

    @Test func aRowTheAppAddsLaterShowsWhereTheAppPutsIt() {
        // A layout saved before New Workspace Below existed: everything else as generated.
        var old = ContextMenuLayout.generated(generated)
        old.top.removeAll { $0 == "workspace.newBelow" }
        let registry = registry()
        registry.contextMenuLayouts[.workspaceRow] = old
        let plain = self.registry().makeContextMenu(for: .workspaceRow, target: workspace)
        #expect(rows(registry.makeContextMenu(for: .workspaceRow, target: workspace)) == rows(plain))
        // And a row the app no longer places is dropped, not drawn empty.
        var stale = ContextMenuLayout.generated(generated)
        stale.top.insert("retired.action", at: 0)
        stale.more = ["retired.other"]
        #expect(stale.normalized(against: generated) == .generated(generated))
    }

    @Test func aRowPromotedOutOfAFolderLeavesTheFolder() throws {
        let registry = registry()
        let units = ContextMenuLayout.units(in: generated)
        // Move ▸ is a top-level folder of the workspace menu.
        let move = ContextMenuLayout.folderKey(.move)
        let child = try #require(units.first { $0.home == move }?.key)
        var layout = ContextMenuLayout.generated(generated)
        layout.top.insert(child, at: 0)
        registry.contextMenuLayouts[.workspaceRow] = layout
        let menu = registry.makeContextMenu(for: .workspaceRow, target: workspace)
        #expect(rows(menu).first == child)
        #expect(allActions(menu).filter { $0 == child }.count == 1)
    }

    @Test func wholeMenusEndWithCustomizeMenuWhichOpensThatMenusEditor() throws {
        let registry = registry()
        var opened: [ActionMenuContext] = []
        registry.customizeMenu = { opened.append($0) }
        let menu = registry.makeContextMenu(for: .workspaceRow, target: workspace)
        let item = try #require(menu.items.last)
        #expect(ActionRegistry.isCustomizeItem(item))
        #expect(item.title == "Customize Menu…")
        #expect(menu.items.dropLast().last?.isSeparatorItem == true)
        let target = try #require(item.target as? NSObject)
        target.perform(try #require(item.action), with: item)
        #expect(opened == [.workspaceRow])

        // Rows a caller takes into another menu have none, and the person can turn it off.
        #expect(!registry.makeContextMenu(for: .workspaceRow, entries: [.action("renameWorkspace")]).items.contains(where: ActionRegistry.isCustomizeItem))
        #expect(!registry.makeContextMenu(for: .workspaceRow, target: workspace, customize: false).items.contains(where: ActionRegistry.isCustomizeItem))
        registry.showsCustomizeMenuItem = false
        #expect(!registry.makeContextMenu(for: .workspaceRow, target: workspace).items.contains(where: ActionRegistry.isCustomizeItem))
    }

    @Test func callSiteFiltersApplyAfterTheArrangement() {
        let registry = registry()
        let promoted = rowInMore
        var layout = ContextMenuLayout.generated(generated)
        layout.top.insert(promoted, at: 0)
        registry.contextMenuLayouts[.workspaceRow] = layout
        let entries = registry.contextMenuEntries(for: .workspaceRow, removing: [ActionID(rawValue: promoted)])
        #expect(!ContextMenuCatalog.shared.referencedIDs(entries).contains(ActionID(rawValue: promoted)))
    }

    @Test func settingsListsEveryMenuOnce() {
        #expect(Set(ActionMenuContext.editorOrder) == Set(ActionMenuContext.allCases))
        #expect(ActionMenuContext.editorOrder.count == ActionMenuContext.allCases.count)
        let menus = registry().contextMenuEditorMenus()
        let workspaceMenu = menus.first { $0.context == .workspaceRow }
        #expect(workspaceMenu?.isCustomized == false)
        #expect(workspaceMenu?.rows.contains { $0.key == "renameWorkspace" && $0.home == nil } == true)
        #expect(workspaceMenu?.rows.contains { $0.key == ContextMenuLayout.moreKey && $0.kind == .folder } == true)
    }
}
