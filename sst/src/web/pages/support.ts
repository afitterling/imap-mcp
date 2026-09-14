import { page, esc } from "../layout.js";
import type { SupportContact } from "../../lib/settings.js";
import { ALLOWED_EMAILS } from "../../lib/allowlist.js";

export const supportPage = (nonce: string, contact: SupportContact, signedIn?: { name: string; email: string; role: "admin" | "user" }) =>
  page({
    title: "Support",
    nonce,
    user: signedIn,
    active: "support",
    body: `<div class="wrap">
  <h1>Support</h1>
  <p class="lead">Answers to the questions people ask most. Anything else: use the contact at the bottom.</p>

  <div class="card faq">
    <details open><summary>Who can create an account?</summary>
      <p>Only ${ALLOWED_EMAILS.length} pre-approved email addresses. Use <b>Sign up</b> on the sign-in page; if your address is not on the list the sign-up is refused and the attempt is logged.
      Ask the operator to have the list changed — it is a code change, on purpose.</p></details>

    <details><summary>Where do I change my password or my authenticator?</summary>
      <p>Sign-in is handled by Amazon Cognito. To change your password, sign out and use <b>Forgot your password?</b> on the sign-in page (a code is mailed to you).
      If you lost your authenticator app, an administrator can reset it under Admin → Users; you set up a new one at your next sign-in.</p></details>

    <details><summary>Connecting Claude Code</summary>
      <p>Sign in, open <b>Connect Claude</b>, create a token and run the command shown. The token is displayed once; if you lose it, revoke it and create another.</p>
      <p><code>claude mcp add --transport http --scope user private-office &lt;MCP URL&gt; --header "Authorization: Bearer &lt;token&gt;"</code></p>
      <p>Tokens expire after 90 days by default and can be revoked at any time.</p></details>

    <details><summary>Connecting claude.ai or the Claude desktop app</summary>
      <p>Settings → Connectors → Add custom connector → paste the MCP URL → Connect. Claude sends you to this server's consent screen where you sign in
      with your email, password and second factor. The app then appears under <b>Connect Claude → Connected apps</b>, where you can disconnect it.</p></details>

    <details><summary>Adding Gmail, iCloud, Yahoo or Outlook</summary>
      <p>Use an <b>app-specific password</b>, never your main account password: Gmail (Google Account → Security → App passwords, requires 2-step verification),
      iCloud (appleid.apple.com → Sign-In and Security → App-Specific Passwords), Yahoo (Account Security → Generate app password). Outlook/Microsoft 365 needs
      IMAP enabled by the tenant and an app password where MFA is on. The presets fill in host and port.</p></details>

    <details><summary>Connecting Apple Calendar (iCloud)</summary>
      <p>Open <b>Calendars → Add calendar</b>, keep <b>Apple iCloud Calendar</b>, enter your Apple ID address and an <b>app-specific password</b> (the same kind as for iCloud Mail; you can reuse one or create a second at appleid.apple.com), then <b>Connect &amp; list calendars</b> and pick Home, Work, … Each iCloud calendar is added separately. Step-by-step with screenshots-in-words in the <a href="/docs#calendar">manual</a>.</p></details>

    <details><summary>Subscribing to an ICS / webcal link</summary>
      <p>Choose <b>ICS / webcal subscription</b> and paste the link (holiday feeds, a team calendar, anything Calendar.app's “New Calendar Subscription” accepts). ICS feeds are always read-only; only public https/webcal links work. Calendars you subscribed to inside iCloud show up in the iCloud pick list as read-only subscriptions.</p></details>

    <details><summary>What can Claude do to a calendar?</summary>
      <p>List and search events (recurring ones expanded), read details, and — unless the calendar is read-only — create, change and delete events including recurring rules and reminders. Events with attendees: iCloud sends the invitation e-mails itself the moment the event is saved, so Claude is instructed to show you the attendee list and wait for your go-ahead. Deleting needs your explicit confirmation. All of it is in your Activity log.</p></details>

    <details><summary>What does “read-only” do?</summary>
      <p>On a read-only account Claude can list folders, search and read messages and download attachments. Every tool that changes anything — send, draft, flag,
      move, archive, create or delete folders, even marking a message as read — is refused, and the refusal is logged. Mailboxes are opened in IMAP read-only mode,
      so reading does not alter server state.</p></details>

    <details><summary>How does sending work? Why is my mail in the Outbox?</summary>
      <p>By default Claude cannot put mail on the wire. <code>send_message</code> composes the message, saves it to your Drafts folder and adds it to your Outbox.
      Press <b>Send now</b> there to release it (the exact bytes you reviewed are sent), or <b>Discard</b> to drop the request — the draft stays in Drafts.
      Queued mail expires after 7 days. The toggle above the Outbox lets you allow direct sending; it is off by default and every change is logged.</p></details>

    <details><summary>I lost my phone / authenticator</summary>
      <p>Ask an administrator to reset your two-factor setup (Admin → Users → Reset 2FA). This also signs you out everywhere and revokes tokens and connected apps; at your next sign-in Cognito walks you through setting up a new authenticator.</p></details>

    <details><summary>Revoking access</summary>
      <p><b>Connect Claude</b> lists your tokens and connected apps; revoke any of them and it stops working immediately. <b>Security → Sessions</b> shows every browser signed in as you,
      with a “sign out everywhere” button that also revokes your Cognito refresh tokens. Deleting a mail account removes its credentials from the server.</p></details>

    <details><summary>Claude does not see a new tool</summary>
      <p>Clients cache the tool list when they connect. After the server is updated, toggle the connector off and on, or start a new conversation.</p></details>

    <details><summary>What is logged?</summary>
      <p>Sign-ins (successful and failed), second-factor use, token and app changes, mail-account changes, Outbox decisions and every tool call Claude makes
      (tool name, account, folder/uid/recipients/subject — never message bodies or attachments). You see your own log under <b>Activity</b>; administrators see everyone's.
      Entries are kept for one year.</p></details>
  </div>

  <h2>Contact</h2>
  <div class="card">
    ${contact.email ? `<p class="mb0">Operator: <a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a></p>` : `<p class="mb0 muted">The operator has not published a contact address yet.</p>`}
    ${contact.note ? `<p class="muted small">${esc(contact.note)}</p>` : ""}
    <p class="muted small mb0">Service status: <a href="/health">/health</a></p>
  </div>
  <footer><span>Private Office MCP</span><a href="/">Home</a><a href="/docs">Manual</a><a href="/health">Status</a></footer>
</div>`,
  });
