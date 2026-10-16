import CryptoKit
import Foundation
import Security

/// What the server's public `/relay/config` returns: enough to run Cognito's hosted sign-in.
public struct RelayConfig: Codable, Sendable, Equatable {
    public var region: String
    public var userPoolId: String
    public var clientId: String
    public var domain: String
    public var redirectUri: String
    public var scopes: [String]

    public init(region: String, userPoolId: String, clientId: String, domain: String, redirectUri: String, scopes: [String]) {
        self.region = region
        self.userPoolId = userPoolId
        self.clientId = clientId
        self.domain = domain
        self.redirectUri = redirectUri
        self.scopes = scopes
    }

    /// The custom scheme ASWebAuthenticationSession waits for.
    public var callbackScheme: String? { URL(string: redirectUri)?.scheme }
}

extension Data {
    var base64URL: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// RFC 7636 proof key: the app proves it started the sign-in it finishes.
public enum PKCE {
    public static func randomString(bytes count: Int = 48) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
            fatalError("No secure random bytes available")
        }
        return Data(bytes).base64URL
    }

    public static func challenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
    }

    /// Cognito's hosted UI: authorization code flow with an S256 challenge. MFA is the pool's.
    public static func authorizeURL(config: RelayConfig, state: String, challenge: String) -> URL {
        var c = URLComponents(string: config.domain.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/oauth2/authorize")!
        c.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: config.clientId),
            URLQueryItem(name: "redirect_uri", value: config.redirectUri),
            URLQueryItem(name: "scope", value: config.scopes.joined(separator: " ")),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        return c.url!
    }

    /// The code from the callback, if its state matches the one this sign-in sent.
    public static func code(from callback: URL, expectedState: String) throws -> String {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let error = items.first(where: { $0.name == "error" })?.value {
            throw RelayError.signIn(items.first(where: { $0.name == "error_description" })?.value ?? error)
        }
        guard items.first(where: { $0.name == "state" })?.value == expectedState else {
            throw RelayError.signIn("The sign-in answer did not match this request.")
        }
        guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            throw RelayError.signIn("Cognito returned no authorization code.")
        }
        return code
    }
}

public struct TokenSet: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date

    public init(accessToken: String, refreshToken: String, expiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
    }
}

/// Token endpoint calls for the relay's public client (no secret, PKCE).
public struct CognitoAuth: Sendable {
    public let config: RelayConfig
    let transport: any HTTPTransport

    public init(config: RelayConfig, transport: any HTTPTransport = URLSessionTransport()) {
        self.config = config
        self.transport = transport
    }

    private var base: String { config.domain.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }

    public func exchange(code: String, verifier: String, now: Date = Date()) async throws -> TokenSet {
        let t = try await token([
            "grant_type": "authorization_code",
            "client_id": config.clientId,
            "code": code,
            "redirect_uri": config.redirectUri,
            "code_verifier": verifier,
        ])
        guard let refresh = t.refresh_token else { throw RelayError.signIn("Cognito returned no refresh token.") }
        return TokenSet(accessToken: t.access_token, refreshToken: refresh, expiresAt: now.addingTimeInterval(TimeInterval(t.expires_in)))
    }

    /// Cognito does not rotate refresh tokens here; the old one stays valid until it expires.
    public func refresh(_ tokens: TokenSet, now: Date = Date()) async throws -> TokenSet {
        let t = try await token(["grant_type": "refresh_token", "client_id": config.clientId, "refresh_token": tokens.refreshToken])
        return TokenSet(accessToken: t.access_token, refreshToken: t.refresh_token ?? tokens.refreshToken, expiresAt: now.addingTimeInterval(TimeInterval(t.expires_in)))
    }

    /// Best effort: revoking the refresh token also ends the access tokens issued from it.
    public func revoke(_ tokens: TokenSet) async {
        var r = URLRequest(url: URL(string: base + "/oauth2/revoke")!)
        r.httpMethod = "POST"
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        r.httpBody = Self.form(["token": tokens.refreshToken, "client_id": config.clientId])
        _ = try? await transport.send(r)
    }

    private struct TokenResponse: Decodable {
        let access_token: String
        let refresh_token: String?
        let expires_in: Int
    }

    private func token(_ fields: [String: String]) async throws -> TokenResponse {
        var r = URLRequest(url: URL(string: base + "/oauth2/token")!)
        r.httpMethod = "POST"
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        r.httpBody = Self.form(fields)
        let res = try await transport.send(r)
        // 400 invalid_grant: the refresh token expired or was revoked — sign in again.
        if res.status == 400 || res.status == 401 { throw RelayError.signedOut }
        guard res.status == 200 else { throw RelayError.server(res.status, "Cognito token endpoint") }
        return try JSONDecoder().decode(TokenResponse.self, from: res.body)
    }

    static func form(_ fields: [String: String]) -> Data {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return Data(fields.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }
            .joined(separator: "&").utf8)
    }
}

/// Where the tokens live. Only the Keychain in the app; tests use memory.
public protocol TokenStore: Sendable {
    func load() throws -> TokenSet?
    func save(_ tokens: TokenSet) throws
    func clear() throws
}

/// Generic-password item, readable only on this Mac and only after it was first unlocked.
public struct KeychainTokenStore: TokenStore {
    let service: String
    let account: String

    public init(service: String = "tech.sp33c.notesrelay", account: String = "cognito") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func load() throws -> TokenSet? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw RelayError.keychain(status) }
        return try JSONDecoder().decode(TokenSet.self, from: data)
    }

    public func save(_ tokens: TokenSet) throws {
        let data = try JSONEncoder().encode(tokens)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw RelayError.keychain(update) }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw RelayError.keychain(status) }
    }

    public func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw RelayError.keychain(status) }
    }
}

/// The signed-in state: hands out a fresh access token, refreshing a minute before expiry.
public actor AuthSession {
    let auth: CognitoAuth
    let store: any TokenStore
    private var tokens: TokenSet?
    private var loaded = false

    public init(auth: CognitoAuth, store: any TokenStore) {
        self.auth = auth
        self.store = store
    }

    private func current() throws -> TokenSet? {
        if !loaded {
            tokens = try store.load()
            loaded = true
        }
        return tokens
    }

    public var isSignedIn: Bool { (try? current()) != nil }

    public func signIn(with tokens: TokenSet) throws {
        try store.save(tokens)
        self.tokens = tokens
        loaded = true
    }

    public func accessToken(now: Date = Date()) async throws -> String {
        guard var t = try current() else { throw RelayError.signedOut }
        if t.expiresAt.timeIntervalSince(now) < 60 {
            do {
                t = try await auth.refresh(t, now: now)
            } catch RelayError.signedOut {
                try? store.clear()
                tokens = nil
                throw RelayError.signedOut
            }
            try store.save(t)
            tokens = t
        }
        return t.accessToken
    }

    /// The server refused the token (revoked, signed out elsewhere): refresh on next use.
    public func invalidateAccessToken() {
        tokens?.expiresAt = .distantPast
    }

    public func signOut() async {
        if let t = try? current() { await auth.revoke(t) }
        try? store.clear()
        tokens = nil
    }
}
