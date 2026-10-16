import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { randomUUID } from "node:crypto";
import { doc, epoch } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";

/**
 * iCloud notes, as last pushed by the user's Mac relay (mac/NotesRelay). Apple offers no
 * server API for iCloud notes, so this table is a snapshot of the folders the user chose to
 * share, never the source of truth. Title and text are AES-256-GCM encrypted like mail
 * credentials. A note the Mac has not re-sent for SNAPSHOT_DAYS expires on its own.
 *
 * Relay state and queued creates live in the OAuth key/value table, carrying `userId` so
 * a user's rows are listed, re-keyed and wiped together with the rest.
 */
const TABLE = () => Resource.Notes.name;
const KV = () => Resource.OAuth.name;

export const SNAPSHOT_DAYS = 90;
export const PENDING_DAYS = 14;
export const MAX_TITLE_CHARS = 500;
export const MAX_TEXT_CHARS = 100_000;
const PREVIEW_CHARS = 200;

/** What the Mac sends for one note. */
export type IcloudNoteIn = {
  /** Notes.app's own id (x-coredata://…/ICNote/p123). */
  noteId: string;
  account: string;
  folder: string;
  title: string;
  text: string;
  created?: string;
  modified: string;
};

type Row = Omit<IcloudNoteIn, "title" | "text"> & { ownerId: string; title: string; text: string; syncedAt: string; expiresAt: number };

export type IcloudNote = IcloudNoteIn & { syncedAt: string };

function seal(ownerId: string, n: IcloudNoteIn, now: Date): Row {
  return {
    ownerId,
    noteId: n.noteId,
    account: n.account,
    folder: n.folder,
    title: encrypt(n.title.slice(0, MAX_TITLE_CHARS)),
    text: encrypt(n.text.slice(0, MAX_TEXT_CHARS)),
    created: n.created,
    modified: n.modified,
    syncedAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + SNAPSHOT_DAYS * 86400,
  };
}

function open(r: Row): IcloudNote {
  return { noteId: r.noteId, account: r.account, folder: r.folder, title: decrypt(r.title), text: decrypt(r.text), created: r.created, modified: r.modified, syncedAt: r.syncedAt };
}

async function rows(ownerId: string, projection?: string): Promise<Row[]> {
  const out: Row[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: "ownerId = :o",
        ExpressionAttributeValues: { ":o": ownerId },
        ProjectionExpression: projection,
        ExclusiveStartKey: start,
      }),
    );
    out.push(...((res.Items ?? []) as Row[]));
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

/** BatchWrite in chunks of 25, retrying what DynamoDB hands back unprocessed. */
async function batch(requests: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    let pending: Record<string, unknown>[] | undefined = requests.slice(i, i + 25);
    for (let attempt = 0; pending?.length && attempt < 5; attempt++) {
      const res = await doc.send(new BatchWriteCommand({ RequestItems: { [TABLE()]: pending as any } }));
      pending = res.UnprocessedItems?.[TABLE()] as Record<string, unknown>[] | undefined;
    }
    if (pending?.length) throw new Error("DynamoDB kept refusing part of the notes batch.");
  }
}

export async function upsertNotes(ownerId: string, notes: IcloudNoteIn[], now = new Date()): Promise<number> {
  await batch(notes.map((n) => ({ PutRequest: { Item: seal(ownerId, n, now) } })));
  return notes.length;
}

/** Deletes every note the Mac no longer has (or no longer shares). Returns how many went. */
export async function pruneNotes(ownerId: string, keep: string[]): Promise<number> {
  const kept = new Set(keep);
  const gone = (await rows(ownerId, "noteId")).filter((r) => !kept.has(r.noteId));
  await batch(gone.map((r) => ({ DeleteRequest: { Key: { ownerId, noteId: r.noteId } } })));
  return gone.length;
}

export async function countNotes(ownerId: string): Promise<number> {
  return (await rows(ownerId, "noteId")).length;
}

/** Newest first. `query` matches title or text, case-insensitively. */
export async function listIcloudNotes(ownerId: string, args: { query?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const q = args.query?.trim().toLowerCase();
  const all = (await rows(ownerId)).map(open);
  return all
    .filter((n) => !q || n.title.toLowerCase().includes(q) || n.text.toLowerCase().includes(q))
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, limit)
    .map((n) => {
      const body = n.text.startsWith(n.title) ? n.text.slice(n.title.length).trim() : n.text;
      return { noteId: n.noteId, account: n.account, folder: n.folder, title: n.title, created: n.created, modified: n.modified, preview: body.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS) };
    });
}

export async function getIcloudNote(ownerId: string, noteId: string): Promise<IcloudNote> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { ownerId, noteId } }));
  if (!res.Item) throw new Error(`No synced iCloud note with id "${noteId}". Call list_notes for current ids.`);
  return open(res.Item as Row);
}

/* ------------------------------- relay state ------------------------------- */

export type RelayState = {
  device: string;
  lastSyncAt: string;
  noteCount: number;
  /** Claude may read the synced notes but not queue new ones. */
  readOnly: boolean;
};

const relayId = (userId: string) => `noterelay#${userId}`;

export async function getRelay(userId: string): Promise<RelayState | undefined> {
  const res = await doc.send(new GetCommand({ TableName: KV(), Key: { id: relayId(userId) } }));
  if (!res.Item) return undefined;
  const { device, lastSyncAt, noteCount, readOnly } = res.Item as RelayState;
  return { device, lastSyncAt, noteCount, readOnly: readOnly === true };
}

/** Record a sync. Keeps the read-only switch the user set in the web app. */
export async function touchRelay(userId: string, device: string, noteCount: number, now = new Date()): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: KV(),
      Key: { id: relayId(userId) },
      UpdateExpression: "SET userId = :u, device = :d, lastSyncAt = :t, noteCount = :n, readOnly = if_not_exists(readOnly, :f)",
      ExpressionAttributeValues: { ":u": userId, ":d": device.slice(0, 100), ":t": now.toISOString(), ":n": noteCount, ":f": false },
    }),
  );
}

export async function setRelayReadOnly(userId: string, readOnly: boolean): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: KV(),
      Key: { id: relayId(userId) },
      UpdateExpression: "SET readOnly = :r",
      ConditionExpression: "attribute_exists(id)",
      ExpressionAttributeValues: { ":r": readOnly },
    }),
  );
}

/* ----------------------------- queued creates ----------------------------- */

const PENDING = "notecreate#";

export type PendingNote = { id: string; title: string; body: string; folder?: string; account?: string; createdAt: string };

/** Claude asked for a new iCloud note; the Mac carries it out the next time it syncs. */
export async function queueNoteCreate(userId: string, n: { title: string; body?: string; folder?: string; account?: string }, now = new Date()): Promise<PendingNote> {
  const item = {
    id: `${PENDING}${randomUUID()}`,
    userId,
    title: encrypt(n.title.slice(0, MAX_TITLE_CHARS)),
    body: encrypt((n.body ?? "").slice(0, MAX_TEXT_CHARS)),
    folder: n.folder,
    account: n.account,
    createdAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + PENDING_DAYS * 86400,
  };
  await doc.send(new PutCommand({ TableName: KV(), Item: item }));
  return { id: item.id, title: n.title, body: n.body ?? "", folder: n.folder, account: n.account, createdAt: item.createdAt };
}

async function pendingRows(userId: string, prefix = PENDING): Promise<Record<string, any>[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: KV(),
      IndexName: "byUser",
      KeyConditionExpression: "userId = :u AND begins_with(id, :p)",
      ExpressionAttributeValues: { ":u": userId, ":p": prefix },
    }),
  );
  // TTL deletion lags; an expired row is as good as gone.
  return (res.Items ?? []).filter((i) => !i.expiresAt || i.expiresAt > epoch());
}

export async function listNoteCreates(userId: string): Promise<PendingNote[]> {
  return (await pendingRows(userId))
    .map((i) => ({ id: i.id, title: decrypt(i.title), body: decrypt(i.body), folder: i.folder, account: i.account, createdAt: i.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The Mac created the note: drop the queued row. Only the owner's rows can be acknowledged. */
export async function ackNoteCreate(userId: string, id: string): Promise<boolean> {
  if (!id.startsWith(PENDING)) return false;
  try {
    await doc.send(
      new DeleteCommand({ TableName: KV(), Key: { id }, ConditionExpression: "userId = :u", ExpressionAttributeValues: { ":u": userId } }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/** Deletes the synced notes only. The Mac sends them again on its next sync. */
export async function dropSnapshot(ownerId: string): Promise<number> {
  const notes = await rows(ownerId, "noteId");
  await batch(notes.map((r) => ({ DeleteRequest: { Key: { ownerId, noteId: r.noteId } } })));
  return notes.length;
}

/** Disconnect: every synced note, queued create and the relay state go. */
export async function wipeNotes(userId: string): Promise<number> {
  const count = await dropSnapshot(userId);
  const kv = [...(await pendingRows(userId)).map((i) => i.id as string), relayId(userId)];
  await Promise.all(kv.map((id) => doc.send(new DeleteCommand({ TableName: KV(), Key: { id } }))));
  return count;
}
