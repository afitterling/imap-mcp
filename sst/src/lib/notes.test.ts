import "../test/env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

/** A fake IMAP server: one account whose folders and messages each test sets up. */
const server = {
  folders: [] as { path: string; delimiter?: string }[],
  messages: new Map<number, Buffer>(),
  locks: [] as { folder: string; readOnly?: boolean }[],
  searches: [] as unknown[],
  appended: [] as { folder: string; raw: Buffer; flags: string[] }[],
  refuseAppend: false,
};
class FakeImap {
  async connect() {}
  async logout() {}
  close() {}
  async list() { return server.folders; }
  async getMailboxLock(folder: string, opts: { readOnly?: boolean } = {}) {
    server.locks.push({ folder, readOnly: opts.readOnly });
    return { release() {} };
  }
  async search(criteria: unknown) { server.searches.push(criteria); return [...server.messages.keys()]; }
  async *fetch(uids: number[], query: { source?: { maxLength?: number } }) {
    for (const uid of uids) {
      const raw = server.messages.get(uid)!;
      yield { uid, flags: new Set(["\\Seen"]), size: raw.length, source: query.source?.maxLength ? raw.subarray(0, query.source.maxLength) : raw };
    }
  }
  async download(uid: string) {
    const raw = server.messages.get(Number(uid));
    return raw ? { content: Readable.from(raw) } : undefined;
  }
  async append(folder: string, raw: Buffer, flags: string[]) {
    if (server.refuseAppend) return false;
    server.appended.push({ folder, raw, flags });
    return { uid: 42 };
  }
}
mock.module("imapflow", { namedExports: { ImapFlow: FakeImap } });
mock.module("./store.js", { namedExports: { imapPassword: () => "pw", smtpPassword: () => "pw" } });

const notes = await import("./notes.js");
const acct: any = { accountId: "a1", label: "Home", email: "me@example.test", imap: { host: "imap.example.test", port: 993, secure: true, user: "me" } };

function reset(folders: { path: string; delimiter?: string }[] = [{ path: "INBOX" }, { path: "Notes" }]) {
  server.folders = folders;
  server.messages.clear();
  server.locks.length = 0;
  server.searches.length = 0;
  server.appended.length = 0;
  server.refuseAppend = false;
}

const appleNote = (uid: number, title: string, lines: string[], date: string) =>
  [
    "Content-Type: text/html; charset=utf-8",
    "Mime-Version: 1.0 (Mac OS X Notes 4.11)",
    `Date: ${date}`,
    `Subject: ${title}`,
    "X-Uniform-Type-Identifier: com.apple.mail-note",
    `X-Universally-Unique-Identifier: UUID-${uid}`,
    "X-Mail-Created-Date: Thu, 1 Oct 2026 08:00:00 +0200",
    "",
    `<html><body><div><b>${title}</b></div>${lines.map((l) => `<div>${l}</div>`).join("")}</body></html>`,
  ].join("\r\n");

test("pickNotesFolder finds Notes at the top level or under a parent, and prefers the top level", () => {
  assert.equal(notes.pickNotesFolder([{ path: "INBOX" }, { path: "Notes" }]), "Notes");
  assert.equal(notes.pickNotesFolder([{ path: "INBOX" }, { path: "[Gmail]/Notes", delimiter: "/" }]), "[Gmail]/Notes");
  assert.equal(notes.pickNotesFolder([{ path: "INBOX.Notes", delimiter: "." }]), "INBOX.Notes");
  assert.equal(notes.pickNotesFolder([{ path: "Archive/Notes", delimiter: "/" }, { path: "Notes" }]), "Notes");
  assert.equal(notes.pickNotesFolder([{ path: "INBOX" }, { path: "Notes 2026" }, { path: "Notizen" }]), undefined);
});

test("noteCriteria leaves out deleted notes and matches the query in title or text", () => {
  assert.deepEqual(notes.noteCriteria(), { deleted: false });
  assert.deepEqual(notes.noteCriteria("  "), { deleted: false });
  assert.deepEqual(notes.noteCriteria("milk"), { deleted: false, or: [{ subject: "milk" }, { body: "milk" }] });
});

test("noteHtml writes the title first, one div per line, lists as lists, and escapes markup", () => {
  const html = notes.noteHtml("Groceries <today>", "Buy:\n- milk\n- **eggs**\n\n1. first\n2. second\n## Later\nfish & chips");
  assert.equal(
    html,
    "<html><head></head><body>" +
      "<div><b>Groceries &lt;today&gt;</b></div>" +
      "<div>Buy:</div>" +
      "<ul><li>milk</li><li><b>eggs</b></li></ul>" +
      "<div><br></div>" +
      "<ol><li>first</li><li>second</li></ol>" +
      "<div><b>Later</b></div>" +
      "<div>fish &amp; chips</div>" +
      "</body></html>",
  );
  assert.equal(notes.noteHtml("Only a title"), "<html><head></head><body><div><b>Only a title</b></div><div><br></div></body></html>");
});

test("composeNote carries the Apple note headers and an HTML body", async () => {
  const raw = (await notes.composeNote(acct, { title: "Plan", body: "- a" }, new Date("2026-10-16T09:00:00Z"), "FIXED-UUID")).toString();
  assert.match(raw, /^X-Uniform-Type-Identifier: com\.apple\.mail-note$/m);
  assert.match(raw, /^X-Universally-Unique-Identifier: FIXED-UUID$/m);
  assert.match(raw, /^X-Mail-Created-Date: Fri, 16 Oct 2026 09:00:00 GMT$/m);
  assert.match(raw, /^Subject: Plan$/m);
  assert.match(raw, /^Content-Type: text\/html/m);
  assert.doesNotMatch(raw, /multipart/i, "a note is a single HTML part");
});

test("listNotes reads the detected Notes folder read-only, newest first, with previews", async () => {
  reset([{ path: "INBOX" }, { path: "[Gmail]/Notes", delimiter: "/" }]);
  server.messages.set(1, Buffer.from(appleNote(1, "Old", ["one"], "Thu, 1 Oct 2026 08:00:00 +0000")));
  server.messages.set(2, Buffer.from(appleNote(2, "New", ["second line", "third"], "Wed, 14 Oct 2026 08:00:00 +0000")));
  const res = await notes.listNotes(acct, { query: "line" });
  assert.equal(res.folder, "[Gmail]/Notes");
  assert.deepEqual(server.locks, [{ folder: "[Gmail]/Notes", readOnly: true }]);
  assert.deepEqual(server.searches, [{ deleted: false, or: [{ subject: "line" }, { body: "line" }] }]);
  assert.deepEqual(res.notes.map((n) => [n.uid, n.title, n.preview]), [[2, "New", "second line third"], [1, "Old", "one"]]);
  assert.equal(res.notes[0].created, "2026-10-01T06:00:00.000Z");
  assert.equal(res.notes[0].modified, "2026-10-14T08:00:00.000Z");
});

test("getNote returns the full text and leaves the note untouched", async () => {
  reset();
  server.messages.set(7, Buffer.from(appleNote(7, "Trip", ["Passport", "Tickets"], "Wed, 14 Oct 2026 08:00:00 +0000")));
  const n = await notes.getNote(acct, 7);
  assert.equal(n.folder, "Notes");
  assert.equal(n.title, "Trip");
  assert.match(n.text, /Passport\s+Tickets/);
  assert.deepEqual(server.locks, [{ folder: "Notes", readOnly: true }]);
  await assert.rejects(notes.getNote(acct, 99), /Note uid 99 not found in Notes/);
});

test("createNote appends to the Notes folder, marked seen", async () => {
  reset();
  const res = await notes.createNote(acct, { title: " Ideas ", body: "- one" });
  assert.deepEqual([res.folder, res.uid, res.title], ["Notes", 42, "Ideas"]);
  assert.equal(server.appended.length, 1);
  assert.deepEqual(server.appended[0].flags, ["\\Seen"]);
  assert.match(server.appended[0].raw.toString(), /com\.apple\.mail-note/);
});

test("without a Notes folder the tools explain how to switch Notes on; empty titles and refused appends fail", async () => {
  reset([{ path: "INBOX" }]);
  await assert.rejects(notes.listNotes(acct), notes.NoNotesFolderError);
  await assert.rejects(notes.createNote(acct, { title: "x" }), /Settings → Apps → Mail/);
  assert.deepEqual(server.appended, []);
  reset();
  await assert.rejects(notes.createNote(acct, { title: "  " }), /needs a `title`/);
  server.refuseAppend = true;
  await assert.rejects(notes.createNote(acct, { title: "x" }), /refused to save a note in "Notes"/);
});
