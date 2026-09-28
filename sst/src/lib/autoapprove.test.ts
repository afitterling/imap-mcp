import "../test/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRecipients, allCovered, validateAddress, type AutoApproved } from "./autoapprove.js";

const entry = (address: string, accountId?: string): AutoApproved => ({ id: address, address, accountId, createdAt: "" });

test("parseRecipients handles display names, quoted commas and case", () => {
  assert.deepEqual(parseRecipients('Ann <Ann@X.io>, b@y.io', '"Doe, John" <j@z.io>', undefined, " "), ["ann@x.io", "b@y.io", "j@z.io"]);
  assert.deepEqual(parseRecipients("a@x.io; b@x.io"), ["a@x.io", "b@x.io"]);
});

test("parseRecipients rejects anything that is not a clean address", () => {
  assert.equal(parseRecipients("a@x.io, not-an-address"), undefined);
  assert.equal(parseRecipients("undisclosed-recipients:;"), undefined);
  assert.equal(parseRecipients("Ann <a@x.io"), undefined);
});

test("allCovered needs every recipient on the list for that account", () => {
  const list = [entry("friend@x.io", "biz"), entry("any@x.io")];
  assert.ok(allCovered(list, "biz", ["friend@x.io"]));
  assert.ok(allCovered(list, "biz", ["friend@x.io", "any@x.io"]));
  assert.ok(allCovered(list, "home", ["any@x.io"]));
  assert.equal(allCovered(list, "home", ["friend@x.io"]), false, "scoped to another account");
  assert.equal(allCovered(list, "biz", ["friend@x.io", "stranger@x.io"]), false, "one unknown recipient");
  assert.equal(allCovered(list, "biz", []), false, "no recipients");
  assert.equal(allCovered(list, "biz", undefined), false, "unparseable recipients");
});

test("validateAddress normalises and refuses lists or display names", () => {
  assert.equal(validateAddress("  Tek@Gmail.com "), "tek@gmail.com");
  assert.throws(() => validateAddress("a@x.io, b@x.io"), /single/);
  assert.throws(() => validateAddress("Ann <a@x.io>"), /single/);
  assert.throws(() => validateAddress(""), /single/);
});
