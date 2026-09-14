import "../test/env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// A tiny in-memory stand-in for the two DynamoDB operations the store uses on reads.
const items: Record<string, any> = {
  a1: { accountId: "a1", ownerId: "alice", label: "Work", email: "alice@work.example", imap: {}, smtp: {}, readOnly: false },
  a2: { accountId: "a2", ownerId: "alice", label: "Private", email: "alice@home.example", imap: {}, smtp: {}, readOnly: true },
  b1: { accountId: "b1", ownerId: "bob", label: "Work", email: "bob@work.example", imap: {}, smtp: {}, readOnly: false },
};
mock.module("./db.js", {
  namedExports: {
    epoch: () => 0,
    doc: {
      send: async (cmd: any) => {
        const name = cmd.constructor.name;
        if (name === "GetCommand") return { Item: items[cmd.input.Key.accountId] };
        if (name === "QueryCommand") {
          const owner = cmd.input.ExpressionAttributeValues[":o"];
          return { Items: Object.values(items).filter((i) => i.ownerId === owner) };
        }
        throw new Error("unexpected " + name);
      },
    },
  },
});
const { resolveAccount, listAccounts, getAccount, redact } = await import("./store.js");

test("listAccounts only returns the owner's accounts", async () => {
  assert.deepEqual((await listAccounts("alice")).map((a) => a.accountId), ["a2", "a1"]);
  assert.deepEqual((await listAccounts("bob")).map((a) => a.accountId), ["b1"]);
  assert.deepEqual(await listAccounts("nobody"), []);
});

test("getAccount refuses another owner's id", async () => {
  assert.equal((await getAccount("a1", "alice"))?.label, "Work");
  assert.equal(await getAccount("a1", "bob"), undefined);
});

test("resolveAccount never crosses owners, by id, label or email", async () => {
  assert.equal((await resolveAccount("a1", "alice")).accountId, "a1");
  assert.equal((await resolveAccount("work", "bob")).accountId, "b1");
  assert.equal((await resolveAccount("bob@work.example", "bob")).accountId, "b1");
  await assert.rejects(resolveAccount("b1", "alice"), /No mail account matches/);
  await assert.rejects(resolveAccount("bob@work.example", "alice"), /No mail account matches/);
  assert.equal((await resolveAccount("priv", "alice")).accountId, "a2");
});

test("redact strips secrets and the owner", () => {
  const pub = redact({ ...items.a1, imapPass: "enc", smtpPass: "enc" });
  assert.ok(!("imapPass" in pub) && !("smtpPass" in pub) && !("ownerId" in pub));
  assert.equal(pub.readOnly, false);
});
