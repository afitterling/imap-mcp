import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  CognitoIdentityProviderClient,
  ListUserPoolClientsCommand,
  DescribeUserPoolClientCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUserGlobalSignOutCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { createHash, randomBytes } from "node:crypto";
import { GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { doc, epoch } from "./db.js";

const POOL_ID = () => process.env.COGNITO_USER_POOL_ID ?? "";
const DOMAIN = () => (process.env.COGNITO_DOMAIN ?? "").replace(/\/$/, "");
const REGION = () => process.env.COGNITO_REGION ?? process.env.AWS_REGION ?? "eu-central-1";
const CLIENT_NAME = "Web";

const idp = new CognitoIdentityProviderClient({});

/* --------------------------------- client --------------------------------- */

type ClientConfig = { clientId: string; clientSecret: string };
let cached: Promise<ClientConfig> | undefined;

/** The app client is created after the function (its callback is the function URL), so it is found by name at runtime and cached for the container's life. */
export function clientConfig(): Promise<ClientConfig> {
  return (cached ??= (async () => {
    const list = await idp.send(new ListUserPoolClientsCommand({ UserPoolId: POOL_ID(), MaxResults: 60 }));
    const hit = list.UserPoolClients?.find((c) => c.ClientName === CLIENT_NAME) ?? list.UserPoolClients?.[0];
    if (!hit?.ClientId) throw new Error("No Cognito app client found for this user pool.");
    const desc = await idp.send(new DescribeUserPoolClientCommand({ UserPoolId: POOL_ID(), ClientId: hit.ClientId }));
    return { clientId: hit.ClientId, clientSecret: desc.UserPoolClient?.ClientSecret ?? "" };
  })().catch((err) => {
    cached = undefined;
    throw err;
  }));
}

export const issuer = () => `https://cognito-idp.${REGION()}.amazonaws.com/${POOL_ID()}`;

/* ---------------------------------- PKCE ---------------------------------- */

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * A sign-in in progress: the PKCE verifier and where to go afterwards. Keyed by the
 * opaque `state` we send to Cognito; single use; 10 minutes.
 */
export type LoginState = {
  verifier: string;
  redirectUri: string;
  /** Where the browser lands after sign-in, or the pending MCP OAuth request. */
  next?: string;
  oauth?: Record<string, string>;
  expiresAt: number;
};

export async function beginLogin(redirectUri: string, extra: Pick<LoginState, "next" | "oauth">): Promise<{ url: string; state: string }> {
  const { clientId } = await clientConfig();
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(24).toString("base64url");
  const row: LoginState = { verifier, redirectUri, ...extra, expiresAt: epoch() + 600 };
  await doc.send(new PutCommand({ TableName: Resource.OAuth.name, Item: { id: `login#${state}`, ...row } }));
  const url = new URL(`${DOMAIN()}/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  return { url: url.toString(), state };
}

export async function takeLoginState(state: string): Promise<LoginState | undefined> {
  const id = `login#${state}`;
  const res = await doc.send(new GetCommand({ TableName: Resource.OAuth.name, Key: { id } }));
  if (!res.Item) return undefined;
  await doc.send(new DeleteCommand({ TableName: Resource.OAuth.name, Key: { id } }));
  const row = res.Item as LoginState & { id: string };
  return row.expiresAt > epoch() ? row : undefined;
}

/* --------------------------------- tokens --------------------------------- */

export type IdClaims = { sub: string; email: string; name?: string; email_verified?: boolean };

export async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<{ idToken: string; accessToken: string; refreshToken?: string }> {
  const { clientId, clientSecret } = await clientConfig();
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  const res = await fetch(`${DOMAIN()}/oauth2/token`, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Cognito token exchange failed (${res.status}).`);
  const t = (await res.json()) as { id_token: string; access_token: string; refresh_token?: string };
  return { idToken: t.id_token, accessToken: t.access_token, refreshToken: t.refresh_token };
}

let idVerifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;
let accessVerifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

/** Validates signature (JWKS), issuer, audience, expiry and token_use. */
export async function verifyIdToken(token: string): Promise<IdClaims> {
  const { clientId } = await clientConfig();
  idVerifier ??= CognitoJwtVerifier.create({ userPoolId: POOL_ID(), tokenUse: "id", clientId });
  const p = (await idVerifier.verify(token)) as unknown as IdClaims;
  if (!p.sub || !p.email) throw new Error("ID token lacks sub/email.");
  return { sub: p.sub, email: String(p.email).toLowerCase(), name: p.name, email_verified: p.email_verified };
}

/** For MCP callers presenting a Cognito access token directly. Returns the user's sub and username. */
export async function verifyAccessToken(token: string): Promise<{ sub: string; username: string } | undefined> {
  try {
    const { clientId } = await clientConfig();
    accessVerifier ??= CognitoJwtVerifier.create({ userPoolId: POOL_ID(), tokenUse: "access", clientId });
    const p = (await accessVerifier.verify(token)) as unknown as { sub: string; username: string };
    return { sub: p.sub, username: p.username };
  } catch {
    return undefined;
  }
}

export async function logoutUrl(redirectTo: string): Promise<string> {
  const { clientId } = await clientConfig();
  const url = new URL(`${DOMAIN()}/logout`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("logout_uri", redirectTo);
  return url.toString();
}

/* --------------------------------- admin --------------------------------- */

const username = (email: string) => email; // usernames: ["email"] → the e-mail is the username

export const adminDisableUser = (email: string) => idp.send(new AdminDisableUserCommand({ UserPoolId: POOL_ID(), Username: username(email) }));
export const adminEnableUser = (email: string) => idp.send(new AdminEnableUserCommand({ UserPoolId: POOL_ID(), Username: username(email) }));
export const adminGlobalSignOut = (email: string) => idp.send(new AdminUserGlobalSignOutCommand({ UserPoolId: POOL_ID(), Username: username(email) }));

/** Clears the MFA preference; with the pool's MFA set to ON, Cognito forces a fresh setup at next sign-in. */
export const adminResetMfa = (email: string) =>
  idp.send(
    new AdminSetUserMFAPreferenceCommand({
      UserPoolId: POOL_ID(),
      Username: username(email),
      SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
    }),
  );

export async function adminUserStatus(email: string): Promise<{ enabled: boolean; status?: string; mfa: string[] } | undefined> {
  try {
    const u = await idp.send(new AdminGetUserCommand({ UserPoolId: POOL_ID(), Username: username(email) }));
    return { enabled: u.Enabled !== false, status: u.UserStatus, mfa: (u.UserMFASettingList ?? []).map((m) => (m === "SOFTWARE_TOKEN_MFA" ? "totp" : m === "SMS_MFA" ? "sms" : m)) };
  } catch {
    return undefined;
  }
}
