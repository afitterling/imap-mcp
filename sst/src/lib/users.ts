import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
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


/**
 * The user pool was recreated (a schema change forces that): the person is the same, the
 * Cognito `sub` is new. Move everything they own to the new id so nothing is lost.
 */
async function rekey(old: User, sub: string): Promise<void> {
  const tables = [
    { table: Resource.Accounts.name, key: "accountId", field: "ownerId" },
    { table: Resource.Calendars.name, key: "calendarId", field: "ownerId" },
  ];
  for (const t of tables) {
    const res = await doc.send(
      new QueryCommand({ TableName: t.table, IndexName: "byOwner", KeyConditionExpression: "ownerId = :o", ExpressionAttributeValues: { ":o": old.userId }, ProjectionExpression: t.key }),
    );
    for (const item of res.Items ?? []) {
      await doc.send(new UpdateCommand({ TableName: t.table, Key: { [t.key]: item[t.key] }, UpdateExpression: `SET ${t.field} = :n`, ExpressionAttributeValues: { ":n": sub } }));
    }
  }
  // Tokens, grants, outbox and settings rows carry userId as an attribute.
  const kv = await doc.send(
    new QueryCommand({ TableName: Resource.OAuth.name, IndexName: "byUser", KeyConditionExpression: "userId = :o", ExpressionAttributeValues: { ":o": old.userId }, ProjectionExpression: "id" }),
  );
  for (const item of kv.Items ?? []) {
    if (String(item.id).startsWith("session#")) continue; // old sessions die with the old sub
    await doc.send(new UpdateCommand({ TableName: Resource.OAuth.name, Key: { id: item.id }, UpdateExpression: "SET userId = :n", ExpressionAttributeValues: { ":n": sub } }));
  }
  await doc.send(new DeleteCommand({ TableName: TABLE(), Key: { userId: old.userId } }));
  console.log(JSON.stringify({ type: "audit", kind: "user", action: "user.rekey", outcome: "success", from: old.userId, to: sub, at: new Date().toISOString() }));
}

/** Called after every verified sign-in: creates the profile on first login, refreshes it afterwards. */
export async function upsertFromClaims(claims: IdClaims): Promise<{ user: User; created: boolean }> {
  let existing = await getUser(claims.sub);
  if (!existing) {
    const sameEmail = await findByEmail(claims.email);
    if (sameEmail && sameEmail.userId !== claims.sub) {
      await rekey(sameEmail, claims.sub);
      existing = { ...sameEmail, userId: claims.sub };
      await doc.send(new PutCommand({ TableName: TABLE(), Item: existing }));
    }
  }
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
