import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { randomUUID } from "node:crypto";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = () => Resource.OAuth.name;
const epoch = () => Math.floor(Date.now() / 1000);

/* --------------------------------- setting --------------------------------- */

const SETTING_ID = "config#require-send-approval";

/** Approval is ON unless a human has explicitly switched it off. */
export async function requireApproval(): Promise<boolean> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { id: SETTING_ID } }));
  return res.Item?.value !== false;
}

export async function setRequireApproval(value: boolean): Promise<void> {
  await doc.send(new PutCommand({ TableName: TABLE(), Item: { id: SETTING_ID, value } }));
}

/* --------------------------------- outbox --------------------------------- */

export type Pending = {
  id: string;
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

export async function listPending(): Promise<Pending[]> {
  const res = await doc.send(
    new ScanCommand({
      TableName: TABLE(),
      FilterExpression: "begins_with(id, :p)",
      ExpressionAttributeValues: { ":p": "outbox#" },
    }),
  );
  return ((res.Items ?? []) as Pending[])
    .map((i) => ({ ...i, id: String(i.id).replace("outbox#", "") }))
    .filter((i) => i.expiresAt > epoch())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getPending(id: string): Promise<Pending | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { id: `outbox#${id}` } }));
  if (!res.Item) return undefined;
  return { ...(res.Item as Pending), id };
}

export async function dropPending(id: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: TABLE(), Key: { id: `outbox#${id}` } }));
}
