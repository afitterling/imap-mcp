import "../test/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { origin, fromEdge } from "./ctx.js";

// No OriginVerify linked (unit tests, or a stage without an edge): nothing can vouch for a request.
const app = new Hono();
app.get("/where", (c) => c.json({ origin: origin(c), fromEdge: fromEdge(c) }));

test("without an edge secret, forwarded hosts are never trusted", async () => {
  const res = await app.request("https://abc.lambda-url.eu-central-1.on.aws/where", {
    headers: { "x-forwarded-host": "evil.test", "x-origin-verify": "anything" },
  });
  assert.deepEqual(await res.json(), { origin: "https://abc.lambda-url.eu-central-1.on.aws", fromEdge: false });
});
