import { listAccounts, redact, resolveAccount } from "../lib/store.js";
import * as mail from "../lib/mail.js";

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any) => Promise<unknown>;
};

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
