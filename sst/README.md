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

`list_accounts`, `list_folders`, `search_messages`, `get_message`, `send_message`,
`flag_message`, `move_message`. Accounts can be referenced by label, email or id.

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

## Operating

```bash
npx sst deploy --stage alex        # deploy
npx sst secret set McpToken <new>  # rotate the MCP token, then redeploy
npx sst remove --stage alex        # tear down
```

Secrets: `EncryptionKey` (credential encryption + cookie signing), `AdminPassword`, `McpToken`.
