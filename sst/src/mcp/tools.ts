import { listAccounts, redact, resolveAccount } from "../lib/store.js";
import * as mail from "../lib/mail.js";

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any) => Promise<unknown>;
};

/** A handler may return this to emit MCP content blocks directly instead of JSON. */
export type RawContent = { __mcpContent: unknown[] };

const account = {
  type: "string",
  description: "Mail account to act on — its label, email address, or id. Use list_accounts first.",
};

export const tools: Tool[] = [
  {
    name: "list_accounts",
    title: "List mail accounts",
    description:
      "List every mail account connected to this server, with its label, email address and server settings. Call this first to learn which accounts exist.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => (await listAccounts()).map(redact),
  },
  {
    name: "list_folders",
    title: "List folders",
    description: "List the IMAP folders (mailboxes) of one account, including special-use folders like Sent and Trash.",
    inputSchema: { type: "object", properties: { account }, required: ["account"] },
    handler: async (a) => mail.listFolders(await resolveAccount(a.account)),
  },
  {
    name: "search_messages",
    title: "Search messages",
    description:
      "Search a folder and return message headers (uid, subject, from, date, read state). Combine filters freely; with no filters it returns the most recent messages.",
    inputSchema: {
      type: "object",
      properties: {
        account,
        folder: { type: "string", description: "Folder path, default INBOX." },
        query: { type: "string", description: "Text to match in subject or body." },
        from: { type: "string", description: "Match the sender address." },
        unseen: { type: "boolean", description: "Only unread messages." },
        since: { type: "string", description: "Only messages on or after this date (ISO 8601)." },
        limit: { type: "number", description: "Max messages to return, default 20, max 100." },
      },
      required: ["account"],
    },
    handler: async (a) => mail.searchMessages(await resolveAccount(a.account), a),
  },
  {
    name: "get_message",
    title: "Read a message",
    description: "Fetch the full body, headers and attachment list of one message by uid.",
    inputSchema: {
      type: "object",
      properties: {
        account,
        folder: { type: "string", description: "Folder the uid belongs to, default INBOX." },
        uid: { type: "number", description: "Message uid from search_messages." },
        markSeen: { type: "boolean", description: "Mark the message read after fetching. Default false." },
      },
      required: ["account", "uid"],
    },
    handler: async (a) =>
      mail.getMessage(await resolveAccount(a.account), a.folder ?? "INBOX", a.uid, a.markSeen ?? false),
  },
  {
    name: "send_message",
    title: "Send a message",
    description:
      "Send an email from one of the connected accounts over SMTP. Confirm recipient and content with the user before calling.",
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
      },
      required: ["account", "to", "subject"],
    },
    handler: async (a) => mail.sendMessage(await resolveAccount(a.account), a),
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
    handler: async (a): Promise<RawContent> => {
      const att = await mail.getAttachment(await resolveAccount(a.account), a.folder ?? "INBOX", a.uid, {
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
    handler: async (a) => mail.createFolder(await resolveAccount(a.account), a.path),
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
    handler: async (a) => {
      if (a.confirm !== true) {
        throw new Error(
          "Refused: deleting a folder destroys every message in it. Ask the user to confirm, then call again with confirm=true.",
        );
      }
      return mail.deleteFolder(await resolveAccount(a.account), a.path);
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
    handler: async (a) =>
      mail.setFlags(await resolveAccount(a.account), a.folder ?? "INBOX", a.uid, a.add ?? [], a.remove ?? []),
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
    handler: async (a) =>
      mail.archiveMessages(await resolveAccount(a.account), a.folder ?? "INBOX", a.uids, a.target),
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
    handler: async (a) => mail.moveMessage(await resolveAccount(a.account), a.folder ?? "INBOX", a.uid, a.target),
  },
];

export const toolMap = new Map(tools.map((t) => [t.name, t]));
