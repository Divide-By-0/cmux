import CmuxNextActions
import CmuxNextDesign
import CmuxNextPages
import CmuxNextSettings

/// Settings > Menus: every right-click menu's rows and the person's arrangement of it
/// (``ContextMenuLayout``), saved in cmux.json `contextMenus` (``ContextMenusSetting``).
///
/// - The page reads `context_menus` in the host lists (``hostJSON``): each menu's rows, its
///   generated layout (what Reset draws), the layout drawn now, and whether menus end with
///   Customize Menu…. A row's icon is `cmux-page://cmux.settings/symbol/<name>` (``MenuSymbolImages``).
/// - `set {menu, layout}` saves a layout; a null layout, or one that draws the generated menu, removes it.
/// - `show_item {show}` turns the Customize Menu… row on or off.
///
/// Writes take the person's gesture on Settings only.
@MainActor
final class ContextMenusPageRoute: PageProvider {
    nonisolated static let prefix = "cmux.settings.context_menus."

    private let registry: ActionRegistry
    private let settings: () -> SettingsController?

    init(registry: ActionRegistry, settings: @escaping () -> SettingsController?) {
        self.registry = registry
        self.settings = settings
    }

    /// The host lists' `context_menus`. It reads the registry's layouts, so the page's host-lists
    /// watch re-sends it after cmux.json changes.
    var hostJSON: JSONValue {
        [
            "show_customize_item": .bool(registry.showsCustomizeMenuItem),
            "menus": .array(registry.contextMenuEditorMenus().map(Self.menuJSON)),
        ]
    }

    func call(_ op: String, params: JSONValue, context: PageCallContext) async throws -> JSONValue {
        guard context.page == PageDescriptor.settings.id, context.userGesture else {
            throw PageError(code: "cmux.settings.user_only", message: "only you can change your menus")
        }
        guard let settings = settings() else { throw PageError.unavailable("settings are not loaded yet") }
        switch op {
        case Self.prefix + "set":
            guard let name = params["menu"]?.stringValue, let menu = ActionMenuContext(rawValue: name) else {
                throw PageError.invalidParams("menu must name a right-click menu")
            }
            let generated = ContextMenuCatalog.shared.entries(for: menu)
            var layout: ContextMenuLayout?
            if let value = params["layout"], value != .null {
                guard let parsed = ContextMenusSetting.layout(value) else {
                    throw PageError.invalidParams("layout must be {top, more, hidden} lists of row keys")
                }
                // Saved as drawn: keys the app does not place are dropped, and the generated
                // menu is no layout at all, so later app changes reach it.
                let normalized = parsed.normalized(against: generated)
                layout = normalized == .generated(generated) ? nil : normalized
            }
            try await settings.setContextMenuLayout(layout, for: menu)
        case Self.prefix + "show_item":
            guard let show = params["show"]?.boolValue else { throw PageError.invalidParams("show is required") }
            try await settings.setShowsCustomizeMenuItem(show)
        default:
            throw PageError.unknownOp(op)
        }
        return .object([:])
    }

    private static func menuJSON(_ menu: ContextMenuEditorMenu) -> JSONValue {
        [
            "id": .string(menu.context.rawValue),
            "title": .string(menu.title),
            "area": .string(menu.area.rawValue),
            "customized": .bool(menu.isCustomized),
            "rows": .array(menu.rows.map { row in
                [
                    "key": .string(row.key), "title": .string(row.title), "kind": .string(row.kind.rawValue),
                    "symbol": row.symbol.map(JSONValue.string) ?? .null, "home": row.home.map(JSONValue.string) ?? .null,
                ]
            }),
            "generated": layoutJSON(menu.generated),
            "layout": layoutJSON(menu.layout),
        ]
    }

    private static func layoutJSON(_ layout: ContextMenuLayout) -> JSONValue {
        [
            "top": .array(layout.top.map(JSONValue.string)),
            "more": .array(layout.more.map(JSONValue.string)),
            "hidden": .array(layout.hidden.map(JSONValue.string)),
        ]
    }
}
