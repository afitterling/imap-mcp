import "../test/env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

/* send_message / send_draft with approval ON, against the real auto-approve logic over a fake table. */
const accounts: Record<string, any> = {
  biz: { accountId: "biz", ownerId: "u1", label: "PrivateBiz", email: "me@biz.io", imap: {}, smtp: {}, readOnly: false },
  home: { accountId: "home", ownerId: "u1", label: "Home", email: "me@home.io", imap: {}, smtp: {}, readOnly: false },
};
let list: any[] = [];
let draft: any = {};
const calls: string[] = [];
const audits: any[] = [];

mock.module("../lib/db.js", {
  namedExports: {
    epoch: () => Math.floor(Date.now() / 1000),
    doc: { send: async (cmd: any) => (cmd.input?.Key?.id === "config#autoapprove#u1" ? { Item: { entries: list } } : {}) },
  },
});
mock.module("../lib/store.js", {
  namedExports: {
    listAccounts: async () => Object.values(accounts),
    resolveAccount: async (ref: string) => accounts[ref],
    redact: (a: any) => a,
  },
});
mock.module("../lib/mail.js", {
  namedExports: {
    createDraft: async () => { calls.push("createDraft"); return { folder: "Drafts", uid: 5 }; },
    sendMessage: async () => { calls.push("sendMessage"); return { sent: true }; },
    sendParkedMessage: async () => { calls.push("sendParkedMessage"); return { filedIn: "Sent" }; },
    getMessage: async () => draft,
    draftsFolder: async () => "Drafts",
    MAX_TOTAL_ATTACHMENT_BYTES: 1024,
    firstMessageId: (v?: string) => v,
  },
});
const noted: any[] = [];
mock.module("../lib/replies.js", {
  namedExports: {
    REPLY_RETENTION_DAYS: 365,
    getReplies: async () => new Map(),
    listReplies: async () => [],
    noteReply: async (_a: any, _u: string, sent: any) => { noted.push(sent); return { recorded: !!sent.inReplyTo }; },
  },
});
mock.module("../lib/settings.js", { namedExports: { requireApproval: async () => true } });
mock.module("../lib/outbox.js", { namedExports: { queueSend: async () => { calls.push("queueSend"); return { id: "p" }; }, listPending: async () => [] } });
mock.module("../lib/audit.js", { namedExports: { audit: async (e: any) => { audits.push(e); } } });
mock.module("../lib/guardrails.js", { namedExports: { listGuardrails: async () => [] } });

const { tools, toolMap } = await import("./tools.js");
const ctx = { userId: "u1", auth: "oauth" as const, tokenId: "t" };
const send = (args: any) => toolMap.get("send_message")!.handler({ account: "biz", subject: "Hi", text: "t", ...args }, ctx);
const reset = () => { calls.length = 0; audits.length = 0; noted.length = 0; };

test("all recipients approved for the account: sent at once and audited", async () => {
  list = [{ id: "1", address: "approved.person@example.com", accountId: "biz", createdAt: "" }];
  reset();
  const r: any = await send({ to: "Approved <Approved.Person@example.com>" });
  assert.deepEqual(calls, ["sendMessage"]);
  assert.equal(r.sent, true);
  assert.equal(r.autoApproved, true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "outbox.auto-release");
  assert.equal(audits[0].userId, "u1");
  assert.equal(audits[0].details.tool, "send_message");
});

test("one recipient not on the list (to, cc or bcc): queued as before", async () => {
  list = [{ id: "1", address: "friend@x.io", createdAt: "" }];
  for (const extra of [{ to: "friend@x.io, stranger@x.io" }, { to: "friend@x.io", cc: "stranger@x.io" }, { to: "friend@x.io", bcc: "stranger@x.io" }]) {
    reset();
    const r: any = await send(extra);
    assert.deepEqual(calls, ["createDraft", "queueSend"], JSON.stringify(extra));
    assert.equal(r.sent, false);
    assert.equal(audits.length, 0);
  }
});

test("an entry scoped to another account does not apply", async () => {
  list = [{ id: "1", address: "friend@x.io", accountId: "home", createdAt: "" }];
  reset();
  await send({ to: "friend@x.io" });
  assert.deepEqual(calls, ["createDraft", "queueSend"]);
});

test("empty list keeps every mail in the Outbox", async () => {
  list = [];
  reset();
  await send({ to: "friend@x.io" });
  assert.deepEqual(calls, ["createDraft", "queueSend"]);
});

test("send_draft follows the same rule, using the draft's own recipients", async () => {
  list = [{ id: "1", address: "friend@x.io", createdAt: "" }];
  draft = { to: "friend@x.io", subject: "s", text: "t", attachments: [] };
  reset();
  const r: any = await toolMap.get("send_draft")!.handler({ account: "biz", uid: 7 }, ctx);
  assert.deepEqual(calls, ["sendParkedMessage"]);
  assert.equal(r.autoApproved, true);
  assert.equal(audits[0].details.tool, "send_draft");

  draft = { to: "friend@x.io", cc: "stranger@x.io", subject: "s", text: "t", attachments: [] };
  reset();
  await toolMap.get("send_draft")!.handler({ account: "biz", uid: 7 }, ctx);
  assert.deepEqual(calls, ["queueSend"]);
});

test("an auto-sent reply is logged like any other sent reply; a queued one is not", async () => {
  list = [{ id: "1", address: "friend@x.io", createdAt: "" }];
  reset();
  const r: any = await send({ to: "friend@x.io", inReplyTo: "<parent@x>" });
  assert.equal(r.autoApproved, true);
  assert.equal(r.replyLogged, true);
  assert.deepEqual(noted.map((n) => [n.inReplyTo, n.via]), [["<parent@x>", "send_message"]]);

  draft = { to: "friend@x.io", subject: "Re: s", text: "t", attachments: [], inReplyTo: "<draft-parent@x>" };
  reset();
  const d: any = await toolMap.get("send_draft")!.handler({ account: "biz", uid: 7 }, ctx);
  assert.equal(d.replyLogged, true);
  assert.deepEqual(noted.map((n) => [n.inReplyTo, n.via]), [["<draft-parent@x>", "send_draft"]]);

  reset();
  await send({ to: "stranger@x.io", inReplyTo: "<parent@x>" });
  assert.deepEqual(calls, ["createDraft", "queueSend"]);
  assert.equal(noted.length, 0);
});

test("no MCP tool can read or change the auto-approved list", () => {
  for (const t of tools) assert.doesNotMatch(t.name, /approv|allow|trust|recipient/i, t.name);
});
