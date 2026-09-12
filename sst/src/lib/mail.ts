import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import type { Account } from "./store.js";
import { imapPassword, smtpPassword } from "./store.js";

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
          date: msg.envelope?.date?.toISOString(),
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
        attachments: parsed.attachments?.map((att) => ({
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

export type SendArgs = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  inReplyTo?: string;
};

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
  });
  transport.close();
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
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
