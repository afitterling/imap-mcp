import "../test/env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

/** Just enough DynamoDB for notestore: the Notes table (owner + note id) and the OAuth key/value table. */
const notesTable = new Map<string, any>();
const kv = new Map<string, any>();
const nkey = (k: { ownerId: string; noteId: string }) => `${k.ownerId}\0${k.noteId}`;
let unprocessedOnce = false;
let now = 1_000;

function conditionFails(input: any, item: any): boolean {
  if (!input.ConditionExpression) return false;
  if (input.ConditionExpression === "attribute_exists(id)") return !item;
  if (input.ConditionExpression === "userId = :u") return !item || item.userId !== input.ExpressionAttributeValues[":u"];
  throw new Error("unexpected condition " + input.ConditionExpression);
}
const conditional = () => Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });

mock.module("./db.js", {
  namedExports: {
    epoch: () => now,
    doc: {
      send: async (cmd: any) => {
        const name = cmd.constructor.name;
        const i = cmd.input;
        if (name === "BatchWriteCommand") {
          let reqs = i.RequestItems.Notes as any[];
          // DynamoDB may hand part of a batch back; the store must retry it.
          if (unprocessedOnce && reqs.length > 1) {
            unprocessedOnce = false;
            const [first, ...rest] = reqs;
            reqs = [first];
            for (const r of reqs) apply(r);
            return { UnprocessedItems: { Notes: rest } };
          }
          for (const r of reqs) apply(r);
          return {};
        }
        if (i.TableName === "Notes") {
          if (name === "QueryCommand") return { Items: [...notesTable.values()].filter((r) => r.ownerId === i.ExpressionAttributeValues[":o"]) };
          if (name === "GetCommand") return { Item: notesTable.get(nkey(i.Key)) };
        }
        if (i.TableName === "OAuth") {
          if (name === "GetCommand") return { Item: kv.get(i.Key.id) };
          if (name === "PutCommand") { kv.set(i.Item.id, i.Item); return {}; }
          if (name === "QueryCommand") {
            const v = i.ExpressionAttributeValues;
            return { Items: [...kv.values()].filter((r) => r.userId === v[":u"] && String(r.id).startsWith(v[":p"])) };
          }
          if (name === "DeleteCommand") {
            if (conditionFails(i, kv.get(i.Key.id))) throw conditional();
            kv.delete(i.Key.id);
            return {};
          }
          if (name === "UpdateCommand") {
            const item = kv.get(i.Key.id);
            if (conditionFails(i, item)) throw conditional();
            const v = i.ExpressionAttributeValues;
            const next = { ...(item ?? { id: i.Key.id }) };
            if (i.UpdateExpression.startsWith("SET userId")) Object.assign(next, { userId: v[":u"], device: v[":d"], lastSyncAt: v[":t"], noteCount: v[":n"], readOnly: next.readOnly ?? v[":f"] });
            else if (i.UpdateExpression === "SET readOnly = :r") next.readOnly = v[":r"];
            else throw new Error("unexpected update " + i.UpdateExpression);
            kv.set(i.Key.id, next);
            return {};
          }
        }
        throw new Error(`unexpected ${name} on ${i.TableName}`);
      },
    },
  },
});
function apply(r: any) {
  if (r.PutRequest) notesTable.set(nkey(r.PutRequest.Item), r.PutRequest.Item);
  else notesTable.delete(nkey(r.DeleteRequest.Key));
}

const store = await import("./notestore.js");

const note = (id: string, title: string, text: string, modified: string, extra: Partial<Record<string, string>> = {}) => ({
  noteId: `x-coredata://ABC/ICNote/${id}`,
  account: "iCloud",
  folder: "Notes",
  title,
  text,
  modified,
  ...extra,
});

function reset() {
  notesTable.clear();
  kv.clear();
  now = 1_000;
}

test("notes are stored encrypted, listed newest first and filtered by title or text", async () => {
  reset();
  await store.upsertNotes("alice", [
    note("p1", "Groceries", "Groceries\nmilk, eggs", "2026-10-01T10:00:00Z"),
    note("p2", "Trip", "Trip\nPassport and tickets", "2026-10-15T10:00:00Z", { folder: "Travel" }),
  ], new Date("2026-10-16T00:00:00Z"));
  await store.upsertNotes("bob", [note("p9", "Bob's", "secret", "2026-10-16T10:00:00Z")]);

  const raw = notesTable.get(nkey({ ownerId: "alice", noteId: "x-coredata://ABC/ICNote/p1" }));
  assert.doesNotMatch(JSON.stringify(raw), /Groceries|milk/, "title and text are encrypted at rest");
  assert.equal(raw.expiresAt, Math.floor(Date.parse("2026-10-16T00:00:00Z") / 1000) + 90 * 86400);

  const all = await store.listIcloudNotes("alice");
  assert.deepEqual(all.map((n) => [n.title, n.folder, n.preview]), [["Trip", "Travel", "Passport and tickets"], ["Groceries", "Notes", "milk, eggs"]]);
  assert.deepEqual((await store.listIcloudNotes("alice", { query: "EGGS" })).map((n) => n.title), ["Groceries"]);
  assert.deepEqual((await store.listIcloudNotes("alice", { limit: 1 })).map((n) => n.title), ["Trip"]);

  const one = await store.getIcloudNote("alice", "x-coredata://ABC/ICNote/p2");
  assert.equal(one.text, "Trip\nPassport and tickets");
  await assert.rejects(store.getIcloudNote("alice", "x-coredata://ABC/ICNote/p9"), /No synced iCloud note/, "other users' notes are not reachable");
});

test("over-long notes are cut to the limits before they are stored", async () => {
  reset();
  await store.upsertNotes("alice", [note("p1", "t".repeat(600), "x".repeat(store.MAX_TEXT_CHARS + 50), "2026-10-01T10:00:00Z")]);
  const n = await store.getIcloudNote("alice", "x-coredata://ABC/ICNote/p1");
  assert.equal(n.title.length, store.MAX_TITLE_CHARS);
  assert.equal(n.text.length, store.MAX_TEXT_CHARS);
});

test("big pushes go in batches of 25, and what DynamoDB hands back is retried", async () => {
  reset();
  unprocessedOnce = true;
  const many = Array.from({ length: 60 }, (_, i) => note(`p${i}`, `n${i}`, "x", "2026-10-01T10:00:00Z"));
  assert.equal(await store.upsertNotes("alice", many), 60);
  assert.equal(await store.countNotes("alice"), 60);
});

test("prune deletes exactly the notes the Mac no longer sends", async () => {
  reset();
  await store.upsertNotes("alice", [note("p1", "a", "a", "2026-10-01T10:00:00Z"), note("p2", "b", "b", "2026-10-01T10:00:00Z"), note("p3", "c", "c", "2026-10-01T10:00:00Z")]);
  await store.upsertNotes("bob", [note("p1", "bob", "bob", "2026-10-01T10:00:00Z")]);
  assert.equal(await store.pruneNotes("alice", ["x-coredata://ABC/ICNote/p2"]), 2);
  assert.deepEqual((await store.listIcloudNotes("alice")).map((n) => n.title), ["b"]);
  assert.equal(await store.countNotes("bob"), 1, "pruning one user never touches another");
});

test("relay state: a sync keeps the user's read-only switch", async () => {
  reset();
  assert.equal(await store.getRelay("alice"), undefined);
  await assert.rejects(store.setRelayReadOnly("alice", true), /condition/, "no switch without a relay");
  await store.touchRelay("alice", "Alex's MacBook", 3, new Date("2026-10-16T08:00:00Z"));
  assert.deepEqual(await store.getRelay("alice"), { device: "Alex's MacBook", lastSyncAt: "2026-10-16T08:00:00.000Z", noteCount: 3, readOnly: false });
  await store.setRelayReadOnly("alice", true);
  await store.touchRelay("alice", "Alex's MacBook", 4);
  assert.equal((await store.getRelay("alice"))!.readOnly, true);
  assert.equal(kv.get("noterelay#alice").userId, "alice", "the row carries userId so re-keying moves it");
});

test("queued creates are encrypted, listed oldest first, expire, and only the owner can acknowledge them", async () => {
  reset();
  const a = await store.queueNoteCreate("alice", { title: "First", body: "- one" }, new Date("2026-10-16T08:00:00Z"));
  const b = await store.queueNoteCreate("alice", { title: "Second", folder: "Ideas" }, new Date("2026-10-16T09:00:00Z"));
  await store.queueNoteCreate("bob", { title: "Bob's" });
  assert.doesNotMatch(JSON.stringify(kv.get(a.id)), /First|one/);

  now = Math.floor(Date.parse("2026-10-16T10:00:00Z") / 1000);
  assert.deepEqual((await store.listNoteCreates("alice")).map((p) => [p.title, p.body, p.folder]), [["First", "- one", undefined], ["Second", "", "Ideas"]]);
  assert.equal(await store.ackNoteCreate("bob", a.id), false, "bob cannot acknowledge alice's note");
  assert.equal(await store.ackNoteCreate("alice", "noterelay#alice"), false, "only queued creates can be acknowledged");
  assert.equal(await store.ackNoteCreate("alice", a.id), true);
  assert.deepEqual((await store.listNoteCreates("alice")).map((p) => p.id), [b.id]);

  now += store.PENDING_DAYS * 86400 + 3600;
  assert.deepEqual(await store.listNoteCreates("alice"), [], "expired rows count as gone before TTL removes them");
});

test("wipeNotes removes the snapshot, the queue and the relay state of one user only", async () => {
  reset();
  await store.upsertNotes("alice", [note("p1", "a", "a", "2026-10-01T10:00:00Z")]);
  await store.upsertNotes("bob", [note("p1", "b", "b", "2026-10-01T10:00:00Z")]);
  await store.touchRelay("alice", "Mac", 1);
  await store.touchRelay("bob", "Mac", 1);
  await store.queueNoteCreate("alice", { title: "x" });
  assert.equal(await store.wipeNotes("alice"), 1);
  assert.equal(await store.countNotes("alice"), 0);
  assert.equal(await store.getRelay("alice"), undefined);
  assert.deepEqual(await store.listNoteCreates("alice"), []);
  assert.equal(await store.countNotes("bob"), 1);
  assert.ok(await store.getRelay("bob"));
});
