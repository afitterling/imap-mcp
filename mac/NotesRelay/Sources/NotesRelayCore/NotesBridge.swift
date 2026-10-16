import Foundation

public struct NotesFolder: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var account: String

    public init(id: String, name: String, account: String) {
        self.id = id
        self.name = name
        self.account = account
    }
}

/// Just enough to tell whether a note changed since it was last sent.
public struct NoteStamp: Sendable, Equatable {
    public var id: String
    public var modified: Date

    public init(id: String, modified: Date) {
        self.id = id
        self.modified = modified
    }
}

public struct NoteContent: Sendable, Equatable {
    public var id: String
    public var title: String
    public var text: String
    public var created: Date?
    public var modified: Date

    public init(id: String, title: String, text: String, created: Date?, modified: Date) {
        self.id = id
        self.title = title
        self.text = text
        self.created = created
        self.modified = modified
    }
}

public enum NotesBridgeError: Error, Equatable, CustomStringConvertible {
    /// macOS refused the Apple Events: System Settings → Privacy & Security → Automation.
    case notAuthorized
    case script(String, Int?)
    case unexpectedResult(String)

    public var description: String {
        switch self {
        case .notAuthorized: "Notes access is off. Allow it in System Settings → Privacy & Security → Automation → NotesRelay → Notes."
        case let .script(message, code): "Notes said: \(message)\(code.map { " (\($0))" } ?? "")"
        case let .unexpectedResult(what): "Unexpected answer from Notes: \(what)"
        }
    }
}

/// Notes.app as the sync engine needs it. Read lists cheaply, read text only for changed notes.
public protocol NotesBridge: Sendable {
    func folders() async throws -> [NotesFolder]
    func stamps(in folder: NotesFolder) async throws -> [NoteStamp]
    func content(of noteId: String) async throws -> NoteContent
    func create(html: String, in folder: NotesFolder) async throws
}

/// An AppleScript string literal. Notes ids and Claude's text both pass through here.
public func appleScriptLiteral(_ s: String) -> String {
    "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
}

/// Talks to Notes.app through AppleScript. NSAppleScript is used from the main thread only.
@MainActor
public final class AppleScriptNotesBridge: NotesBridge {
    public init() {}

    public func folders() async throws -> [NotesFolder] {
        let result = try run("""
        tell application "Notes"
            set out to {}
            repeat with a in accounts
                repeat with f in folders of a
                    set end of out to {id of f, name of f, name of a}
                end repeat
            end repeat
            return out
        end tell
        """)
        return try items(result).map { row in
            let r = try items(row)
            guard r.count == 3, let id = r[0].stringValue, let name = r[1].stringValue, let account = r[2].stringValue else {
                throw NotesBridgeError.unexpectedResult("folder row")
            }
            return NotesFolder(id: id, name: name, account: account)
        }
    }

    public func stamps(in folder: NotesFolder) async throws -> [NoteStamp] {
        let result = try run("""
        tell application "Notes"
            set f to folder id \(appleScriptLiteral(folder.id))
            return {id of notes of f, modification date of notes of f}
        end tell
        """)
        let pair = try items(result)
        guard pair.count == 2 else { throw NotesBridgeError.unexpectedResult("stamps") }
        let ids = try items(pair[0]), dates = try items(pair[1])
        guard ids.count == dates.count else { throw NotesBridgeError.unexpectedResult("stamp counts") }
        return try zip(ids, dates).map { id, date in
            guard let id = id.stringValue, let modified = date.dateValue else { throw NotesBridgeError.unexpectedResult("stamp") }
            return NoteStamp(id: id, modified: modified)
        }
    }

    public func content(of noteId: String) async throws -> NoteContent {
        let result = try run("""
        tell application "Notes"
            set n to note id \(appleScriptLiteral(noteId))
            return {name of n, plaintext of n, creation date of n, modification date of n}
        end tell
        """)
        let r = try items(result)
        guard r.count == 4, let modified = r[3].dateValue else { throw NotesBridgeError.unexpectedResult("note") }
        return NoteContent(id: noteId, title: r[0].stringValue ?? "", text: r[1].stringValue ?? "", created: r[2].dateValue, modified: modified)
    }

    public func create(html: String, in folder: NotesFolder) async throws {
        _ = try run("""
        tell application "Notes"
            make new note at folder id \(appleScriptLiteral(folder.id)) with properties {body:\(appleScriptLiteral(html))}
        end tell
        """)
    }

    private func run(_ source: String) throws -> NSAppleEventDescriptor {
        guard let script = NSAppleScript(source: source) else { throw NotesBridgeError.script("could not compile", nil) }
        var error: NSDictionary?
        let result = script.executeAndReturnError(&error)
        if let error {
            let code = error[NSAppleScript.errorNumber] as? Int
            // -1743: not permitted to send Apple Events; -1744: the user has not decided yet.
            if code == -1743 || code == -1744 { throw NotesBridgeError.notAuthorized }
            throw NotesBridgeError.script(error[NSAppleScript.errorMessage] as? String ?? "AppleScript failed", code)
        }
        return result
    }

    private func items(_ d: NSAppleEventDescriptor) throws -> [NSAppleEventDescriptor] {
        // An empty folder answers with an empty list; a one-item answer may not be a list at all.
        guard d.descriptorType == typeAEList else { return d.numberOfItems == 0 && d.stringValue == nil ? [] : [d] }
        return (0..<d.numberOfItems).compactMap { d.atIndex($0 + 1) }
    }
}

/// Note HTML in the shape Notes writes: the title first, one <div> per line, real lists.
/// The same rules as the server's mail-account notes (sst/src/lib/notes.ts).
public enum NoteHTML {
    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    static func inline(_ s: String) -> String {
        var out = escape(s)
        out = out.replacing(/\*\*(.+?)\*\*/) { "<b>\($0.output.1)</b>" }
        out = out.replacing(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/) { "\($0.output.1)<i>\($0.output.2)</i>" }
        return out
    }

    public static func render(title: String, body: String) -> String {
        var out = ["<div><b>\(escape(title.trimmingCharacters(in: .whitespacesAndNewlines)))</b></div>"]
        var list: (tag: String, items: [String])?
        func flush() {
            if let l = list { out.append("<\(l.tag)>" + l.items.map { "<li>\($0)</li>" }.joined() + "</\(l.tag)>") }
            list = nil
        }
        for raw in body.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw).replacing(/\s+$/, with: "")
            if let m = line.firstMatch(of: /^\s*[-*•]\s+(.*)$/) ?? line.firstMatch(of: /^\s*\d+[.)]\s+(.*)$/) {
                let tag = line.firstMatch(of: /^\s*[-*•]\s+/) != nil ? "ul" : "ol"
                if list?.tag != tag { flush() }
                if list == nil { list = (tag, []) }
                list!.items.append(inline(String(m.output.1)))
                continue
            }
            flush()
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                out.append("<div><br></div>")
            } else if let h = line.firstMatch(of: /^#{1,6}\s+(.*)$/) {
                out.append("<div><b>\(inline(String(h.output.1)))</b></div>")
            } else {
                out.append("<div>\(inline(line))</div>")
            }
        }
        flush()
        return "<html><head></head><body>" + out.joined() + "</body></html>"
    }
}
