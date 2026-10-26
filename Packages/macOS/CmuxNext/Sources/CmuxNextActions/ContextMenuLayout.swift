/// A person's arrangement of one right-click menu (Settings > Menus, cmux.json
/// `contextMenus.layouts.<menu>`), applied over the generated menu
/// (``ContextMenuCatalog``). It names rows by key (``key(of:)``): an action's ID, or
/// `folder:<name>` for a titled submenu (`folder:more` is More).
///
/// - `top`: the top level in order; `-` is a separator. A row named here leaves the folder
///   it was in (Promote: More > Copy Path becomes a top-level row).
/// - `more`: rows the person moved into More, in order, before More's own rows.
/// - `hidden`: rows left out everywhere.
///
/// A row the layout does not name keeps its generated place, so an action the app adds later
/// still shows: in More when it was generated there, at the top level after the row it follows
/// in the generated menu otherwise. A named row the app no longer places is dropped.
public nonisolated struct ContextMenuLayout: Sendable, Hashable, Codable {
    public static let separator = "-"
    public static let moreKey = folderKey(.more)

    public var top: [String]
    public var more: [String]
    public var hidden: [String]

    public init(top: [String], more: [String] = [], hidden: [String] = []) {
        self.top = top
        self.more = more
        self.hidden = hidden
    }

    public static func folderKey(_ folder: MenuFolder) -> String { "folder:\(folder.rawValue)" }

    /// The key a layout names `entry` by; nil for a separator.
    public static func key(of entry: ContextMenuEntry) -> String? {
        switch entry {
        case .action(let id), .choices(let id), .submenu(let id, _): id.rawValue
        case .folder(let folder, _): folderKey(folder)
        case .separator: nil
        }
    }

    /// The generated menu as a layout: its top level as it is, nothing moved or hidden.
    public static func generated(_ entries: [ContextMenuEntry]) -> ContextMenuLayout {
        ContextMenuLayout(top: entries.map { key(of: $0) ?? separator })
    }

    /// One row a layout can place: a generated entry and the folder it was generated in
    /// (nil for the top level). A folder's rows are rows too; a submenu or choices row moves whole.
    public struct Unit: Sendable, Hashable {
        public let key: String
        public let entry: ContextMenuEntry
        public let home: String?
    }

    /// Every placeable row of `entries`, in menu order, folders before their rows.
    public static func units(in entries: [ContextMenuEntry]) -> [Unit] {
        var units: [Unit] = []
        var seen: Set<String> = []
        func walk(_ entries: [ContextMenuEntry], home: String?) {
            for entry in entries {
                guard let key = key(of: entry), seen.insert(key).inserted else { continue }
                units.append(Unit(key: key, entry: entry, home: home))
                if case .folder(_, let children) = entry { walk(children, home: key) }
            }
        }
        walk(entries, home: nil)
        return units
    }

    /// This layout against the generated `entries`: rows the app no longer places dropped, each
    /// named once, and the generated top-level rows it does not name inserted after the row they
    /// follow in the generated menu (an action added since the layout was saved). What the
    /// Settings editor starts from, and what ``applied(to:)`` draws.
    public func normalized(against entries: [ContextMenuEntry]) -> ContextMenuLayout {
        let known = Set(Self.units(in: entries).map(\.key))
        var seen: Set<String> = []
        func keep(_ key: String) -> Bool { known.contains(key) && seen.insert(key).inserted }
        let hidden = hidden.filter(keep)
        var top = top.filter { $0 == Self.separator || keep($0) }
        let more = more.filter(keep)
        let generatedTop = entries.compactMap(Self.key(of:))
        for (index, key) in generatedTop.enumerated() where !seen.contains(key) {
            seen.insert(key)
            let anchor = generatedTop[..<index].last { top.contains($0) }
            let position = anchor.flatMap { top.firstIndex(of: $0) }.map { $0 + 1 } ?? 0
            top.insert(key, at: position)
        }
        return ContextMenuLayout(top: top, more: more, hidden: hidden)
    }

    /// The menu `entries` arranged by this layout (``normalized(against:)`` first). More shows the
    /// rows moved into it, then its generated rows that stayed; a folder left empty disappears.
    public func applied(to entries: [ContextMenuEntry]) -> [ContextMenuEntry] {
        let layout = normalized(against: entries)
        let units = Self.units(in: entries)
        let byKey = Dictionary(units.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        let hidden = Set(layout.hidden)
        let placed = Set(layout.top + layout.more).union(hidden)

        func stripped(_ entries: [ContextMenuEntry]) -> [ContextMenuEntry] {
            entries.compactMap { entry in
                guard let key = Self.key(of: entry) else { return entry }
                guard !placed.contains(key) else { return nil }
                if case .folder(let folder, let children) = entry { return .folder(folder, stripped(children)) }
                return entry
            }
        }
        func entry(_ key: String) -> ContextMenuEntry? {
            guard !hidden.contains(key), let unit = byKey[key] else { return nil }
            if case .folder(let folder, let children) = unit.entry { return .folder(folder, stripped(children)) }
            return unit.entry
        }

        let generatedMore: [ContextMenuEntry] = {
            for case .folder(.more, let children) in entries { return stripped(children) }
            return []
        }()
        let moved = layout.more.compactMap(entry)
        let moreRows = Self.collapsingSeparators(moved + (moved.isEmpty ? [] : [.separator]) + generatedMore)
        let more: ContextMenuEntry? = moreRows.isEmpty || hidden.contains(Self.moreKey) ? nil : .folder(.more, moreRows)

        var result: [ContextMenuEntry] = []
        for key in layout.top {
            if key == Self.separator { result.append(.separator) }
            else if key == Self.moreKey { more.map { result.append($0) } }
            else if let entry = entry(key) { result.append(entry) }
        }
        // Rows moved into More show even when the layout keeps no More row.
        if let more, !layout.top.contains(Self.moreKey) { result += [.separator, more] }
        return Self.collapsingSeparators(result)
    }

    /// Whether this layout draws `entries` as generated.
    public func isGenerated(for entries: [ContextMenuEntry]) -> Bool {
        normalized(against: entries) == Self.generated(entries)
    }

    /// One separator between sections and none at the ends, inside folders too; a folder left
    /// with no rows disappears.
    static func collapsingSeparators(_ entries: [ContextMenuEntry]) -> [ContextMenuEntry] {
        var result: [ContextMenuEntry] = []
        for entry in entries {
            switch entry {
            case .separator:
                if let last = result.last, last != .separator { result.append(entry) }
            case .folder(let folder, let children):
                let kept = collapsingSeparators(children)
                if !kept.isEmpty { result.append(.folder(folder, kept)) }
            default:
                result.append(entry)
            }
        }
        while case .separator? = result.last { result.removeLast() }
        return result
    }
}
