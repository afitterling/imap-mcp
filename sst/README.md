# WebMail / Private Office MCP

(Infrastructure and package name remain `webmail-mcp`; renaming the SST app would recreate every resource.)

A multi-user MCP server on AWS that lets Claude read, search, file and draft in each
user's own IMAP/SMTP mailboxes and manage their calendars (iCloud/CalDAV read-write,
ICS feeds read-only) — with every send held for human approval, optional read-only
accounts and calendars, mandatory two-factor sign-in and a built-in audit trail.

The user manual (Apple Mail, Apple Calendar, connecting Claude) is served at `/docs`.

> **Branch `upgrade`: not deployed yet.** See "Deploying this branch" below before running
> `sst deploy`.

## Architecture

One Lambda behind a Function URL serves the MCP endpoint, the OAuth server and the web app;
four DynamoDB tables hold the state.

```
Claude Code ──personal token──┐
claude.ai   ──OAuth token─────┼─> /mcp ─┐
                               │        ├─ Lambda (Hono) ─┬─ Users     (people, scrypt hashes, MFA)
Browser ──session cookie──> /app,/admin ┘                 ├─ Accounts  (mailboxes per owner, AES-256-GCM creds)
                                                          ├─ OAuth     (sessions, tokens, grants, codes, outbox, settings, throttles)
                                                          └─ Audit     (one row per event, 1-year TTL)
                                                              └──> IMAP / SMTP, CalDAV (tsdav) and ICS feeds, SNS for SMS codes
```

| Path | Purpose |
|---|---|
| `src/handler.ts` | Composes the route modules and maps errors |
| `src/routes/security.ts` | CSP with per-request nonce, HSTS, CSRF guard, body limits |
| `src/routes/pages.ts` | Landing, support, docs, `/login` → Cognito, `/auth/callback`, `/app`, `/admin` |
| `src/lib/cognito.ts`, `src/triggers/pre-signup.ts` | PKCE/state, token exchange + JWT validation, admin calls; allowlist trigger |
| `src/routes/api.ts` | User JSON API: accounts, calendars, outbox, tokens, apps, sessions, activity |
| `scripts/user.ts` | Operator CLI (no admin in the app): list, reset-mfa, signout, disable, enable |
| `src/routes/oauth.ts` | OAuth 2.1 for MCP clients: registration, consent via Cognito, PKCE codes, tokens |
| `src/routes/mcp.ts` | Resolves the bearer token to a user and hands off to the RPC layer |
| `src/mcp/` | JSON-RPC over Streamable HTTP (stateless), tool definitions, read-only gate |
| `src/lib/calendar.ts`, `calstore.ts`, `tz.ts` | CalDAV via tsdav + ical.js: discovery, time-range reads with recurrence expansion, create/update/delete with etag checks; ICS fetch with SSRF guard; VTIMEZONE synthesis without a tz database |
| `src/lib/` | mail (imapflow/nodemailer), users (profile mirror), sessions, tokens, oauth, store, outbox, settings, audit, ratelimit, notify, crypto |
| `src/web/` | `layout.ts` (design system, nonce'd CSS/JS) and one file per page |

## Users and sign-in (Amazon Cognito)

Authentication is **Amazon Cognito** (`sst.aws.CognitoUserPool("Auth")`, managed login on a
Cognito prefix domain, authorization code + PKCE). The app never handles a password.

- **Who can sign up:** the addresses in `src/lib/allowlist.ts`, enforced by the Pre-Sign-Up
  trigger `src/triggers/pre-signup.ts` — Cognito refuses everyone else. There are no roles: every
  allowlisted person has the same rights, including the Users page for mutual rescue.
- **Pool policy:** email as username, verified by Cognito; password ≥ 12 chars with upper,
  lower, digit and symbol; **MFA `on`** with software token (authenticator app) — Cognito
  forces setup at the first sign-in; account recovery by verified e-mail; Cognito's own
  lockout on repeated failures.
- **Flow:** `/login` → `beginLogin` stores a PKCE verifier + single-use `state` (10 min) →
  Cognito hosted UI → `/auth/callback` exchanges the code (client secret, server side),
  validates the ID token (JWKS, issuer, audience, `token_use`, expiry via `aws-jwt-verify`),
  upserts the profile row in `Users` keyed by the Cognito `sub`, then opens the server-side
  session (`__Host-` cookie, UA-bound, 1 h idle / 12 h absolute).
- **Sign out** clears the session and sends the browser through Cognito's `/logout`;
  "sign out everywhere" bumps the session version and calls `AdminUserGlobalSignOut`.
- **No admin.** Every setting is per user and self-service. The rare operator actions —
  list users, reset a lost authenticator, sign out, disable/enable — are a CLI:
  `npm run user -- <list|reset-mfa|signout|disable|enable> [email] --stage <stage>`
  (`scripts/user.ts`, runs with your AWS credentials, not through the app).
- The app client is created *after* the function (its callback is the function URL) and
  found at runtime by name (`ListUserPoolClients`); the function gets only the five
  `cognito-idp` actions it uses (client lookup, own status, own global sign-out, MFA preference), scoped
  to the pool ARN — no `cognito-idp:*` link.

## Connecting Claude

| Client | Mechanism |
|---|---|
| Claude Code | Personal token from **Connect Claude** — `claude mcp add --transport http --scope user private-office <MCP URL> --header "Authorization: Bearer <token>"`. Stored hashed, 90-day default expiry, revocable. |
| claude.ai / desktop | OAuth 2.1 + PKCE against this server (Claude needs dynamic client registration, which Cognito lacks). The consent screen sends the user through Cognito (password + MFA) and creates a *grant*; tokens are bound to user + grant and die the moment the grant is revoked under **Connected apps**. |
| Anything holding a Cognito access token | Accepted directly at `/mcp` (validated against the pool's JWKS). |

There is no shared token and no `?token=` query parameter any more.

## Tools exposed to Claude

Every tool is scoped to the calling user's accounts; accounts are referenced by label,
email or id. `list_accounts` reports `readOnly` and `allowArchive` (a read-only account that still lets Claude archive).

| Tool | Does | Read-only account |
|---|---|---|
| `list_accounts` | List the caller's accounts | ✓ |
| `list_folders` | List IMAP folders, with special-use flags | ✓ |
| `search_messages` | Search subject/body, filter by sender, unread, date | ✓ |
| `get_message` | Full body, headers, indexed attachment list | ✓ (`markSeen` refused) |
| `get_attachment` | Download one attachment (4 MB cap) | ✓ |
| `create_draft` | Save to Drafts over IMAP APPEND — nothing is sent | refused |
| `send_message` | Compose; parked in Drafts and queued for approval (or sent directly if the user allowed it) | refused |
| `send_draft` | Queue an existing draft (written in the mail client or by `create_draft`) for approval, recipients from the draft | refused |
| `list_guardrails` | The user's guardrails (see below) | ✓ |
| `archive_message` | Move to the archive folder, auto-detected | refused, unless the account's **Allow archiving** switch is on |
| `move_message` | Move to any folder | refused |
| `flag_message` | Add/remove IMAP flags | refused |
| `create_folder` | Create a folder | refused |
| `delete_folder` | Delete a folder and its messages — `confirm=true`, special folders protected | refused |

Read paths open mailboxes with IMAP `EXAMINE` (read-only), so reading changes nothing on
the server. `tools/list` carries `readOnlyHint` / `destructiveHint` annotations.

### Calendar tools

| Tool | Does | Read-only calendar / ICS |
|---|---|---|
| `list_calendars` | The caller's calendar sources with kind and `readOnly` | ✓ |
| `list_events` | Events in a window (≤ 366 days), recurrences expanded, text filter | ✓ |
| `get_event` | One event by uid with attendees, alarms, rrule | ✓ |
| `create_event` | Timed/all-day, wall-clock in an IANA zone (VTIMEZONE emitted), rrule, reminder, attendees | refused |
| `update_event` | Partial update, `SEQUENCE` bump, etag `If-Match` | refused |
| `delete_event` | `confirm=true` required | refused |

Attendees on an event make the CalDAV server (iCloud) send invitations immediately; the
tool description tells the model to get the user's go-ahead first, and the audit row
records the attendee count. Sources: iCloud (`https://caldav.icloud.com`, app-specific
password), Fastmail, Google, any CalDAV, and `webcal://`/`https://` ICS feeds (public,
https-only, private networks refused, 5 MB cap).

## Guardrails

Per-user rules in plain language (`src/lib/guardrails.ts`), evaluated by the server on every
`tools/call` before the handler runs: **remind** (injected into the server instructions and
prepended to matching results), **confirm** (the call is refused until the model re-calls with
`guardrails_ack: [ruleId]`), **block** (always refused). Managed in the Guardrails tab, audited,
readable by the model via `list_guardrails`; every tool's schema gains the optional
`guardrails_ack` argument.

## Outbox

Per user, on by default: `send_message` writes the composed MIME to Drafts and queues a
pointer. **Send now** in the app sends those exact bytes and files the copy in Sent;
**Discard** drops the queue entry and leaves the draft. Queue entries expire after 7 days.
Turning the hold off is logged and mails the user.

## Audit trail

`src/lib/audit.ts` writes one row per event to the `Audit` table (partition = user,
`byDay` index for admins, 365-day TTL) and the same record as a structured JSON line to
CloudWatch Logs (function logging is JSON, 1-month retention, set in SST): sign-in/2FA/OAuth events, token and app changes,
account and calendar changes, outbox decisions, admin actions and **every MCP tool call**
(tool, account or calendar, folder/uid/recipients/subject or event title/time, outcome,
duration, client — never bodies, notes or attachments). Users see their own log under **Activity** with filters and CSV export; there is no
cross-user view. Exports are themselves logged.

## Security notes

- Strict CSP (`script-src`/`style-src` by nonce only, `frame-ancestors 'none'`), HSTS,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
- CSRF: non-GET browser requests must be same-origin by Fetch Metadata / `Origin`; the
  JSON API also needs `X-Requested-With: fetch`. `/mcp` and the OAuth token/registration
  endpoints are machine endpoints with their own CORS.
- Rate limits (atomic DynamoDB counters): sign-in starts per IP, OAuth registration,
  failed MCP auth. Credential brute force is Cognito's problem, and it locks accounts.
- Mail and calendar credentials are AES-256-GCM encrypted with `EncryptionKey`; tokens
  are stored as SHA-256.
- Every AWS resource is tagged `Project=webmail-mcp`, `Stage`, `ManagedBy=SST`.
- Alerts (sign-ins, lockouts, new tokens, apps, factor changes, admin actions) are mailed
  to the affected user from the system-sender account; failure alerts throttle to one per
  5 minutes per kind.

## Development

```bash
npm run typecheck
npm test          # node:test; pure modules + mocked DB/mail layers
```

`sst dev` deploys a personal stage — do not run it on this branch until the steps below
are done.

## Deploying this branch

1. Replace `michael.meyer@mindyourstep.de` in `src/lib/allowlist.ts`.
2. Secrets: only `EncryptionKey` is used. `McpToken` and `AdminPassword` are no longer
   read — remove them after the deploy with `npx sst secret remove`.
3. Cognito sends verification mails from its default sender (50/day, plenty for two users).
   MFA is authenticator-app only; SMS MFA would need an SNS role with `sns:Publish` on `*`,
   which the project's IAM rule forbids.
4. Deploy stage `alex` first. Sign up through the hosted UI as the admin: at the first
   sign-in by whoever is first, the existing production accounts (which have no owner) are claimed.
5. Reconnect Claude Code with a personal token and claude.ai via the new consent screen;
   existing connectors keep a cached tool list until reconnected.
