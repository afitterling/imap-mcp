import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed, normalizeEmail, ALLOWED_EMAILS } from "./allowlist.js";

test("allowlist has exactly two entries", () => {
  assert.equal(ALLOWED_EMAILS.length, 2);
  assert.ok(ALLOWED_EMAILS.includes("afitterling@icloud.com"));
});

test("allowlisted address passes regardless of case and whitespace", () => {
  assert.ok(isAllowed("afitterling@icloud.com"));
  assert.ok(isAllowed("  AFitterling@iCloud.com "));
});

test("anything else is refused", () => {
  assert.ok(!isAllowed("someone@icloud.com"));
  assert.ok(!isAllowed("fitterling@icloud.com.evil.com"));
  assert.ok(!isAllowed("xfitterling@icloud.com"));
  assert.ok(!isAllowed(""));
});

test("normalizeEmail lowercases and trims", () => {
  assert.equal(normalizeEmail("  A@B.C "), "a@b.c");
});
