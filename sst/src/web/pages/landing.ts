import { page } from "../layout.js";

export const landingPage = (nonce: string, signedIn?: { name: string; email: string; role: "admin" | "user" }) =>
  page({
    title: "Mail and calendars for Claude",
    description: "Private Office MCP lets Claude read, search, draft and plan in your own mailboxes and calendars — with every send held for your approval.",
    nonce,
    user: signedIn,
    active: "home",
    body: `<div class="wrap">
  <section class="hero">
    <h1>Your private office, open to Claude — on your terms.</h1>
    <p>Private Office MCP connects Claude to the mailboxes and calendars <em>you</em> choose. It can read, search, file, draft and plan.
       It can never send a mail on its own, and any account can be kept strictly read-only.</p>
    <div class="row">
      ${signedIn ? `<a class="btn primary" href="/app">Open my mail</a>` : `<a class="btn primary" href="/login">Sign in</a>`}
      <a class="btn" href="/docs">Manual</a><a class="btn" href="/support">Support</a>
    </div>
  </section>

  <div class="grid cols3">
    <div class="card feature"><h3>One person, one set of mailboxes</h3><p>Every account you add belongs to you alone. Claude, working with your token, sees your accounts and nobody else's.</p></div>
    <div class="card feature"><h3>Nothing leaves without you</h3><p>When Claude wants to send, the message is parked in your Drafts and shown in your Outbox. Only your click releases it.</p></div>
    <div class="card feature"><h3>Read-only, when you want</h3><p>Flip an account to read-only and Claude can search and read but cannot move, flag, draft or send — not even mark a message as read.</p></div>
    <div class="card feature"><h3>Calendars too</h3><p>Apple Calendar over CalDAV (and Fastmail, Google, Nextcloud) with full read-write, plus read-only ICS subscriptions. The same read-only switch applies.</p></div>
    <div class="card feature"><h3>Two-factor, always</h3><p>Sign-in runs on Amazon Cognito: password plus an authenticator app, required for every account.</p></div>
    <div class="card feature"><h3>Every action on record</h3><p>Sign-ins, tokens, connected apps and each tool call Claude makes are written to an activity log you can filter and export.</p></div>
    <div class="card feature"><h3>Credentials stay encrypted</h3><p>Mail passwords are AES-256-GCM encrypted at rest and only ever used to reach your mail server. Tokens are stored hashed.</p></div>
  </div>

  <h2>How it works</h2>
  <div class="card">
    <ol class="steps">
      <li><b>Sign in</b> — or use the sign-up link on the sign-in page if your address has been invited.</li>
      <li><b>Add a mailbox</b> — Gmail, Outlook, Fastmail, iCloud, Yahoo or any IMAP server. Test it before Claude touches it.</li>
      <li><b>Connect Claude</b> — a personal token for Claude Code, or one click for claude.ai and the desktop app.</li>
      <li><b>Ask</b> — <i>“what's new from the bank?”</i>, <i>“draft a reply to Anna”</i>, <i>“file last week's invoices”</i>.</li>
      <li><b>Approve</b> — anything Claude wants to send waits in your Outbox until you say so.</li>
    </ol>
  </div>

  <h2>Security in short</h2>
  <div class="card small muted">
    Sign-up is limited to invited addresses. Accounts, passwords and MFA live in Amazon Cognito (12+ character policy, authenticator app
    required); the app never sees a password. Sessions are server-side, short-lived and bound to your browser. Personal tokens and OAuth grants are per user, revocable
    at any time and expire on their own. Failed sign-ins are rate-limited and trigger an alert to you. Every page carries a strict
    Content-Security-Policy. See <a href="/support">Support</a> for details and the operator contact.
  </div>
  <footer><span>Private Office MCP</span><a href="/docs">Manual</a><a href="/support">Support</a><a href="/health">Status</a></footer>
</div>`,
  });
