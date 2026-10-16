# Notes Relay (macOS)

A menu-bar app that gives the WebMail / Private Office MCP server access to the **iCloud Notes
folders you choose**. Apple has no server API for iCloud notes, so the Mac reads them through
Notes.app scripting and sends them to the server, where Claude's `list_notes` / `get_note` tools
read them. Notes Claude adds with `create_note source=icloud` are queued on the server and
created here at the next sync.

## Build and run

```bash
swift test                 # Swift Testing: PKCE, tokens, API client, sync engine, note HTML
./scripts/bundle.sh        # build/NotesRelay.app, ad-hoc signed (SIGN_IDENTITY=… for a real one)
open build/NotesRelay.app
```

Then **Sign in…** → enter the server address (e.g. the `url` output of `npx sst deploy`) →
Cognito's hosted sign-in (e-mail, password, authenticator code) → allow Notes access when
macOS asks → tick the folders to share.

## How it works

- **Auth:** Cognito authorization code + PKCE with the server's public `MacRelay` client
  (parameters from `GET /relay/config`), in an ephemeral `ASWebAuthenticationSession`. Tokens
  live only in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), the access
  token is refreshed a minute before it expires, and sign-out revokes the refresh token.
- **Sync** (every 10 minutes and on wake, `SyncEngine`): read ids and modification dates of the
  shared folders; read the text only of new or changed notes; push in batches of ≤ 200 notes /
  2.5 MB; prune notes that vanished (deleted, moved, folder unshared) and once a day anyway; then
  create the queued notes and acknowledge each. A create whose acknowledgement got lost is
  remembered, so it is never created twice.
- **Local state** (`~/Library/Application Support/NotesRelay/state.json`): shared folder ids,
  note ids with their last-sent modification date, pending acknowledgements. No note content.
- **Sign out** deletes everything this Mac synced from the server (`DELETE /relay/notes`).

`NotesRelayCore` holds all logic behind protocols (`NotesBridge`, `RelayService`, `TokenStore`,
`StateStore`, `HTTPTransport`), so the tests run without Notes.app, Cognito or a network. The
`NotesRelay` target is only the SwiftUI menu-bar UI and the sign-in sheet.
