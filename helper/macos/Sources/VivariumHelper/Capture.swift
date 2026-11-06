import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

/// Streams one app window as H.264.
///
/// On the stage (see Stage.swift) the window is on screen, so we capture the stage *display*
/// filtered to just this app's window + its menus/popups/sheets, cropped to the window: other
/// windows never appear, and popups do. Elsewhere we fall back to single-window capture.
/// ScreenCaptureKit only delivers frames when pixels change, so an idle window costs nothing.
final class WindowStream: NSObject, SCStreamOutput, SCStreamDelegate {
    let streamId: UInt32
    let windowId: CGWindowID
    let pid: pid_t
    private var fps: Int
    private var maxW: Int
    private var maxH: Int
    private var stream: SCStream?
    private var display: SCDisplay?
    private var frame: CGRect = .zero
    private var onStage = false
    private var includedIds: Set<CGWindowID> = []
    private var timer: DispatchSourceTimer?
    private let q = DispatchQueue(label: "vivarium.stream")
    // accessed on q only
    private var encoder: Encoder?
    private var lastPixelBuffer: CVPixelBuffer?
    private var stopped = false

    init(streamId: UInt32, windowId: CGWindowID, pid: pid_t, fps: Int, maxW: Int, maxH: Int) {
        self.streamId = streamId
        self.windowId = windowId
        self.pid = pid
        self.fps = max(1, min(120, fps))
        self.maxW = maxW
        self.maxH = maxH
    }

    func start() async throws -> [String: Any] {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let target = content.windows.first(where: { $0.windowID == windowId }) else { throw HelperError("window \(windowId) not found") }
        frame = target.frame
        let (filter, disp) = try makeFilter(content, target)
        display = disp
        let s = SCStream(filter: filter, configuration: makeConfig(), delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
        try await s.startCapture()
        stream = s
        startPolling()
        return ["windowWidth": frame.width, "windowHeight": frame.height]
    }

    private func makeFilter(_ content: SCShareableContent, _ target: SCWindow) throws -> (SCContentFilter, SCDisplay) {
        let disp = content.displays.max { a, b in
            a.frame.intersection(target.frame).area < b.frame.intersection(target.frame).area
        } ?? content.displays.first
        guard let disp else { throw HelperError("no display") }
        onStage = Stage.shared.displayID != 0 && disp.displayID == Stage.shared.displayID
        if !onStage {
            includedIds = [target.windowID]
            return (SCContentFilter(desktopIndependentWindow: target), disp)
        }
        let extras = content.windows.filter { isPopup($0.windowID, $0.windowLayer, $0.frame, owner: $0.owningApplication?.processID) }
        includedIds = Set([target.windowID] + extras.map(\.windowID))
        return (SCContentFilter(display: disp, including: [target] + extras), disp)
    }

    /// Menus, popovers, tooltips (layer > 0) and sheets/dialogs (smaller, inside the window) of the same app.
    private func isPopup(_ id: CGWindowID, _ layer: Int, _ f: CGRect, owner: pid_t?) -> Bool {
        owner == pid && id != windowId && f.intersects(frame)
            && (layer > 0 || (layer == 0 && frame.contains(f) && f.size != frame.size))
    }

    private func outputSize() -> (Int, Int) {
        let scale = Double(NSScreenScale.forDisplay(display?.displayID ?? CGMainDisplayID()))
        var w = Double(frame.width) * scale, h = Double(frame.height) * scale
        let k = min(1.0, Double(maxW) / max(w, 1), Double(maxH) / max(h, 1))
        w *= k; h *= k
        return (max(16, Int(w) & ~1), max(16, Int(h) & ~1))
    }

    private func makeConfig() -> SCStreamConfiguration {
        let cfg = SCStreamConfiguration()
        let (w, h) = outputSize()
        cfg.width = w
        cfg.height = h
        if onStage, let d = display {
            cfg.sourceRect = CGRect(x: frame.minX - d.frame.minX, y: frame.minY - d.frame.minY, width: frame.width, height: frame.height)
        }
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.showsCursor = false
        cfg.queueDepth = 4
        cfg.colorSpaceName = CGColorSpace.sRGB
        return cfg
    }

    /// Change frame rate / resolution cap without restarting (LOD: focused → 60 fps, idle → low).
    func reconfigure(fps: Int?, maxW: Int?, maxH: Int?) {
        if let fps { self.fps = max(1, min(120, fps)) }
        if let maxW { self.maxW = maxW }
        if let maxH { self.maxH = maxH }
        stream?.updateConfiguration(makeConfig()) { err in
            if let err { Out.log("updateConfiguration: \(err)") }
        }
    }

    func requestKeyframe() {
        q.async {
            self.encoder?.requestKeyframe()
            // Idle windows produce no new frames: re-encode the last one so the decoder can start.
            if let pb = self.lastPixelBuffer { self.encode(pb, pts: CMClockGetTime(CMClockGetHostTimeClock())) }
        }
    }

    // MARK: frames

    func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid,
              let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = att.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        lastPixelBuffer = pb
        encode(pb, pts: CMSampleBufferGetPresentationTimeStamp(sb))
    }

    private func encode(_ pb: CVPixelBuffer, pts: CMTime) {
        if stopped { return }
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        if encoder == nil || encoder!.width != Int32(w & ~1) || encoder!.height != Int32(h & ~1) {
            encoder?.invalidate()
            do {
                let e = try Encoder(width: w, height: h, fps: fps)
                let id = streamId
                let winW = frame.width, winH = frame.height
                e.onConfig = { codec, desc in
                    Out.event("stream_config", ["stream": Int(id), "codec": codec, "description": desc.base64EncodedString(),
                                                "width": w, "height": h, "windowWidth": winW, "windowHeight": winH])
                }
                e.onPacket = { data, key, ts in Out.video(stream: id, keyframe: key, timestampUs: ts, data: data) }
                encoder = e
            } catch {
                Out.event("stream_error", ["stream": Int(streamId), "message": "\(error)"])
                return
            }
        }
        encoder?.encode(pb, pts: pts)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Out.event("stream_error", ["stream": Int(streamId), "message": error.localizedDescription])
    }

    // MARK: window tracking (cheap CoreGraphics polling)

    private func startPolling() {
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 0.25, repeating: 0.25)
        t.setEventHandler { [weak self] in self?.poll() }
        t.resume()
        timer = t
    }

    private func poll() {
        let wins = Windows.cgList(pid: pid)
        guard let me = wins.first(where: { $0.id == windowId }) else {
            Out.event("window_closed", ["stream": Int(streamId), "windowId": Int(windowId)])
            stop()
            return
        }
        var refilter = false
        if me.frame != frame {
            let sizeChanged = me.frame.size != frame.size
            frame = me.frame
            if Stage.shared.contains(frame) != onStage { refilter = true }
            else { stream?.updateConfiguration(makeConfig()) { _ in } }
            if sizeChanged {
                Out.event("window_changed", ["stream": Int(streamId), "windowId": Int(windowId), "windowWidth": frame.width, "windowHeight": frame.height])
            }
        }
        if onStage {
            let popups = Set(wins.filter { isPopup($0.id, $0.layer, $0.frame, owner: $0.pid) }.map(\.id) + [windowId])
            if popups != includedIds { refilter = true }
        }
        if refilter { Task { await self.refilter() } }
    }

    private func refilter() async {
        guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false),
              let target = content.windows.first(where: { $0.windowID == windowId }),
              let (filter, disp) = try? makeFilter(content, target) else { return }
        display = disp
        try? await stream?.updateContentFilter(filter)
        try? await stream?.updateConfiguration(makeConfig())
    }

    func stop() {
        timer?.cancel()
        timer = nil
        stream?.stopCapture { _ in }
        stream = nil
        q.async {
            self.stopped = true
            self.encoder?.invalidate()
            self.encoder = nil
            self.lastPixelBuffer = nil
        }
    }

    /// Global top-left point of the window (for input mapping).
    var windowFrame: CGRect { frame }
}

enum NSScreenScale {
    static func forDisplay(_ id: CGDirectDisplayID) -> CGFloat {
        guard let mode = CGDisplayCopyDisplayMode(id) else { return 2 }
        return CGFloat(mode.pixelWidth) / CGFloat(max(1, mode.width))
    }
}

extension CGRect {
    var area: CGFloat { isNull ? 0 : width * height }
}
