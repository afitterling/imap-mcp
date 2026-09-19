import { test } from "node:test";
import assert from "node:assert/strict";
import { messageLink, withLink } from "./links.js";

test("a message link carries account id, folder and uid, each URL-safe", () => {
  assert.equal(messageLink("https://x.test", "acc1", "INBOX", 42), "https://x.test/mail/acc1/INBOX/42");
  assert.equal(messageLink("https://x.test/", "acc1", "[Gmail]/All Mail", 7), "https://x.test/mail/acc1/%5BGmail%5D%2FAll%20Mail/7");
  assert.equal(messageLink("https://x.test", "a/b", "Archive/2026", 1), "https://x.test/mail/a%2Fb/Archive%2F2026/1");
});

test("withLink adds the link only when the origin is known", () => {
  const row = { uid: 3, folder: "Sent", subject: "hi" };
  assert.deepEqual(withLink(undefined, "acc", row), row);
  assert.equal(withLink("https://x.test", "acc", row).link, "https://x.test/mail/acc/Sent/3");
  assert.equal(withLink("https://x.test", "acc", row).subject, "hi");
});
