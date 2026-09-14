import { UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { doc, epoch } from "./db.js";

const TABLE = () => Resource.OAuth.name;

/**
 * Atomic fixed-window counter. Returns true while the caller is under `limit` hits
 * in the current window. Rows expire via the table's TTL, so windows clean themselves up.
 */
export async function hit(scope: string, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const window = Math.floor(epoch() / windowSeconds);
  const id = `throttle#${scope}#${key}#${window}`;
  const res = await doc.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { id },
      UpdateExpression: "ADD #n :one SET expiresAt = if_not_exists(expiresAt, :exp)",
      ExpressionAttributeNames: { "#n": "n" },
      ExpressionAttributeValues: { ":one": 1, ":exp": (window + 2) * windowSeconds },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  return Number(res.Attributes?.n ?? 0) <= limit;
}

/** First caller in the window wins; everyone else is told to stand down. */
export async function claimWindow(key: string, windowSeconds: number): Promise<boolean> {
  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE(),
        Item: { id: `alert#${key}`, expiresAt: epoch() + windowSeconds },
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export class RateLimited extends Error {
  constructor(message = "Too many attempts. Please wait a few minutes and try again.") {
    super(message);
  }
}

export const LIMITS = {
  loginPerIp: { limit: 30, window: 900 },
  loginPerEmail: { limit: 10, window: 900 },
  signupPerIp: { limit: 10, window: 3600 },
  codePerKey: { limit: 8, window: 600 },
  mcpAuthFailPerIp: { limit: 60, window: 900 },
  oauthRegisterPerIp: { limit: 20, window: 3600 },
  smsPerUserHour: { limit: 5, window: 3600 },
  smsPerUserDay: { limit: 20, window: 86400 },
} as const;
