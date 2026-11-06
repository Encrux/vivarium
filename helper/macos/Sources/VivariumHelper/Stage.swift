import AppKit
import CGVirtualDisplayPrivate
import CoreGraphics
import Foundation

/// The "stage": an invisible virtual display where tile windows live.
///
/// Why: macOS tells apps when their windows are fully hidden (behind Obsidian, other Space),
/// and apps like Safari/Chrome then stop painting — a streamed tile would freeze. On the
/// stage, windows are "on screen", so apps render normally, and you never see them.
/// Windows are cascaded so each keeps a visible strip (never fully occluded).
///
/// The display exists only while the helper runs. When Obsidian quits, macOS moves the
/// windows back to your real screens — which is what you want with Obsidian closed.
final class Stage {
    static let shared = Stage()

    private var display: CGVirtualDisplay?
    private(set) var displayID: CGDirectDisplayID = 0
    private var slots: [CGWindowID: Int] = [:]
    private var owners: [CGWindowID: pid_t] = [:]
    private var watching = false
    // points; HiDPI so streamed windows stay sharp on Retina canvases
    private let width: UInt32 = 2560
    private let height: UInt32 = 1600
    private let step: CGFloat = 36

    var bounds: CGRect { displayID == 0 ? .null : CGDisplayBounds(displayID) }

    func ensure() throws {
        if display != nil, displayID != 0 { return }
        let d = CGVirtualDisplayDescriptor()
        d.queue = DispatchQueue.main
        d.name = "Vivarium Stage"
        d.maxPixelsWide = width * 2
        d.maxPixelsHigh = height * 2
        d.sizeInMillimeters = CGSize(width: 600, height: 375)
        d.productID = 0xCA11
        d.vendorID = 0xCA11
        // Unique per helper: every Obsidian vault window runs its own helper, and macOS refuses
        // a second virtual display with the same vendor/product/serial.
        d.serialNum = UInt32(truncatingIfNeeded: getpid())
        d.terminationHandler = { _, _ in Out.log("stage display terminated") }
        guard let vd = CGVirtualDisplay(descriptor: d) else { throw HelperError("could not create the Vivarium stage display") }
        let s = CGVirtualDisplaySettings()
        s.hiDPI = 1
        s.modes = [CGVirtualDisplayMode(width: width, height: height, refreshRate: 60)]
        guard vd.apply(s) else { throw HelperError("could not configure the Vivarium stage display") }
        display = vd
        displayID = vd.displayID
        waitForDisplay()
        moveOutOfReach()
        watchDisplays()
        Out.log("stage display \(displayID) at \(bounds)")
    }

    /// If the stage disappears (display reconfiguration, sleep/wake edge cases), macOS dumps its
    /// windows onto your real screens. Recreate it and put them back.
    private func watchDisplays() {
        if watching { return }
        watching = true
        CGDisplayRegisterReconfigurationCallback({ id, flags, _ in
            guard flags.contains(.removeFlag) || flags.contains(.disabledFlag) else { return }
            DispatchQueue.main.async { Stage.shared.displayRemoved(id) }
        }, nil)
    }

    private func displayRemoved(_ id: CGDirectDisplayID) {
        guard id == displayID, displayID != 0 else { return }
        Out.log("stage display removed; recreating")
        display = nil
        displayID = 0
        let parked = slots
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            for (wid, _) in parked {
                if let pid = self.owners[wid] { try? self.park(windowId: wid, pid: pid) }
            }
        }
    }

    private func waitForDisplay() {
        for _ in 0..<40 where CGDisplayBounds(displayID).width == 0 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
    }

    /// Put the stage diagonally off the bottom-right corner of all real displays, so the cursor
    /// can't slide onto it along a shared edge.
    private func moveOutOfReach() {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var n: UInt32 = 0
        CGGetActiveDisplayList(16, &ids, &n)
        let real = ids.prefix(Int(n)).filter { $0 != displayID }
        let union = real.map { CGDisplayBounds($0) }.reduce(CGRect.null) { $0.union($1) }
        guard !union.isNull else { return }
        var cfg: CGDisplayConfigRef?
        guard CGBeginDisplayConfiguration(&cfg) == .success else { return }
        CGConfigureDisplayOrigin(cfg, displayID, Int32(union.maxX), Int32(union.maxY))
        CGCompleteDisplayConfiguration(cfg, .forSession)
        waitForDisplay()
    }

    func contains(_ frame: CGRect) -> Bool {
        let b = bounds
        return !b.isNull && b.intersects(frame) && b.intersection(frame).area >= frame.area * 0.5
    }

    /// Move a window onto the stage (keeps its size). Needs Accessibility.
    func park(windowId: CGWindowID, pid: pid_t) throws {
        try ensure()
        let slot: Int
        if let s = slots[windowId] { slot = s }
        else {
            let used = Set(slots.values)
            slot = (0...).first { !used.contains($0) }!
            slots[windowId] = slot
        }
        owners[windowId] = pid
        let b = bounds
        let k = CGFloat(slot % 24)
        let origin = CGPoint(x: b.minX + 8 + k * step, y: b.minY + 8 + k * step)
        try Windows.setFrame(pid: pid, id: windowId, origin: origin, size: nil)
    }

    /// Bring a window to the display Obsidian is on (for full screen / "show real window").
    func unpark(windowId: CGWindowID, pid: pid_t) throws {
        let target = Windows.obsidianWindowFrame() ?? CGDisplayBounds(CGMainDisplayID())
        try Windows.setFrame(pid: pid, id: windowId, origin: CGPoint(x: target.minX + 40, y: target.minY + 40), size: nil)
    }

    func forget(_ windowId: CGWindowID) {
        slots[windowId] = nil
        owners[windowId] = nil
    }

    func teardown() {
        display = nil // releasing the object removes the display
        displayID = 0
    }
}
