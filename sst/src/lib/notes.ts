import { randomUUID } from "node:crypto";
import type { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser, type ParsedMail } from "mailparser";
import type { Account } from "./store.js";
import { withImap, toIso, describeFlags } from "./mail.js";

/**
 * Apple Notes kept in a mail account (iPhone: Settings → Apps → Mail → Mail Accounts → <account>
 * → Notes; Mac: System Settings → Internet Accounts). Each note is an ordinary message in the
 * account's "Notes" IMAP folder, tagged with this header. iCloud notes do not live here: Apple
 * syncs those through CloudKit, which has no server API.
 */
export const NOTE_TYPE = "com.apple.mail-note";

/** How much of each note list_notes downloads for its preview. Notes may embed images. */
const PREVIEW_BYTES = 8 * 1024;
const PREVIEW_CHARS = 200;

export const NOTES_HINT =
  "Switch on Notes for this account first — iPhone: Settings → Apps → Mail → Mail Accounts → the account → Notes; Mac: System Settings → Internet Accounts → the account → Notes.";

/** The folder whose last path segment is "Notes" — "Notes", "INBOX.Notes", "[Gmail]/Notes"… Pure, for tests. */
export function pickNotesFolder(folders: { path: string; delimiter?: string }[]): string | undefined {
  const leaf = (f: { path: string; delimiter?: string }) => f.path.split(f.delimiter || "/").pop()!.toLowerCase();
  const hits = folders.filter((f) => leaf(f) === "notes");
  // A top-level "Notes" is what Apple creates; prefer it over a same-named subfolder.
  return (hits.find((f) => f.path.toLowerCase() === "notes") ?? hits[0])?.path;
}

export async function findNotesFolder(c: ImapFlow): Promise<string | undefined> {
  return pickNotesFolder(await c.list());
}

const NO_FOLDER = Symbol("no Notes folder");

/**
 * Connect, find the Notes folder (or take the one given) and run `fn` in it. A missing folder
 * is thrown only after the connection is closed: withImap words every error inside it as an
 * IMAP error, and callers need to tell "Notes is not switched on" apart from a server failure.
 */
async function inNotes<T>(a: Account, folder: string | undefined, fn: (c: ImapFlow, folder: string) => Promise<T>): Promise<T> {
  const out = await withImap(a, async (c) => {
    const box = folder ?? (await findNotesFolder(c));
    return box ? fn(c, box) : NO_FOLDER;
  });
  if (out === NO_FOLDER) throw new NoNotesFolderError(a);
  return out as T;
}

export class NoNotesFolderError extends Error {
  constructor(a: { label: string }) {
    super(`Account "${a.label}" has no Notes folder. ${NOTES_HINT}`);
  }
}

export type NoteSearch = { query?: string; limit?: number; folder?: string };

/** IMAP SEARCH criteria for list_notes. Pure. Notes the user deleted but the server kept are left out. */
export function noteCriteria(query?: string): Record<string, unknown> {
  const q = query?.trim();
  return q ? { deleted: false, or: [{ subject: q }, { body: q }] } : { deleted: false };
}

function header(parsed: ParsedMail, name: string): string | undefined {
  const v = parsed.headers.get(name);
  return v === undefined || v === null ? undefined : v instanceof Date ? v.toISOString() : String(v);
}

/** The first non-empty text line of a note is its title in the Notes app. */
function firstLine(text: string | undefined): string | undefined {
  return text?.split("\n").map((l) => l.trim()).find(Boolean);
}

/** A note's fields from its parsed MIME. Pure, for tests. */
export function describeNote(parsed: ParsedMail) {
  const text = (parsed.text ?? "").replace(/\r\n/g, "\n").trim();
  const created = header(parsed, "x-mail-created-date");
  return {
    title: parsed.subject || firstLine(text) || "(untitled)",
    created: toIso(created) ?? parsed.date?.toISOString(),
    modified: parsed.date?.toISOString(),
    noteId: header(parsed, "x-universally-unique-identifier"),
    isAppleNote: header(parsed, "x-uniform-type-identifier") === NOTE_TYPE,
    text,
  };
}

/** Notes in an account's Notes folder, newest first, with a short preview. */
export async function listNotes(a: Account, args: NoteSearch = {}) {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  return inNotes(a, args.folder, async (c, folder) => {
    const lock = await c.getMailboxLock(folder, { readOnly: true });
    try {
      const uids = await c.search(noteCriteria(args.query), { uid: true });
      if (!uids || uids.length === 0) return { folder, notes: [] };
      const wanted = uids.slice(-limit).reverse();
      const notes = [];
      for await (const msg of c.fetch(wanted, { uid: true, flags: true, size: true, source: { maxLength: PREVIEW_BYTES } }, { uid: true })) {
        const n = describeNote(await simpleParser(msg.source ?? Buffer.alloc(0)));
        // The title opens the body too; leave it out of the preview.
        const body = n.text.startsWith(n.title) ? n.text.slice(n.title.length).trim() : n.text;
        notes.push({
          uid: msg.uid,
          folder,
          title: n.title,
          created: n.created,
          modified: n.modified,
          preview: body.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS),
          size: msg.size,
          flagged: describeFlags(msg.flags).flagged,
        });
      }
      notes.sort((x, y) => (y.modified ?? "").localeCompare(x.modified ?? ""));
      return { folder, notes };
    } finally {
      lock.release();
    }
  });
}

/** One note in full. Opened read-only, so reading never changes it. */
export async function getNote(a: Account, uid: number, folder?: string) {
  return inNotes(a, folder, async (c, box) => {
    const lock = await c.getMailboxLock(box, { readOnly: true });
    try {
      const downloaded = await c.download(String(uid), undefined, { uid: true });
      if (!downloaded) throw new Error(`Note uid ${uid} not found in ${box}`);
      const parsed = await simpleParser(downloaded.content);
      const n = describeNote(parsed);
      return {
        uid,
        folder: box,
        title: n.title,
        created: n.created,
        modified: n.modified,
        text: n.text,
        html: typeof parsed.html === "string" ? parsed.html.slice(0, 20_000) : undefined,
        attachments: parsed.attachments?.map((att, index) => ({ index, filename: att.filename, contentType: att.contentType, size: att.size })),
      };
    } finally {
      lock.release();
    }
  });
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** **bold** and *italic*, the only inline markdown worth carrying into a note. */
function inline(s: string): string {
  return escape(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<i>$2</i>");
}

/**
 * Note HTML in the shape the Notes app itself writes: one <div> per line, the title first,
 * <br> for blank lines, real <ul>/<ol> for lists so they show as Notes bullets. Models
 * write markdown-ish text; headings become bold lines. Pure, for tests.
 */
export function noteHtml(title: string, body = ""): string {
  const out: string[] = [`<div><b>${escape(title.trim())}</b></div>`];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  const flush = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
    list = undefined;
  };
  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const tag = bullet ? "ul" : numbered ? "ol" : undefined;
    if (tag) {
      if (list?.tag !== tag) flush();
      list ??= { tag, items: [] };
      list.items.push(inline((bullet ?? numbered)![1]));
      continue;
    }
    flush();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    out.push(!line.trim() ? "<div><br></div>" : heading ? `<div><b>${inline(heading[1])}</b></div>` : `<div>${inline(line)}</div>`);
  }
  flush();
  return `<html><head></head><body>${out.join("")}</body></html>`;
}

/** RFC 822 Apple note. Pure apart from the clock and uuid, which tests pass in. */
export async function composeNote(
  a: Pick<Account, "email" | "label">,
  args: { title: string; body?: string },
  now = new Date(),
  uuid: string = randomUUID().toUpperCase(),
): Promise<Buffer> {
  return new MailComposer({
    from: `${a.label} <${a.email}>`,
    subject: args.title.trim(),
    date: now,
    html: noteHtml(args.title, args.body),
    headers: {
      "X-Uniform-Type-Identifier": NOTE_TYPE,
      "X-Universally-Unique-Identifier": uuid,
      "X-Mail-Created-Date": now.toUTCString(),
    },
  })
    .compile()
    .build();
}

/** Append a new note to the account's Notes folder. Nothing is edited or deleted. */
export async function createNote(a: Account, args: { title: string; body?: string; folder?: string }) {
  const title = args.title?.trim();
  if (!title) throw new Error("A note needs a `title`.");
  const raw = await composeNote(a, { title, body: args.body });
  return inNotes(a, args.folder, async (c, folder) => {
    // \Seen: Notes never shows notes as unread, but mail clients that see the folder would.
    const res = await c.append(folder, raw, ["\\Seen"], new Date());
    if (res === false) throw new Error(`The server refused to save a note in "${folder}".`);
    return {
      folder,
      uid: res.uid,
      title,
      size: raw.length,
      note: "Saved to the account's Notes folder. It shows up in the Notes app on every device where Notes is switched on for this account.",
    };
  });
}
