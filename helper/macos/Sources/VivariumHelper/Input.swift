import CoreGraphics
import Foundation

/// Synthetic input delivered to one process (CGEventPostToPid): the real cursor and the
/// frontmost app are untouched, so the target window can stay behind Obsidian.
/// Requires the Accessibility permission (for the app that launched us, i.e. Obsidian).
enum Input {
    private static let source = CGEventSource(stateID: .privateState)
    private static var frameCache: [CGWindowID: (CGRect, Date)] = [:]

    static func windowFrame(_ id: CGWindowID, pid: pid_t) -> CGRect? {
        if let (f, t) = frameCache[id], Date().timeIntervalSince(t) < 0.1 { return f }
        guard let w = Windows.cgList(pid: pid).first(where: { $0.id == id }) else { return nil }
        frameCache[id] = (w.frame, Date())
        return w.frame
    }

    static func flags(_ mods: Int) -> CGEventFlags {
        var f: CGEventFlags = []
        if mods & 1 != 0 { f.insert(.maskShift) }
        if mods & 2 != 0 { f.insert(.maskControl) }
        if mods & 4 != 0 { f.insert(.maskAlternate) }
        if mods & 8 != 0 { f.insert(.maskCommand) }
        return f
    }

    /// x, y in window points (top-left origin). button: 0 left, 1 middle, 2 right (DOM numbering).
    static func mouse(windowId: CGWindowID, pid: pid_t, kind: String, button: Int, x: Double, y: Double, clicks: Int, mods: Int) throws {
        guard let f = windowFrame(windowId, pid: pid) else { throw HelperError("window gone") }
        let p = CGPoint(x: f.minX + x, y: f.minY + y)
        let (type, cgButton): (CGEventType, CGMouseButton) = {
            switch (kind, button) {
            case ("down", 0): return (.leftMouseDown, .left)
            case ("up", 0): return (.leftMouseUp, .left)
            case ("drag", 0): return (.leftMouseDragged, .left)
            case ("down", 2): return (.rightMouseDown, .right)
            case ("up", 2): return (.rightMouseUp, .right)
            case ("drag", 2): return (.rightMouseDragged, .right)
            case ("down", _): return (.otherMouseDown, .center)
            case ("up", _): return (.otherMouseUp, .center)
            case ("drag", _): return (.otherMouseDragged, .center)
            default: return (.mouseMoved, .left)
            }
        }()
        guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: cgButton) else { return }
        e.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, clicks)))
        // Route to this window even though it isn't under the real cursor / frontmost.
        if let f91 = CGEventField(rawValue: 91) { e.setIntegerValueField(f91, value: Int64(windowId)) }
        if let f92 = CGEventField(rawValue: 92) { e.setIntegerValueField(f92, value: Int64(windowId)) }
        e.flags = flags(mods)
        e.postToPid(pid)
    }

    static func scroll(windowId: CGWindowID, pid: pid_t, x: Double, y: Double, dx: Double, dy: Double, mods: Int) throws {
        guard let f = windowFrame(windowId, pid: pid) else { throw HelperError("window gone") }
        guard let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                              wheel1: Int32(-dy.rounded()), wheel2: Int32(-dx.rounded()), wheel3: 0) else { return }
        e.location = CGPoint(x: f.minX + x, y: f.minY + y)
        if let f91 = CGEventField(rawValue: 91) { e.setIntegerValueField(f91, value: Int64(windowId)) }
        if let f92 = CGEventField(rawValue: 92) { e.setIntegerValueField(f92, value: Int64(windowId)) }
        e.flags = flags(mods)
        e.postToPid(pid)
    }

    // MARK: in-tile mouse ("teleport")
    //
    // Synthetic mouse events posted to a process are ignored by web content (WebKit/Chromium)
    // even when the app is active; only real, HID-level events work. So for a click inside a
    // tile we post it at the window's actual position (on the invisible stage) and put the
    // cursor back where it was. Like a real click, it activates the app (its menu bar shows).

    private static let hid: CGEventSource? = {
        let s = CGEventSource(stateID: .hidSystemState)
        s?.localEventsSuppressionInterval = 0 // don't freeze the real mouse after our events
        return s
    }()

    private static func global(_ windowId: CGWindowID, _ pid: pid_t, _ x: Double, _ y: Double, fresh: Bool = true) throws -> CGPoint {
        if fresh { frameCache[windowId] = nil } // clicks: the window may have just moved
        guard var f = windowFrame(windowId, pid: pid) else { throw HelperError("window gone") }
        // A real click lands on whatever is on top at that point. Only on the stage is that
        // guaranteed to be our window, so never click a window that isn't there.
        if !Stage.shared.contains(f) {
            try Stage.shared.park(windowId: windowId, pid: pid)
            frameCache[windowId] = nil
            guard let g = windowFrame(windowId, pid: pid), Stage.shared.contains(g) else {
                throw HelperError("window isn't on the stage; not clicking")
            }
            f = g
        }
        return CGPoint(x: f.minX + min(max(x, 0), f.width - 1), y: f.minY + min(max(y, 0), f.height - 1))
    }

    /// Last cursor position on a *real* screen. Never trust the live position while teleporting:
    /// with rapid events (scrolling) the previous warp-back may not have landed yet, and saving
    /// that position would strand the cursor on the invisible stage.
    private static var lastRealCursor: CGPoint?
    private static var teleporting = false

    private static func onStage(_ p: CGPoint) -> Bool {
        let b = Stage.shared.bounds
        return !b.isNull && b.contains(p)
    }

    private static func realCursor() -> CGPoint {
        if let p = CGEvent(source: nil)?.location, !onStage(p) {
            lastRealCursor = p
            return p
        }
        if let p = lastRealCursor { return p }
        let m = CGDisplayBounds(CGMainDisplayID())
        return CGPoint(x: m.midX, y: m.midY)
    }

    private static func withCursorRestored(_ body: () -> Void) {
        let saved = realCursor()
        teleporting = true
        body()
        CGWarpMouseCursorPosition(saved)
        CGAssociateMouseAndMouseCursorPosition(1)
        teleporting = false
    }

    /// Safety net: if the cursor ever ends up on the stage (a lost warp, or you pushed it into the
    /// one corner where the stage touches your screens), bring it straight back.
    static func startCursorWatchdog() {
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 0.25, repeating: 0.25)
        t.setEventHandler {
            guard !teleporting, let p = CGEvent(source: nil)?.location else { return }
            if onStage(p) {
                CGWarpMouseCursorPosition(realCursorFallback())
                CGAssociateMouseAndMouseCursorPosition(1)
            } else {
                lastRealCursor = p
            }
        }
        t.resume()
        watchdog = t
    }

    private static var watchdog: DispatchSourceTimer?

    private static func realCursorFallback() -> CGPoint {
        if let p = lastRealCursor { return p }
        let m = CGDisplayBounds(CGMainDisplayID())
        return CGPoint(x: m.midX, y: m.midY)
    }

    private static func buttonTypes(_ button: Int) -> (CGEventType, CGEventType, CGEventType, CGMouseButton) {
        switch button {
        case 2: return (.rightMouseDown, .rightMouseDragged, .rightMouseUp, .right)
        case 1: return (.otherMouseDown, .otherMouseDragged, .otherMouseUp, .center)
        default: return (.leftMouseDown, .leftMouseDragged, .leftMouseUp, .left)
        }
    }

    private static func post(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clicks: Int, mods: Int) {
        guard let e = CGEvent(mouseEventSource: hid, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
        e.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, clicks)))
        e.flags = flags(mods)
        e.post(tap: .cghidEventTap)
    }

    static func click(windowId: CGWindowID, pid: pid_t, x: Double, y: Double, button: Int, clicks: Int, mods: Int) throws {
        let p = try global(windowId, pid, x, y)
        Windows.raiseOnly(pid: pid, id: windowId) // topmost at that point on the stage
        let (down, _, up, b) = buttonTypes(button)
        withCursorRestored {
            post(down, p, b, clicks: clicks, mods: mods)
            post(up, p, b, clicks: clicks, mods: mods)
        }
    }

    /// A whole drag replayed at once (on release): text selection, sliders, moving things.
    static func drag(windowId: CGWindowID, pid: pid_t, points: [(Double, Double)], button: Int, mods: Int) throws {
        guard points.count >= 2 else { return }
        let ps = try points.map { try global(windowId, pid, $0.0, $0.1) }
        Windows.raiseOnly(pid: pid, id: windowId)
        let (down, dragged, up, b) = buttonTypes(button)
        withCursorRestored {
            post(down, ps[0], b, clicks: 1, mods: mods)
            for p in ps.dropFirst() {
                usleep(8_000) // apps sample drags per event; give each a moment
                post(dragged, p, b, clicks: 1, mods: mods)
            }
            post(up, ps[ps.count - 1], b, clicks: 1, mods: mods)
        }
    }

    static func scrollHID(windowId: CGWindowID, pid: pid_t, x: Double, y: Double, dx: Double, dy: Double, mods: Int) throws {
        // 60×/s while scrolling: use the cached frame (≤100 ms old), no window-list round trip
        let p = try global(windowId, pid, x, y, fresh: false)
        guard let e = CGEvent(scrollWheelEvent2Source: hid, units: .pixel, wheelCount: 2,
                              wheel1: Int32(-dy.rounded()), wheel2: Int32(-dx.rounded()), wheel3: 0) else { return }
        e.location = p
        e.flags = flags(mods)
        // continuous = trackpad-style pixel scrolling (smooth in WebKit/Chromium, not line steps)
        e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        withCursorRestored {
            // scroll goes to the window under the cursor
            CGWarpMouseCursorPosition(p)
            e.post(tap: .cghidEventTap)
        }
    }

    /// A key by macOS virtual key code (shortcuts, arrows, Return, …).
    static func key(pid: pid_t, code: Int, down: Bool, mods: Int) {
        guard let e = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: down) else { return }
        e.flags = flags(mods)
        e.postToPid(pid)
    }

    /// Literal text, independent of keyboard layout (handles ü, @ on German layouts, emoji, IME output).
    static func text(pid: pid_t, _ s: String) {
        let units = Array(s.utf16)
        var i = 0
        while i < units.count {
            let chunk = Array(units[i..<min(i + 20, units.count)])
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                chunk.withUnsafeBufferPointer { e.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
                e.postToPid(pid)
            }
            i += 20
        }
    }
}
