import CoreMedia
import Foundation
import VideoToolbox

/// Hardware H.264 encoder tuned for interactive streaming: low-latency rate control,
/// no B-frames (no reordering delay), keyframes only on demand.
final class Encoder {
    let width: Int32
    let height: Int32
    private var session: VTCompressionSession?
    private var forceKeyframe = true
    private var lastDescription: Data?
    /// (sample in AVCC format, isKeyframe, timestamp µs)
    var onPacket: ((Data, Bool, UInt64) -> Void)?
    /// (codec string e.g. "avc1.640028", avcC description) — sent whenever SPS/PPS change.
    var onConfig: ((String, Data) -> Void)?

    init(width: Int, height: Int, fps: Int) throws {
        self.width = Int32(width & ~1)
        self.height = Int32(height & ~1)
        let spec: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
            kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
        ]
        var s: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil, width: self.width, height: self.height, codecType: kCMVideoCodecType_H264,
            encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        guard status == noErr, let s else { throw HelperError("VTCompressionSessionCreate failed: \(status)") }
        session = s
        let bitrate = max(1_500_000, min(40_000_000, Int(Double(width * height) * Double(fps) * 0.12)))
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 100_000 as CFNumber)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(s)
    }

    func requestKeyframe() { forceKeyframe = true }

    func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime) {
        guard let session else { return }
        var props: CFDictionary?
        if forceKeyframe {
            props = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
            forceKeyframe = false
        }
        VTCompressionSessionEncodeFrame(session, imageBuffer: pixelBuffer, presentationTimeStamp: pts, duration: .invalid,
                                        frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sample in
            guard status == noErr, let sample, let self else { return }
            self.handle(sample)
        }
    }

    private func handle(_ sample: CMSampleBuffer) {
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let keyframe = !((attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
        if keyframe, let fd = CMSampleBufferGetFormatDescription(sample), let desc = Self.avcC(fd), desc != lastDescription {
            lastDescription = desc
            // codec string from SPS profile/compat/level bytes (avcC bytes 1..3)
            let codec = String(format: "avc1.%02x%02x%02x", desc[1], desc[2], desc[3])
            onConfig?(codec, desc)
        }
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        let len = CMBlockBufferGetDataLength(block)
        var data = Data(count: len)
        data.withUnsafeMutableBytes { _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: len, destination: $0.baseAddress!) }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let us = pts.isValid ? UInt64(max(0, CMTimeGetSeconds(pts) * 1_000_000)) : 0
        onPacket?(data, keyframe, us)
    }

    private static func avcC(_ fd: CMFormatDescription) -> Data? {
        guard let ext = CMFormatDescriptionGetExtension(fd, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any]
        else { return nil }
        return ext["avcC"] as? Data
    }

    func invalidate() {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
        session = nil
    }

    deinit { invalidate() }
}
