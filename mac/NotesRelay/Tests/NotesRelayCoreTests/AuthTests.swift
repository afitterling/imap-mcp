import Foundation
import Testing
@testable import NotesRelayCore

let config = RelayConfig(
    region: "eu-central-1", userPoolId: "eu-central-1_X", clientId: "relay-client",
    domain: "https://auth.example.test/", redirectUri: "privateoffice-relay://callback", scopes: ["openid", "email"]
)

@Suite struct PKCETests {
    @Test func challengeMatchesTheRFC7636Example() {
        #expect(PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func verifiersAreRandomAndURLSafe() {
        let a = PKCE.randomString(), b = PKCE.randomString()
        #expect(a != b)
        #expect(a.count == 64)
        #expect(a.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
    }

    @Test func authorizeURLAsksForCodeWithS256() throws {
        let url = PKCE.authorizeURL(config: config, state: "st", challenge: "ch")
        let c = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(c.host == "auth.example.test")
        #expect(c.path == "/oauth2/authorize")
        let q = Dictionary(uniqueKeysWithValues: (c.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(q == [
            "response_type": "code", "client_id": "relay-client", "redirect_uri": "privateoffice-relay://callback",
            "scope": "openid email", "state": "st", "code_challenge": "ch", "code_challenge_method": "S256",
        ])
        #expect(config.callbackScheme == "privateoffice-relay")
    }

    @Test func callbackCodeNeedsTheMatchingState() throws {
        #expect(try PKCE.code(from: URL(string: "privateoffice-relay://callback?code=abc&state=st")!, expectedState: "st") == "abc")
        #expect(throws: RelayError.self) { try PKCE.code(from: URL(string: "privateoffice-relay://callback?code=abc&state=evil")!, expectedState: "st") }
        #expect(throws: RelayError.signIn("denied")) {
            try PKCE.code(from: URL(string: "privateoffice-relay://callback?error=access_denied&error_description=denied")!, expectedState: "st")
        }
    }
}

@Suite struct TokenTests {
    @Test func exchangeSendsVerifierAndStoresExpiry() async throws {
        let t = MockTransport([json(200, #"{"access_token":"A","refresh_token":"R","id_token":"I","expires_in":3600}"#)])
        let tokens = try await CognitoAuth(config: config, transport: t).exchange(code: "c+d", verifier: "v", now: t0)
        #expect(tokens == TokenSet(accessToken: "A", refreshToken: "R", expiresAt: t0.addingTimeInterval(3600)))
        let r = try #require(t.requests.first)
        #expect(r.url?.absoluteString == "https://auth.example.test/oauth2/token")
        #expect(String(data: r.httpBody!, encoding: .utf8) == "client_id=relay-client&code=c%2Bd&code_verifier=v&grant_type=authorization_code&redirect_uri=privateoffice-relay%3A%2F%2Fcallback")
    }

    @Test func sessionRefreshesShortlyBeforeExpiryAndKeepsTheRefreshToken() async throws {
        let store = MemoryTokenStore(TokenSet(accessToken: "old", refreshToken: "R", expiresAt: t0.addingTimeInterval(30)))
        let t = MockTransport([json(200, #"{"access_token":"new","expires_in":3600}"#)])
        let s = AuthSession(auth: CognitoAuth(config: config, transport: t), store: store)
        #expect(try await s.accessToken(now: t0) == "new")
        #expect(try store.load() == TokenSet(accessToken: "new", refreshToken: "R", expiresAt: t0.addingTimeInterval(3600)))
        #expect(try await s.accessToken(now: t0) == "new")
        #expect(t.requests.count == 1, "a fresh token is not refreshed again")
    }

    @Test func aRejectedRefreshSignsOutAndClearsTheKeychain() async throws {
        let store = MemoryTokenStore(TokenSet(accessToken: "old", refreshToken: "R", expiresAt: t0))
        let s = AuthSession(auth: CognitoAuth(config: config, transport: MockTransport([json(400, #"{"error":"invalid_grant"}"#)])), store: store)
        await #expect(throws: RelayError.signedOut) { try await s.accessToken(now: t0) }
        #expect(try store.load() == nil)
        #expect(await s.isSignedIn == false)
    }
}

@Suite struct RelayAPITests {
    func api(_ t: MockTransport, expires: Date = .distantFuture) throws -> RelayAPI {
        let store = MemoryTokenStore(TokenSet(accessToken: "A", refreshToken: "R", expiresAt: expires))
        return try RelayAPI(baseURL: URL(string: "https://office.example.test/")!, session: AuthSession(auth: CognitoAuth(config: config, transport: t), store: store), transport: t)
    }

    @Test func refusesPlainHTTP() {
        #expect(throws: RelayError.insecureServer) {
            try RelayAPI(baseURL: URL(string: "http://office.example.test")!, session: AuthSession(auth: CognitoAuth(config: config), store: MemoryTokenStore()))
        }
    }

    @Test func pushSendsBearerAndJSON() async throws {
        let t = MockTransport([json(200, #"{"stored":1,"total":5}"#)])
        let note = NotePayload(noteId: "n1", account: "iCloud", folder: "Notes", title: "T", text: "x", created: nil, modified: t0)
        #expect(try await api(t).push(device: "Mac", notes: [note]) == 5)
        let r = try #require(t.requests.first)
        #expect(r.httpMethod == "PUT")
        #expect(r.url?.absoluteString == "https://office.example.test/relay/notes")
        #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer A")
        let body = try JSONSerialization.jsonObject(with: r.httpBody!) as! [String: Any]
        #expect(body["device"] as? String == "Mac")
        #expect(((body["notes"] as? [[String: Any]])?.first?["modified"] as? String)?.hasSuffix("Z") == true)
    }

    @Test func ackEncodesTheQueuedIdIntoOnePathSegment() async throws {
        let t = MockTransport([json(200, #"{"acknowledged":true}"#)])
        try await api(t).ack(id: "notecreate#a/b", ok: true, error: nil)
        #expect(t.requests.first?.url?.absoluteString == "https://office.example.test/relay/notes/pending/notecreate%23a%2Fb/ack")
    }

    @Test func a401RefreshesOnceThenGivesUp() async throws {
        let ok = MockTransport([json(401, "{}"), json(200, #"{"access_token":"B","expires_in":3600}"#), json(200, #"{"pending":[]}"#)])
        #expect(try await api(ok).pending() == [])
        #expect(ok.requests.map { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer A", nil, "Bearer B"])

        let bad = MockTransport([json(401, "{}"), json(200, #"{"access_token":"B","expires_in":3600}"#), json(401, "{}")])
        await #expect(throws: RelayError.signedOut) { try await api(bad).pending() }
    }

    @Test func serverErrorsCarryTheServersMessage() async throws {
        let t = MockTransport([json(400, #"{"error":"Invalid request: notes too long"}"#)])
        await #expect(throws: RelayError.server(400, "Invalid request: notes too long")) { try await api(t).prune(device: "Mac", keep: []) }
    }

    @Test func configComesFromThePublicEndpoint() async throws {
        let t = MockTransport([json(200, #"{"region":"eu-central-1","userPoolId":"p","clientId":"c","domain":"https://d","redirectUri":"privateoffice-relay://callback","scopes":["openid"]}"#)])
        let c = try await RelayAPI.config(baseURL: URL(string: "https://office.example.test")!, transport: t)
        #expect(c.clientId == "c")
        #expect(t.requests.first?.url?.absoluteString == "https://office.example.test/relay/config")
        #expect(t.requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
    }
}
