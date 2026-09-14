import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { doc } from "./db.js";
import { normalizeEmail } from "./allowlist.js";
import type { IdClaims } from "./cognito.js";

const TABLE = () => Resource.Users.name;

export type UserStatus = "active" | "disabled";

/**
 * Local profile of a Cognito user. Cognito owns credentials and MFA; this row owns what
 * the app needs per request (status, session version) and what the Users page lists.
 * There are no roles: every allowlisted person has the same rights.
 */
export type User = {
  /** The Cognito `sub` — the only user id ever trusted. */
  userId: string;
  email: string;
  name: string;
  status: UserStatus;
  /** Bumping this invalidates every session the user has. */
  sessionVersion: number;
  createdAt: string;
  lastLoginAt?: string;
};

export type PublicUser = User;
export const publicUser = (u: User): PublicUser => u;

export async function getUser(userId: string): Promise<User | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { userId } }));
  return res.Item as User | undefined;
}

export async function findByEmail(email: string): Promise<User | undefined> {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "byEmail",
      KeyConditionExpression: "email = :e",
      ExpressionAttributeValues: { ":e": normalizeEmail(email) },
      Limit: 1,
    }),
  );
  return res.Items?.[0] as User | undefined;
}

export async function listUsers(): Promise<User[]> {
  const res = await doc.send(new ScanCommand({ TableName: TABLE() }));
  return ((res.Items ?? []) as User[]).sort((a, b) => a.email.localeCompare(b.email));
}


/** Called after every verified sign-in: creates the profile on first login, refreshes it afterwards. */
export async function upsertFromClaims(claims: IdClaims): Promise<{ user: User; created: boolean }> {
  const existing = await getUser(claims.sub);
  const now = new Date().toISOString();
  if (existing) {
    const patch: Partial<User> = { lastLoginAt: now, email: claims.email };
    if (claims.name && claims.name !== existing.name) patch.name = claims.name.slice(0, 80);
    await updateUser(existing.userId, patch);
    return { user: { ...existing, ...patch }, created: false };
  }
  const user: User = {
    userId: claims.sub,
    email: claims.email,
    name: (claims.name ?? claims.email.split("@")[0]).slice(0, 80),
    status: "active",
    sessionVersion: 1,
    createdAt: now,
    lastLoginAt: now,
  };
  await doc.send(new PutCommand({ TableName: TABLE(), Item: user, ConditionExpression: "attribute_not_exists(userId)" }));
  return { user, created: true };
}

export async function updateUser(userId: string, patch: Partial<Omit<User, "userId">>): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const removes: string[] = [];
  keys.forEach((k, i) => {
    names[`#k${i}`] = k;
    if (patch[k] === undefined) removes.push(`#k${i}`);
    else {
      values[`:v${i}`] = patch[k];
      sets.push(`#k${i} = :v${i}`);
    }
  });
  const expr = [sets.length ? `SET ${sets.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""].filter(Boolean).join(" ");
  await doc.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { userId },
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
      ConditionExpression: "attribute_exists(userId)",
    }),
  );
}

/** Sign the user out of every browser at once. */
export async function bumpSessionVersion(u: User): Promise<number> {
  const next = (u.sessionVersion ?? 1) + 1;
  await updateUser(u.userId, { sessionVersion: next });
  return next;
}
