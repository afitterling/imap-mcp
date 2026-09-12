# Webmail MCP

An MCP server on AWS that lets Claude read, search and send mail on any number of
IMAP/SMTP mail accounts — with a web UI for adding those accounts.

**Live (stage `alex`)**

| | |
|---|---|
| Admin UI | https://uxtjw6anklhf5bmg44dt6dqffu0ptmtw.lambda-url.eu-central-1.on.aws/admin |
| MCP endpoint | https://uxtjw6anklhf5bmg44dt6dqffu0ptmtw.lambda-url.eu-central-1.on.aws/mcp |
| Admin password | see `.credentials.local` (git-ignored, local only) |

## Architecture

One Lambda behind a Function URL serves both surfaces; accounts live in DynamoDB.

```
Claude ──Bearer token──> /mcp   ┐
                                ├─ Lambda (Hono) ──> DynamoDB (accounts, AES-256-GCM creds)
Browser ──session cookie──> /admin ┘        └──> IMAP / SMTP of each mail server
```

- `src/handler.ts` — routes: MCP, admin UI, account API
- `src/mcp/` — JSON-RPC over Streamable HTTP (stateless) and the tool definitions
- `src/lib/mail.ts` — IMAP (imapflow) + SMTP (nodemailer); connections open and close per request
- `src/lib/crypto.ts` — credential encryption and signed admin sessions
- `src/lib/oauth.ts` — OAuth 2.1: registration, PKCE codes, signed access/refresh tokens
- `src/web/` — login, consent and admin pages

## Tools exposed to Claude

Accounts can be referenced by label, email or id — `"work"` is enough.

| Tool | Does |
|---|---|
| `list_accounts` | List connected accounts |
| `list_folders` | List IMAP folders, with special-use flags |
| `search_messages` | Search subject/body, filter by sender, unread, date |
| `get_message` | Full body, headers, indexed attachment list |
| `get_attachment` | Download one attachment (images viewable, rest as a file resource, 4 MB cap) |
| `create_draft` | Save a message to Drafts over IMAP APPEND — nothing is sent |
| `send_message` | Send over SMTP, with CC/BCC, threading and attachments (base64, or forwarded server-side from another message) |
| `archive_message` | Move messages to the archive folder, auto-detected |
| `move_message` | Move a message to any folder |
| `flag_message` | Add/remove IMAP flags (`\Seen`, `\Flagged`, `\Deleted`) |
| `create_folder` | Create a folder |
| `delete_folder` | Delete a folder and its messages — requires `confirm=true`; INBOX and special-use folders are protected |

## Adding a mail account

Open the admin UI, sign in, **Add mail account**. Presets cover Gmail, Outlook/M365,
Fastmail, iCloud and Yahoo; anything else takes host/port directly. **Test** verifies
IMAP and SMTP before Claude ever touches the mailbox. For Gmail, iCloud and Yahoo use
an app-specific password, not the account password.

## Connecting Claude

Claude Code (already done for this machine):

```bash
claude mcp add --transport http --scope user webmail <mcp-url> \
  --header "Authorization: Bearer <token>"
```

Claude desktop / claude.ai: Settings → Connectors → Add custom connector, paste the MCP
URL, and click Connect. The server implements OAuth 2.1, so Claude registers itself
(RFC 7591), sends you to a consent screen, and you approve with the admin password —
no token handling. Access tokens last 30 days and refresh silently.

## Tool-list caching

Clients fetch `tools/list` once at connect and cache it; this server is stateless, so it
cannot push `notifications/tools/list_changed`. After deploying a new tool, an
already-connected client keeps the old list until it reconnects — toggle the connector
off and on, or start a new conversation.

## Auth

Three ways in, all checked at `/mcp`:

| Client | Mechanism |
|---|---|
| claude.ai / Claude desktop | OAuth 2.1 + PKCE (S256), dynamic client registration |
| Claude Code | static `Authorization: Bearer <McpToken>` |
| Anything that can't set headers | `?token=<McpToken>` |

OAuth endpoints: `/.well-known/oauth-protected-resource`,
`/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`,
`/oauth/token`. Authorization codes are single-use, PKCE-bound and expire in 10 minutes
(DynamoDB TTL sweeps the rest). Revoke every OAuth grant by rotating `EncryptionKey`,
which invalidates the signatures on all issued tokens.

## Sign-in alerts

Every sign-in attempt mails the operator, sent from the first configured account to its
own address:

| Event | Alert |
|---|---|
| Admin signs in to the web UI | ✓ Admin signed in |
| Wrong admin password on the web UI | ⚠ Failed admin sign-in attempt |
| A connector completes OAuth consent | ✓ New connector authorized: `<name>` |
| Wrong password on the consent screen | ⚠ Failed connector authorization |

Each mail carries the time, IP address and browser, plus the commands to rotate
credentials. Failure alerts are throttled to one per five minutes per kind — an atomic
conditional write claims the window, so a brute-force attempt cannot become a mail
flood. Alert failures are logged and swallowed; they never block a login.

## Operating

```bash
npx sst deploy --stage alex        # deploy
npx sst secret set McpToken <new>  # rotate the MCP token, then redeploy
npx sst remove --stage alex        # tear down
```

Secrets: `EncryptionKey` (credential encryption + cookie signing), `AdminPassword`, `McpToken`.
