import "../test/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchCriteria, describeFlags, firstMessageId } from "./mail.js";

test("no filters means every message", () => {
  assert.deepEqual(searchCriteria({}), { all: true });
});

test("the default scope searches headers only: subject, sender, recipients", () => {
  assert.deepEqual(searchCriteria({ query: "invoice" }), { or: [{ subject: "invoice" }, { from: "invoice" }, { to: "invoice" }] });
  assert.deepEqual(searchCriteria({ query: "invoice", scope: "headers" }), searchCriteria({ query: "invoice" }));
});

test("the body scope is the deep search: headers plus the message text", () => {
  assert.deepEqual(searchCriteria({ query: "invoice", scope: "body" }), { or: [{ subject: "invoice" }, { from: "invoice" }, { to: "invoice" }, { body: "invoice" }] });
});

test("sender, unread and date filters combine with the query", () => {
  const c = searchCriteria({ query: "q", from: "anna@x.y", unseen: true, since: "2026-09-01" })!;
  assert.deepEqual(c.or, [{ subject: "q" }, { from: "q" }, { to: "q" }]);
  assert.equal(c.from, "anna@x.y");
  assert.equal(c.seen, false);
  assert.equal((c.since as Date).toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(c.all, undefined);
});

test("system flag filters: true requires the flag, false excludes it, omitted ignores it", () => {
  assert.deepEqual(searchCriteria({ answered: false, seen: true }), { seen: true, answered: false });
  assert.deepEqual(searchCriteria({ flagged: true, draft: false, deleted: true }), { flagged: true, draft: false, deleted: true });
  // An explicit `seen` wins over the legacy `unseen` shorthand.
  assert.deepEqual(searchCriteria({ unseen: true, seen: true }), { seen: true });
});

test("a system flag passed as a keyword becomes the matching filter; a contradiction matches nothing", () => {
  assert.deepEqual(searchCriteria({ keyword: ["\\answered"], notKeyword: "\\Seen" }), { seen: false, answered: true });
  assert.equal(searchCriteria({ answered: false, keyword: "\\Answered" }), null);
});

test("keywords: one goes in directly, further ones are ANDed through NOT/OR", () => {
  assert.deepEqual(searchCriteria({ forwarded: true }), { keyword: "$Forwarded" });
  assert.deepEqual(searchCriteria({ forwarded: false }), { unKeyword: "$Forwarded" });
  assert.deepEqual(searchCriteria({ keyword: ["Work", "$label1"] }), { keyword: "Work", not: { unKeyword: "$label1" } });
  assert.deepEqual(searchCriteria({ keyword: ["A", "B"], notKeyword: ["C"] }), { keyword: "A", not: { or: [{ unKeyword: "B" }, { keyword: "C" }] } });
});

test("a keyword the folder cannot hold: requiring it matches nothing, excluding it matches everything", () => {
  const usable = (k: string) => k !== "$Junk";
  assert.equal(searchCriteria({ keyword: "$Junk" }, usable), null);
  assert.deepEqual(searchCriteria({ notKeyword: "$Junk" }, usable), { all: true });
  assert.deepEqual(searchCriteria({ keyword: "Work", notKeyword: "$Junk" }, usable), { keyword: "Work" });
});

test("malformed keywords and dates are refused, not silently ignored", () => {
  assert.throws(() => searchCriteria({ keyword: "two words" }), /not a valid IMAP keyword/);
  assert.throws(() => searchCriteria({ keyword: "\\Recent" }), /not a valid IMAP keyword/);
  assert.throws(() => searchCriteria({ since: "yesterday-ish" }), /not a date/);
});

test("recipient, subject, before and size filters", () => {
  const c = searchCriteria({ to: "bob@x.y", subject: "Invoice", before: "2026-10-01", larger: 1000, smaller: 5000 })!;
  assert.equal(c.to, "bob@x.y");
  assert.equal(c.subject, "Invoice");
  assert.equal((c.before as Date).toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(c.larger, 1000);
  assert.equal(c.smaller, 5000);
});

test("describeFlags names the system flags and lists keywords", () => {
  assert.deepEqual(describeFlags(new Set(["\\Seen", "\\Answered", "$Forwarded", "Work"])), {
    seen: true, answered: true, flagged: false, draft: false, deleted: false, forwarded: true, keywords: ["$Forwarded", "Work"],
  });
  assert.deepEqual(describeFlags(undefined), { seen: false, answered: false, flagged: false, draft: false, deleted: false, forwarded: false });
});

test("firstMessageId normalises Message-ID and In-Reply-To values", () => {
  assert.equal(firstMessageId("<a@b.c>"), "<a@b.c>");
  assert.equal(firstMessageId("a@b.c"), "<a@b.c>");
  assert.equal(firstMessageId("  <a@b.c> <d@e.f>"), "<a@b.c>");
  assert.equal(firstMessageId(""), undefined);
  assert.equal(firstMessageId(undefined), undefined);
});
