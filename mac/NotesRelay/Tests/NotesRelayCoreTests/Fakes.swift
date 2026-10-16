import Foundation
@testable import NotesRelayCore

/// Answers requests in order and records them.
final class MockTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [HTTPResponse]
    private(set) var requests: [URLRequest] = []

    init(_ responses: [HTTPResponse]) { self.responses = responses }

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        lock.withLock {
            requests.append(request)
            return responses.isEmpty ? HTTPResponse(status: 500, body: Data()) : responses.removeFirst()
        }
    }
}

func json(_ status: Int, _ s: String) -> HTTPResponse { HTTPResponse(status: status, body: Data(s.utf8)) }

final class MemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: TokenSet?
    init(_ tokens: TokenSet? = nil) { self.tokens = tokens }
    func load() throws -> TokenSet? { lock.withLock { tokens } }
    func save(_ t: TokenSet) throws { lock.withLock { tokens = t } }
    func clear() throws { lock.withLock { tokens = nil } }
}

final class MemoryStateStore: StateStore, @unchecked Sendable {
    private let lock = NSLock()
    var state: SyncState
    init(_ state: SyncState = SyncState()) { self.state = state }
    func load() throws -> SyncState { lock.withLock { state } }
    func save(_ s: SyncState) throws { lock.withLock { state = s } }
}

final class FakeBridge: NotesBridge, @unchecked Sendable {
    var allFolders: [NotesFolder]
    var notes: [String: (folder: String, content: NoteContent)]
    var created: [(html: String, folder: String)] = []
    var contentReads: [String] = []
    var createError: NotesBridgeError?

    init(folders: [NotesFolder], notes: [NoteContent] = [], in folderOf: [String: String] = [:]) {
        allFolders = folders
        self.notes = Dictionary(uniqueKeysWithValues: notes.map { ($0.id, (folderOf[$0.id] ?? folders[0].id, $0)) })
    }

    func folders() async throws -> [NotesFolder] { allFolders }
    func stamps(in folder: NotesFolder) async throws -> [NoteStamp] {
        notes.values.filter { $0.folder == folder.id }.map { NoteStamp(id: $0.content.id, modified: $0.content.modified) }
    }
    func content(of noteId: String) async throws -> NoteContent {
        contentReads.append(noteId)
        return notes[noteId]!.content
    }
    func create(html: String, in folder: NotesFolder) async throws {
        if let createError { throw createError }
        created.append((html, folder.id))
    }
}

final class FakeRelay: RelayService, @unchecked Sendable {
    var pushes: [[NotePayload]] = []
    var prunes: [[String]] = []
    var pendingNotes: [PendingNote] = []
    var acks: [(id: String, ok: Bool, error: String?)] = []
    var failAckOnce = false

    func push(device: String, notes: [NotePayload]) async throws -> Int {
        pushes.append(notes)
        return pushes.flatMap { $0 }.count
    }
    func prune(device: String, keep: [String]) async throws { prunes.append(keep) }
    func pending() async throws -> [PendingNote] { pendingNotes.filter { p in !acks.contains { $0.id == p.id } } }
    func ack(id: String, ok: Bool, error: String?) async throws {
        if failAckOnce {
            failAckOnce = false
            throw RelayError.server(503, "unavailable")
        }
        acks.append((id, ok, error))
    }
    func disconnect() async throws {}
}

let day: TimeInterval = 86400
let t0 = Date(timeIntervalSince1970: 1_790_000_000)
