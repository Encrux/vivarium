import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit

// Private but stable since 10.x and used widely (yabai, Rectangle, AltTab): AXUIElement → CGWindowID.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

struct WinInfo {
    let id: CGWindowID
    let pid: pid_t
    let layer: Int
    let frame: CGRect // global, top-left origin (points)
    let owner: String
    let title: String
    let onScreen: Bool
}

enum Windows {
    /// Cheap window list via CoreGraphics (no ScreenCaptureKit round trip). Used for polling.
    static func cgList(pid: pid_t? = nil) -> [WinInfo] {
        guard let arr = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        var out: [WinInfo] = []
        for w in arr {
            guard let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let p = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { continue }
            if let pid, p != pid { continue }
            var rect = CGRect.zero
            if let b = w[kCGWindowBounds as String] as! CFDictionary? { CGRectMakeWithDictionaryRepresentation(b, &rect) }
            out.append(WinInfo(
                id: id, pid: p,
                layer: (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                frame: rect,
                owner: w[kCGWindowOwnerName as String] as? String ?? "",
                title: w[kCGWindowName as String] as? String ?? "",
                onScreen: (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
            ))
        }
        return out
    }

    static func cgWindow(_ id: CGWindowID) -> WinInfo? {
        guard let arr = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]], arr.first != nil else { return nil }
        return cgList().first { $0.id == id }
    }

    /// Application windows a user would want as tiles.
    static func listForTiles() -> [[String: Any]] {
        let me = getpid()
        let obsidian = NSRunningApplication.runningApplications(withBundleIdentifier: "md.obsidian").map(\.processIdentifier)
        return cgList().filter { w in
            w.layer == 0 && w.pid != me && !obsidian.contains(w.pid) && w.frame.width >= 120 && w.frame.height >= 80
                && !["Window Server", "Dock", "Control Center", "Notification Center"].contains(w.owner)
        }.map { w in
            let app = NSRunningApplication(processIdentifier: w.pid)
            return [
                "windowId": Int(w.id), "pid": Int(w.pid), "app": w.owner, "bundleId": app?.bundleIdentifier ?? "",
                "title": w.title, "x": w.frame.minX, "y": w.frame.minY, "width": w.frame.width, "height": w.frame.height,
                "onScreen": w.onScreen,
            ]
        }
    }

    // MARK: Accessibility

    static func trusted(prompt: Bool) -> Bool {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(opts)
    }

    static func axWindow(pid: pid_t, id: CGWindowID) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let wins = value as? [AXUIElement] else { return nil }
        for w in wins {
            var wid: CGWindowID = 0
            if _AXUIElementGetWindow(w, &wid) == .success, wid == id { return w }
        }
        return nil
    }

    static func setFrame(pid: pid_t, id: CGWindowID, origin: CGPoint?, size: CGSize?) throws {
        guard let w = axWindow(pid: pid, id: id) else { throw HelperError("window not reachable via Accessibility (grant permission?)") }
        if var o = origin, let v = AXValueCreate(.cgPoint, &o) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v) }
        if var s = size, let v = AXValueCreate(.cgSize, &s) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, v) }
    }

    static func isFullscreen(pid: pid_t, id: CGWindowID) -> Bool {
        guard let w = axWindow(pid: pid, id: id) else { return false }
        var v: CFTypeRef?
        AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &v)
        return (v as? Bool) ?? false
    }

    static func setFullscreen(pid: pid_t, id: CGWindowID, _ on: Bool) throws {
        guard let w = axWindow(pid: pid, id: id) else { throw HelperError("window not reachable via Accessibility (grant permission?)") }
        raise(pid: pid, id: id)
        AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, on as CFBoolean)
    }

    /// Raise within its display without activating the app.
    static func raiseOnly(pid: pid_t, id: CGWindowID) {
        if let w = axWindow(pid: pid, id: id) { AXUIElementPerformAction(w, kAXRaiseAction as CFString) }
    }

    static func raise(pid: pid_t, id: CGWindowID) {
        if let w = axWindow(pid: pid, id: id) {
            AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
            AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        }
        NSRunningApplication(processIdentifier: pid)?.activate()
    }

    /// The Obsidian instance that launched us (walk up the process tree: helper → renderer → app).
    static let ownerApp: NSRunningApplication? = {
        var pid = getppid()
        for _ in 0..<6 {
            if let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == "md.obsidian" { return app }
            var info = kinfo_proc()
            var size = MemoryLayout<kinfo_proc>.stride
            var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
            guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { break }
            pid = info.kp_eproc.e_ppid
            if pid <= 1 { break }
        }
        return NSRunningApplication.runningApplications(withBundleIdentifier: "md.obsidian").first
    }()

    /// Bring (our) Obsidian back to the front.
    static func activateObsidian() {
        ownerApp?.activate()
    }

    /// Does the app currently show a menu / popover / dropdown over this window?
    static func hasPopup(pid: pid_t, over id: CGWindowID) -> Bool {
        let wins = cgList(pid: pid)
        guard let me = wins.first(where: { $0.id == id }) else { return false }
        return wins.contains { $0.id != id && $0.layer > 0 && $0.onScreen && $0.frame.intersects(me.frame) }
    }

    /// Largest normal window of the Obsidian process that spawned us (for parking).
    static func obsidianWindowFrame() -> CGRect? {
        let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "md.obsidian").map(\.processIdentifier))
        return cgList().filter { pids.contains($0.pid) && $0.layer == 0 && $0.onScreen }
            .max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }?.frame
    }
}

// MARK: Apps

enum Apps {
    static func list() -> [[String: Any]] {
        let fm = FileManager.default
        var dirs = ["/Applications", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]
        let xcodeApps = "/Applications/Xcode.app/Contents/Developer/Applications"
        if fm.fileExists(atPath: xcodeApps) { dirs.append(xcodeApps) }
        var seen = Set<String>()
        var out: [[String: Any]] = []
        for d in dirs {
            guard let items = try? fm.contentsOfDirectory(atPath: d) else { continue }
            for i in items where i.hasSuffix(".app") {
                let path = d + "/" + i
                guard let b = Bundle(path: path), let id = b.bundleIdentifier, !seen.contains(id) else { continue }
                seen.insert(id)
                let name = (b.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (b.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? String(i.dropLast(4))
                out.append(["name": name, "bundleId": id, "path": path])
            }
        }
        return out.sorted { ($0["name"] as! String).localizedCaseInsensitiveCompare($1["name"] as! String) == .orderedAscending }
    }

    /// Launch (or find) an app; resolves with its pid once running.
    static func launch(bundleId: String?, path: String?, completion: @escaping (Result<pid_t, Error>) -> Void) {
        var url: URL?
        if let path { url = URL(fileURLWithPath: path) }
        else if let bundleId { url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) }
        guard let url else { return completion(.failure(HelperError("app not found"))) }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = false
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, err in
            if let app { completion(.success(app.processIdentifier)) }
            else { completion(.failure(err ?? HelperError("launch failed"))) }
        }
    }
}
