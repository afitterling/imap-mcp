// swift-tools-version: 6.0
import PackageDescription

// Notes relay: a menu-bar app that shares chosen iCloud Notes folders with the WebMail /
// Private Office MCP server and carries out the notes Claude queues. The logic lives in
// NotesRelayCore so it can be tested without Notes.app, Cognito or a network.
let package = Package(
    name: "NotesRelay",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "NotesRelay", targets: ["NotesRelay"]),
    ],
    targets: [
        .target(name: "NotesRelayCore"),
        .executableTarget(name: "NotesRelay", dependencies: ["NotesRelayCore"]),
        .testTarget(name: "NotesRelayCoreTests", dependencies: ["NotesRelayCore"]),
    ]
)
