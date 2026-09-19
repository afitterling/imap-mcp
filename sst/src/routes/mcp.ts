import { Hono } from "hono";
import { cors } from "hono/cors";
import { type Env, ip, ua, origin } from "./ctx.js";
import { handleRpc } from "../mcp/server.js";
import type { CallerContext } from "../mcp/tools.js";
import { lookupToken } from "../lib/tokens.js";
import { verifyToken } from "../lib/oauth.js";
import { getUser } from "../lib/users.js";
import { verifyAccessToken } from "../lib/cognito.js";
import { hit, LIMITS } from "../lib/ratelimit.js";
import { audit, ANONYMOUS } from "../lib/audit.js";

export const mcp = new Hono<Env>();

mcp.use(
  "/mcp",
  cors({
    origin: "*",
    allowHeaders: ["content-type", "authorization", "mcp-session-id", "mcp-protocol-version", "accept"],
    allowMethods: ["POST", "GET", "DELETE", "OPTIONS"],
    exposeHeaders: ["mcp-session-id"],
  }),
);

/**
 * Three ways in, all per user: a personal access token (Claude Code), an OAuth access
 * token issued at the consent screen (claude.ai, desktop), or a Cognito access token from
 * the user pool itself. Nothing in the query string.
 */
async function caller(c: any): Promise<CallerContext | undefined> {
  const header = c.req.header("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!bearer) return undefined;

  const pat = await lookupToken(bearer);
  if (pat) {
    const user = await getUser(pat.userId);
    if (!user || user.status !== "active") return undefined;
    return { userId: user.userId, auth: "pat", tokenId: pat.id, client: pat.name, ip: ip(c), origin: origin(c) };
  }

  const v = await verifyToken(bearer, "access");
  if (v) return { userId: v.user.userId, auth: "oauth", tokenId: v.grant.id, client: v.grant.clientName, ip: ip(c), origin: origin(c) };

  if (bearer.split(".").length === 3) {
    const jwt = await verifyAccessToken(bearer);
    if (jwt) {
      const user = await getUser(jwt.sub);
      if (user && user.status === "active") return { userId: user.userId, auth: "cognito", tokenId: jwt.sub.slice(0, 8), client: "Cognito token", ip: ip(c), origin: origin(c) };
    }
  }
  return undefined;
}

mcp.post("/mcp", async (c) => {
  const addr = ip(c) ?? "unknown";
  const ctx = await caller(c);
  if (!ctx) {
    const allowed = await hit("mcp-auth", addr, LIMITS.mcpAuthFailPerIp.limit, LIMITS.mcpAuthFailPerIp.window);
    await audit({ userId: ANONYMOUS, kind: "security", action: "mcp.auth", outcome: "denied", details: { ratelimited: !allowed }, ip: addr, ua: ua(c) });
    if (!allowed) return c.json({ error: "too_many_requests" }, 429);
    return c.json({ error: "unauthorized" }, 401, {
      "WWW-Authenticate": `Bearer realm="webmail-mcp", resource_metadata="${origin(c)}/.well-known/oauth-protected-resource"`,
    });
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const result = await handleRpc(body, ctx);
  // Notification-only payloads get 202 with no body, per the Streamable HTTP spec.
  return result === null ? c.body(null, 202) : c.json(result);
});

// This server is stateless: there is no server-initiated stream to open or session to end.
mcp.get("/mcp", (c) => c.json({ error: "method_not_allowed" }, 405));
mcp.delete("/mcp", (c) => c.body(null, 204));
