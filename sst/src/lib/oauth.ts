import { GetCommand, PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { createHash, createHmac, randomUUID, randomBytes } from "node:crypto";
import { doc, epoch } from "./db.js";
import { safeEqual } from "./crypto.js";
import { getUser, type User } from "./users.js";

const TABLE = () => Resource.OAuth.name;
const secret = () => Resource.EncryptionKey.value;

/* ------------------------------ signed tokens ------------------------------ */

type TokenPayload = { typ: "access" | "refresh"; uid: string; gid: string; cid: string; exp: number; jti: string };

function sign(payload: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function parseToken(token: string, typ: "access" | "refresh"): TokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
    if (payload.typ !== typ || payload.exp < epoch() || !payload.uid || !payload.gid) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * A token is good only while its grant row still exists and its user is active — so a
 * user revoking a connected app, or an admin disabling a user, takes effect immediately.
 */
export async function verifyToken(token: string, typ: "access" | "refresh"): Promise<{ payload: TokenPayload; grant: Grant; user: User } | null> {
  const payload = parseToken(token, typ);
  if (!payload) return null;
  const grant = await getGrant(payload.gid);
  if (!grant || grant.userId !== payload.uid) return null;
  const user = await getUser(payload.uid);
  if (!user || user.status !== "active") return null;
  return { payload, grant, user };
}

const ACCESS_TTL = 30 * 24 * 60 * 60;
const REFRESH_TTL = 365 * 24 * 60 * 60;

export function issueTokens(userId: string, grantId: string, clientId: string) {
  return {
    access_token: sign({ typ: "access", uid: userId, gid: grantId, cid: clientId, exp: epoch() + ACCESS_TTL, jti: randomUUID() }),
    refresh_token: sign({ typ: "refresh", uid: userId, gid: grantId, cid: clientId, exp: epoch() + REFRESH_TTL, jti: randomUUID() }),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    scope: "mcp",
  };
}

/* --------------------------- dynamic registration --------------------------- */

export type Client = { clientId: string; redirectUris: string[]; name: string; createdAt: number };

export async function registerClient(name: string, redirectUris: string[]): Promise<Client> {
  const client: Client = {
    clientId: `client_${randomBytes(16).toString("base64url")}`,
    redirectUris,
    name: name.slice(0, 80),
    createdAt: epoch(),
  };
  // `id` is the partition key and must stay prefixed — keep it out of the spread.
  await doc.send(new PutCommand({ TableName: TABLE(), Item: { ...client, id: `client#${client.clientId}` } }));
  return client;
}

export async function getClient(clientId: string): Promise<Client | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { id: `client#${clientId}` } }));
  if (!res.Item) return undefined;
  const { id: _pk, ...client } = res.Item;
  return client as Client;
}

/* --------------------------------- grants --------------------------------- */

/** One row per "this app may act as this user"; deleting it revokes every token issued under it. */
export type Grant = { id: string; userId: string; clientId: string; clientName: string; createdAt: string; lastUsedAt?: string };

export async function createGrant(userId: string, client: Client): Promise<Grant> {
  const grant: Grant = { id: randomUUID(), userId, clientId: client.clientId, clientName: client.name, createdAt: new Date().toISOString() };
  await doc.send(new PutCommand({ TableName: TABLE(), Item: { ...grant, id: `grant#${grant.id}` } }));
  return grant;
}

export async function getGrant(id: string): Promise<Grant | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { id: `grant#${id}` } }));
  return res.Item ? ({ ...(res.Item as Grant), id } as Grant) : undefined;
}

export async function listGrants(userId: string): Promise<Grant[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "byUser",
      KeyConditionExpression: "userId = :u AND begins_with(id, :p)",
      ExpressionAttributeValues: { ":u": userId, ":p": "grant#" },
    }),
  );
  return ((res.Items ?? []) as Grant[])
    .map((g) => ({ ...g, id: g.id.replace("grant#", "") }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function revokeGrant(userId: string, id: string): Promise<boolean> {
  try {
    await doc.send(
      new DeleteCommand({
        TableName: TABLE(),
        Key: { id: `grant#${id}` },
        ConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/* -------------------------- authorization codes (PKCE) -------------------------- */

type Code = { id: string; clientId: string; redirectUri: string; challenge: string; userId: string; grantId: string; expiresAt: number };

export async function issueCode(client: Client, redirectUri: string, challenge: string, userId: string, grantId: string): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  const item: Code = {
    id: `code#${code}`,
    clientId: client.clientId,
    redirectUri,
    challenge,
    userId,
    grantId,
    // Codes are single-use and short-lived; DynamoDB TTL sweeps whatever is left.
    expiresAt: epoch() + 600,
  };
  await doc.send(new PutCommand({ TableName: TABLE(), Item: item }));
  return code;
}

export async function redeemCode(code: string, clientId: string, redirectUri: string, verifier: string): Promise<{ userId: string; grantId: string }> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { id: `code#${code}` } }));
  const item = res.Item as Code | undefined;
  if (!item) throw new Error("invalid_grant: unknown or already-used code");
  await doc.send(new DeleteCommand({ TableName: TABLE(), Key: { id: `code#${code}` } }));

  if (item.expiresAt < epoch()) throw new Error("invalid_grant: code expired");
  if (item.clientId !== clientId) throw new Error("invalid_grant: client mismatch");
  if (item.redirectUri !== redirectUri) throw new Error("invalid_grant: redirect_uri mismatch");

  const digest = createHash("sha256").update(verifier).digest("base64url");
  if (!safeEqual(digest, item.challenge)) throw new Error("invalid_grant: PKCE verification failed");
  return { userId: item.userId, grantId: item.grantId };
}

/* --------------------------- discovery documents --------------------------- */

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}
