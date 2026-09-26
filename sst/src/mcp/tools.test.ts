import "../test/env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const accounts: Record<string, any> = {
  ro: { accountId: "ro", ownerId: "u1", label: "Locked", email: "l@x.y", imap: {}, smtp: {}, readOnly: true },
  rw: { accountId: "rw", ownerId: "u1", label: "Open", email: "o@x.y", imap: {}, smtp: {}, readOnly: false },
  roa: { accountId: "roa", ownerId: "u1", label: "Locked but archivable", email: "a@x.y", imap: {}, smtp: {}, readOnly: true, allowArchive: true },
};
const calls: string[] = [];
const searchArgs: any[] = [];
mock.module("../lib/store.js", {
  namedExports: {
    listAccounts: async (owner: string) => Object.values(accounts).filter((a) => a.ownerId === owner),
    resolveAccount: async (ref: string, owner: string) => {
      const a = accounts[ref];
      if (!a || a.ownerId !== owner) throw new Error(`No mail account matches "${ref}"`);
      return a;
    },
    redact: (a: any) => a,
  },
});
const stub = (name: string) => async () => { calls.push(name); return { ok: name }; };
mock.module("../lib/mail.js", {
  namedExports: {
    listFolders: stub("listFolders"),
    searchMessages: async (_a: any, args: any) => { calls.push("searchMessages"); searchArgs.push(args); return [{ uid: 9, folder: args.folder ?? "INBOX", subject: "s", messageId: "<answered@x>" }, { uid: 8, folder: args.folder ?? "INBOX", subject: "s2", messageId: "<open@x>" }]; },
    getMessage: async (_a: any, folder: string, uid: number) => { calls.push("getMessage"); return { uid, folder, to: "a@b.c", subject: "s", text: "t", attachments: [], messageId: "<answered@x>", inReplyTo: "<parent@x>" }; },
    folderFlags: stub("folderFlags"),
    firstMessageId: (v?: string) => (v ? (v.match(/<[^<>\s]+>/)?.[0] ?? `<${v.trim()}>`) : undefined),
    getAttachment: async () => { calls.push("getAttachment"); return { filename: "a.txt", contentType: "text/plain", size: 1, content: Buffer.from("a") }; },
    setFlags: stub("setFlags"), archiveMessages: stub("archiveMessages"), moveMessage: stub("moveMessage"),
    createFolder: stub("createFolder"), deleteFolder: stub("deleteFolder"), createDraft: stub("createDraft"), sendMessage: stub("sendMessage"),
    sendParkedMessage: stub("sendParkedMessage"), draftsFolder: async () => { calls.push("draftsFolder"); return "Drafts"; },
    MAX_TOTAL_ATTACHMENT_BYTES: 1024,
  },
});
let approval = false;
mock.module("../lib/settings.js", { namedExports: { requireApproval: async () => approval } });

const calendars: Record<string, any> = {
  open: { calendarId: "open", ownerId: "u1", label: "Work", kind: "caldav", readOnly: false },
  locked: { calendarId: "locked", ownerId: "u1", label: "Family", kind: "caldav", readOnly: true },
  feed: { calendarId: "feed", ownerId: "u1", label: "Holidays", kind: "ics", readOnly: true },
};
mock.module("../lib/calstore.js", {
  namedExports: {
    listCalendars: async (owner: string) => Object.values(calendars).filter((c) => c.ownerId === owner),
    resolveCalendar: async (ref: string, owner: string) => {
      const c = calendars[ref];
      if (!c || c.ownerId !== owner) throw new Error(`No calendar matches "${ref}"`);
      return c;
    },
    redactCalendar: (c: any) => ({ ...c, readOnly: c.kind === "ics" || c.readOnly }),
    isReadOnly: (c: any) => c.kind === "ics" || c.readOnly === true,
  },
});
mock.module("../lib/calendar.js", {
  namedExports: {
    listEvents: stub("listEvents"), getEvent: stub("getEvent"), createEvent: stub("createEvent"), updateEvent: stub("updateEvent"), deleteEvent: stub("deleteEvent"),
  },
});
const queued: any[] = [];
mock.module("../lib/outbox.js", {
  namedExports: {
    queueSend: async (item: any) => { queued.push(item); return { id: "p" }; },
    listPending: async (userId: string) => (userId === "u1" ? [{ id: "q1", accountId: "rw", accountLabel: "Open", to: "c@d.e", subject: "Re: x", createdAt: "2026-09-25T00:00:00Z", inReplyTo: "<queued@x>" }] : []),
  },
});
// The reply log: "<answered@x>" on account rw was answered by u1.
const logged = { accountId: "rw", messageId: "<answered@x>", repliedAt: "2026-09-24T10:00:00.000Z", firstRepliedAt: "2026-09-24T10:00:00.000Z", count: 1, to: "a@b.c", subject: "Re: s", via: "outbox" };
const noted: any[] = [];
mock.module("../lib/replies.js", {
  namedExports: {
    REPLY_RETENTION_DAYS: 365,
    getReplies: async (userId: string, accountId: string, ids: (string | undefined)[]) =>
      new Map(userId === "u1" && accountId === "rw" && ids.some((i) => i?.includes("answered@x")) ? [["<answered@x>", logged]] : []),
    listReplies: async (userId: string) => (userId === "u1" ? [logged] : []),
    noteReply: async (_a: any, _u: string, sent: any) => { noted.push(sent); return { recorded: !!sent.inReplyTo }; },
  },
});
mock.module("../lib/guardrails.js", { namedExports: { listGuardrails: async () => [] } });

const { tools, toolMap, ReadOnlyError } = await import("./tools.js");
const ctx = { userId: "u1", auth: "pat" as const, tokenId: "t" };

const MUTATING: Record<string, any> = {
  send_message: { to: "a@b.c", subject: "s", text: "t" },
  send_draft: { uid: 7 },
  create_draft: { subject: "s" },
  flag_message: { uid: 1, add: ["\\Seen"] },
  archive_message: { uids: [1] },
  move_message: { uid: 1, target: "X" },
  create_folder: { path: "X" },
  delete_folder: { path: "X", confirm: true },
};
const READ: Record<string, any> = { list_folders: {}, search_messages: {}, get_message: { uid: 1 }, get_attachment: { uid: 1 }, list_flags: {} };
const CAL_MUTATING: Record<string, any> = {
  create_event: { summary: "x", start: "2026-09-14T10:00" },
  update_event: { uid: "u", summary: "y" },
  delete_event: { uid: "u", confirm: true },
};
const CAL_READ: Record<string, any> = { list_events: {}, get_event: { uid: "u" } };

test("every tool declares mutating and matches the expected sets", () => {
  for (const t of tools) assert.equal(typeof t.mutating, "boolean", t.name);
  assert.deepEqual(tools.filter((t) => t.mutating).map((t) => t.name).sort(), [...Object.keys(MUTATING), ...Object.keys(CAL_MUTATING)].sort());
  assert.deepEqual(tools.filter((t) => !t.mutating).map((t) => t.name).sort(), [...Object.keys(READ), ...Object.keys(CAL_READ), "list_accounts", "list_calendars", "list_guardrails", "list_replies"].sort());
});

test("mutating tools are refused on a read-only account before touching mail", async () => {
  for (const [name, args] of Object.entries(MUTATING)) {
    calls.length = 0;
    await assert.rejects(toolMap.get(name)!.handler({ account: "ro", ...args }, ctx), ReadOnlyError, name);
    assert.deepEqual(calls, [], `${name} reached the mail layer`);
  }
});

test("mutating tools run on a writable account", async () => {
  for (const [name, args] of Object.entries(MUTATING)) {
    calls.length = 0;
    await toolMap.get(name)!.handler({ account: "rw", ...args }, ctx);
    assert.ok(calls.length > 0, name);
  }
});

test("read tools work on a read-only account", async () => {
  for (const [name, args] of Object.entries(READ)) {
    calls.length = 0;
    await toolMap.get(name)!.handler({ account: "ro", ...args }, ctx);
    assert.ok(calls.length > 0, name);
  }
});

test("allowArchive lets archive_message through on a read-only account, and nothing else", async () => {
  calls.length = 0;
  await toolMap.get("archive_message")!.handler({ account: "roa", uids: [1] }, ctx);
  assert.deepEqual(calls, ["archiveMessages"]);
  for (const [name, args] of Object.entries(MUTATING)) {
    if (name === "archive_message") continue;
    calls.length = 0;
    await assert.rejects(toolMap.get(name)!.handler({ account: "roa", ...args }, ctx), ReadOnlyError, name);
    assert.deepEqual(calls, [], `${name} reached the mail layer`);
  }
  await assert.rejects(toolMap.get("get_message")!.handler({ account: "roa", uid: 1, markSeen: true }, ctx), ReadOnlyError);
});

test("get_message with markSeen is a write and is refused on read-only", async () => {
  await assert.rejects(toolMap.get("get_message")!.handler({ account: "ro", uid: 1, markSeen: true }, ctx), ReadOnlyError);
  await toolMap.get("get_message")!.handler({ account: "rw", uid: 1, markSeen: true }, ctx);
});

test("list_accounts is scoped to the caller and exposes readOnly", async () => {
  const mine = (await toolMap.get("list_accounts")!.handler({}, ctx)) as any[];
  assert.deepEqual(mine.map((a) => [a.accountId, a.readOnly, a.allowArchive === true]), [["ro", true, false], ["rw", false, false], ["roa", true, true]]);
  assert.deepEqual(await toolMap.get("list_accounts")!.handler({}, { ...ctx, userId: "u2" }), []);
  await assert.rejects(toolMap.get("list_folders")!.handler({ account: "rw" }, { ...ctx, userId: "u2" }), /No mail account/);
});

test("calendar writes are refused on read-only calendars and ICS feeds, allowed otherwise", async () => {
  for (const [name, args] of Object.entries(CAL_MUTATING)) {
    for (const ref of ["locked", "feed"]) {
      calls.length = 0;
      await assert.rejects(toolMap.get(name)!.handler({ calendar: ref, ...args }, ctx), /read-only|ICS subscription/, `${name} on ${ref}`);
      assert.deepEqual(calls, []);
    }
    calls.length = 0;
    await toolMap.get(name)!.handler({ calendar: "open", ...args }, ctx);
    assert.ok(calls.length > 0, name);
  }
  for (const [name, args] of Object.entries(CAL_READ)) {
    for (const ref of ["locked", "feed", "open"]) {
      calls.length = 0;
      await toolMap.get(name)!.handler({ calendar: ref, ...args }, ctx);
      assert.ok(calls.length > 0, `${name} on ${ref}`);
    }
  }
});

test("delete_event needs confirm=true; calendars are owner-scoped", async () => {
  await assert.rejects(toolMap.get("delete_event")!.handler({ calendar: "open", uid: "u", confirm: false }, ctx), /confirm/);
  await assert.rejects(toolMap.get("list_events")!.handler({ calendar: "open" }, { ...ctx, userId: "u2" }), /No calendar/);
  const mine = (await toolMap.get("list_calendars")!.handler({}, ctx)) as any[];
  assert.deepEqual(mine.map((c) => [c.calendarId, c.readOnly]), [["open", false], ["locked", true], ["feed", true]]);
});

test("tools/list annotations mark read-only and destructive tools", () => {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.delete_folder.destructive, true);
  assert.equal(byName.flag_message.destructive, true);
  assert.equal(byName.delete_event.destructive, true);
  assert.notEqual(byName.search_messages.destructive, true);
});

test("search_messages searches headers by default and goes deep only when asked", async () => {
  searchArgs.length = 0;
  await toolMap.get("search_messages")!.handler({ account: "rw", query: "invoice" }, ctx);
  await toolMap.get("search_messages")!.handler({ account: "rw", query: "invoice", scope: "body" }, ctx);
  await toolMap.get("search_messages")!.handler({ account: "rw", query: "invoice", scope: "nonsense" }, ctx);
  assert.deepEqual(searchArgs.map((a) => a.scope), ["headers", "body", "headers"]);
});

test("messages carry a deep link into the web app when the caller's origin is known", async () => {
  const withOrigin = { ...ctx, origin: "https://office.test" };
  const rows = (await toolMap.get("search_messages")!.handler({ account: "rw", folder: "Archive/2026" }, withOrigin)) as any[];
  assert.equal(rows[0].link, "https://office.test/mail/rw/Archive%2F2026/9");
  const one = (await toolMap.get("get_message")!.handler({ account: "ro", uid: 4 }, withOrigin)) as any;
  assert.equal(one.link, "https://office.test/mail/ro/INBOX/4");
  assert.equal(one.text, "t");
  const bare = (await toolMap.get("search_messages")!.handler({ account: "rw" }, ctx)) as any[];
  assert.equal(bare[0].link, undefined);
});

test("search results and get_message carry the logged reply, and only on the answered mail", async () => {
  const rows = (await toolMap.get("search_messages")!.handler({ account: "rw" }, ctx)) as any[];
  assert.equal(rows.find((r) => r.uid === 9).reply.repliedAt, "2026-09-24T10:00:00.000Z");
  assert.equal(rows.find((r) => r.uid === 8).reply, undefined);
  const one = (await toolMap.get("get_message")!.handler({ account: "rw", uid: 9 }, ctx)) as any;
  assert.equal(one.reply.via, "outbox");
  // Another user's view of the same ids finds nothing.
  await assert.rejects(toolMap.get("search_messages")!.handler({ account: "rw" }, { ...ctx, userId: "u2" }), /No mail account/);
});

test("search_messages hands flag and keyword filters through to the mail layer", async () => {
  searchArgs.length = 0;
  await toolMap.get("search_messages")!.handler({ account: "rw", answered: false, seen: true, flagged: true, forwarded: false, keyword: ["Work"], notKeyword: ["$Junk"], before: "2026-10-01" }, ctx);
  const a = searchArgs[0];
  assert.deepEqual([a.answered, a.seen, a.flagged, a.forwarded, a.keyword, a.notKeyword, a.before], [false, true, true, false, ["Work"], ["$Junk"], "2026-10-01"]);
});

test("list_replies answers per message: replied, not replied, or waiting in the Outbox", async () => {
  const res = (await toolMap.get("list_replies")!.handler({ account: "ro", messageIds: ["<answered@x>"] }, ctx)) as any;
  assert.equal(res.results[0].replied, false, "the log is per account");
  const rw = (await toolMap.get("list_replies")!.handler({ account: "rw", messageIds: ["answered@x", "<open@x>", "<queued@x>"] }, ctx)) as any;
  assert.deepEqual(rw.results.map((r: any) => [r.messageId, r.replied, r.awaitingApproval?.approvalId]), [
    ["<answered@x>", true, undefined],
    ["<open@x>", false, undefined],
    ["<queued@x>", false, "q1"],
  ]);
  assert.match(rw.note, /Answered/);
  await assert.rejects(toolMap.get("list_replies")!.handler({ messageIds: ["<a@x>"] }, ctx), /Pass `account`/);
});

test("list_replies without ids lists the log with account labels, and is scoped to the caller", async () => {
  const res = (await toolMap.get("list_replies")!.handler({}, ctx)) as any;
  assert.deepEqual(res.replies.map((r: any) => [r.account, r.inReplyTo]), [["Open", "<answered@x>"]]);
  assert.deepEqual(res.awaitingApproval.map((p: any) => p.inReplyTo), ["<queued@x>"]);
  const other = (await toolMap.get("list_replies")!.handler({}, { ...ctx, userId: "u2" })) as any;
  assert.deepEqual([other.replies, other.awaitingApproval], [[], []]);
  await assert.rejects(toolMap.get("list_replies")!.handler({ since: "soon" }, ctx), /not a date/);
});

test("a direct send logs the reply; a queued one carries inReplyTo to the Outbox", async () => {
  noted.length = 0; queued.length = 0;
  const direct = (await toolMap.get("send_message")!.handler({ account: "rw", to: "a@b.c", subject: "Re: s", text: "t", inReplyTo: "<answered@x>" }, ctx)) as any;
  assert.equal(direct.replyLogged, true);
  assert.deepEqual(noted.map((n) => [n.inReplyTo, n.via]), [["<answered@x>", "send_message"]]);
  await toolMap.get("send_draft")!.handler({ account: "rw", uid: 7 }, ctx);
  assert.deepEqual(noted.at(-1)!.inReplyTo, "<parent@x>");
  approval = true;
  try {
    await toolMap.get("send_message")!.handler({ account: "rw", to: "a@b.c", subject: "Re: s", text: "t", inReplyTo: "answered@x" }, ctx);
    await toolMap.get("send_draft")!.handler({ account: "rw", uid: 7 }, ctx);
    assert.deepEqual(queued.map((q) => q.inReplyTo), ["<answered@x>", "<parent@x>"]);
    assert.equal(noted.length, 2, "queued mail is not logged until it is approved");
  } finally {
    approval = false;
  }
});
