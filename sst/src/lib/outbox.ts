import { GetCommand, PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { randomUUID } from "node:crypto";
import { doc, epoch } from "./db.js";

const TABLE = () => Resource.OAuth.name;

export type Pending = {
  id: string;
  userId: string;
  accountId: string;
  accountLabel: string;
  /** Where the composed message is parked until a human releases it. */
  folder: string;
  uid: number;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  preview: string;
  attachments: { filename: string; size: number }[];
  createdAt: string;
  expiresAt: number;
};

export async function queueSend(item: Omit<Pending, "id" | "createdAt" | "expiresAt">): Promise<Pending> {
  const pending: Pending = {
    ...item,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    // Unapproved mail expires rather than lingering as a surprise send.
    expiresAt: epoch() + 7 * 24 * 60 * 60,
  };
  await doc.send(new PutCommand({ TableName: TABLE(), Item: { ...pending, id: `outbox#${pending.id}` } }));
  return pending;
}

export async function listPending(userId: string): Promise<Pending[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "byUser",
      KeyConditionExpression: "userId = :u AND begins_with(id, :p)",
      ExpressionAttributeValues: { ":u": userId, ":p": "outbox#" },
    }),
  );
  return ((res.Items ?? []) as Pending[])
    .map((i) => ({ ...i, id: String(i.id).replace("outbox#", "") }))
    .filter((i) => i.expiresAt > epoch())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Only the owner can see, approve or discard a queued mail. */
export async function getPending(id: string, userId: string): Promise<Pending | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { id: `outbox#${id}` } }));
  const p = res.Item as Pending | undefined;
  return p && p.userId === userId ? { ...p, id } : undefined;
}

export async function dropPending(id: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: TABLE(), Key: { id: `outbox#${id}` } }));
}
