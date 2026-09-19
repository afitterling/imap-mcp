import "../test/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchCriteria } from "./mail.js";

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
  const c = searchCriteria({ query: "q", from: "anna@x.y", unseen: true, since: "2026-09-01" });
  assert.deepEqual(c.or, [{ subject: "q" }, { from: "q" }, { to: "q" }]);
  assert.equal(c.from, "anna@x.y");
  assert.equal(c.seen, false);
  assert.equal((c.since as Date).toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(c.all, undefined);
});
