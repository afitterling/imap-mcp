import { GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { createHash } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { doc, epoch } from "./db.js";
import { randomToken, sha256 } from "./crypto.js";
import { getUser, type User } from "./users.js";

const TABLE = () => Resource.OAuth.name;
export const COOKIE = "__Host-wmcp";
const ABSOLUTE_SECONDS = 12 * 60 * 60;
const IDLE_SECONDS = 60 * 60;

/** Sessions exist only after Cognito has verified the user; there are no partial stages. */
export type Session = {
  id: string;
  userId: string;
  sessionVersion: number;
  createdAt: string;
  lastSeenAt: string;
  ip?: string;
  uaHash: string;
  expiresAt: number;
  absoluteExpiry: number;
};

function uaHash(c: Context): string {
  return createHash("sha256").update(c.req.header("user-agent") ?? "").digest("base64url").slice(0, 16);
}

export function clientIp(c: Context): string | undefined {
  const forwarded = c.req.header("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : undefined;
}

export async function createSession(c: Context, user: User): Promise<Session> {
  const token = randomToken(32);
  const now = epoch();
  const ttl = ABSOLUTE_SECONDS;
  const session: Session = {
    id: sha256(token),
    userId: user.userId,
    sessionVersion: user.sessionVersion ?? 1,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    ip: clientIp(c),
    uaHash: uaHash(c),
    expiresAt: now + Math.min(ttl, IDLE_SECONDS),
    absoluteExpiry: now + ttl,
  };
  await doc.send(new PutCommand({ TableName: TABLE(), Item: { ...session, id: `session#${session.id}` } }));
  setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: ttl });
  return session;
}

export async function readSession(c: Context): Promise<(Session & { user: User }) | undefined> {
  const token = getCookie(c, COOKIE);
  if (!token) return undefined;
  const id = sha256(token);
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { id: `session#${id}` } }));
  const s = res.Item as Session | undefined;
  if (!s) return undefined;
  const now = epoch();
  if (s.expiresAt <= now || s.absoluteExpiry <= now || s.uaHash !== uaHash(c)) return undefined;
  const user = await getUser(s.userId);
  if (!user || user.status === "disabled" || (user.sessionVersion ?? 1) !== s.sessionVersion) return undefined;
  // Slide the idle window, but never past the absolute expiry.
  await doc
    .send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: { id: `session#${id}` },
        UpdateExpression: "SET expiresAt = :e, lastSeenAt = :t",
        ExpressionAttributeValues: { ":e": Math.min(now + IDLE_SECONDS, s.absoluteExpiry), ":t": new Date().toISOString() },
      }),
    )
    .catch(() => undefined);
  return { ...s, id, user };
}

export async function destroySession(c: Context): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) {
    await doc.send(new DeleteCommand({ TableName: TABLE(), Key: { id: `session#${sha256(token)}` } })).catch(() => undefined);
  }
  deleteCookie(c, COOKIE, { path: "/", secure: true });
}

export async function listSessions(userId: string): Promise<Session[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "byUser",
      KeyConditionExpression: "userId = :u AND begins_with(id, :p)",
      ExpressionAttributeValues: { ":u": userId, ":p": "session#" },
    }),
  );
  const now = epoch();
  return ((res.Items ?? []) as Session[])
    .filter((s) => s.expiresAt > now)
    .map((s) => ({ ...s, id: s.id.replace("session#", "") }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export async function deleteSessionById(id: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: TABLE(), Key: { id: `session#${id}` } }));
}

/* ----------------------------- route helpers ----------------------------- */

export type Signed = Session & { user: User };

/** Fully signed-in user or undefined. Routes decide whether to 401 or redirect. */
export async function getSigned(c: Context): Promise<Signed | undefined> {
  const s = await readSession(c);
  return s && s.user.status === "active" ? s : undefined;
}

export async function requireSigned(c: Context): Promise<Signed> {
  const s = await getSigned(c);
  if (!s) throw new Unauthorized();
  return s;
}


export class Unauthorized extends Error {
  status = 401 as const;
  constructor() {
    super("Please sign in.");
  }
}
