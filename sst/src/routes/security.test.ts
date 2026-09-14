import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { security } from "./security.js";
import type { Env } from "./ctx.js";

function build() {
  const app = new Hono<Env>();
  security(app);
  app.post("/api/x", (c) => c.json({ ok: true }));
  app.post("/login", (c) => c.text("ok"));
  app.post("/mcp", (c) => c.text("ok"));
  app.post("/oauth/authorize", (c) => c.text("ok"));
  app.get("/", (c) => c.html(`<script nonce="${c.get("nonce")}">1</script>`));
  return app;
}
const ORIGIN = "https://example.test";
const req = (path: string, headers: Record<string, string> = {}, method = "POST") => new Request(ORIGIN + path, { method, headers });

test("same-origin form post passes; cross-site is refused", async () => {
  const app = build();
  assert.equal((await app.request(req("/login", { "sec-fetch-site": "same-origin" }))).status, 200);
  assert.equal((await app.request(req("/login", { "sec-fetch-site": "cross-site" }))).status, 403);
  assert.equal((await app.request(req("/login", { origin: "https://evil.test" }))).status, 403);
  assert.equal((await app.request(req("/login", { origin: ORIGIN }))).status, 200);
  // Safari: same-origin per fetch metadata but "Origin: null"
  assert.equal((await app.request(req("/login", { "sec-fetch-site": "same-origin", origin: "null" }))).status, 200);
  assert.equal((await app.request(req("/login", { origin: "null" }))).status, 403);
});

test("JSON API additionally requires the custom header", async () => {
  const app = build();
  assert.equal((await app.request(req("/api/x", { "sec-fetch-site": "same-origin" }))).status, 403);
  assert.equal((await app.request(req("/api/x", { "sec-fetch-site": "same-origin", "x-requested-with": "fetch" }))).status, 200);
  assert.equal((await app.request(req("/api/x", { "sec-fetch-site": "cross-site", "x-requested-with": "fetch" }))).status, 403);
});

test("machine endpoints are exempt from the browser CSRF rules", async () => {
  const app = build();
  assert.equal((await app.request(req("/mcp", { origin: "https://claude.ai" }))).status, 200);
  assert.equal((await app.request(req("/oauth/authorize", { origin: "null", "sec-fetch-site": "cross-site" }))).status, 200);
});

test("security headers and a per-request nonce", async () => {
  const app = build();
  const a = await app.request(req("/", {}, "GET"));
  const b = await app.request(req("/", {}, "GET"));
  const csp = a.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]+'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!csp.includes("unsafe-inline"));
  const nonce = csp.match(/'nonce-([^']+)'/)![1];
  assert.ok((await a.text()).includes(`nonce="${nonce}"`));
  assert.notEqual(nonce, (b.headers.get("content-security-policy") ?? "").match(/'nonce-([^']+)'/)![1]);
  assert.equal(a.headers.get("x-frame-options"), "DENY");
  assert.match(a.headers.get("strict-transport-security") ?? "", /max-age=63072000/);
  assert.equal(a.headers.get("referrer-policy"), "no-referrer");
});
