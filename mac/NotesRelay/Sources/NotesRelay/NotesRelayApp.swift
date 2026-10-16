import NotesRelayCore
import SwiftUI

@main
struct NotesRelayApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        MenuBarExtra("Notes Relay", systemImage: model.signedIn ? "note.text" : "note.text.badge.plus") {
            MenuContent(model: model)
        }
        .menuBarExtraStyle(.window)

        Window("Notes Relay", id: "settings") {
            SettingsView(model: model)
        }
        .windowResizability(.contentSize)
    }
}

struct MenuContent: View {
    @Bindable var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Notes Relay").font(.headline)
            if model.signedIn {
                Text("Sharing \(model.shared.count) folder\(model.shared.count == 1 ? "" : "s")").font(.subheadline)
                if let last = model.lastSync {
                    Text("Last sync \(last.formatted(.relative(presentation: .named)))").foregroundStyle(.secondary)
                }
                if let r = model.lastReport {
                    Text(summary(r)).font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text("Not signed in").foregroundStyle(.secondary)
            }
            if let message = model.message {
                Text(message).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            HStack {
                if model.signedIn {
                    Button("Sync now") { Task { await model.syncNow() } }.disabled(model.busy)
                }
                Button(model.signedIn ? "Folders…" : "Sign in…") {
                    openWindow(id: "settings")
                    NSApp.activate()
                }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
        }
        .padding(14)
        .frame(width: 300)
    }

    private func summary(_ r: SyncReport) -> String {
        var parts = ["\(r.pushed) sent"]
        if r.removed > 0 { parts.append("\(r.removed) removed") }
        if r.created > 0 { parts.append("\(r.created) created for Claude") }
        if r.failedCreates > 0 { parts.append("\(r.failedCreates) could not be created") }
        if r.waitingCreates > 0 { parts.append("\(r.waitingCreates) waiting — share a folder") }
        if let total = r.total { parts.append("\(total) on server") }
        return parts.joined(separator: " · ")
    }
}

struct SettingsView: View {
    @Bindable var model: AppModel

    var body: some View {
        Form {
            Section("Server") {
                TextField("https://…", text: $model.serverURL).disabled(model.signedIn)
                Text("The address of your WebMail / Private Office MCP app. Sign-in uses your usual e-mail, password and authenticator code.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    if model.signedIn {
                        Button("Sign out and delete synced notes", role: .destructive) { Task { await model.signOut() } }
                    } else {
                        Button("Sign in") { Task { await model.signIn() } }.disabled(model.serverURL.isEmpty || model.busy)
                    }
                    if model.busy { ProgressView().controlSize(.small) }
                }
            }
            if model.signedIn {
                Section("Folders Claude may read") {
                    if model.folders.isEmpty {
                        Text("No folders yet — allow Notes access when macOS asks.").foregroundStyle(.secondary)
                    }
                    ForEach(model.folders) { folder in
                        Toggle("\(folder.name) — \(folder.account)", isOn: Binding(
                            get: { model.shared.contains(folder.id) },
                            set: { model.setShared(folder, $0) }
                        ))
                    }
                    HStack {
                        Button("Reload folders") { Task { await model.loadFolders() } }
                        Button("Sync now") { Task { await model.syncNow() } }.disabled(model.busy)
                    }
                    Text("Only the folders ticked here leave this Mac. Notes Claude adds go into the folder it names if that folder is shared, otherwise into a shared folder called Notes.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let message = model.message {
                Text(message).font(.caption).foregroundStyle(.red)
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .task { if model.signedIn && model.folders.isEmpty { await model.loadFolders() } }
    }
}
