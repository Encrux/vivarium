// Wire protocol shared with the Linux helper and the plugin (see helper/PROTOCOL.md).
//
//   plugin → helper : one JSON object per line on stdin
//   helper → plugin : frames on stdout: [u32 BE length][u8 type][payload]
//       type 1  JSON (UTF-8)
//       type 2  video packet: [u32 BE stream][u8 flags][u64 BE timestamp µs][H.264 AVCC sample]
//                flags: bit0 = keyframe
import Foundation

enum Out {
    private static let queue = DispatchQueue(label: "vivarium.out")
    private static let stdout = FileHandle.standardOutput

    private static func frame(_ type: UInt8, _ payload: Data) {
        var header = Data(capacity: 5)
        var len = UInt32(payload.count + 1).bigEndian
        withUnsafeBytes(of: &len) { header.append(contentsOf: $0) }
        header.append(type)
        queue.async {
            do {
                try stdout.write(contentsOf: header)
                try stdout.write(contentsOf: payload)
            } catch {
                exit(0) // plugin went away
            }
        }
    }

    static func json(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
        frame(1, data)
    }

    static func event(_ name: String, _ fields: [String: Any] = [:]) {
        var o = fields
        o["ev"] = name
        json(o)
    }

    static func video(stream: UInt32, keyframe: Bool, timestampUs: UInt64, data: Data) {
        var p = Data(capacity: data.count + 13)
        var s = stream.bigEndian
        withUnsafeBytes(of: &s) { p.append(contentsOf: $0) }
        p.append(keyframe ? 1 : 0)
        var t = timestampUs.bigEndian
        withUnsafeBytes(of: &t) { p.append(contentsOf: $0) }
        p.append(data)
        frame(2, p)
    }

    static func log(_ msg: String) {
        FileHandle.standardError.write(("[vivarium-helper] " + msg + "\n").data(using: .utf8)!)
    }
}

struct HelperError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

extension Dictionary where Key == String, Value == Any {
    func int(_ k: String) -> Int? { (self[k] as? NSNumber)?.intValue }
    func double(_ k: String) -> Double? { (self[k] as? NSNumber)?.doubleValue }
    func str(_ k: String) -> String? { self[k] as? String }
    func bool(_ k: String) -> Bool? { (self[k] as? NSNumber)?.boolValue }
}
