import "../test/env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// In-memory stand-in for the key/value table: just enough of Update, BatchGet, Query and Delete.
const rows = new Map<string, Record<string, any>>();
let now = 1_000_000;
let failWrites = false;
mock.module("./db.js", {
  namedExports: {
    epoch: () => now,
    doc: {
      send: async (cmd: any) => {
        const name = cmd.constructor.name;
        const i = cmd.input;
        if (name === "UpdateCommand") {
          if (failWrites) throw new Error("dynamo down");
          const v = i.ExpressionAttributeValues;
          const old = rows.get(i.Key.id);
          if (old && old.userId !== v[":u"]) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
          rows.set(i.Key.id, {
            ...old, id: i.Key.id, userId: v[":u"], accountId: v[":a"], messageId: v[":m"], repliedAt: v[":now"],
            firstRepliedAt: old?.firstRepliedAt ?? v[":now"], replyMessageId: v[":r"], subject: v[":s"], to: v[":to"], via: v[":v"],
            expiresAt: v[":x"], count: (old?.count ?? 0) + v[":one"],
          });
          return {};
        }
        if (name === "BatchGetCommand") {
          const [table, { Keys }] = Object.entries(i.RequestItems)[0] as [string, any];
          return { Responses: { [table]: Keys.map((k: any) => rows.get(k.id)).filter(Boolean) } };
        }
        if (name === "QueryCommand") {
          const v = i.ExpressionAttributeValues;
          return { Items: [...rows.values()].filter((r) => r.userId === v[":u"] && r.id.startsWith(v[":p"])) };
        }
        if (name === "DeleteCommand") {
          rows.delete(i.Key.id);
          return {};
        }
        throw new Error("unexpected " + name);
      },
    },
  },
});
const marked: string[] = [];
mock.module("./mail.js", {
  namedExports: {
    firstMessageId: (v?: string) => (v ? (v.match(/<[^<>\s]+>/)?.[0] ?? `<${v.trim()}>`) : undefined),
    markAnswered: async (_a: any, id: string) => { marked.push(id); return { folder: "INBOX", uids: [1] }; },
  },
});
const audited: any[] = [];
mock.module("./audit.js", { namedExports: { audit: async (e: any) => { audited.push(e); } } });

const { recordReply, getReplies, listReplies, forgetAccountReplies, noteReply, REPLY_RETENTION_DAYS } = await import("./replies.js");
const acct = { accountId: "acc1", label: "Work" } as any;

test("recording twice keeps the first time, counts, and refreshes the TTL", async () => {
  rows.clear();
  await recordReply("alice", { accountId: "acc1", messageId: "<m1@x>", to: "bob@x", subject: "Re: hi", via: "outbox" });
  await recordReply("alice", { accountId: "acc1", messageId: "<m1@x>", to: "bob@x", subject: "Re: hi", via: "send_message" });
  const row = rows.get("reply#acc1#<m1@x>")!;
  assert.equal(row.count, 2);
  assert.equal(row.via, "send_message");
  assert.equal(row.expiresAt, now + REPLY_RETENTION_DAYS * 86400);
  await assert.rejects(recordReply("mallory", { accountId: "acc1", messageId: "<m1@x>", via: "outbox" }), /conditional/);
});

test("getReplies normalises ids and never returns another user's or expired rows", async () => {
  rows.clear();
  await recordReply("alice", { accountId: "acc1", messageId: "<m1@x>", via: "outbox" });
  await recordReply("alice", { accountId: "acc1", messageId: "<old@x>", via: "outbox" });
  rows.get("reply#acc1#<old@x>")!.expiresAt = now - 1;
  rows.set("reply#acc1#<bob@x>", { id: "reply#acc1#<bob@x>", userId: "bob", messageId: "<bob@x>", expiresAt: now + 10 });
  const found = await getReplies("alice", "acc1", ["m1@x", "<m1@x>", "<old@x>", "<bob@x>", undefined, "<none@x>"]);
  assert.deepEqual([...found.keys()], ["<m1@x>"]);
  const r = found.get("<m1@x>")!;
  assert.ok(!("userId" in r) && !("id" in r) && !("expiresAt" in r));
});

test("listReplies is newest first, per account on request, and honours since/limit", async () => {
  rows.clear();
  await recordReply("alice", { accountId: "acc1", messageId: "<a@x>", via: "outbox" });
  await recordReply("alice", { accountId: "acc2", messageId: "<b@x>", via: "outbox" });
  rows.get("reply#acc1#<a@x>")!.repliedAt = "2026-09-01T00:00:00.000Z";
  rows.get("reply#acc2#<b@x>")!.repliedAt = "2026-09-20T00:00:00.000Z";
  assert.deepEqual((await listReplies("alice")).map((r) => r.messageId), ["<b@x>", "<a@x>"]);
  assert.deepEqual((await listReplies("alice", { accountId: "acc1" })).map((r) => r.messageId), ["<a@x>"]);
  assert.deepEqual((await listReplies("alice", { since: "2026-09-10" })).map((r) => r.messageId), ["<b@x>"]);
  assert.equal((await listReplies("alice", { limit: 1 })).length, 1);
  assert.deepEqual(await listReplies("bob"), []);
});

test("deleting an account forgets only that account's replies", async () => {
  rows.clear();
  await recordReply("alice", { accountId: "acc1", messageId: "<a@x>", via: "outbox" });
  await recordReply("alice", { accountId: "acc2", messageId: "<b@x>", via: "outbox" });
  assert.equal(await forgetAccountReplies("alice", "acc1"), 1);
  assert.deepEqual([...rows.keys()], ["reply#acc2#<b@x>"]);
});

test("noteReply logs the reply, marks the original answered, and audits without recipients", async () => {
  rows.clear(); marked.length = 0; audited.length = 0;
  assert.deepEqual(await noteReply(acct, "alice", { via: "send_message" }), { recorded: false });
  assert.equal(rows.size, 0);
  const res = await noteReply(acct, "alice", { inReplyTo: "<orig@x> <older@x>", to: "bob@x", subject: "Re", via: "outbox" });
  assert.deepEqual(res, { recorded: true, markedAnswered: "INBOX" });
  assert.deepEqual(marked, ["<orig@x>"]);
  assert.ok(rows.has("reply#acc1#<orig@x>"));
  assert.equal(audited[0].action, "mail.reply.record");
  assert.ok(!JSON.stringify(audited[0]).includes("bob@x"));
});

test("a failing log write never fails the send that already happened", async () => {
  rows.clear(); failWrites = true;
  try {
    const res = await noteReply(acct, "alice", { inReplyTo: "<orig@x>", via: "outbox" });
    assert.equal(res.recorded, false);
    assert.equal(audited.at(-1).outcome, "failure");
  } finally {
    failWrites = false;
  }
});
