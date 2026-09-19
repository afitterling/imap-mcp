import { listAccounts, redact, resolveAccount, type Account } from "../lib/store.js";
import * as mail from "../lib/mail.js";
import { beautify } from "../lib/beautify.js";
import { queueSend } from "../lib/outbox.js";
import { requireApproval } from "../lib/settings.js";
import { listCalendars, resolveCalendar, redactCalendar, isReadOnly, type CalendarSource } from "../lib/calstore.js";
import * as cal from "../lib/calendar.js";
import { listGuardrails } from "../lib/guardrails.js";
import { withLink } from "../lib/links.js";

/** Who is calling, as established by the HTTP layer. Every tool is scoped to `userId`. */
export type CallerContext = {
  userId: string;
  auth: "pat" | "oauth" | "cognito";
  /** Token or grant id, for the audit trail. */
  tokenId: string;
  client?: string;
  ip?: string;
  /** The server's own https origin, so results can carry links into the web app. */
  origin?: string;
};

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Changes mailbox state (or sends). Refused on read-only accounts. */
  mutating: boolean;
  destructive?: boolean;
  handler: (args: any, ctx: CallerContext) => Promise<unknown>;
};

export class ReadOnlyError extends Error {
  constructor(a: { label: string }, what: string, where = "Accounts → Read-only") {
    super(`Account "${a.label}" is read-only: ${what} is not allowed. The user can lift this in the WebMail / Private Office MCP app under ${where}.`);
  }
}

/** Same gate for calendars; ICS feeds can never be written, whatever the switch says. */
async function writableCalendar(ref: string, ctx: CallerContext, what: string): Promise<CalendarSource> {
  const c = await resolveCalendar(ref, ctx.userId);
  if (c.kind === "ics") throw new Error(`Calendar "${c.label}" is an ICS subscription and cannot be changed: ${what} is not possible.`);
  if (isReadOnly(c)) throw new ReadOnlyError({ label: `Calendar ${c.label}` }, what, "Calendars → Read-only");
  return c;
}

/** Resolve an account for a mutating tool, refusing read-only ones before any network access. */
async function writable(ref: string, ctx: CallerContext, what: string): Promise<Account> {
  const a = await resolveAccount(ref, ctx.userId);
  if (a.readOnly) throw new ReadOnlyError(a, what);
  return a;
}

/** A handler may return this to emit MCP content blocks directly instead of JSON. */
export type RawContent = { __mcpContent: unknown[] };

const account = {
  type: "string",
  description: "Mail account to act on — its label, email address, or id. Use list_accounts first.",
};

/**
 * Models write markdown-ish plain text; mail clients render it as a wall of
 * characters. Produce a formatted HTML part from it unless the caller supplied
 * their own HTML or opted out. The text part is kept as the fallback.
 */
function htmlFor(a: any): string | undefined {
  if (a.html) return a.html;
  if (a.beautify === false || !a.text) return undefined;
  return beautify(String(a.text));
}

const formattingProps = {
  beautify: {
    type: "boolean",
    description:
      "Default true: the plain text is also rendered as a cleanly formatted HTML mail (headings, lists, tables, links). Set false only if the user wants plain text only.",
  },
};

const attachmentsSchema = {
  type: "array",
  description:
    "Files to attach. Give each entry EITHER base64 `content` (for a file you are creating) OR `fromUid` (to reuse a file already in a mailbox — the bytes are copied server-side, so you never need to read them first).",
  items: {
    type: "object",
    properties: {
      filename: { type: "string", description: "Name the recipient sees. Required with `content`." },
      contentType: { type: "string", description: 'MIME type, e.g. "application/pdf". Guessed if omitted.' },
      content: { type: "string", description: "Base64-encoded file contents." },
      fromUid: { type: "number", description: "Copy an attachment from this message uid instead." },
      fromFolder: { type: "string", description: "Folder that uid is in, default INBOX." },
      fromFilename: { type: "string", description: "Which attachment on that message, by filename." },
      fromIndex: { type: "number", description: "Which attachment on that message, by index. Default 0." },
    },
  },
};

const calendar = {
  type: "string",
  description: "Calendar to act on — its label, the calendar's name, or id. Use list_calendars first.",
};

const href = { type: "string", description: "The event's `href` as returned by list_events/get_event. Optional, but makes the lookup direct." };

const eventProps = {
  summary: { type: "string", description: "Title of the event." },
  start: {
    type: "string",
    description:
      'Start. "2026-09-14T10:00" is wall-clock time in `timezone`; "2026-09-14T10:00:00+02:00" or "...Z" is exact; "2026-09-14" for all-day (set allDay=true).',
  },
  end: { type: "string", description: "End, same formats. Defaults to one hour (all-day: one day) after start." },
  allDay: { type: "boolean", description: "All-day event (start/end are dates; end is exclusive)." },
  timezone: { type: "string", description: 'IANA zone for wall-clock times, e.g. "Europe/Berlin". Ask the user if unsure; do not guess UTC.' },
  location: { type: "string" },
  description: { type: "string", description: "Notes. Plain text." },
  rrule: { type: "string", description: 'Recurrence rule, e.g. "FREQ=WEEKLY;BYDAY=MO" or "FREQ=MONTHLY;BYMONTHDAY=1;COUNT=12". Empty string removes recurrence.' },
  remindMinutesBefore: { type: "number", description: "Reminder alert this many minutes before. null removes reminders." },
  attendees: {
    type: "array",
    description:
      "People to invite. THE CALENDAR SERVER SENDS THEM AN INVITATION E-MAIL IMMEDIATELY — always show the user the exact list and get their go-ahead before including attendees.",
    items: { type: "object", properties: { email: { type: "string" }, name: { type: "string" } }, required: ["email"] },
  },
  status: { type: "string", enum: ["CONFIRMED", "TENTATIVE", "CANCELLED"] },
};

export const tools: Tool[] = [
  {
    name: "list_accounts",
    title: "List mail accounts",
    description:
      "List the caller's mail accounts, with label, email address, server settings and whether the account is read-only (readOnly: true means no tool may change or send anything on it). Call this first to learn which accounts exist.",
    inputSchema: { type: "object", properties: {} },
    mutating: false,
    handler: async (_a, ctx) => (await listAccounts(ctx.userId)).map(redact),
  },
  {
    name: "list_folders",
    title: "List folders",
    description: "List the IMAP folders (mailboxes) of one account, including special-use folders like Sent and Trash.",
    inputSchema: { type: "object", properties: { account }, required: ["account"] },
    mutating: false,
    handler: async (a, ctx) => mail.listFolders(await resolveAccount(a.account, ctx.userId)),
  },
  {
    name: "search_messages",
    title: "Search messages",
    description:
      "Search a folder and return message headers (uid, subject, from, date, read state) plus a `link` that opens the message in the web app — use that link whenever you refer to a mail somewhere the user will click (a to-do, a note, a summary). Combine filters freely; with no filters it returns the most recent messages. Search headers first (the default); only widen to scope=body when the headers did not find it.",
    inputSchema: {
      type: "object",
      properties: {
        account,
        folder: { type: "string", description: "Folder path, default INBOX." },
        query: { type: "string", description: "Text to look for. Where depends on `scope`." },
        scope: {
          type: "string",
          enum: ["headers", "body"],
          description: 'Where `query` is matched. "headers" (default): subject, sender and recipients only — fast. "body": the deep search, also inside the message text — slower on big folders. Start with headers.',
        },
        from: { type: "string", description: "Match the sender address." },
        unseen: { type: "boolean", description: "Only unread messages." },
        since: { type: "string", description: "Only messages on or after this date (ISO 8601)." },
        limit: { type: "number", description: "Max messages to return, default 20, max 100." },
      },
      required: ["account"],
    },
    mutating: false,
    handler: async (a, ctx) => {
      const acct = await resolveAccount(a.account, ctx.userId);
      const rows = await mail.searchMessages(acct, { ...a, scope: a.scope === "body" ? "body" : "headers" });
      return rows.map((r) => withLink(ctx.origin, acct.accountId, r));
    },
  },
  {
    name: "get_message",
    title: "Read a message",
    description: "Fetch the full body, headers and attachment list of one message by uid. The result's `link` opens this message in the web app.",
    inputSchema: {
      type: "object",
      properties: {
        account,
        folder: { type: "string", description: "Folder the uid belongs to, default INBOX." },
        uid: { type: "number", description: "Message uid from search_messages." },
        markSeen: { type: "boolean", description: "Mark the message read after fetching. Default false. Refused on read-only accounts." },
      },
      required: ["account", "uid"],
    },
    mutating: false,
    handler: async (a, ctx) => {
      const markSeen = a.markSeen === true;
      const acct = markSeen
        ? await writable(a.account, ctx, "marking a message read")
        : await resolveAccount(a.account, ctx.userId);
      return withLink(ctx.origin, acct.accountId, await mail.getMessage(acct, a.folder ?? "INBOX", a.uid, markSeen));
    },
  },
  {
    name: "send_message",
    title: "Send a message",
    description:
      "Compose an email for the user to send. By default this does NOT send: the message is composed, saved to the mailbox and queued for the user to approve by hand in the WebMail / Private Office MCP app, which is where it is actually released. Tell the user plainly that the mail is waiting for their approval and give them the link the tool returns. Never claim a mail has been sent unless the tool result says it was.",
    inputSchema: {
      type: "object",
      properties: {
        account,
        to: { type: "string", description: "Recipient address(es), comma separated." },
        subject: { type: "string" },
        text: { type: "string", description: "Plain-text body." },
        html: { type: "string", description: "Optional HTML body." },
        cc: { type: "string" },
        bcc: { type: "string" },
        replyTo: { type: "string" },
        inReplyTo: { type: "string", description: "Message-Id being replied to, to keep threading intact." },
        attachments: attachmentsSchema,
        ...formattingProps,
      },
      required: ["account", "to", "subject"],
    },
    mutating: true,
    handler: async (a, ctx) => {
      // Reject malformed attachment specs before touching the network.
      validateAttachmentSpecs(a.attachments ?? []);
      const acct = await writable(a.account, ctx, "sending mail");
      const attachments = await resolveAttachments(acct, a.attachments ?? []);
      const args = { ...a, attachments, html: htmlFor(a) };

      if (!(await requireApproval(ctx.userId))) {
        return { ...(await mail.sendMessage(acct, args)), approvalRequired: false };
      }

      // Park the composed message in the mailbox; only a human click releases it.
      const draft = await mail.createDraft(acct, args);
      const pending = await queueSend({
        userId: ctx.userId,
        accountId: acct.accountId,
        accountLabel: acct.label,
        folder: draft.folder,
        uid: draft.uid!,
        to: a.to,
        cc: a.cc,
        bcc: a.bcc,
        subject: a.subject,
        preview: String(a.text ?? "").slice(0, 400),
        attachments: (attachments ?? []).map((x) => ({ filename: x.filename, size: x.content.length })),
      });
      return {
        sent: false,
        status: "awaiting_approval",
        approvalId: pending.id,
        parkedIn: `${draft.folder} (uid ${draft.uid})`,
        message:
          "NOT SENT. The mail is composed and waiting for the user to approve it by hand in the WebMail / Private Office MCP app (Outbox). Tell the user it needs their approval there — you cannot release it yourself.",
      };
    },
  },
  {
    name: "send_draft",
    title: "Send an existing draft",
    description:
      "Send a message that already sits in the Drafts folder (written by the user in their mail client, or by create_draft). By default this does NOT send: the draft is queued for the user to approve by hand in the app's Outbox, exactly like send_message. Give the draft's uid from search_messages on the Drafts folder. Recipients are taken from the draft itself.",
    inputSchema: {
      type: "object",
      properties: {
        account,
        uid: { type: "number", description: "Uid of the draft (search_messages with folder = the Drafts folder)." },
        folder: { type: "string", description: "Folder the draft is in. Default: the account's Drafts folder." },
      },
      required: ["account", "uid"],
    },
    mutating: true,
    handler: async (a, ctx) => {
      const acct = await writable(a.account, ctx, "sending a draft");
      const folder = a.folder ?? (await mail.draftsFolder(acct));
      const draft = await mail.getMessage(acct, folder, a.uid, false);
      const to = draft.to?.trim();
      if (!to) throw new Error("This draft has no recipient. Add one (or use send_message with explicit recipients).");
      const recipients = [to, draft.cc].filter(Boolean).join(",");

      if (!(await requireApproval(ctx.userId))) {
        return { ...(await mail.sendParkedMessage(acct, folder, a.uid, recipients)), sent: true, approvalRequired: false };
      }
      const pending = await queueSend({
        userId: ctx.userId,
        accountId: acct.accountId,
        accountLabel: acct.label,
        folder,
        uid: a.uid,
        to,
        cc: draft.cc,
        subject: draft.subject ?? "(no subject)",
        preview: String(draft.text ?? "").slice(0, 400),
        attachments: (draft.attachments ?? []).map((x) => ({ filename: x.filename ?? "attachment", size: x.size ?? 0 })),
      });
      return {
        sent: false,
        status: "awaiting_approval",
        approvalId: pending.id,
        parkedIn: `${folder} (uid ${a.uid})`,
        message:
          "NOT SENT. The draft is queued and waits for the user to approve it by hand in the app (Outbox). Tell the user it needs their approval there — you cannot release it yourself.",
      };
    },
  },
  {
    name: "create_draft",
    title: "Save a draft",
    description:
      "Write a message into the account's Drafts folder WITHOUT sending it. The user opens it in their own mail client to review, edit and send. Prefer this over send_message whenever the user wants to look the message over first, or when you are unsure about recipients or wording.",
    inputSchema: {
      type: "object",
      properties: {
        account,
        to: { type: "string", description: "Recipient address(es), comma separated. May be left empty on a draft." },
        subject: { type: "string" },
        text: { type: "string", description: "Plain-text body." },
        html: { type: "string", description: "Optional HTML body." },
        cc: { type: "string" },
        bcc: { type: "string" },
        replyTo: { type: "string" },
        inReplyTo: { type: "string", description: "Message-Id being replied to, to keep threading intact." },
        attachments: attachmentsSchema,
        ...formattingProps,
        folder: { type: "string", description: "Override the drafts folder if auto-detection picks the wrong one." },
      },
      required: ["account"],
    },
    mutating: true,
    handler: async (a, ctx) => {
      validateAttachmentSpecs(a.attachments ?? []);
      const acct = await writable(a.account, ctx, "saving a draft");
      const attachments = await resolveAttachments(acct, a.attachments ?? []);
      return mail.createDraft(acct, { ...a, attachments, html: htmlFor(a) });
    },
  },
  {
    name: "get_attachment",
    title: "Download an attachment",
    description:
      "Download one attachment from a message and return its contents. Images come back viewable; everything else as an embedded file resource. Call get_message first to see the attachment list with its indexes. Limit 4 MB per file.",
    inputSchema: {
      type: "object",
      properties: {
        account,
        folder: { type: "string", description: "Folder the message is in, default INBOX." },
        uid: { type: "number", description: "Message uid from search_messages." },
        filename: { type: "string", description: "Attachment filename. Takes precedence over index." },
        index: { type: "number", description: "Zero-based attachment index from get_message. Default 0." },
      },
      required: ["account", "uid"],
    },
    mutating: false,
    handler: async (a, ctx): Promise<RawContent> => {
      const att = await mail.getAttachment(await resolveAccount(a.account, ctx.userId), a.folder ?? "INBOX", a.uid, {
        filename: a.filename,
        index: a.index,
      });
      const base64 = att.content.toString("base64");
      const summary = {
        type: "text",
        text: `Attachment "${att.filename}" (${att.contentType}, ${att.size} bytes) from uid ${a.uid}.`,
      };
      if (att.contentType.startsWith("image/")) {
        return { __mcpContent: [summary, { type: "image", data: base64, mimeType: att.contentType }] };
      }
      const uri = `mail://${encodeURIComponent(a.account)}/${encodeURIComponent(a.folder ?? "INBOX")}/${a.uid}/${encodeURIComponent(att.filename)}`;
      // Text parts are more useful inline; everything else travels as a base64 blob.
      const resource = att.contentType.startsWith("text/")
        ? { uri, mimeType: att.contentType, text: att.content.toString("utf8") }
        : { uri, mimeType: att.contentType, blob: base64 };
      return { __mcpContent: [summary, { type: "resource", resource }] };
    },
  },
  {
    name: "create_folder",
    title: "Create a folder",
    description:
      "Create a new IMAP folder. Use the server's hierarchy separator for nesting, e.g. \"Projects/Acme\" or \"INBOX.Projects\" — call list_folders first to see which style the account uses.",
    inputSchema: {
      type: "object",
      properties: { account, path: { type: "string", description: "Full path of the folder to create." } },
      required: ["account", "path"],
    },
    mutating: true,
    handler: async (a, ctx) => mail.createFolder(await writable(a.account, ctx, "creating a folder"), a.path),
  },
  {
    name: "delete_folder",
    title: "Delete a folder",
    description:
      "Permanently delete a folder AND every message in it. This cannot be undone — always show the user the folder name and message count and get explicit confirmation before calling with confirm=true. INBOX and special folders (Sent, Trash, Drafts, Junk, Archive) are protected and cannot be deleted.",
    inputSchema: {
      type: "object",
      properties: {
        account,
        path: { type: "string", description: "Full path of the folder to delete." },
        confirm: {
          type: "boolean",
          description: "Must be true. Set it only after the user has explicitly confirmed this deletion.",
        },
      },
      required: ["account", "path", "confirm"],
    },
    mutating: true,
    destructive: true,
    handler: async (a, ctx) => {
      if (a.confirm !== true) {
        throw new Error(
          "Refused: deleting a folder destroys every message in it. Ask the user to confirm, then call again with confirm=true.",
        );
      }
      return mail.deleteFolder(await writable(a.account, ctx, "deleting a folder"), a.path);
    },
  },
  {
    name: "flag_message",
    title: "Flag or mark a message",
    description: "Add or remove IMAP flags on a message, e.g. mark read (\\\\Seen), star (\\\\Flagged) or delete (\\\\Deleted).",
    inputSchema: {
      type: "object",
      properties: {
        account,
        folder: { type: "string", description: "Folder path, default INBOX." },
        uid: { type: "number" },
        add: { type: "array", items: { type: "string" }, description: 'Flags to add, e.g. ["\\\\Seen"].' },
        remove: { type: "array", items: { type: "string" }, description: "Flags to remove." },
      },
      required: ["account", "uid"],
    },
    mutating: true,
    destructive: true,
    handler: async (a, ctx) =>
      mail.setFlags(await writable(a.account, ctx, "changing flags"), a.folder ?? "INBOX", a.uid, a.add ?? [], a.remove ?? []),
  },
  {
    name: "archive_message",
    title: "Archive messages",
    description:
      "Archive one or more messages — moves them out of the inbox into the account's archive folder, which is detected automatically (\\Archive special-use, or a folder named Archive / All Mail). Use this rather than deleting when the user wants mail out of the way but kept.",
    inputSchema: {
      type: "object",
      properties: {
        account,
        folder: { type: "string", description: "Folder the messages are in now, default INBOX." },
        uids: { type: "array", items: { type: "number" }, description: "One or more message uids from search_messages." },
        target: { type: "string", description: "Override the archive folder path, if auto-detection picks the wrong one." },
      },
      required: ["account", "uids"],
    },
    mutating: true,
    handler: async (a, ctx) =>
      mail.archiveMessages(await writable(a.account, ctx, "archiving"), a.folder ?? "INBOX", a.uids, a.target),
  },
  {
    name: "move_message",
    title: "Move a message",
    description: "Move a message to another folder, for example to archive it or file it away.",
    inputSchema: {
      type: "object",
      properties: {
        account,
        folder: { type: "string", description: "Current folder, default INBOX." },
        uid: { type: "number" },
        target: { type: "string", description: "Destination folder path." },
      },
      required: ["account", "uid", "target"],
    },
    mutating: true,
    handler: async (a, ctx) => mail.moveMessage(await writable(a.account, ctx, "moving a message"), a.folder ?? "INBOX", a.uid, a.target),
  },
  {
    name: "list_guardrails",
    title: "List the user's guardrails",
    description:
      "The rules the user has set for how you may use these tools. Read them before doing anything consequential. 'confirm' rules refuse matching calls until you re-call with guardrails_ack; 'block' rules cannot be overridden; 'remind' rules are advice you must follow.",
    inputSchema: { type: "object", properties: {} },
    mutating: false,
    handler: async (_a, ctx) => (await listGuardrails(ctx.userId)).filter((r) => r.enabled).map(({ id, text, tools, mode }) => ({ id, text, appliesTo: tools.length ? tools : "all tools", mode })),
  },
  /* --------------------------------- calendars --------------------------------- */
  {
    name: "list_calendars",
    title: "List calendars",
    description:
      "List the caller's calendars: iCloud/CalDAV calendars and ICS subscriptions, with kind and whether they are read-only (ICS feeds always are). Call this first before any calendar tool.",
    inputSchema: { type: "object", properties: {} },
    mutating: false,
    handler: async (_a, ctx) => (await listCalendars(ctx.userId)).map(redactCalendar),
  },
  {
    name: "list_events",
    title: "List events",
    description:
      "Events in a time window (default: the next 14 days, max 366 days). Recurring events are expanded into their occurrences. Times come back as UTC instants plus the event's own wall-clock time and zone — tell the user times in their zone.",
    inputSchema: {
      type: "object",
      properties: {
        calendar,
        from: { type: "string", description: "ISO 8601 start of the window. Default now." },
        to: { type: "string", description: "ISO 8601 end of the window. Default from + 14 days." },
        query: { type: "string", description: "Text to match in title, location, notes or attendees." },
        limit: { type: "number", description: "Max events, default 50, max 200." },
      },
      required: ["calendar"],
    },
    mutating: false,
    handler: async (a, ctx) => cal.listEvents(await resolveCalendar(a.calendar, ctx.userId), a),
  },
  {
    name: "get_event",
    title: "Get an event",
    description: "One event by uid, with attendees, reminders, recurrence rule and notes.",
    inputSchema: { type: "object", properties: { calendar, uid: { type: "string" }, href }, required: ["calendar", "uid"] },
    mutating: false,
    handler: async (a, ctx) => cal.getEvent(await resolveCalendar(a.calendar, ctx.userId), String(a.uid), a.href),
  },
  {
    name: "create_event",
    title: "Create an event",
    description:
      "Create an event in a CalDAV calendar (iCloud etc.). Give wall-clock start/end with the user's timezone. Attendees receive invitations from the calendar server at once — confirm with the user first. Refused on read-only calendars and ICS feeds.",
    inputSchema: { type: "object", properties: { calendar, ...eventProps }, required: ["calendar", "summary", "start"] },
    mutating: true,
    handler: async (a, ctx) => cal.createEvent(await writableCalendar(a.calendar, ctx, "creating an event"), a),
  },
  {
    name: "update_event",
    title: "Update an event",
    description:
      "Change fields of an existing event (only the fields you pass change; `attendees` replaces the whole list and newly added people are invited). For a recurring event this edits the whole series.",
    inputSchema: { type: "object", properties: { calendar, uid: { type: "string" }, href, ...eventProps }, required: ["calendar", "uid"] },
    mutating: true,
    handler: async (a, ctx) => {
      const { calendar: ref, uid, href: h, ...patch } = a;
      return cal.updateEvent(await writableCalendar(ref, ctx, "updating an event"), String(uid), patch, h);
    },
  },
  {
    name: "delete_event",
    title: "Delete an event",
    description:
      "Permanently delete an event (a recurring event: the whole series; attendees are told it was cancelled). Cannot be undone — show the user the title and date and get explicit confirmation before calling with confirm=true.",
    inputSchema: {
      type: "object",
      properties: { calendar, uid: { type: "string" }, href, confirm: { type: "boolean", description: "Must be true, set only after the user confirmed." } },
      required: ["calendar", "uid", "confirm"],
    },
    mutating: true,
    destructive: true,
    handler: async (a, ctx) => {
      if (a.confirm !== true) throw new Error("Refused: deleting an event cannot be undone. Ask the user to confirm, then call again with confirm=true.");
      return cal.deleteEvent(await writableCalendar(a.calendar, ctx, "deleting an event"), String(a.uid), a.href);
    },
  },
];

/** Shape check only — no account or network access needed. */
export function validateAttachmentSpecs(specs: any[]): void {
  if (!Array.isArray(specs)) throw new Error("`attachments` must be an array.");
  specs.forEach((spec, i) => {
    const label = spec?.filename ?? `#${i}`;
    if (spec?.fromUid !== undefined) {
      if (typeof spec.fromUid !== "number") throw new Error(`Attachment ${label}: fromUid must be a number.`);
      return;
    }
    if (typeof spec?.content !== "string") {
      throw new Error(`Attachment ${label} needs either base64 \`content\` or \`fromUid\`.`);
    }
    if (!spec.filename) throw new Error(`Attachment #${i} has base64 content but no filename.`);
  });
}

/**
 * Turn the tool's attachment specs into real buffers: base64 payloads are decoded,
 * `fromUid` entries are pulled off the IMAP server so the bytes never pass through
 * the model.
 */
async function resolveAttachments(acct: Account, specs: any[]): Promise<mail.Attachment[]> {
  const out: mail.Attachment[] = [];
  for (const spec of specs) {
    if (spec.fromUid !== undefined) {
      const att = await mail.getAttachment(
        acct,
        spec.fromFolder ?? "INBOX",
        spec.fromUid,
        { filename: spec.fromFilename, index: spec.fromIndex },
        mail.MAX_TOTAL_ATTACHMENT_BYTES,
      );
      out.push({
        filename: spec.filename ?? att.filename,
        contentType: spec.contentType ?? att.contentType,
        content: att.content,
      });
      continue;
    }
    out.push({
      filename: spec.filename,
      contentType: spec.contentType,
      content: Buffer.from(spec.content, "base64"),
    });
  }

  const total = out.reduce((sum, a) => sum + a.content.length, 0);
  if (total > mail.MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachments total ${(total / 1024 / 1024).toFixed(1)} MB, over the ${
        mail.MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024
      } MB limit for one message.`,
    );
  }
  return out;
}

export const toolMap = new Map(tools.map((t) => [t.name, t]));
