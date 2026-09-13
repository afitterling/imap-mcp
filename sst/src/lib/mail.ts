import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import type { Account } from "./store.js";
import { imapPassword, smtpPassword } from "./store.js";

/** Envelope dates arrive as a Date on most servers and as a raw string on some. */
function toIso(value: string | Date | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function client(a: Account): ImapFlow {
  return new ImapFlow({
    host: a.imap.host,
    port: a.imap.port,
    secure: a.imap.secure,
    auth: { user: a.imap.user, pass: imapPassword(a) },
    logger: false,
    // Lambda has no long-lived connections to keep warm.
    socketTimeout: 45_000,
  });
}

/** Connect, run, always disconnect — Lambda must not leak sockets between invocations. */
async function withImap<T>(a: Account, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = client(a);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout().catch(() => c.close());
  }
}

export async function listFolders(a: Account) {
  return withImap(a, async (c) => {
    const list = await c.list();
    return list.map((f) => ({
      path: f.path,
      name: f.name,
      specialUse: f.specialUse ?? undefined,
      subscribed: f.subscribed,
    }));
  });
}

export type SearchArgs = {
  folder?: string;
  query?: string;
  from?: string;
  unseen?: boolean;
  since?: string;
  limit?: number;
};

export async function searchMessages(a: Account, args: SearchArgs) {
  const limit = Math.min(args.limit ?? 20, 100);
  return withImap(a, async (c) => {
    const lock = await c.getMailboxLock(args.folder ?? "INBOX");
    try {
      const criteria: Record<string, unknown> = {};
      if (args.query) criteria.or = [{ subject: args.query }, { body: args.query }];
      if (args.from) criteria.from = args.from;
      if (args.unseen) criteria.seen = false;
      if (args.since) criteria.since = new Date(args.since);
      if (Object.keys(criteria).length === 0) criteria.all = true;

      const uids = await c.search(criteria, { uid: true });
      if (!uids || uids.length === 0) return [];

      // Newest first, then fetch only the envelopes we will show.
      const wanted = uids.slice(-limit).reverse();
      const out = [];
      for await (const msg of c.fetch(wanted, { uid: true, envelope: true, flags: true, size: true }, { uid: true })) {
        out.push({
          uid: msg.uid,
          folder: args.folder ?? "INBOX",
          subject: msg.envelope?.subject ?? "(no subject)",
          from: msg.envelope?.from?.map((x) => `${x.name ?? ""} <${x.address}>`.trim()).join(", "),
          to: msg.envelope?.to?.map((x) => x.address).join(", "),
          date: toIso(msg.envelope?.date),
          seen: msg.flags?.has("\\Seen") ?? false,
          flagged: msg.flags?.has("\\Flagged") ?? false,
          size: msg.size,
        });
      }
      return out.sort((x, y) => (y.date ?? "").localeCompare(x.date ?? ""));
    } finally {
      lock.release();
    }
  });
}

export async function getMessage(a: Account, folder: string, uid: number, markSeen = false) {
  return withImap(a, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const downloaded = await c.download(String(uid), undefined, { uid: true });
      if (!downloaded) throw new Error(`Message uid ${uid} not found in ${folder}`);
      const parsed = await simpleParser(downloaded.content);
      if (markSeen) await c.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      return {
        uid,
        folder,
        subject: parsed.subject,
        from: parsed.from?.text,
        to: parsed.to && (Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : parsed.to.text),
        cc: parsed.cc && (Array.isArray(parsed.cc) ? parsed.cc.map((t) => t.text).join(", ") : parsed.cc.text),
        date: parsed.date?.toISOString(),
        messageId: parsed.messageId,
        text: parsed.text,
        // Trim runaway HTML mail; the text part is what a model actually needs.
        html: typeof parsed.html === "string" ? parsed.html.slice(0, 20_000) : undefined,
        attachments: parsed.attachments?.map((att, index) => ({
          index,
          filename: att.filename,
          contentType: att.contentType,
          size: att.size,
        })),
      };
    } finally {
      lock.release();
    }
  });
}

/** Lambda can return ~6 MB; base64 inflates by a third, so cap the raw payload below that. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export async function getAttachment(
  a: Account,
  folder: string,
  uid: number,
  selector: { filename?: string; index?: number },
  maxBytes: number = MAX_ATTACHMENT_BYTES,
) {
  return withImap(a, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const downloaded = await c.download(String(uid), undefined, { uid: true });
      if (!downloaded) throw new Error(`Message uid ${uid} not found in ${folder}`);
      const parsed = await simpleParser(downloaded.content);
      const all = parsed.attachments ?? [];
      if (!all.length) throw new Error(`Message uid ${uid} has no attachments.`);

      const wanted =
        selector.filename !== undefined
          ? all.find((x) => x.filename?.toLowerCase() === selector.filename!.toLowerCase())
          : all[selector.index ?? 0];
      if (!wanted) {
        const names = all.map((x, i) => `[${i}] ${x.filename ?? "(unnamed)"}`).join(", ");
        throw new Error(`No attachment matched. This message has: ${names}`);
      }
      if (wanted.size > maxBytes) {
        throw new Error(
          `Attachment "${wanted.filename}" is ${(wanted.size / 1024 / 1024).toFixed(1)} MB, over the ${(
            maxBytes /
            1024 /
            1024
          ).toFixed(0)} MB limit.`,
        );
      }
      return {
        filename: wanted.filename ?? "attachment",
        contentType: wanted.contentType ?? "application/octet-stream",
        size: wanted.size,
        content: wanted.content as Buffer,
      };
    } finally {
      lock.release();
    }
  });
}

export async function setFlags(
  a: Account,
  folder: string,
  uid: number,
  add: string[] = [],
  remove: string[] = [],
) {
  return withImap(a, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      if (add.length) await c.messageFlagsAdd(String(uid), add, { uid: true });
      if (remove.length) await c.messageFlagsRemove(String(uid), remove, { uid: true });
      return { uid, folder, added: add, removed: remove };
    } finally {
      lock.release();
    }
  });
}

/**
 * Locate the account's archive folder. IMAP servers disagree wildly: most advertise
 * the \\Archive special-use flag, Gmail exposes "[Gmail]/All Mail" instead, and some
 * only have a plainly named folder.
 */
const ARCHIVE_NAMES = ["archive", "archiv", "archives", "[gmail]/all mail", "inbox.archive", "all mail"];

export async function findArchiveFolder(c: ImapFlow): Promise<string> {
  const folders = await c.list();
  const special = folders.find((f) => f.specialUse === "\\Archive");
  if (special) return special.path;
  const named = folders.find((f) => ARCHIVE_NAMES.includes(f.path.toLowerCase()));
  if (named) return named.path;
  throw new Error(
    `No archive folder found. Pass "target" explicitly — available folders: ${folders.map((f) => f.path).join(", ")}`,
  );
}

/** Archive one or more messages, resolving the archive folder automatically. */
export async function archiveMessages(a: Account, folder: string, uids: number[], target?: string) {
  return withImap(a, async (c) => {
    const destination = target ?? (await findArchiveFolder(c));
    if (destination === folder) {
      return { archived: [], folder, target: destination, note: "Messages are already in the archive folder." };
    }
    const lock = await c.getMailboxLock(folder);
    try {
      await c.messageMove(uids, destination, { uid: true });
      return { archived: uids, from: folder, target: destination };
    } finally {
      lock.release();
    }
  });
}

export async function moveMessage(a: Account, folder: string, uid: number, target: string) {
  return withImap(a, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      await c.messageMove(String(uid), target, { uid: true });
      return { uid, from: folder, to: target };
    } finally {
      lock.release();
    }
  });
}

export type Attachment = { filename: string; contentType?: string; content: Buffer };

export type SendArgs = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  inReplyTo?: string;
  attachments?: Attachment[];
};

/** Most providers reject messages over ~25 MB; stay well under after base64 encoding. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export async function sendMessage(a: Account, args: SendArgs) {
  const transport = nodemailer.createTransport({
    host: a.smtp.host,
    port: a.smtp.port,
    secure: a.smtp.secure,
    auth: { user: a.smtp.user, pass: smtpPassword(a) },
  });
  const info = await transport.sendMail({
    from: `${a.label} <${a.email}>`,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    replyTo: args.replyTo,
    inReplyTo: args.inReplyTo,
    references: args.inReplyTo,
    subject: args.subject,
    text: args.text,
    html: args.html,
    attachments: args.attachments?.map((att) => ({
      filename: att.filename,
      contentType: att.contentType,
      content: att.content,
    })),
  });
  transport.close();
  return {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    attachments: args.attachments?.map((a) => ({ filename: a.filename, size: a.content.length })),
  };
}

const DRAFT_NAMES = ["drafts", "draft", "entwürfe", "entwuerfe", "inbox.drafts", "[gmail]/drafts"];

/** Locate the Drafts folder the same way archiving locates the archive. */
async function findDraftsFolder(c: ImapFlow): Promise<string> {
  const folders = await c.list();
  const special = folders.find((f) => f.specialUse === "\\Drafts");
  if (special) return special.path;
  const named = folders.find((f) => DRAFT_NAMES.includes(f.path.toLowerCase()));
  if (named) return named.path;
  throw new Error(
    `No drafts folder found. Pass "folder" explicitly — available: ${folders.map((f) => f.path).join(", ")}`,
  );
}

/**
 * Save a message to the Drafts folder over IMAP APPEND. Nothing is sent: the user
 * opens it in their own mail client, edits and sends it there.
 */
export async function createDraft(a: Account, args: SendArgs & { folder?: string }) {
  const raw = await new MailComposer({
    from: `${a.label} <${a.email}>`,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    replyTo: args.replyTo,
    inReplyTo: args.inReplyTo,
    references: args.inReplyTo,
    subject: args.subject,
    text: args.text,
    html: args.html,
    attachments: args.attachments?.map((att) => ({
      filename: att.filename,
      contentType: att.contentType,
      content: att.content,
    })),
  })
    .compile()
    .build();

  return withImap(a, async (c) => {
    const folder = args.folder ?? (await findDraftsFolder(c));
    // \Draft marks it editable; \Seen stops it showing up as unread mail.
    // append() resolves to false on servers that refuse the APPEND outright.
    const res = await c.append(folder, raw, ["\\Draft", "\\Seen"], new Date());
    if (res === false) throw new Error(`The server refused to save a draft in "${folder}".`);
    return {
      folder,
      uid: res.uid,
      subject: args.subject,
      to: args.to,
      size: raw.length,
      attachments: args.attachments?.map((x) => ({ filename: x.filename, size: x.content.length })),
      note: "Saved as a draft. Nothing has been sent.",
    };
  });
}

const SENT_NAMES = ["sent", "sent items", "sent mail", "gesendet", "inbox.sent", "[gmail]/sent mail"];

async function findSentFolder(c: ImapFlow): Promise<string | undefined> {
  const folders = await c.list();
  return (
    folders.find((f) => f.specialUse === "\\Sent")?.path ??
    folders.find((f) => SENT_NAMES.includes(f.path.toLowerCase()))?.path
  );
}

/**
 * Send a message that was parked in a folder awaiting human approval. The stored
 * MIME is sent verbatim, so what the approver reviewed is exactly what goes out.
 */
export async function sendParkedMessage(a: Account, folder: string, uid: number, envelopeTo: string) {
  const raw = await withImap(a, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const downloaded = await c.download(String(uid), undefined, { uid: true });
      if (!downloaded) throw new Error(`The approved message (uid ${uid}) is no longer in ${folder}.`);
      const chunks: Buffer[] = [];
      for await (const chunk of downloaded.content) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    } finally {
      lock.release();
    }
  });

  const transport = nodemailer.createTransport({
    host: a.smtp.host,
    port: a.smtp.port,
    secure: a.smtp.secure,
    auth: { user: a.smtp.user, pass: smtpPassword(a) },
  });
  const info = await transport.sendMail({
    envelope: { from: a.email, to: envelopeTo.split(",").map((x) => x.trim()) },
    raw,
  });
  transport.close();

  // File the sent copy where the user's mail client expects it.
  let filedIn: string | undefined;
  await withImap(a, async (c) => {
    const sent = await findSentFolder(c);
    const lock = await c.getMailboxLock(folder);
    try {
      if (sent && sent !== folder) {
        await c.messageMove(String(uid), sent, { uid: true });
        filedIn = sent;
      } else {
        await c.messageFlagsAdd(String(uid), ["\\Deleted"], { uid: true });
      }
    } finally {
      lock.release();
    }
  }).catch(() => undefined);

  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, filedIn };
}

export async function createFolder(a: Account, path: string) {
  return withImap(a, async (c) => {
    const res = await c.mailboxCreate(path);
    return { path: res.path, created: res.created };
  });
}

/** Folders that must never be deleted, whatever the caller asks for. */
const PROTECTED_USE = ["\\Inbox", "\\Sent", "\\Trash", "\\Drafts", "\\Junk", "\\Archive"];

export async function deleteFolder(a: Account, path: string) {
  return withImap(a, async (c) => {
    if (path.toUpperCase() === "INBOX") throw new Error("The INBOX cannot be deleted.");
    const folders = await c.list();
    const folder = folders.find((f) => f.path === path);
    if (!folder) {
      throw new Error(`No folder "${path}". Available: ${folders.map((f) => f.path).join(", ")}`);
    }
    if (folder.specialUse && PROTECTED_USE.includes(folder.specialUse)) {
      throw new Error(
        `"${path}" is the account's ${folder.specialUse} folder and is protected from deletion.`,
      );
    }
    // Report what is about to be destroyed — deleting a mailbox takes its messages with it.
    const box = await c.mailboxOpen(path, { readOnly: true });
    const messageCount = box.exists;
    await c.mailboxClose();
    await c.mailboxDelete(path);
    return { path, deleted: true, messagesDeleted: messageCount };
  });
}

/** Used by the admin UI's "Test connection" button. */
export async function testAccount(a: Account) {
  const result = { imap: "", smtp: "" };
  await withImap(a, async (c) => {
    const box = await c.mailboxOpen("INBOX");
    result.imap = `OK — INBOX has ${box.exists} messages`;
  });
  const transport = nodemailer.createTransport({
    host: a.smtp.host,
    port: a.smtp.port,
    secure: a.smtp.secure,
    auth: { user: a.smtp.user, pass: smtpPassword(a) },
  });
  await transport.verify();
  transport.close();
  result.smtp = "OK — authenticated";
  return result;
}
