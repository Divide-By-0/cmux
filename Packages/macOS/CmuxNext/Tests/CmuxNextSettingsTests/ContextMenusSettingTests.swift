import CmuxNextActions
import CmuxNextDesign
@testable import CmuxNextSettings
import Foundation
import Testing

/// Settings > Menus saves each right-click menu's arrangement in cmux.json `contextMenus`; the
/// registry draws what the file says, Reset removes the menu's key, and a bad entry is reported
/// without breaking the other menus.
@MainActor @Suite(.serialized) struct ContextMenusSettingTests {
    static func settings(_ json: String = "{}") throws -> (SettingsController, ActionRegistry, URL) {
        let home = FileManager.default.temporaryDirectory.appending(path: "cn-context-menus-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let url = home.appending(path: "cmux-next.json")
        try Data(json.utf8).write(to: url)
        let registry = ActionRegistry.standard()
        let settings = SettingsController(registry: registry, design: DesignSettings(), fileURL: url,
                                          managedReader: FixedManagedPreferenceReader(ManagedPreferences()), managedWatchFiles: [])
        return (settings, registry, home)
    }

    private static func file(_ home: URL) throws -> [String: Any]? {
        try JSONSerialization.jsonObject(with: Data(contentsOf: home.appending(path: "cmux-next.json"))) as? [String: Any]
    }

    @Test func aSavedLayoutReachesTheRegistryAndResetRemovesIt() async throws {
        let (settings, registry, home) = try Self.settings()
        defer { try? FileManager.default.removeItem(at: home) }
        await settings.reload()
        #expect(registry.contextMenuLayouts.isEmpty)

        let layout = ContextMenuLayout(top: ["renameWorkspace", "-", ContextMenuLayout.moreKey], more: ["workspace.duplicate"], hidden: ["home.messageAbout"])
        try await settings.setContextMenuLayout(layout, for: .workspaceRow)
        #expect(registry.contextMenuLayouts[.workspaceRow] == layout)
        let saved = try Self.file(home)?["contextMenus"] as? [String: Any]
        let workspace = (saved?["layouts"] as? [String: Any])?["workspaceRow"] as? [String: Any]
        #expect(workspace?["top"] as? [String] == ["renameWorkspace", "-", "folder:more"])
        #expect(workspace?["hidden"] as? [String] == ["home.messageAbout"])

        try await settings.setShowsCustomizeMenuItem(false)
        #expect(!registry.showsCustomizeMenuItem)

        // Reset: the menu's key goes, then the emptied layouts object; the menu is generated again.
        try await settings.setContextMenuLayout(nil, for: .workspaceRow)
        try await settings.setShowsCustomizeMenuItem(true)
        #expect(registry.contextMenuLayouts[.workspaceRow] == nil)
        #expect(registry.showsCustomizeMenuItem)
        #expect(try Self.file(home)?["contextMenus"] == nil)
    }

    @Test func aBadEntryIsReportedAndTheOthersApply() {
        var diagnostics: [SettingsDiagnostic] = []
        let root: JSONValue = ["contextMenus": [
            "showCustomizeItem": "yes",
            "layouts": [
                "tab": ["top": ["closeTab"], "hidden": ["duplicateTab"]],
                "notAMenu": ["top": []],
                "pane": ["top": "splitRight"],
            ],
        ]]
        let setting = ContextMenusSetting.parse(root, diagnostics: &diagnostics)
        #expect(setting.layouts == [.tab: ContextMenuLayout(top: ["closeTab"], hidden: ["duplicateTab"])])
        #expect(setting.showsCustomizeItem)
        #expect(Set(diagnostics.map(\.path)) == ["contextMenus.showCustomizeItem", "contextMenus.layouts.notAMenu", "contextMenus.layouts.pane"])
    }
}
