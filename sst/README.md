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
- `src/web/` — login and admin pages

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
URL and the `Authorization: Bearer <token>` header. Where custom headers aren't
available, append `?token=<token>` to the URL. Both values are shown on the admin page.

## Operating

```bash
npx sst deploy --stage alex        # deploy
npx sst secret set McpToken <new>  # rotate the MCP token, then redeploy
npx sst remove --stage alex        # tear down
```

Secrets: `EncryptionKey` (credential encryption + cookie signing), `AdminPassword`, `McpToken`.
