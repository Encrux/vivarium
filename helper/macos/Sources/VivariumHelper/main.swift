// vivarium-helper (macOS): native window streaming + input for Vivarium app tiles.
// Spawned by the Obsidian plugin; talks the protocol in Protocol.swift over stdin/stdout.
// Exits when stdin closes. Apps it streams keep running.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

let VERSION = "0.1.0"

NSApplication.shared.setActivationPolicy(.prohibited) // no Dock icon, never steals focus

var streams: [UInt32: WindowStream] = [:]
var handoffTimers: [CGWindowID: DispatchSourceTimer] = [:]

/// "Engaged" window: the real window placed exactly over its tile so you use it natively.
/// Ends when another app (e.g. Obsidian, because you clicked the canvas) becomes active.
var engaged: (windowId: CGWindowID, pid: pid_t)?
let activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { note in
    guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    // Tiles show themselves as "in use" while their app is the active one.
    Out.event("frontmost", ["pid": Int(app.processIdentifier), "bundleId": app.bundleIdentifier ?? ""])
    if let e = engaged, app.processIdentifier != e.pid { disengage(reason: "app_switch") }
}

func disengage(reason: String) {
    guard let e = engaged else { return }
    engaged = nil
    // Report where/how big the real window was when you left it: the tile adopts moves/resizes
    // you made on the real window.
    var fields: [String: Any] = ["windowId": Int(e.windowId), "reason": reason]
    if let f = Windows.cgList(pid: e.pid).first(where: { $0.id == e.windowId })?.frame {
        fields["x"] = f.minX; fields["y"] = f.minY; fields["width"] = f.width; fields["height"] = f.height
    }
    try? Stage.shared.park(windowId: e.windowId, pid: e.pid)
    Out.event("disengaged", fields)
}

/// Post a real (HID-level) click at a global point — used once right after engaging, to replay
/// the click that engaged the tile onto the now-present real window.
func hidClick(at p: CGPoint, button: Int, clicks: Int) {
    let src = CGEventSource(stateID: .hidSystemState)
    let (down, up, b): (CGEventType, CGEventType, CGMouseButton) = button == 2 ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
    for t in [down, up] {
        guard let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: b) else { continue }
        e.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, clicks)))
        e.post(tap: .cghidEventTap)
    }
}

/// A real click activates the clicked app. Give the focus back to Obsidian right after, so your
/// next click on the canvas isn't swallowed by window activation and keys keep flowing through the
/// tile, unless the click opened a menu/dropdown/context menu, which needs its app to stay active.
var focusReturn: DispatchWorkItem?
func returnFocus(pid: pid_t, windowId: CGWindowID, keepForMenus: Bool, rightClick: Bool) {
    focusReturn?.cancel()
    if rightClick { return } // context menu: leave the app active until you pick something
    let work = DispatchWorkItem {
        if keepForMenus, Windows.hasPopup(pid: pid, over: windowId) { return }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { Windows.activateObsidian() }
    }
    focusReturn = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
}

func permissions() -> [String: Any] {
    ["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
}

func reply(_ req: [String: Any], _ result: Result<[String: Any], Error>) {
    var o: [String: Any] = ["id": req["id"] ?? NSNull()]
    switch result {
    case .success(let r):
        o["ok"] = true
        o.merge(r) { a, _ in a }
    case .failure(let e):
        o["ok"] = false
        o["error"] = "\(e)"
    }
    Out.json(o)
}

func ids(_ req: [String: Any]) throws -> (CGWindowID, pid_t) {
    guard let w = req.int("windowId"), let p = req.int("pid") else { throw HelperError("windowId and pid required") }
    return (CGWindowID(w), pid_t(p))
}

/// Make the real window fullscreen in front; when the user leaves fullscreen, put Obsidian
/// back in front and tell the plugin (the tile resumes streaming).
func handoff(windowId: CGWindowID, pid: pid_t) throws {
    // Full screen happens on the display you're looking at, not on the invisible stage.
    try? Stage.shared.unpark(windowId: windowId, pid: pid)
    try Windows.setFullscreen(pid: pid, id: windowId, true)
    handoffTimers[windowId]?.cancel()
    var wasFull = false
    var ticks = 0
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + 0.5, repeating: 0.4)
    t.setEventHandler {
        ticks += 1
        let full = Windows.isFullscreen(pid: pid, id: windowId)
        let alive = Windows.cgList(pid: pid).contains { $0.id == windowId }
        if full { wasFull = true }
        // ended: left fullscreen (after the ~1s animation), or window closed, or never entered within 6s
        if !alive || (wasFull && !full) || (!wasFull && ticks > 15) {
            t.cancel()
            handoffTimers[windowId] = nil
            if alive {
                // after the exit animation, send the window back to the stage
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    try? Stage.shared.park(windowId: windowId, pid: pid)
                    Windows.activateObsidian()
                }
            }
            Out.event("handoff_ended", ["windowId": Int(windowId), "alive": alive])
        }
    }
    t.resume()
    handoffTimers[windowId] = t
}

func handle(_ req: [String: Any]) {
    let op = req.str("op") ?? ""
    do {
        switch op {
        case "hello":
            reply(req, .success(["platform": "macos", "version": VERSION, "permissions": permissions()]))
        case "request_permissions":
            if req.bool("screen") ?? false, !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }
            if req.bool("accessibility") ?? false { _ = Windows.trusted(prompt: true) }
            reply(req, .success(["permissions": permissions()]))
        case "list_windows":
            var wins = Windows.listForTiles()
            if let pid = req.int("pid") { wins = wins.filter { ($0["pid"] as? Int) == pid } }
            reply(req, .success(["windows": wins]))
        case "list_apps":
            reply(req, .success(["apps": Apps.list()]))
        case "launch":
            Apps.launch(bundleId: req.str("bundleId"), path: req.str("path")) { r in
                DispatchQueue.main.async { reply(req, r.map { ["pid": Int($0)] }) }
            }
        case "new_window":
            // ⌘N to the app: the generic "open another window" for document/browser apps.
            guard let p = req.int("pid") else { throw HelperError("pid required") }
            Input.key(pid: pid_t(p), code: 45, down: true, mods: 8)
            Input.key(pid: pid_t(p), code: 45, down: false, mods: 8)
            reply(req, .success([:]))
        case "stream_start":
            let (wid, pid) = try ids(req)
            guard let sid = req.int("stream") else { throw HelperError("stream required") }
            streams[UInt32(sid)]?.stop()
            let s = WindowStream(streamId: UInt32(sid), windowId: wid, pid: pid, fps: req.int("fps") ?? 30,
                                 maxW: req.int("maxWidth") ?? 3840, maxH: req.int("maxHeight") ?? 2160)
            streams[UInt32(sid)] = s
            Task { @MainActor in
                do { reply(req, .success(try await s.start())) }
                catch { streams[UInt32(sid)] = nil; reply(req, .failure(error)) }
            }
        case "stream_update":
            guard let sid = req.int("stream"), let s = streams[UInt32(sid)] else { throw HelperError("no such stream") }
            s.reconfigure(fps: req.int("fps"), maxW: req.int("maxWidth"), maxH: req.int("maxHeight"))
            reply(req, .success([:]))
        case "keyframe":
            guard let sid = req.int("stream"), let s = streams[UInt32(sid)] else { throw HelperError("no such stream") }
            s.requestKeyframe()
            reply(req, .success([:]))
        case "stream_stop":
            if let sid = req.int("stream") { streams.removeValue(forKey: UInt32(sid))?.stop() }
            reply(req, .success([:]))
        case "mouse":
            let (wid, pid) = try ids(req)
            try Input.mouse(windowId: wid, pid: pid, kind: req.str("kind") ?? "move", button: req.int("button") ?? 0,
                            x: req.double("x") ?? 0, y: req.double("y") ?? 0, clicks: req.int("clicks") ?? 1, mods: req.int("mods") ?? 0)
            if req["id"] != nil { reply(req, .success([:])) }
        case "click":
            let (wid, pid) = try ids(req)
            let button = req.int("button") ?? 0
            try Input.click(windowId: wid, pid: pid, x: req.double("x") ?? 0, y: req.double("y") ?? 0,
                            button: button, clicks: req.int("clicks") ?? 1, mods: req.int("mods") ?? 0)
            _ = button // the app stays active after a click, exactly like clicking its real window
        case "drag":
            let (wid, pid) = try ids(req)
            let pts = ((req["points"] as? [[NSNumber]]) ?? []).compactMap { $0.count == 2 ? ($0[0].doubleValue, $0[1].doubleValue) : nil }
            try Input.drag(windowId: wid, pid: pid, points: pts, button: req.int("button") ?? 0, mods: req.int("mods") ?? 0)

        case "scroll_hid":
            let (wid, pid) = try ids(req)
            try Input.scrollHID(windowId: wid, pid: pid, x: req.double("x") ?? 0, y: req.double("y") ?? 0,
                                dx: req.double("dx") ?? 0, dy: req.double("dy") ?? 0, mods: req.int("mods") ?? 0)
        case "scroll":
            let (wid, pid) = try ids(req)
            try Input.scroll(windowId: wid, pid: pid, x: req.double("x") ?? 0, y: req.double("y") ?? 0,
                             dx: req.double("dx") ?? 0, dy: req.double("dy") ?? 0, mods: req.int("mods") ?? 0)
        case "key":
            guard let p = req.int("pid"), let code = req.int("code") else { throw HelperError("pid and code required") }
            Input.key(pid: pid_t(p), code: code, down: req.bool("down") ?? true, mods: req.int("mods") ?? 0)
        case "text":
            guard let p = req.int("pid"), let t = req.str("text") else { throw HelperError("pid and text required") }
            Input.text(pid: pid_t(p), t)
        case "set_frame":
            let (wid, pid) = try ids(req)
            let origin = req.double("x").map { CGPoint(x: $0, y: req.double("y") ?? 0) }
            let size = req.double("width").map { CGSize(width: $0, height: req.double("height") ?? 0) }
            try Windows.setFrame(pid: pid, id: wid, origin: origin, size: size)
            reply(req, .success([:]))
        case "raise":
            let (wid, pid) = try ids(req)
            try? Stage.shared.unpark(windowId: wid, pid: pid)
            Windows.raise(pid: pid, id: wid)
            reply(req, .success([:]))
        case "fullscreen":
            let (wid, pid) = try ids(req)
            if req.bool("on") ?? true { try handoff(windowId: wid, pid: pid) }
            else { try Windows.setFullscreen(pid: pid, id: wid, false) }
            reply(req, .success([:]))
        case "engage":
            // x, y, width, height: the tile's rectangle in global screen points.
            let (wid, pid) = try ids(req)
            if let e = engaged, e.windowId != wid { disengage(reason: "other_tile") }
            let origin = CGPoint(x: req.double("x") ?? 0, y: req.double("y") ?? 0)
            let size = CGSize(width: req.double("width") ?? 800, height: req.double("height") ?? 600)
            let cur = Windows.cgList(pid: pid).first(where: { $0.id == wid })?.frame.size
            let sameSize = cur.map { abs($0.width - size.width) < 2 && abs($0.height - size.height) < 2 } ?? false
            try Windows.setFrame(pid: pid, id: wid, origin: origin, size: sameSize ? nil : size)
            Windows.raise(pid: pid, id: wid)
            engaged = (wid, pid)
            if let cx = req.double("clickX"), let cy = req.double("clickY") {
                // give activation + the move a moment, then replay the click on the real window
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
                    hidClick(at: CGPoint(x: cx, y: cy), button: req.int("button") ?? 0, clicks: req.int("clicks") ?? 1)
                }
            }
            reply(req, .success([:]))
        case "disengage":
            disengage(reason: req.str("reason") ?? "plugin")
            if req.bool("activateObsidian") ?? false { Windows.activateObsidian() }
            reply(req, .success([:]))
        case "park":
            // Move the real window onto the invisible stage display (stays live, never in your way).
            let (wid, pid) = try ids(req)
            try Stage.shared.park(windowId: wid, pid: pid)
            reply(req, .success(["stage": Stage.shared.bounds.debugDescription]))
        case "unpark":
            let (wid, pid) = try ids(req)
            Stage.shared.forget(wid)
            try Stage.shared.unpark(windowId: wid, pid: pid)
            Windows.raise(pid: pid, id: wid)
            reply(req, .success([:]))
        default:
            throw HelperError("unknown op \(op)")
        }
    } catch {
        reply(req, .failure(error))
    }
}

// stdin: one JSON request per line
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async { handle(obj) }
    }
    exit(0)
}

Input.startCursorWatchdog()
Out.event("ready", ["platform": "macos", "version": VERSION, "permissions": permissions()])
RunLoop.main.run()
