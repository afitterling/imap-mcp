# WebMail / Private Office MCP

An MCP server that gives Claude a private office: your own IMAP/SMTP mailboxes and your
iCloud/CalDAV calendars, per user, with every outgoing mail held for your approval, a
read-only switch on any account or calendar, mandatory two-factor sign-in through Amazon
Cognito, and a built-in audit trail.

Runs as one AWS Lambda behind a Function URL, defined and deployed with SST. The server
code, infrastructure and full documentation live in [`sst/`](sst/README.md).

## What Claude can do

| Mail | Calendar |
|---|---|
| list folders, search, read messages, download attachments | list calendars, list/search events (recurrences expanded), read an event |
| save drafts, queue mail for your approval (Outbox) | create, update, delete events; recurrence rules, reminders, attendees |
| archive, move, flag, create/delete folders | ICS/webcal subscriptions (read-only) |

Anything marked **read-only** in the app is refused before the network is touched. Nothing is
ever sent without a human click in the Outbox (unless you switch that off per user).

## Who can use it

Sign-up is limited to a hard-coded allowlist (`sst/src/lib/allowlist.ts`), enforced by a
Cognito pre-sign-up trigger. Every user is equal — there is no admin role in the app. The rare
operator actions (reset a lost authenticator, disable a user) are a CLI: `npm run user`.

## Repository layout

```
sst/                  SST app: Lambda (Hono), DynamoDB tables, Cognito user pool
  sst.config.ts       infrastructure
  src/handler.ts      entry point
  src/routes/         HTTP routes (pages, API, OAuth for MCP clients, /mcp)
  src/mcp/            MCP JSON-RPC server and tool definitions
  src/lib/            mail (imapflow/nodemailer), calendar (tsdav/ical.js), users, sessions, audit…
  src/web/            server-rendered pages (landing, /docs manual, support, app)
  scripts/user.ts     operator CLI
  README.md           architecture, security model, deployment
CLAUDE.md             project rules for Claude Code
```

## Quick start

```bash
cd sst
npm install
npm run typecheck && npm test
npx sst secret set EncryptionKey "$(openssl rand -base64 32)" --stage dev
npx sst deploy --stage dev
```

The deploy prints the app URL. Open it, **Sign in → Sign up** with an allowlisted address, add a
mailbox or calendar, create a token under **Connect Claude** and run the `claude mcp add`
command it shows. Users find the manual at `/docs`.

Stages: `dev` (shared), personal stages via `sst dev`, and `production` (protected, deployed
from `main` only). See [`sst/README.md`](sst/README.md) for the security model, the CalDAV and
ICS details, the audit trail and the deployment checklist.
