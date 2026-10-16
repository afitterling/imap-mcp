import "../test/env.js";
// A deployed stage: CloudFront adds this secret to every request it forwards.
process.env.SST_RESOURCE_OriginVerify = JSON.stringify({ type: "sst.sst.Linkable", value: "edge-secret-0123456789" });

import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

const { security } = await import("./security.js");
const { origin } = await import("./ctx.js");

const app = new Hono<any>();
security(app);
app.get("/where", (c) => c.json({ origin: origin(c) }));
app.get("/cached", (c) => {
  c.header("cache-control", "public, max-age=60");
  return c.text("ok");
});

const LAMBDA = "https://abc.lambda-url.eu-central-1.on.aws";
const viaEdge = { "x-origin-verify": "edge-secret-0123456789", "x-forwarded-host": "d1234.cloudfront.net" };

test("requests without the edge secret are refused, so the Function URL cannot skip the WAF", async () => {
  assert.equal((await app.request(`${LAMBDA}/where`)).status, 404);
  assert.equal((await app.request(`${LAMBDA}/where`, { headers: { "x-origin-verify": "guess" } })).status, 404);
  assert.equal((await app.request(`${LAMBDA}/where`, { headers: { "x-origin-verify": "edge-secret-012345678" } })).status, 404, "a prefix is not the secret");
  assert.equal((await app.request(`${LAMBDA}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
});

test("through the edge the public origin is the CloudFront host, not the Lambda URL", async () => {
  const res = await app.request(`${LAMBDA}/where`, { headers: viaEdge });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { origin: "https://d1234.cloudfront.net" });
  const odd = await app.request(`${LAMBDA}/where`, { headers: { ...viaEdge, "x-forwarded-host": "evil.test/path" } });
  assert.deepEqual(await odd.json(), { origin: LAMBDA }, "a malformed forwarded host is ignored");
});

test("responses are no-store unless a route says otherwise", async () => {
  assert.equal((await app.request(`${LAMBDA}/where`, { headers: viaEdge })).headers.get("cache-control"), "no-store");
  assert.equal((await app.request(`${LAMBDA}/cached`, { headers: viaEdge })).headers.get("cache-control"), "public, max-age=60");
});

test("the CSRF check compares against the public origin", async () => {
  const post = (origin: string) =>
    app.request(`${LAMBDA}/where`, { method: "POST", headers: { ...viaEdge, origin, "content-type": "application/json" }, body: "{}" });
  assert.equal((await post("https://d1234.cloudfront.net")).status, 404, "same origin passes CSRF (then no POST route: 404)");
  assert.equal((await post("https://evil.test")).status, 403);
});
