import Foundation
import Testing
@testable import NotesRelayCore

let icloudNotes = NotesFolder(id: "f-notes", name: "Notes", account: "iCloud")
let ideas = NotesFolder(id: "f-ideas", name: "Ideas", account: "iCloud")
let privateFolder = NotesFolder(id: "f-private", name: "Private", account: "iCloud")

func content(_ id: String, _ title: String, modified: Date) -> NoteContent {
    NoteContent(id: id, title: title, text: "\(title)\nbody", created: t0, modified: modified)
}

@Suite struct PlannerTests {
    @Test func newAndChangedNotesAreSentUnchangedOnesAreNot() {
        var state = SyncState()
        state.sent = ["a": t0, "b": t0, "gone": t0]
        state.lastPrune = t0
        let plan = SyncPlanner.plan(current: ["a": t0, "b": t0.addingTimeInterval(5), "c": t0], state: state, now: t0.addingTimeInterval(60))
        #expect(plan == SyncPlan(changed: ["b", "c"], removed: ["gone"], prune: true))
    }

    @Test func pruneRunsOnRemovalOrOnceADay() {
        var state = SyncState()
        state.sent = ["a": t0]
        #expect(SyncPlanner.plan(current: ["a": t0], state: state, now: t0).prune, "never pruned yet")
        state.lastPrune = t0
        #expect(!SyncPlanner.plan(current: ["a": t0], state: state, now: t0.addingTimeInterval(day - 1)).prune)
        #expect(SyncPlanner.plan(current: ["a": t0], state: state, now: t0.addingTimeInterval(day)).prune)
    }

    @Test func batchesRespectCountAndSize() {
        let small = (0..<450).map { NotePayload(noteId: "n\($0)", account: "a", folder: "f", title: "t", text: "x", created: nil, modified: t0) }
        #expect(SyncPlanner.batches(small).map(\.count) == [200, 200, 50])
        let big = (0..<5).map { NotePayload(noteId: "b\($0)", account: "a", folder: "f", title: "t", text: String(repeating: "x", count: 90_000), created: nil, modified: t0) }
        #expect(SyncPlanner.batches(big, maxBytes: 200_000).map(\.count) == [2, 2, 1])
        #expect(SyncPlanner.batches([]).isEmpty)
    }

    @Test func payloadsAreCutToTheServersLimitsInUTF16Units() {
        let p = NotePayload(noteId: "n", account: "a", folder: "f", title: String(repeating: "😀", count: 300), text: String(repeating: "y", count: 100_010), created: nil, modified: t0)
        #expect(p.title.utf16.count == 500)
        #expect(p.title.count == 250, "never splits an emoji")
        #expect(p.text.utf16.count == NotePayload.maxText)
    }

    @Test func queuedNotesGoToTheNamedSharedFolderElseNotesElseTheFirst() {
        #expect(SyncPlanner.target(for: "ideas", shared: [icloudNotes, ideas]) == ideas)
        #expect(SyncPlanner.target(for: "Private", shared: [ideas, icloudNotes]) == icloudNotes, "an unshared folder is never written to")
        #expect(SyncPlanner.target(for: nil, shared: [ideas]) == ideas)
        #expect(SyncPlanner.target(for: nil, shared: []) == nil)
    }
}

@Suite struct EngineTests {
    func engine(_ bridge: FakeBridge, _ relay: FakeRelay, _ store: MemoryStateStore) -> SyncEngine {
        SyncEngine(bridge: bridge, api: relay, store: store, device: "Test Mac")
    }

    @Test func onlySharedFoldersLeaveTheMacAndOnlyChangedNotesAreRead() async throws {
        let bridge = FakeBridge(
            folders: [icloudNotes, privateFolder],
            notes: [content("n1", "Groceries", modified: t0), content("p1", "Diary", modified: t0)],
            in: ["n1": "f-notes", "p1": "f-private"]
        )
        var state = SyncState()
        state.sharedFolderIds = ["f-notes"]
        let store = MemoryStateStore(state), relay = FakeRelay()

        let first = try await engine(bridge, relay, store).sync(now: t0)
        #expect(first.pushed == 1)
        #expect(relay.pushes.flatMap { $0 }.map(\.noteId) == ["n1"])
        #expect(relay.pushes[0][0].folder == "Notes")
        #expect(!bridge.contentReads.contains("p1"), "an unshared note is never even read")
        #expect(relay.prunes == [["n1"]])

        bridge.contentReads = []
        let second = try await engine(bridge, relay, store).sync(now: t0.addingTimeInterval(60))
        #expect(second.pushed == 0)
        #expect(bridge.contentReads.isEmpty)
        #expect(relay.prunes.count == 1, "no prune again within a day when nothing vanished")
    }

    @Test func unsharingAFolderPrunesItsNotesFromTheServer() async throws {
        let bridge = FakeBridge(folders: [icloudNotes, ideas], notes: [content("n1", "A", modified: t0), content("i1", "B", modified: t0)], in: ["n1": "f-notes", "i1": "f-ideas"])
        var state = SyncState()
        state.sharedFolderIds = ["f-notes", "f-ideas"]
        let store = MemoryStateStore(state), relay = FakeRelay()
        _ = try await engine(bridge, relay, store).sync(now: t0)

        store.state.sharedFolderIds = ["f-notes"]
        let report = try await engine(bridge, relay, store).sync(now: t0.addingTimeInterval(60))
        #expect(report.removed == 1)
        #expect(relay.prunes.last == ["n1"])
        #expect(store.state.sent.keys.sorted() == ["n1"])
    }

    @Test func queuedNotesAreCreatedInASharedFolderAndAcknowledged() async throws {
        let bridge = FakeBridge(folders: [icloudNotes, ideas])
        var state = SyncState()
        state.sharedFolderIds = ["f-notes", "f-ideas"]
        let store = MemoryStateStore(state), relay = FakeRelay()
        relay.pendingNotes = [PendingNote(id: "q1", title: "Idea <1>", body: "- milk", folder: "Ideas", createdAt: "x")]

        let report = try await engine(bridge, relay, store).sync(now: t0)
        #expect(report.created == 1)
        #expect(bridge.created.map(\.folder) == ["f-ideas"])
        #expect(bridge.created[0].html == "<html><head></head><body><div><b>Idea &lt;1&gt;</b></div><ul><li>milk</li></ul></body></html>")
        #expect(relay.acks.map(\.id) == ["q1"])
        #expect(store.state.createdNotAcked.isEmpty)
    }

    @Test func aLostAcknowledgementNeverCreatesTheNoteTwice() async throws {
        let bridge = FakeBridge(folders: [icloudNotes])
        var state = SyncState()
        state.sharedFolderIds = ["f-notes"]
        let store = MemoryStateStore(state), relay = FakeRelay()
        relay.pendingNotes = [PendingNote(id: "q1", title: "Once", body: "", createdAt: "x")]
        relay.failAckOnce = true

        await #expect(throws: RelayError.self) { try await engine(bridge, relay, store).sync(now: t0) }
        #expect(store.state.createdNotAcked == ["q1"])
        _ = try await engine(bridge, relay, store).sync(now: t0.addingTimeInterval(60))
        #expect(bridge.created.count == 1)
        #expect(relay.acks.map(\.id) == ["q1"])
        #expect(store.state.createdNotAcked.isEmpty)
    }

    @Test func withoutASharedFolderQueuedNotesWait() async throws {
        let bridge = FakeBridge(folders: [icloudNotes])
        let store = MemoryStateStore(), relay = FakeRelay()
        relay.pendingNotes = [PendingNote(id: "q1", title: "Later", body: "", createdAt: "x")]
        let report = try await engine(bridge, relay, store).sync(now: t0)
        #expect(report.waitingCreates == 1)
        #expect(bridge.created.isEmpty && relay.acks.isEmpty)
    }

    @Test func aRefusedCreateIsReportedButMissingPermissionKeepsItQueued() async throws {
        var state = SyncState()
        state.sharedFolderIds = ["f-notes"]
        let relay = FakeRelay()
        relay.pendingNotes = [PendingNote(id: "q1", title: "x", body: "", createdAt: "x")]

        let denied = FakeBridge(folders: [icloudNotes])
        denied.createError = .notAuthorized
        await #expect(throws: NotesBridgeError.notAuthorized) { try await engine(denied, relay, MemoryStateStore(state)).sync(now: t0) }
        #expect(relay.acks.isEmpty)

        let broken = FakeBridge(folders: [icloudNotes])
        broken.createError = .script("folder is locked", -10000)
        let report = try await engine(broken, relay, MemoryStateStore(state)).sync(now: t0)
        #expect(report.failedCreates == 1)
        #expect(relay.acks.map { [$0.id, String($0.ok)] } == [["q1", "false"]])
        #expect(relay.acks[0].error?.contains("folder is locked") == true)
    }
}

@Suite struct NoteHTMLTests {
    @Test func rendersLikeTheServer() {
        // Same input and output as sst/src/lib/notes.test.ts.
        let html = NoteHTML.render(title: "Groceries <today>", body: "Buy:\n- milk\n- **eggs**\n\n1. first\n2. second\n## Later\nfish & chips")
        #expect(html ==
            "<html><head></head><body>" +
            "<div><b>Groceries &lt;today&gt;</b></div>" +
            "<div>Buy:</div>" +
            "<ul><li>milk</li><li><b>eggs</b></li></ul>" +
            "<div><br></div>" +
            "<ol><li>first</li><li>second</li></ol>" +
            "<div><b>Later</b></div>" +
            "<div>fish &amp; chips</div>" +
            "</body></html>")
    }

    @Test func appleScriptLiteralsEscapeQuotesAndBackslashes() {
        #expect(appleScriptLiteral(#"say "hi" \ bye"#) == #""say \"hi\" \\ bye""#)
        #expect(appleScriptLiteral(#"" & do shell script "x"#) == #""\" & do shell script \"x""#)
    }
}

@Suite struct FileStateStoreTests {
    @Test func roundTripsAndStartsEmpty() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "notesrelay-\(UUID().uuidString)/state.json")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = FileStateStore(url: url)
        #expect(try store.load() == SyncState())
        var s = SyncState()
        s.sharedFolderIds = ["f"]
        s.sent = ["n": t0]
        try store.save(s)
        #expect(try store.load() == s)
    }
}
