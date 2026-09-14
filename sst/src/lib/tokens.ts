import { GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { doc, epoch } from "./db.js";
import { randomToken, sha256 } from "./crypto.js";

const TABLE = () => Resource.OAuth.name;
export const TOKEN_PREFIX = "wmcp_";
const DEFAULT_TTL_DAYS = 90;
const MAX_PER_USER = 10;

export type Pat = {
  id: string;
  userId: string;
  name: string;
  /** First characters of the token, so the user can tell them apart. Never enough to use. */
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt: number;
};

export async function createToken(userId: string, name: string, ttlDays = DEFAULT_TTL_DAYS): Promise<{ token: string; pat: Pat }> {
  const existing = await listTokens(userId);
  if (existing.length >= MAX_PER_USER) throw new Error(`You already have ${MAX_PER_USER} tokens. Revoke one first.`);
  const token = TOKEN_PREFIX + randomToken(32);
  const pat: Pat = {
    id: sha256(token),
    userId,
    name: name.trim().slice(0, 60) || "Claude Code",
    prefix: token.slice(0, TOKEN_PREFIX.length + 6),
    createdAt: new Date().toISOString(),
    expiresAt: epoch() + Math.min(Math.max(ttlDays, 1), 365) * 86400,
  };
  await doc.send(new PutCommand({ TableName: TABLE(), Item: { ...pat, id: `pat#${pat.id}` } }));
  return { token, pat };
}

/** Resolve a presented bearer token; touches lastUsedAt without waiting for it. */
export async function lookupToken(token: string): Promise<Pat | undefined> {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const id = sha256(token);
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { id: `pat#${id}` } }));
  const pat = res.Item as Pat | undefined;
  if (!pat || pat.expiresAt <= epoch()) return undefined;
  void doc
    .send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: { id: `pat#${id}` },
        UpdateExpression: "SET lastUsedAt = :t",
        ExpressionAttributeValues: { ":t": new Date().toISOString() },
      }),
    )
    .catch(() => undefined);
  return { ...pat, id };
}

export async function listTokens(userId: string): Promise<Pat[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "byUser",
      KeyConditionExpression: "userId = :u AND begins_with(id, :p)",
      ExpressionAttributeValues: { ":u": userId, ":p": "pat#" },
    }),
  );
  const now = epoch();
  return ((res.Items ?? []) as Pat[])
    .filter((p) => p.expiresAt > now)
    .map((p) => ({ ...p, id: p.id.replace("pat#", "") }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function revokeToken(userId: string, id: string): Promise<boolean> {
  try {
    await doc.send(
      new DeleteCommand({
        TableName: TABLE(),
        Key: { id: `pat#${id}` },
        ConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Remove every row of a kind for a user — used when an admin wipes a user's access. */
export async function revokeAllOfKind(userId: string, prefix: "pat#" | "grant#" | "session#"): Promise<number> {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "byUser",
      KeyConditionExpression: "userId = :u AND begins_with(id, :p)",
      ExpressionAttributeValues: { ":u": userId, ":p": prefix },
      ProjectionExpression: "id",
    }),
  );
  const ids = (res.Items ?? []).map((i) => i.id as string);
  await Promise.all(ids.map((id) => doc.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }))));
  return ids.length;
}
