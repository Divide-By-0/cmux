public import CmuxNextActions

/// The person's right-click menu arrangements, in cmux.json (Settings > Menus):
///
/// ```jsonc
/// "contextMenus": {
///   "showCustomizeItem": true,
///   "layouts": {
///     "workspaceRow": {
///       "top": ["renameWorkspace", "workspace.copyPath", "-", "folder:more", "-", "closeWorkspace"],
///       "more": ["home.messageAbout"],
///       "hidden": ["workspace.duplicate"]
///     }
///   }
/// }
/// ```
///
/// A menu without a layout is drawn as the app generates it (``ContextMenuLayout``). An unknown
/// menu or a malformed layout is dropped with a diagnostic; unknown row keys are dropped when the
/// layout is applied, so a row the app retired never breaks the menu.
public nonisolated struct ContextMenusSetting: Sendable, Hashable {
    public static let configPath = ["contextMenus"]
    public static let layoutsPath = configPath + ["layouts"]
    public static let showCustomizeItemPath = configPath + ["showCustomizeItem"]

    public var layouts: [ActionMenuContext: ContextMenuLayout] = [:]
    public var showsCustomizeItem = true

    public init(layouts: [ActionMenuContext: ContextMenuLayout] = [:], showsCustomizeItem: Bool = true) {
        self.layouts = layouts
        self.showsCustomizeItem = showsCustomizeItem
    }

    public static func read(_ root: JSONValue) -> ContextMenusSetting {
        var diagnostics: [SettingsDiagnostic] = []
        return parse(root, diagnostics: &diagnostics)
    }

    static func parse(_ root: JSONValue, diagnostics: inout [SettingsDiagnostic]) -> ContextMenusSetting {
        var setting = ContextMenusSetting()
        if let show = root.value(at: showCustomizeItemPath) {
            if let value = show.boolValue { setting.showsCustomizeItem = value } else {
                diagnostics.append(SettingsDiagnostic(kind: .invalidValue, path: showCustomizeItemPath.joined(separator: "."), message: "expected true or false"))
            }
        }
        guard let layouts = root.value(at: layoutsPath) else { return setting }
        let id = layoutsPath.joined(separator: ".")
        guard let members = layouts.objectValue else {
            diagnostics.append(SettingsDiagnostic(kind: .invalidValue, path: id, message: "expected an object of menu layouts"))
            return setting
        }
        for (name, value) in members {
            guard let context = ActionMenuContext(rawValue: name) else {
                diagnostics.append(SettingsDiagnostic(kind: .invalidValue, path: "\(id).\(name)", message: "no right-click menu with this name"))
                continue
            }
            guard let layout = layout(value) else {
                diagnostics.append(SettingsDiagnostic(kind: .invalidValue, path: "\(id).\(name)",
                                                      message: "expected {\"top\": [...], \"more\": [...], \"hidden\": [...]} of row keys"))
                continue
            }
            setting.layouts[context] = layout
        }
        return setting
    }

    /// A layout object (cmux.json, or a Settings > Menus write): `top` is required; each list holds strings only.
    public static func layout(_ value: JSONValue) -> ContextMenuLayout? {
        func keys(_ list: JSONValue?) -> [String]? {
            guard let items = list?.arrayValue else { return nil }
            let keys = items.compactMap(\.stringValue)
            return keys.count == items.count ? keys : nil
        }
        guard value.objectValue != nil, let top = keys(value["top"]) else { return nil }
        let more = value["more"] == nil ? [] : keys(value["more"])
        let hidden = value["hidden"] == nil ? [] : keys(value["hidden"])
        guard let more, let hidden else { return nil }
        return ContextMenuLayout(top: top, more: more, hidden: hidden)
    }

    /// The value to write for `layout`.
    public static func value(_ layout: ContextMenuLayout) -> JSONValue {
        var members: [String: JSONValue] = ["top": .array(layout.top.map(JSONValue.string))]
        if !layout.more.isEmpty { members["more"] = .array(layout.more.map(JSONValue.string)) }
        if !layout.hidden.isEmpty { members["hidden"] = .array(layout.hidden.map(JSONValue.string)) }
        return .object(members)
    }
}

extension SettingsController {
    /// Saves the person's arrangement of `context`'s menu; nil (Reset) removes it, so the menu
    /// follows the app's generated one again. Settings > Menus calls this on the person's gesture only.
    public func setContextMenuLayout(_ layout: ContextMenuLayout?, for context: ActionMenuContext) async throws {
        let path = ContextMenusSetting.layoutsPath + [context.rawValue]
        guard let layout else { return try await removePruning(path) }
        try await set(ContextMenusSetting.value(layout), at: path)
    }

    /// Whether whole right-click menus end with Customize Menu…; true (the default) removes the key.
    public func setShowsCustomizeMenuItem(_ show: Bool) async throws {
        if show { return try await removePruning(ContextMenusSetting.showCustomizeItemPath) }
        try await set(.bool(false), at: ContextMenusSetting.showCustomizeItemPath)
    }
}
