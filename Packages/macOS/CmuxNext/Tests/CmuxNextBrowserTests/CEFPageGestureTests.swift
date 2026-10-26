import AppKit
@testable import CmuxNextBrowser
import Testing

/// A Chromium page's gestures come from the app's own input events (`CEFLinkClickTracker`): a
/// mouse down, a key down, and the mouse up that ends a click or a drag, as a WebKit page view
/// counts them. Settings > Menus saves a reordered row on the drag's release; with only the down
/// counted, a drag longer than the write's one-second gesture window was refused ("only you can
/// change your menus").
@MainActor
struct CEFPageGestureTests {
    @Test func aMouseUpOnAPageIsTheirGestureAndStillRecordsTheClick() throws {
        _ = NSApplication.shared
        let host = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 400, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
        let page = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 400, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
        host.addChildWindow(page, ordered: .above)
        defer { host.removeChildWindow(page) }
        let tracker = CEFLinkClickTracker()
        var gestures: [Int32] = []
        tracker.onGesture = { gestures.append($0) }
        tracker.startRecordingClicks { [CEFClickTarget(browser: 7, hostWindow: ObjectIdentifier(host), frame: CGRect(x: 0, y: 0, width: 400, height: 400))] }

        func event(_ type: NSEvent.EventType) throws -> NSEvent {
            try #require(NSEvent.mouseEvent(with: type, location: CGPoint(x: 100, y: 100), modifierFlags: [], timestamp: 1,
                                            windowNumber: page.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
        }
        tracker.record(try event(.leftMouseDown))
        #expect(gestures == [7], "a press on the page is the person's gesture")
        tracker.record(try event(.leftMouseUp))
        #expect(gestures == [7, 7], "the release that ends a drag is the person's gesture too")
        #expect(tracker.clicks[7] != nil, "the release is still the page's last click")
    }
}
