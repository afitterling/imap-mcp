import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyText, messagePage } from "./message.js";

const user = { name: "Alex", email: "a@x.y" };
const account = { label: "Work", email: "a@x.y" };

test("bodyText prefers the text part and falls back to de-tagged HTML", () => {
  assert.equal(bodyText({ text: "plain", html: "<b>rich</b>" }), "plain");
  assert.equal(bodyText({ html: "<p>Hello<br>there</p><script>alert(1)</script><p>&amp; bye</p>" }), "Hello\nthere\n\n& bye");
  assert.equal(bodyText({}), "");
});

test("the page escapes everything that came out of the mail", () => {
  const html = messagePage("n", user, { uid: 5, folder: "INBOX", subject: "<script>x</script>", from: "Eve <eve@x.y>", text: "<img src=x onerror=alert(1)>", attachments: [{ index: 0, filename: "<b>.pdf", contentType: "application/pdf", size: 2048 }] }, account);
  assert.ok(!html.includes("<script>x</script>"));
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(html.includes("Eve &lt;eve@x.y&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("&lt;b&gt;.pdf"));
  assert.ok(html.includes("2 KB"));
  assert.ok(html.includes("INBOX") && html.includes("uid 5"));
});

test("an Apple Mail link appears only when the message id is known", () => {
  const withId = messagePage("n", user, { uid: 1, folder: "INBOX", messageId: "<abc@x.y>" }, account);
  assert.ok(withId.includes('href="message://%3Cabc%40x.y%3E"'));
  assert.ok(!messagePage("n", user, { uid: 1, folder: "INBOX" }, account).includes("message://"));
});
