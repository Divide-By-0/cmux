import CmuxNextActions
import CmuxNextDesign
import CmuxNextPages
import CmuxNextSettings
import Foundation
import Testing

/// Settings > Menus' page route: the host lists carry every menu's rows and arrangement, a save
/// writes cmux.json `contextMenus` and reaches the menus, a layout equal to the generated menu
/// saves as none (so later app rows reach it), and only the person's click on Settings writes.
@MainActor @Suite(.serialized) struct ContextMenusPageProviderTests {
    private static let click = PageCallContext(page: "cmux.settings", userGesture: true)

    private static func route() async throws -> (ContextMenusPageProvider, ActionRegistry, URL) {
        let home = FileManager.default.temporaryDirectory.appending(path: "cn-menus-route-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let url = home.appending(path: "cmux-next.json")
        try Data("{}".utf8).write(to: url)
        let registry = ActionRegistry.standard()
        let settings = SettingsController(registry: registry, design: DesignSettings(), fileURL: url,
                                          managedReader: FixedManagedPreferenceReader(ManagedPreferences()), managedWatchFiles: [])
        await settings.reload()
        return (ContextMenusPageProvider { ContextMenusSettingsPage(registry: registry, settings: settings) }, registry, home)
    }

    private static func menu(_ route: ContextMenusPageProvider, _ id: String) -> JSONValue? {
        route.hostJSON["menus"]?.arrayValue?.first { $0["id"]?.stringValue == id }
    }

    @Test func theHostListsDescribeEveryMenu() async throws {
        let (route, _, home) = try await Self.route()
        defer { try? FileManager.default.removeItem(at: home) }
        #expect(route.hostJSON["show_customize_item"] == true)
        let workspace = try #require(Self.menu(route, "workspaceRow"))
        #expect(workspace["title"] == "Workspace")
        #expect(workspace["customized"] == false)
        #expect(workspace["layout"] == workspace["generated"])
        let rename = workspace["rows"]?.arrayValue?.first { $0["key"] == "renameWorkspace" }
        #expect(rename?["home"] == .null)
        #expect(rename?["kind"] == "item")
    }

    @Test func aSaveArrangesTheMenuAndTheGeneratedLayoutSavesAsNone() async throws {
        let (route, registry, home) = try await Self.route()
        defer { try? FileManager.default.removeItem(at: home) }
        let generated = try #require(Self.menu(route, "workspaceRow")?["generated"])
        var top = try #require(generated["top"]?.arrayValue)
        top.removeAll { $0 == "workspace.duplicate" }
        let layout: JSONValue = ["top": .array(top), "more": [], "hidden": ["workspace.duplicate"]]
        _ = try await route.call(ContextMenusPageProvider.prefix + "set", params: ["menu": "workspaceRow", "layout": layout], context: Self.click)
        #expect(registry.contextMenuLayouts[.workspaceRow]?.hidden == ["workspace.duplicate"])
        #expect(Self.menu(route, "workspaceRow")?["customized"] == true)
        #expect(!ContextMenuCatalog.shared.referencedIDs(registry.contextMenuEntries(for: .workspaceRow)).contains("workspace.duplicate"))

        // Saving the generated arrangement is Reset.
        _ = try await route.call(ContextMenusPageProvider.prefix + "set", params: ["menu": "workspaceRow", "layout": generated], context: Self.click)
        #expect(registry.contextMenuLayouts[.workspaceRow] == nil)
        _ = try await route.call(ContextMenusPageProvider.prefix + "show_item", params: ["show": false], context: Self.click)
        #expect(route.hostJSON["show_customize_item"] == false)
    }

    @Test func onlyThePersonsClickOnSettingsWrites() async throws {
        let (route, registry, home) = try await Self.route()
        defer { try? FileManager.default.removeItem(at: home) }
        let params: JSONValue = ["menu": "tab", "layout": ["top": ["closeTab"]]]
        for context in [PageCallContext(page: "cmux.settings"), PageCallContext(page: "cmux.history", userGesture: true)] {
            await #expect(throws: PageError.self) {
                _ = try await route.call(ContextMenusPageProvider.prefix + "set", params: params, context: context)
            }
        }
        await #expect(throws: PageError.self) {
            _ = try await route.call(ContextMenusPageProvider.prefix + "set", params: ["menu": "nope", "layout": .null], context: Self.click)
        }
        await #expect(throws: PageError.self) {
            _ = try await route.call(ContextMenusPageProvider.prefix + "set", params: ["menu": "tab", "layout": ["top": "closeTab"]], context: Self.click)
        }
        #expect(registry.contextMenuLayouts.isEmpty)
    }
}
