import "../test/env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

// The deep-link page, with sign-in, account lookup, IMAP and the audit trail replaced.
let signed: any = undefined;
const audits: any[] = [];
mock.module("../lib/sessions.js", {
  namedExports: {
    getSigned: async () => signed,
    mfaPending: async () => undefined,
    readSession: async () => undefined, createSession: async () => ({}), destroySession: async () => {},
    clearMfaRequired: async () => {}, cognitoAccessToken: () => undefined,
  },
});
mock.module("../lib/store.js", {
  namedExports: {
    resolveAccount: async (ref: string, owner: string) => {
      if (ref === "acc1" && owner === "u1") return { accountId: "acc1", ownerId: "u1", label: "Work", email: "w@x.y" };
      throw new Error(`No mail account matches "${ref}"`);
    },
    claimOrphanAccounts: async () => 0,
  },
});
mock.module("../lib/mail.js", {
  namedExports: {
    getMessage: async (_a: any, folder: string, uid: number) => {
      if (uid === 404) throw new Error(`Message uid ${uid} not found in ${folder}`);
      return { uid, folder, subject: "Quarterly <numbers>", from: "Anna <anna@x.y>", to: "w@x.y", date: "2026-09-19T10:00:00Z", text: "Hello & goodbye", attachments: [] };
    },
  },
});
mock.module("../lib/audit.js", { namedExports: { audit: async (e: any) => { audits.push(e); }, ANONYMOUS: "anonymous" } });
mock.module("../lib/notify.js", { namedExports: { alertUser: async () => {}, alertEveryone: async () => {}, requestContext: () => ({}) } });

const { pages } = await import("./pages.js");
const app = new Hono<any>();
app.use("*", async (c, next) => { c.set("nonce", "n"); await next(); });
app.route("/", pages);
const get = (path: string) => app.request(new Request("https://office.test" + path));

test("signed out, the link sends the person through sign-in and back to the message", async () => {
  signed = undefined;
  const res = await get("/mail/acc1/INBOX/7");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login?next=%2Fmail%2Facc1%2FINBOX%2F7");
});

test("signed in, the owner sees the message as escaped text and the view is audited", async () => {
  signed = { user: { userId: "u1", name: "Alex", email: "a@x.y" } };
  audits.length = 0;
  const res = await get("/mail/acc1/Archive%2F2026/7");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Quarterly &lt;numbers&gt;"));
  assert.ok(html.includes("Hello &amp; goodbye"));
  assert.ok(html.includes("Archive/2026"));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "mail.view");
  assert.deepEqual([audits[0].userId, audits[0].details.folder, audits[0].details.uid], ["u1", "Archive/2026", 7]);
});

test("somebody else's account, a bad uid and a vanished message all end in not found", async () => {
  signed = { user: { userId: "u2", name: "Eve", email: "e@x.y" } };
  assert.equal((await get("/mail/acc1/INBOX/7")).status, 404);
  signed = { user: { userId: "u1", name: "Alex", email: "a@x.y" } };
  assert.equal((await get("/mail/acc1/INBOX/abc")).status, 404);
  assert.equal((await get("/mail/acc1/INBOX/0")).status, 404);
  const gone = await get("/mail/acc1/INBOX/404");
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /per folder/);
});
