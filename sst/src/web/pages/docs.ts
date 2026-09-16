import { page, CLIENT_LIB } from "../layout.js";

const kv = (rows: [string, string][]) =>
  `<div class="kv">${rows
    .map(([k, v], i) => `<span class="k">${k}</span><code id="kv${k.replace(/\W/g, "")}${i}">${v}</code><button type="button" class="sm" data-copy="kv${k.replace(/\W/g, "")}${i}">Copy</button>`)
    .join("")}</div>`;

export const docsPage = (nonce: string, signedIn?: { name: string; email: string }) =>
  page({
    title: "Manual",
    description: "How to connect Apple Mail and Apple Calendar to Claude with WebMail / Private Office MCP, and what Claude can do with them.",
    nonce,
    user: signedIn,
    active: "docs",
    wide: true,
    body: `<div class="wrap wide">
  <h1>Manual</h1>
  <p class="lead">Setting up Apple Mail and Apple Calendar, connecting Claude, and staying in control.</p>
  <div class="docs">
    <nav class="toc">
      <a href="#start">1. Getting started</a>
      <a href="#mail">2. Apple Mail (iCloud)</a>
      <a class="sub" href="#mail-password">App-specific password</a>
      <a class="sub" href="#mail-add">Adding the account</a>
      <a class="sub" href="#mail-what">What Claude can do</a>
      <a class="sub" href="#mail-outbox">The Outbox</a>
      <a class="sub" href="#mail-trouble">Troubleshooting</a>
      <a href="#calendar">3. Apple Calendar (iCloud)</a>
      <a class="sub" href="#cal-add">Adding a calendar</a>
      <a class="sub" href="#cal-what">What Claude can do</a>
      <a class="sub" href="#cal-ics">ICS subscriptions</a>
      <a class="sub" href="#cal-trouble">Troubleshooting</a>
      <a href="#guardrails">4. Guardrails</a>
      <a href="#connect">5. Connecting Claude</a>
      <a href="#safety">6. Safety &amp; privacy</a>
      <a href="#ops">7. Operations (CLI)</a>
    </nav>
    <div class="prose">

      <h2 id="start">1. Getting started</h2>
      <p>Accounts live in Amazon Cognito; the app itself never sees your password.</p>
      <ol>
        <li><b>Press Sign in</b> and choose <b>Sign up</b> on the page that opens. Only pre-approved e-mail addresses are accepted; anything else is refused on the spot. The name is optional.</li>
        <li><b>Choose a password</b> of at least 12 characters with upper- and lowercase letters, a digit and a symbol.</li>
        <li><b>Verify your e-mail</b> with the code Cognito mails you.</li>
        <li><b>Set up your authenticator app</b> (1Password, Apple Passwords, Google Authenticator, Authy, Microsoft Authenticator…) by scanning the QR code and entering one code. This is required for every account.</li>
      </ol>
      <p>Signing in is always e-mail + password + authenticator code. Forgot the password? Use <i>Forgot your password?</i> on the sign-in page. New phone? <b>Security → Set up / replace authenticator</b> shows a fresh QR code. Locked out entirely? The operator resets it on the command line (see <a href="#ops">Operations</a>). The app has five tabs: <b>Accounts</b> (mailboxes), <b>Calendars</b>, <b>Outbox</b> (mail waiting for your approval), <b>Connect Claude</b> (tokens and connected apps), <b>Activity</b> (everything that happened) and <b>Security</b> (sessions).</p>

      <h2 id="mail">2. Apple Mail (iCloud)</h2>
      <h3 id="mail-password">Create an app-specific password</h3>
      <p>Apple does not let third-party software use your Apple ID password. You need an <em>app-specific password</em>, which requires two-factor authentication to be on for your Apple ID (it almost certainly is).</p>
      <ol>
        <li>Go to <a href="https://appleid.apple.com" rel="noopener">appleid.apple.com</a> and sign in.</li>
        <li>Open <b>Sign-In and Security → App-Specific Passwords</b>.</li>
        <li>Click <b>Generate an app-specific password</b>, name it <code>WebMail / Private Office MCP</code>, and copy the 16-character password (<code>xxxx-xxxx-xxxx-xxxx</code>). It is shown only once.</li>
      </ol>
      <p>You can revoke it on the same page at any time; that instantly cuts Claude off from the mailbox.</p>

      <h3 id="mail-add">Add the account</h3>
      <ol>
        <li>In the app, <b>Accounts → Add mail account</b> and choose the preset <b>iCloud Mail</b>. The hosts and ports fill in:</li>
      </ol>
      ${kv([
        ["IMAP host", "imap.mail.me.com"],
        ["IMAP port", "993"],
        ["SMTP host", "smtp.mail.me.com"],
        ["SMTP port", "587"],
      ])}
      <ol start="2">
        <li><b>Email address</b>: your iCloud address (<code>you@icloud.com</code>, <code>you@me.com</code> or a custom domain on iCloud+). <b>IMAP username</b>: the full address — for custom domains use the primary iCloud address as the username. <b>IMAP password</b>: the app-specific password. Leave the SMTP fields empty; they inherit the IMAP values.</li>
        <li>Tick <b>Read-only</b> if Claude should only ever read this mailbox. You can change this later from the account card.</li>
        <li><b>Save</b>, then press <b>Test</b> on the card. You should see <code>IMAP OK — INBOX has … messages · SMTP OK — authenticated</code>.</li>
      </ol>

      <h3 id="mail-what">What Claude can do with it</h3>
      <ul>
        <li><b>Search and read</b> — folders, subject/body/sender/date search, full messages, attachment download (images shown inline, other files as attachments; 4 MB each).</li>
        <li><b>Draft</b> — writes into your Drafts folder; you open it in Mail.app, edit and send yourself.</li>
        <li><b>Send</b> — by default Claude cannot send. It composes, parks the mail in Drafts and adds it to your <b>Outbox</b>; see below. The same goes for a draft you wrote yourself in Mail.app: “send my draft to Anna” queues it for your approval.</li>
        <li><b>File</b> — archive, move between folders, flag/unflag, mark read/unread, create folders. Deleting folders needs your explicit confirmation.</li>
        <li><b>Nothing at all beyond reading</b> when the account is read-only — including marking a message as read.</li>
      </ul>

      <h3 id="mail-outbox">The Outbox</h3>
      <p>When Claude wants to send, the exact message is saved to your Drafts and listed in <b>Outbox</b> with recipients, subject and a preview. <b>Send now</b> puts exactly those bytes on the wire and files a copy in Sent; <b>Discard</b> drops the request and leaves the draft. Queued mail expires after 7 days. The switch above the list can allow direct sending — it is off by default and every change is logged and mailed to you.</p>

      <h3 id="mail-trouble">Troubleshooting</h3>
      <ul>
        <li><b>“Authentication failed”</b> — you entered your Apple ID password; iCloud only accepts app-specific passwords here. Generate one as above.</li>
        <li><b>No app-specific passwords option</b> — turn on two-factor authentication for your Apple ID first (Settings → your name → Sign-In &amp; Security on an iPhone).</li>
        <li><b>Custom domain address rejected as username</b> — sign in with your primary <code>@icloud.com</code> address as the IMAP username and keep the custom domain as the account's e-mail address.</li>
        <li><b>Sent mail missing from Mail.app</b> — the copy is filed in the folder iCloud marks as Sent; give Mail.app a moment to sync.</li>
        <li><b>“Message not found”</b> — message ids (uids) are per folder; ask Claude to search again in the right folder.</li>
      </ul>

      <h2 id="calendar">3. Apple Calendar (iCloud)</h2>
      <p>Apple Calendar is reached over <b>CalDAV</b>, an open standard iCloud supports fully: reading, creating, changing and deleting events, including recurring events, reminders and invitations. Each iCloud calendar (Home, Work, Family…) is added separately so you can decide per calendar what Claude may do.</p>

      <h3 id="cal-add">Add a calendar</h3>
      <ol>
        <li>Use the app-specific password from the mail section, or generate a second one named <code>WebMail / Private Office MCP Calendar</code>.</li>
        <li><b>Calendars → Add calendar</b>, keep the source <b>Apple iCloud Calendar</b>:</li>
      </ol>
      ${kv([
        ["Server URL", "https://caldav.icloud.com"],
        ["Username", "your Apple ID address"],
        ["Password", "app-specific password"],
      ])}
      <ol start="3">
        <li>Press <b>Connect &amp; list calendars</b>. After a moment a dropdown shows every calendar on the account. Calendars you subscribed to in Calendar.app appear marked <em>subscription, read-only</em>.</li>
        <li>Pick one, give it a label (e.g. <code>Work</code>), tick <b>Read-only</b> if Claude should only look, and <b>Save</b> — or press <b>Add all calendars</b> to add every calendar on the account in one go, each named after itself (the Label field then acts as an optional prefix). Subscribed calendars are added read-only.</li>
        <li><b>Test</b> on the card confirms the sign-in and whether the calendar has upcoming events.</li>
      </ol>

      <h3 id="cal-what">What Claude can do with it</h3>
      <ul>
        <li><b>List and search</b> events in any window up to a year, recurring events expanded into their occurrences, with times in the event's own zone.</li>
        <li><b>Create events</b> — title, start/end (Claude works in your time zone and repeats it back), all-day events, location, notes, a recurrence rule (“every Monday”, “first of the month for a year”) and a reminder.</li>
        <li><b>Change events</b> — any of those fields; a recurring event is changed as a series. Edits use the calendar server's version check, so a change you make in Calendar.app at the same moment is never silently overwritten.</li>
        <li><b>Delete events</b> — only after you have confirmed the title and date.</li>
        <li><b>Invite people</b> — when an event has attendees, <em>iCloud itself e-mails the invitations the moment the event is saved</em>. Claude is instructed to show you the attendee list and wait for your approval before doing so. If you would rather keep this impossible, mark the calendar read-only or ask Claude to create the event without attendees and add them in Calendar.app.</li>
      </ul>
      <p>Events created by Claude show up in Calendar.app on all your devices within a minute, like any other iCloud change.</p>

      <h3 id="cal-ics">ICS / webcal subscriptions</h3>
      <p>Any public calendar link — public holidays, school terms, a team calendar from another tool — can be added with the source <b>ICS / webcal subscription</b>: paste the <code>webcal://</code> or <code>https://…ics</code> link and Save. Feeds are read-only, must be public (no passwords in the link) and at most 5 MB. To find the link of a calendar you already subscribed to in Calendar.app: right-click the calendar → <b>Get Info</b> → the URL field.</p>

      <h3 id="cal-trouble">Troubleshooting</h3>
      <ul>
        <li><b>“Sign-in failed”</b> — same cause as for mail: use an app-specific password.</li>
        <li><b>A calendar is missing from the list</b> — reminders lists are not calendars and are skipped; calendars shared <em>with</em> you appear only if iCloud exposes them, often as read-only.</li>
        <li><b>“The calendar server refused the event”</b> — usually a read-only calendar on the server side (a subscription or a shared calendar without write access). Pick another calendar.</li>
        <li><b>Times are off by an hour</b> — tell Claude your time zone (<code>Europe/Berlin</code>, <code>America/New_York</code>…). Wall-clock times without a zone are treated as UTC.</li>
        <li><b>“The event changed on the server while editing”</b> — you or a device edited it at the same time; ask Claude to fetch and retry.</li>
      </ul>

      <h2 id="guardrails">4. Guardrails</h2>
      <p>Under <b>Guardrails</b> you write rules, in plain language, that the server enforces on <em>every</em> tool call before anything happens — independent of what the model remembers or intends. Each rule applies to all tools or to the ones you tick, and has a mode:</p>
      <ul>
        <li><b>Remind</b> — the rule is placed in Claude's instructions at connect time and prepended to every matching tool result. For style and preference rules: “Write German mails with Sie”, “Never archive mail from my accountant”.</li>
        <li><b>Confirm</b> — a matching call is refused with the rule text; Claude has to follow it (typically: ask you) and then call again with an explicit acknowledgement of the rule id. For “ask me first” rules: “Before sending to anyone outside my company, show me the recipients and wait for my OK.”</li>
        <li><b>Block</b> — matching calls are always refused, and Claude is told not to retry. For hard limits: “Never delete calendar events” (tick <code>delete_event</code>), “No sending at all from the Private account”.</li>
      </ul>
      <p>Every refusal and every reminder is recorded in your Activity log (kind “Settings” for rule changes; the tool call itself shows <code>denied</code> with the rule id). Claude can read the current rules with <code>list_guardrails</code>. Guardrails complement, not replace, the structural safeguards — read-only accounts and the Outbox stay as they are.</p>

      <h2 id="connect">5. Connecting Claude</h2>
      <h3>Claude Code</h3>
      <ol>
        <li><b>Connect Claude → Create token</b>, name it after the machine. Copy the token — it is shown once.</li>
        <li>Run the command shown, which looks like:</li>
      </ol>
      <p><code>claude mcp add --transport http --scope user private-office &lt;MCP URL&gt; --header "Authorization: Bearer wmcp_…"</code></p>
      <p>Tokens expire after 90 days by default; revoke any time from the same tab.</p>
      <h3>claude.ai and the Claude desktop app</h3>
      <ol>
        <li>Settings → <b>Connectors</b> → <b>Add custom connector</b>, paste the MCP URL from <b>Connect Claude</b>, press Connect.</li>
        <li>You land on this server's consent screen: sign in with e-mail, password and second factor.</li>
        <li>The app now appears under <b>Connected apps</b>; <b>Disconnect</b> revokes it immediately.</li>
      </ol>
      <p>Clients cache the tool list when they connect. After the server is updated, toggle the connector off and on (or start a new conversation) to see new tools. A good first prompt: <i>“What's in my inbox, and what's on my calendar this week?”</i></p>

      <h2 id="safety">6. Safety &amp; privacy</h2>
      <ul>
        <li><b>Logged:</b> sign-ins and failures, token and connector changes, mailbox and calendar changes, Outbox decisions, and every tool call Claude makes — tool, account or calendar, folder/uid/recipients/subject or event title and time, outcome, duration. <b>Never logged:</b> message bodies, attachments, event notes, passwords, codes.</li>
        <li><b>Stored encrypted:</b> mail and calendar passwords. Your sign-in password and authenticator secret live in Cognito, never here. Tokens are stored only as hashes.</li>
        <li><b>Alerts:</b> every new sign-in, failed attempt, new token, new connector, factor change and operator actions is mailed to you.</li>
        <li><b>Revoking:</b> delete a token or disconnect an app (instant); revoke the app-specific password at Apple (instant, for both mail and calendar); <b>Security → Sign out everywhere</b>; or delete the account/calendar from the app, which erases its credentials.</li>
        <li><b>New phone:</b> Security → Set up / replace authenticator. Locked out: the operator resets your two-factor setup on the command line and Cognito asks for a new authenticator at the next sign-in.</li>
      </ul>

      <h2 id="ops">7. Operations (command line)</h2>
      <p>There is no administrator in the web app: everybody has the same rights over their own data and nothing else. The few things that must be done <em>to</em> a user happen on the command line, from the repository, with AWS credentials for the stage:</p>
      <p><code>cd sst &amp;&amp; npm run user -- &lt;command&gt; [email] --stage dev</code></p>
      <ul>
        <li><code>list</code> — users in the pool with status and MFA state</li>
        <li><code>reset-mfa &lt;email&gt;</code> — clear the authenticator; the user sets up a new one at the next sign-in</li>
        <li><code>signout &lt;email&gt;</code> — revoke every Cognito session and refresh token</li>
        <li><code>disable &lt;email&gt;</code> / <code>enable &lt;email&gt;</code> — switch an account off or on (sign-in and every token stop working while disabled)</li>
      </ul>
      <p>Everything else — passwords (via <i>Forgot your password?</i>), sessions, tokens, connected apps, accounts, calendars — each user manages for themselves in the app.</p>
    </div>
  </div>
  <footer><span>WebMail / Private Office MCP</span><a href="/">Home</a><a href="/support">Support</a><a href="/health">Status</a></footer>
</div>`,
    script: CLIENT_LIB,
  });
