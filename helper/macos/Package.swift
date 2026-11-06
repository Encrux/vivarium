// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "VivariumHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "CGVirtualDisplayPrivate", path: "Sources/CGVirtualDisplayPrivate"),
        .executableTarget(
            name: "vivarium-helper",
            dependencies: ["CGVirtualDisplayPrivate"],
            path: "Sources/VivariumHelper",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AppKit"),
            ]
        )
    ]
)
