import { Hono } from "hono";
import { cors } from "hono/cors";
import { type Env, form, ip, origin } from "./ctx.js";
import { authorizePage } from "../web/pages/authorize.js";
import { registerClient, getClient, redeemCode, issueTokens, verifyToken, protectedResourceMetadata, authorizationServerMetadata } from "../lib/oauth.js";
import { hit, LIMITS } from "../lib/ratelimit.js";
import { audit } from "../lib/audit.js";
import { beginLogin } from "../lib/cognito.js";
import { getSigned } from "../lib/sessions.js";
import { callbackUri } from "./pages.js";

export const oauth = new Hono<Env>();

oauth.use("/.well-known/*", cors({ origin: "*" }));
oauth.use("/oauth/register", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));
oauth.use("/oauth/token", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));

// Some clients probe the path-suffixed form of the resource metadata, some the bare one.
oauth.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(origin(c))));
oauth.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata(origin(c))));
oauth.get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServerMetadata(origin(c))));
oauth.get("/.well-known/oauth-authorization-server/mcp", (c) => c.json(authorizationServerMetadata(origin(c))));

/** RFC 7591 dynamic client registration — open, since PKCE plus the Cognito-backed consent gate access. */
oauth.post("/oauth/register", async (c) => {
  if (!(await hit("oauth-register", ip(c) ?? "unknown", LIMITS.oauthRegisterPerIp.limit, LIMITS.oauthRegisterPerIp.window))) {
    return c.json({ error: "too_many_requests" }, 429);
  }
  const body = await c.req.json().catch(() => ({}) as any);
  const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u: unknown) => typeof u === "string") : [];
  if (!redirectUris.length || !redirectUris.every(isSafeRedirect)) {
    return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https or loopback URLs" }, 400);
  }
  const client = await registerClient(String(body.client_name ?? "MCP client"), redirectUris);
  return c.json(
    {
      client_id: client.clientId,
      client_id_issued_at: client.createdAt,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
});

function isSafeRedirect(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

const AUTH_FIELDS = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"];
const pick = (src: Record<string, string | undefined>) => Object.fromEntries(AUTH_FIELDS.filter((k) => src[k]).map((k) => [k, src[k]!]));

oauth.get("/oauth/authorize", async (c) => {
  const q = c.req.query();
  const client = await getClient(q.client_id ?? "");
  if (!client) return c.text("Unknown client_id. Re-add the connector so it can register again.", 400);
  if (!client.redirectUris.includes(q.redirect_uri ?? "")) return c.text("redirect_uri is not registered for this client.", 400);
  if (q.code_challenge_method !== "S256" || !q.code_challenge) return c.text("PKCE with S256 is required.", 400);
  const signed = await getSigned(c);
  return c.html(authorizePage(c.get("nonce"), { clientName: client.name, params: pick(q), signedInAs: signed?.user.email }));
});

/**
 * Consent: the user authenticates with Cognito (password + MFA, even when already signed in
 * to the web app — connecting an agent deserves a fresh proof). The callback mints the grant.
 */
oauth.post("/oauth/authorize", async (c) => {
  const f = await form(c);
  const client = await getClient(f.client_id ?? "");
  if (!client || !client.redirectUris.includes(f.redirect_uri ?? "") || !f.code_challenge) return c.text("Invalid authorization request.", 400);
  const params = pick(f);
  const { url } = await beginLogin(callbackUri(c), { oauth: { ...params, clientName: client.name } });
  await audit({ userId: "anonymous", kind: "oauth", action: "oauth.consent.start", outcome: "success", target: client.name, ip: ip(c) });
  return c.redirect(url);
});

oauth.post("/oauth/token", async (c) => {
  const f = await form(c);
  try {
    if (f.grant_type === "authorization_code") {
      const { userId, grantId } = await redeemCode(f.code ?? "", f.client_id ?? "", f.redirect_uri ?? "", f.code_verifier ?? "");
      await audit({ userId, kind: "oauth", action: "oauth.token", outcome: "success", details: { grant: grantId.slice(0, 8), grantType: "authorization_code" }, ip: ip(c) });
      return c.json(issueTokens(userId, grantId, f.client_id ?? ""));
    }
    if (f.grant_type === "refresh_token") {
      const v = await verifyToken(f.refresh_token ?? "", "refresh");
      if (!v) return c.json({ error: "invalid_grant" }, 400);
      return c.json(issueTokens(v.user.userId, v.grant.id, v.payload.cid));
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "invalid_grant", error_description: message }, 400);
  }
});
