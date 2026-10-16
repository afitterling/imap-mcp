import Foundation

/// What the relay remembers between syncs. No note content: ids, dates and the user's choice.
public struct SyncState: Codable, Sendable, Equatable {
    /// Folders the user chose to share. Nothing is shared until they pick.
    public var sharedFolderIds: [String] = []
    /// Modification date of each note as last sent to the server.
    public var sent: [String: Date] = [:]
    public var lastPrune: Date?
    /// Queued notes already created in Notes whose acknowledgement has not reached the server.
    public var createdNotAcked: [String] = []

    public init() {}
}

public protocol StateStore: Sendable {
    func load() throws -> SyncState
    func save(_ state: SyncState) throws
}

/// ~/Library/Application Support/NotesRelay/state.json
public struct FileStateStore: StateStore {
    let url: URL

    public init(url: URL? = nil) {
        self.url = url ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: "NotesRelay/state.json")
    }

    public func load() throws -> SyncState {
        guard let data = try? Data(contentsOf: url) else { return SyncState() }
        return try JSONDecoder().decode(SyncState.self, from: data)
    }

    public func save(_ state: SyncState) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(state).write(to: url, options: [.atomic, .completeFileProtection])
    }
}

public struct SyncPlan: Equatable, Sendable {
    public var changed: [String]
    public var removed: [String]
    public var prune: Bool
}

public enum SyncPlanner {
    public static let pruneEvery: TimeInterval = 24 * 3600

    /// New or modified notes are sent; vanished ones (deleted, moved out, folder unshared) trigger a prune.
    public static func plan(current: [String: Date], state: SyncState, now: Date) -> SyncPlan {
        let changed = current.filter { id, modified in state.sent[id].map { $0 != modified } ?? true }.keys.sorted()
        let removed = state.sent.keys.filter { current[$0] == nil }.sorted()
        let due = state.lastPrune.map { now.timeIntervalSince($0) >= pruneEvery } ?? true
        return SyncPlan(changed: changed, removed: removed, prune: !removed.isEmpty || due)
    }

    /// Pushes stay well under the server's 200-note and 4 MB limits.
    public static func batches(_ notes: [NotePayload], maxCount: Int = 200, maxBytes: Int = 2_500_000) -> [[NotePayload]] {
        var out: [[NotePayload]] = []
        var current: [NotePayload] = []
        var bytes = 0
        for n in notes {
            let size = n.title.utf8.count + n.text.utf8.count + n.noteId.utf8.count + 200
            if !current.isEmpty && (current.count == maxCount || bytes + size > maxBytes) {
                out.append(current)
                current = []
                bytes = 0
            }
            current.append(n)
            bytes += size
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    /// Where a queued note goes: the shared folder Claude named, else a shared "Notes", else the first shared one.
    public static func target(for name: String?, shared: [NotesFolder]) -> NotesFolder? {
        if let name, let hit = shared.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) { return hit }
        return shared.first(where: { $0.name == "Notes" }) ?? shared.first
    }
}

public struct SyncReport: Equatable, Sendable {
    public var pushed = 0
    public var removed = 0
    public var created = 0
    public var failedCreates = 0
    /// Queued notes left on the server because no folder is shared yet.
    public var waitingCreates = 0
    public var total: Int?

    public init() {}
}

public actor SyncEngine {
    let bridge: any NotesBridge
    let api: any RelayService
    let store: any StateStore
    let device: String

    public init(bridge: any NotesBridge, api: any RelayService, store: any StateStore, device: String) {
        self.bridge = bridge
        self.api = api
        self.store = store
        self.device = device
    }

    public func sync(now: Date = Date()) async throws -> SyncReport {
        var state = try store.load()
        var report = SyncReport()
        let shared = try await bridge.folders().filter { state.sharedFolderIds.contains($0.id) }

        var current: [String: (stamp: NoteStamp, folder: NotesFolder)] = [:]
        for folder in shared {
            for stamp in try await bridge.stamps(in: folder) { current[stamp.id] = (stamp, folder) }
        }
        let plan = SyncPlanner.plan(current: current.mapValues(\.stamp.modified), state: state, now: now)

        var payloads: [NotePayload] = []
        for id in plan.changed {
            guard let (stamp, folder) = current[id] else { continue }
            let c = try await bridge.content(of: id)
            payloads.append(NotePayload(noteId: id, account: folder.account, folder: folder.name, title: c.title, text: c.text, created: c.created, modified: stamp.modified))
        }
        for batch in SyncPlanner.batches(payloads) {
            report.total = try await api.push(device: device, notes: batch)
            report.pushed += batch.count
            // Saved per batch, so an interrupted sync resumes where it stopped.
            for p in batch { state.sent[p.noteId] = current[p.noteId]?.stamp.modified }
            try store.save(state)
        }
        if plan.prune {
            try await api.prune(device: device, keep: current.keys.sorted())
            for id in plan.removed { state.sent[id] = nil }
            report.removed = plan.removed.count
            state.lastPrune = now
            try store.save(state)
        }

        for p in try await api.pending() {
            if state.createdNotAcked.contains(p.id) {
                // Created last time; only the acknowledgement was lost.
                try await api.ack(id: p.id, ok: true, error: nil)
                state.createdNotAcked.removeAll { $0 == p.id }
                try store.save(state)
                continue
            }
            guard let folder = SyncPlanner.target(for: p.folder, shared: shared) else {
                report.waitingCreates += 1
                continue
            }
            do {
                try await bridge.create(html: NoteHTML.render(title: p.title, body: p.body), in: folder)
            } catch NotesBridgeError.notAuthorized {
                // Keep it queued: it can be created once the user allows Notes access.
                throw NotesBridgeError.notAuthorized
            } catch {
                try await api.ack(id: p.id, ok: false, error: String(describing: error))
                report.failedCreates += 1
                continue
            }
            state.createdNotAcked.append(p.id)
            try store.save(state)
            try await api.ack(id: p.id, ok: true, error: nil)
            state.createdNotAcked.removeAll { $0 == p.id }
            try store.save(state)
            report.created += 1
        }
        return report
    }
}
