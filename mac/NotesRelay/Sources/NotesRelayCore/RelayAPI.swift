import Foundation

public enum RelayError: Error, Equatable, CustomStringConvertible {
    case signedOut
    case signIn(String)
    case insecureServer
    case server(Int, String)
    case keychain(OSStatus)

    public var description: String {
        switch self {
        case .signedOut: "Signed out — sign in to the Notes relay again."
        case let .signIn(why): "Sign-in failed: \(why)"
        case .insecureServer: "The server address must start with https://."
        case let .server(status, what): "Server answered \(status): \(what)"
        case let .keychain(status): "Keychain error \(status)."
        }
    }
}

public struct HTTPResponse: Sendable {
    public let status: Int
    public let body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> HTTPResponse
}

public struct URLSessionTransport: HTTPTransport {
    public init() {}

    public func send(_ request: URLRequest) async throws -> HTTPResponse {
        let (data, response) = try await URLSession.shared.data(for: request)
        return HTTPResponse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: data)
    }
}

/// One note as the server stores it. Lengths are counted in UTF-16 units, like the server.
public struct NotePayload: Codable, Sendable, Equatable {
    public var noteId: String
    public var account: String
    public var folder: String
    public var title: String
    public var text: String
    public var created: String?
    public var modified: String

    public static let maxTitle = 500
    public static let maxText = 100_000

    public init(noteId: String, account: String, folder: String, title: String, text: String, created: Date?, modified: Date) {
        self.noteId = noteId
        self.account = account
        self.folder = folder
        self.title = truncatedUTF16(title, max: Self.maxTitle)
        self.text = truncatedUTF16(text, max: Self.maxText)
        self.created = created.map(iso)
        self.modified = iso(modified)
    }
}

public struct PendingNote: Codable, Sendable, Equatable {
    public var id: String
    public var title: String
    public var body: String
    public var folder: String?
    public var createdAt: String

    public init(id: String, title: String, body: String, folder: String? = nil, createdAt: String) {
        self.id = id
        self.title = title
        self.body = body
        self.folder = folder
        self.createdAt = createdAt
    }
}

func iso(_ date: Date) -> String {
    date.formatted(.iso8601)
}

/// Cuts on character boundaries so the result never exceeds `max` UTF-16 units.
public func truncatedUTF16(_ s: String, max: Int) -> String {
    if s.utf16.count <= max { return s }
    var out = ""
    var count = 0
    for ch in s {
        let n = ch.utf16.count
        if count + n > max { break }
        out.append(ch)
        count += n
    }
    return out
}

/// The server side of a sync, so the engine can be tested against a fake.
public protocol RelayService: Sendable {
    func push(device: String, notes: [NotePayload]) async throws -> Int
    func prune(device: String, keep: [String]) async throws
    func pending() async throws -> [PendingNote]
    func ack(id: String, ok: Bool, error: String?) async throws
    func disconnect() async throws
}

public struct RelayAPI: RelayService {
    public let baseURL: URL
    let session: AuthSession
    let transport: any HTTPTransport

    public init(baseURL: URL, session: AuthSession, transport: any HTTPTransport = URLSessionTransport()) throws {
        guard baseURL.scheme == "https" else { throw RelayError.insecureServer }
        self.baseURL = baseURL
        self.session = session
        self.transport = transport
    }

    /// Public: the sign-in parameters, read before there is any token.
    public static func config(baseURL: URL, transport: any HTTPTransport = URLSessionTransport()) async throws -> RelayConfig {
        guard baseURL.scheme == "https" else { throw RelayError.insecureServer }
        let res = try await transport.send(URLRequest(url: baseURL.appending(path: "relay/config")))
        guard res.status == 200 else { throw RelayError.server(res.status, "This does not look like a Private Office server.") }
        let config = try JSONDecoder().decode(RelayConfig.self, from: res.body)
        guard !config.clientId.isEmpty else { throw RelayError.server(res.status, "The server has no Notes relay client configured.") }
        return config
    }

    public func push(device: String, notes: [NotePayload]) async throws -> Int {
        struct Body: Encodable { let device: String; let notes: [NotePayload] }
        struct Out: Decodable { let total: Int }
        return try JSONDecoder().decode(Out.self, from: try await call("PUT", "relay/notes", Body(device: device, notes: notes))).total
    }

    public func prune(device: String, keep: [String]) async throws {
        struct Body: Encodable { let device: String; let keep: [String] }
        _ = try await call("POST", "relay/notes/prune", Body(device: device, keep: keep))
    }

    public func pending() async throws -> [PendingNote] {
        struct Out: Decodable { let pending: [PendingNote] }
        return try JSONDecoder().decode(Out.self, from: try await call("GET", "relay/notes/pending", Optional<String>.none)).pending
    }

    public func ack(id: String, ok: Bool, error: String?) async throws {
        struct Body: Encodable { let ok: Bool; let error: String? }
        _ = try await call("POST", "relay/notes/pending/\(Self.pathSegment(id))/ack", Body(ok: ok, error: error.map { truncatedUTF16($0, max: 300) }))
    }

    public func disconnect() async throws {
        _ = try await call("DELETE", "relay/notes", Optional<String>.none)
    }

    /// Ids carry "#"; nothing but unreserved characters goes into the path unencoded.
    static func pathSegment(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    private func call(_ method: String, _ path: String, _ body: (some Encodable)?) async throws -> Data {
        // The path is appended verbatim: percent-encoded ids must stay encoded.
        let url = URL(string: baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/" + path)!
        for attempt in 0..<2 {
            var r = URLRequest(url: url)
            r.httpMethod = method
            r.setValue("Bearer \(try await session.accessToken())", forHTTPHeaderField: "Authorization")
            if let body {
                r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                r.httpBody = try JSONEncoder().encode(body)
            }
            let res = try await transport.send(r)
            if res.status == 401 && attempt == 0 {
                await session.invalidateAccessToken()
                continue
            }
            if res.status == 401 { throw RelayError.signedOut }
            guard (200..<300).contains(res.status) else {
                let message = (try? JSONDecoder().decode([String: String].self, from: res.body))?["error"] ?? "request failed"
                throw RelayError.server(res.status, message)
            }
            return res.body
        }
        throw RelayError.signedOut
    }
}
