import { BatchGetCommand, DeleteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { doc, epoch } from "./db.js";
import { audit } from "./audit.js";
import { firstMessageId, markAnswered } from "./mail.js";
import type { Account } from "./store.js";

/**
 * The reply log: one row per message the user answered through this server, so "have I
 * replied to that?" is a key lookup instead of a trawl through the Sent folder. Rows live in
 * the per-user key/value table (they carry `userId`, so they follow a re-keyed user and are
 * listed with the rest of their data) and expire after a year.
 *
 * Replies written in the user's own mail client are not logged here; their clients set the
 * IMAP \Answered flag, which search_messages reports and filters on.
 */
const TABLE = () => Resource.OAuth.name;
export const REPLY_RETENTION_DAYS = 365;
const PREFIX = "reply#";

export type ReplyVia = "send_message" | "send_draft" | "outbox";

export type Reply = {
  accountId: string;
  /** Message-ID of the message that was answered, with angle brackets. */
  messageId: string;
  repliedAt: string;
  firstRepliedAt: string;
  count: number;
  replyMessageId?: string;
  subject?: string;
  to?: string;
  via: ReplyVia;
};

const key = (accountId: string, messageId: string) => `${PREFIX}${accountId}#${messageId}`;

function strip(item: Record<string, unknown>): Reply {
  const { id: _id, userId: _u, expiresAt: _e, ...rest } = item;
  return rest as Reply;
}

export async function recordReply(
  userId: string,
  r: { accountId: string; messageId: string; replyMessageId?: string; subject?: string; to?: string; via: ReplyVia },
): Promise<void> {
  const now = new Date().toISOString();
  await doc.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { id: key(r.accountId, r.messageId) },
      UpdateExpression:
        "SET userId = :u, accountId = :a, messageId = :m, repliedAt = :now, firstRepliedAt = if_not_exists(firstRepliedAt, :now), " +
        "replyMessageId = :r, subject = :s, #to = :to, via = :v, expiresAt = :x ADD #count :one",
      // A row is only ever touched by its owner.
      ConditionExpression: "attribute_not_exists(id) OR userId = :u",
      ExpressionAttributeNames: { "#to": "to", "#count": "count" },
      ExpressionAttributeValues: {
        ":u": userId,
        ":a": r.accountId,
        ":m": r.messageId,
        ":now": now,
        ":r": r.replyMessageId ?? null,
        ":s": r.subject?.slice(0, 300) ?? null,
        ":to": r.to?.slice(0, 500) ?? null,
        ":v": r.via,
        ":x": epoch() + REPLY_RETENTION_DAYS * 86400,
        ":one": 1,
      },
    }),
  );
}

/** Replies to the given messages of one account, keyed by the normalised Message-ID. */
export async function getReplies(userId: string, accountId: string, messageIds: (string | undefined)[]): Promise<Map<string, Reply>> {
  const ids = [...new Set(messageIds.map(firstMessageId).filter((x): x is string => !!x))];
  const out = new Map<string, Reply>();
  for (let i = 0; i < ids.length; i += 100) {
    let keys: Record<string, unknown>[] | undefined = ids.slice(i, i + 100).map((m) => ({ id: key(accountId, m) }));
    // BatchGet may hand back part of the batch as unprocessed; ask again for those.
    for (let attempt = 0; keys?.length && attempt < 3; attempt++) {
      const res = await doc.send(new BatchGetCommand({ RequestItems: { [TABLE()]: { Keys: keys } } }));
      for (const item of res.Responses?.[TABLE()] ?? []) {
        if (item.userId === userId && item.expiresAt > epoch()) out.set(String(item.messageId), strip(item));
      }
      keys = res.UnprocessedKeys?.[TABLE()]?.Keys as Record<string, unknown>[] | undefined;
    }
  }
  return out;
}

async function queryAll(userId: string, prefix: string, max = 5000): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE(),
        IndexName: "byUser",
        KeyConditionExpression: "userId = :u AND begins_with(id, :p)",
        ExpressionAttributeValues: { ":u": userId, ":p": prefix },
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start && items.length < max);
  return items;
}

/** Newest first. */
export async function listReplies(userId: string, q: { accountId?: string; since?: string; limit?: number } = {}): Promise<Reply[]> {
  const items = await queryAll(userId, q.accountId ? `${PREFIX}${q.accountId}#` : PREFIX);
  return items
    .filter((i) => i.expiresAt > epoch() && (!q.since || i.repliedAt >= q.since))
    .map(strip)
    .sort((a, b) => b.repliedAt.localeCompare(a.repliedAt))
    .slice(0, Math.min(q.limit ?? 50, 500));
}

/** Deleting a mail account takes its reply log with it. */
export async function forgetAccountReplies(userId: string, accountId: string): Promise<number> {
  const items = await queryAll(userId, `${PREFIX}${accountId}#`, Infinity);
  for (const item of items) await doc.send(new DeleteCommand({ TableName: TABLE(), Key: { id: item.id } }));
  return items.length;
}

/**
 * Called after a mail has actually gone out. If it answered another message, log the reply
 * and set \Answered on the original. Sending already succeeded, so nothing here may throw.
 */
export async function noteReply(
  acct: Account,
  userId: string,
  sent: { inReplyTo?: string; replyMessageId?: string; subject?: string; to?: string; via: ReplyVia },
): Promise<{ recorded: boolean; markedAnswered?: string }> {
  const original = firstMessageId(sent.inReplyTo);
  if (!original) return { recorded: false };
  let recorded = false;
  let markedAnswered: string | undefined;
  try {
    await recordReply(userId, { accountId: acct.accountId, messageId: original, replyMessageId: sent.replyMessageId, subject: sent.subject, to: sent.to, via: sent.via });
    recorded = true;
  } catch (err) {
    console.error("[replies] record failed:", err instanceof Error ? err.message : err);
  }
  try {
    markedAnswered = (await markAnswered(acct, original))?.folder;
  } catch (err) {
    console.error("[replies] \\Answered not set:", err instanceof Error ? err.message : err);
  }
  await audit({
    userId,
    kind: "mcp",
    action: "mail.reply.record",
    outcome: recorded ? "success" : "failure",
    target: acct.label,
    details: { via: sent.via, markedAnswered: markedAnswered ?? "not found" },
  });
  return { recorded, markedAnswered };
}
