import AppKit
import AuthenticationServices
import NotesRelayCore
import Observation

/// The menu-bar app's state. Everything that touches the network or Notes goes through NotesRelayCore.
@MainActor
@Observable
final class AppModel {
    var serverURL: String = UserDefaults.standard.string(forKey: "serverURL") ?? ""
    private(set) var signedIn = false
    private(set) var busy = false
    private(set) var message: String?
    private(set) var lastSync: Date?
    private(set) var lastReport: SyncReport?
    private(set) var folders: [NotesFolder] = []
    private(set) var shared: Set<String> = []

    static let syncInterval: Duration = .seconds(600)

    private let bridge = AppleScriptNotesBridge()
    private let tokens = KeychainTokenStore()
    private let stateStore = FileStateStore()
    private var session: AuthSession?
    private var api: RelayAPI?
    private var engine: SyncEngine?
    private var loop: Task<Void, Never>?
    private let presenter = Presenter()

    private var device: String { Host.current().localizedName ?? "Mac" }

    init() {
        shared = Set((try? stateStore.load())?.sharedFolderIds ?? [])
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.syncNow() }
        }
        Task { await restore() }
    }

    /// A previous sign-in survives restarts: the tokens are in the Keychain.
    private func restore() async {
        guard let url = URL(string: serverURL), (try? tokens.load()) != nil else { return }
        do {
            try await connect(url: url, config: try await RelayAPI.config(baseURL: url))
            signedIn = await session?.isSignedIn ?? false
            if signedIn { startLoop() }
        } catch {
            message = String(describing: error)
        }
    }

    private func connect(url: URL, config: RelayConfig) async throws {
        let s = AuthSession(auth: CognitoAuth(config: config), store: tokens)
        let a = try RelayAPI(baseURL: url, session: s)
        session = s
        api = a
        engine = SyncEngine(bridge: bridge, api: a, store: stateStore, device: device)
    }

    func signIn() async {
        busy = true
        defer { busy = false }
        message = nil
        do {
            let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let url = URL(string: trimmed.hasPrefix("https://") ? trimmed : "https://" + trimmed) else { throw RelayError.insecureServer }
            let config = try await RelayAPI.config(baseURL: url)
            let verifier = PKCE.randomString(), state = PKCE.randomString(bytes: 16)
            let callback = try await presenter.authenticate(
                url: PKCE.authorizeURL(config: config, state: state, challenge: PKCE.challenge(for: verifier)),
                scheme: config.callbackScheme ?? "privateoffice-relay"
            )
            let code = try PKCE.code(from: callback, expectedState: state)
            let tokenSet = try await CognitoAuth(config: config).exchange(code: code, verifier: verifier)
            try await connect(url: url, config: config)
            try await session?.signIn(with: tokenSet)
            serverURL = url.absoluteString
            UserDefaults.standard.set(serverURL, forKey: "serverURL")
            signedIn = true
            await loadFolders()
            startLoop()
        } catch {
            message = String(describing: error)
        }
    }

    /// Deletes what this Mac synced from the server, then forgets the sign-in.
    func signOut() async {
        busy = true
        defer { busy = false }
        loop?.cancel()
        do { try await api?.disconnect() } catch { message = "Signed out, but the server copy could not be deleted: \(error)" }
        await session?.signOut()
        try? stateStore.save(SyncState())
        shared = []
        signedIn = false
        lastSync = nil
        lastReport = nil
    }

    func loadFolders() async {
        do {
            folders = try await bridge.folders().sorted { ($0.account, $0.name) < ($1.account, $1.name) }
        } catch {
            message = String(describing: error)
        }
    }

    func setShared(_ folder: NotesFolder, _ on: Bool) {
        if on { shared.insert(folder.id) } else { shared.remove(folder.id) }
        var state = (try? stateStore.load()) ?? SyncState()
        state.sharedFolderIds = folders.map(\.id).filter(shared.contains)
        try? stateStore.save(state)
    }

    func syncNow() async {
        guard signedIn, let engine, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            lastReport = try await engine.sync()
            lastSync = Date()
            message = nil
        } catch RelayError.signedOut {
            signedIn = false
            loop?.cancel()
            message = RelayError.signedOut.description
        } catch {
            message = String(describing: error)
        }
    }

    private func startLoop() {
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.syncNow()
                try? await Task.sleep(for: AppModel.syncInterval)
            }
        }
    }
}

/// Runs Cognito's hosted sign-in in a system web sheet. Ephemeral: no cookies are kept.
@MainActor
final class Presenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    func authenticate(url: URL, scheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme(scheme)) { callback, error in
                if let callback { continuation.resume(returning: callback) }
                else { continuation.resume(throwing: error ?? RelayError.signIn("cancelled")) }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            if !session.start() { continuation.resume(throwing: RelayError.signIn("could not open the sign-in window")) }
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { NSApp.keyWindow ?? NSApp.windows.first ?? NSWindow() }
    }
}
