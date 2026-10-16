import "../test/env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

const users: Record<string, any> = { alice: { userId: "alice", status: "active" }, gone: { userId: "gone", status: "disabled" } };
const audits: any[] = [];
const calls: { fn: string; args: any[] }[] = [];
let underLimit = true;

class RateLimited extends Error {}
mock.module("../lib/cognito.js", {
  namedExports: {
    // "relay-<sub>" is a valid relay token; anything else (a web-client token included) is not.
    verifyRelayToken: async (t: string) => (t.startsWith("relay-") ? { sub: t.slice(6) } : undefined),
    relayConfig: () => ({ clientId: "relay-client", domain: "https://auth.test", redirectUri: "privateoffice-relay://callback" }),
  },
});
mock.module("../lib/users.js", { namedExports: { getUser: async (id: string) => users[id] } });
mock.module("../lib/ratelimit.js", {
  namedExports: { hit: async () => underLimit, LIMITS: { mcpAuthFailPerIp: { limit: 60, window: 900 } }, RateLimited },
});
mock.module("../lib/audit.js", { namedExports: { audit: async (e: any) => { audits.push(e); }, ANONYMOUS: "anonymous" } });
const rec = (fn: string, ret: (...a: any[]) => any) => async (...args: any[]) => { calls.push({ fn, args }); return ret(...args); };
mock.module("../lib/notestore.js", {
  namedExports: {
    MAX_TITLE_CHARS: 500,
    MAX_TEXT_CHARS: 100_000,
    upsertNotes: rec("upsertNotes", (_u, n) => n.length),
    pruneNotes: rec("pruneNotes", () => 2),
    countNotes: rec("countNotes", () => 7),
    touchRelay: rec("touchRelay", () => undefined),
    listNoteCreates: rec("listNoteCreates", () => [{ id: "notecreate#1", title: "Idea", body: "", createdAt: "2026-10-16T08:00:00Z" }]),
    ackNoteCreate: rec("ackNoteCreate", (_u, id) => id === "notecreate#1"),
    wipeNotes: rec("wipeNotes", () => 7),
  },
});

const { relay } = await import("./relay.js");
const { HttpError } = await import("./ctx.js");
// The same mapping src/handler.ts applies to /relay/*.
const app = new Hono().route("/", relay);
app.onError((err, c) => {
  if (err instanceof RateLimited) return c.json({ error: err.message }, 429);
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
  throw err;
});

const call = (method: string, path: string, opts: { token?: string; body?: unknown } = {}) =>
  app.request(path, {
    method,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

const pushBody = {
  device: "Alex's MacBook",
  notes: [{ noteId: "x-coredata://A/ICNote/p1", account: "iCloud", folder: "Notes", title: "Groceries", text: "Groceries\nmilk", modified: "2026-10-16T08:00:00Z" }],
};

function reset() {
  audits.length = 0;
  calls.length = 0;
  underLimit = true;
}

test("config is public and names the relay's own client", async () => {
  const res = await call("GET", "/relay/config");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).clientId, "relay-client");
});

test("every other route needs a relay token of an active user, and failures are audited", async () => {
  reset();
  for (const token of [undefined, "web-token", "relay-nobody", "relay-gone"]) {
    const res = await call("PUT", "/relay/notes", { token, body: pushBody });
    assert.equal(res.status, 401, String(token));
  }
  assert.equal(calls.length, 0, "nothing reached the store");
  assert.deepEqual(new Set(audits.map((a) => [a.action, a.outcome].join(":"))), new Set(["relay.auth:denied"]));
  underLimit = false;
  assert.equal((await call("GET", "/relay/notes/pending", { token: "web-token" })).status, 429);
});

test("a push is stored for the token's user, recorded on the relay and audited without content", async () => {
  reset();
  const res = await call("PUT", "/relay/notes", { token: "relay-alice", body: pushBody });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { stored: 1, total: 7 });
  assert.deepEqual(calls.map((c) => c.fn), ["upsertNotes", "countNotes", "touchRelay"]);
  assert.equal(calls[0].args[0], "alice");
  assert.deepEqual(calls[2].args, ["alice", "Alex's MacBook", 7]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "notes.sync");
  assert.doesNotMatch(JSON.stringify(audits), /Groceries|milk/);
});

test("pushes are schema-checked: shape, sizes, dates and batch length", async () => {
  reset();
  const bad = [
    { notes: pushBody.notes },
    { ...pushBody, notes: [{ ...pushBody.notes[0], modified: "yesterday" }] },
    { ...pushBody, notes: [{ ...pushBody.notes[0], title: "t".repeat(501) }] },
    { ...pushBody, notes: [{ ...pushBody.notes[0], noteId: "" }] },
    { ...pushBody, notes: Array.from({ length: 201 }, () => pushBody.notes[0]) },
  ];
  for (const body of bad) assert.equal((await call("PUT", "/relay/notes", { token: "relay-alice", body })).status, 400, JSON.stringify(body).slice(0, 80));
  const notJson = await app.request("/relay/notes", { method: "PUT", headers: { authorization: "Bearer relay-alice" }, body: "{" });
  assert.equal(notJson.status, 400);
  assert.equal(calls.filter((c) => c.fn === "upsertNotes").length, 0);
});

test("prune, pending, ack and disconnect act on the token's user only", async () => {
  reset();
  assert.deepEqual(await (await call("POST", "/relay/notes/prune", { token: "relay-alice", body: { device: "Mac", keep: ["a"] } })).json(), { removed: 2, total: 7 });
  const pending = await (await call("GET", "/relay/notes/pending", { token: "relay-alice" })).json();
  assert.deepEqual(pending.pending.map((p: any) => p.title), ["Idea"]);

  assert.equal((await call("POST", "/relay/notes/pending/notecreate%231/ack", { token: "relay-alice", body: { ok: true } })).status, 200);
  assert.equal((await call("POST", "/relay/notes/pending/notecreate%232/ack", { token: "relay-alice", body: { ok: true } })).status, 404);
  assert.equal((await call("POST", "/relay/notes/pending/notecreate%231/ack", { token: "relay-alice", body: { ok: "yes" } })).status, 400);
  assert.deepEqual(await (await call("DELETE", "/relay/notes", { token: "relay-alice" })).json(), { removed: 7 });

  for (const c of calls) if (c.fn !== "countNotes" || c.args.length) assert.equal(c.args[0], "alice", c.fn);
  assert.deepEqual(audits.map((a) => a.action), ["notes.prune", "notes.create.done", "notes.disconnect"]);
});
