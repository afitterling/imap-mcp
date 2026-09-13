import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Resource } from "sst";
import { randomUUID } from "node:crypto";
import { signSession, verifySession, safeEqual } from "./lib/crypto.js";
import { listAccounts, getAccount, putAccount, deleteAccount, redact } from "./lib/store.js";
import { testAccount, sendParkedMessage as mailSendParked } from "./lib/mail.js";
import { handleRpc } from "./mcp/server.js";
import {
  verifyToken,
  issueTokens,
  registerClient,
  getClient,
  issueCode,
  redeemCode,
  protectedResourceMetadata,
  authorizationServerMetadata,
} from "./lib/oauth.js";
import { authorizePage } from "./web/authorize.js";
import { sendSecurityAlert, requestContext } from "./lib/notify.js";
import { requireApproval, setRequireApproval, listPending, getPending, dropPending } from "./lib/outbox.js";
import { loginPage } from "./web/login.js";
import { appPage } from "./web/app.js";

const app = new Hono();
const SESSION = "wmcp_session";

/* ---------------------------------- MCP ---------------------------------- */

app.use(
  "/mcp",
  cors({
    origin: "*",
    allowHeaders: ["content-type", "authorization", "mcp-session-id", "mcp-protocol-version", "accept"],
    allowMethods: ["POST", "GET", "DELETE", "OPTIONS"],
    exposeHeaders: ["mcp-session-id"],
  }),
);

/**
 * Three ways in: an OAuth access token (claude.ai connectors), the static token as a
 * Bearer header (Claude Code), or ?token= for clients that can set neither.
 */
function authorized(c: any): boolean {
  const expected = Resource.McpToken.value;
  const header = c.req.header("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const query = c.req.query("token") ?? "";
  if (bearer && verifyToken(bearer, "access")) return true;
  return safeEqual(bearer, expected) || safeEqual(query, expected);
}

app.post("/mcp", async (c) => {
  if (!authorized(c)) {
    const origin = new URL(c.req.url).origin;
    return c.json({ error: "unauthorized" }, 401, {
      "WWW-Authenticate": `Bearer realm="webmail-mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    });
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const result = await handleRpc(body);
  // Notification-only payloads get 202 with no body, per the Streamable HTTP spec.
  return result === null ? c.body(null, 202) : c.json(result);
});

// This server is stateless: there is no server-initiated stream to open or session to end.
app.get("/mcp", (c) => c.json({ error: "method_not_allowed" }, 405));
app.delete("/mcp", (c) => c.body(null, 204));

/* --------------------------------- OAuth --------------------------------- */

app.use("/.well-known/*", cors({ origin: "*" }));
app.use("/oauth/register", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));
app.use("/oauth/token", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"] }));

const origin = (c: any) => new URL(c.req.url).origin;

// Some clients probe the path-suffixed form of the resource metadata, some the bare one.
app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(origin(c))));
app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata(origin(c))));
app.get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServerMetadata(origin(c))));
app.get("/.well-known/oauth-authorization-server/mcp", (c) => c.json(authorizationServerMetadata(origin(c))));

/** RFC 7591 dynamic client registration — open, since PKCE plus the consent screen gate access. */
app.post("/oauth/register", async (c) => {
  const body = await c.req.json().catch(() => ({}) as any);
  const redirectUris: string[] = body.redirect_uris ?? [];
  if (!redirectUris.length) {
    return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required" }, 400);
  }
  const client = await registerClient(body.client_name ?? "MCP client", redirectUris);
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

const AUTH_FIELDS = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"];

app.get("/oauth/authorize", async (c) => {
  const q = c.req.query();
  const client = await getClient(q.client_id ?? "");
  if (!client) return c.text("Unknown client_id. Re-add the connector so it can register again.", 400);
  if (!client.redirectUris.includes(q.redirect_uri ?? "")) return c.text("redirect_uri is not registered for this client.", 400);
  if (q.code_challenge_method !== "S256" || !q.code_challenge) return c.text("PKCE with S256 is required.", 400);

  const params = Object.fromEntries(AUTH_FIELDS.filter((k) => q[k]).map((k) => [k, q[k]!]));
  return c.html(authorizePage({ clientName: client.name, params }));
});

app.post("/oauth/authorize", async (c) => {
  const form = (await c.req.parseBody()) as Record<string, string>;
  const client = await getClient(form.client_id ?? "");
  if (!client || !client.redirectUris.includes(form.redirect_uri ?? "")) {
    return c.text("Invalid authorization request.", 400);
  }
  const params = Object.fromEntries(AUTH_FIELDS.filter((k) => form[k]).map((k) => [k, form[k]]));

  if (!safeEqual(String(form.password ?? ""), Resource.AdminPassword.value)) {
    await sendSecurityAlert({
      title: "Failed connector authorization",
      outcome: "failure",
      details: { ...requestContext(c), Where: "OAuth consent screen", Client: client.name },
    });
    return c.html(authorizePage({ clientName: client.name, params, error: "That password is not correct." }), 401);
  }

  await sendSecurityAlert({
    title: `New connector authorized: ${client.name}`,
    outcome: "success",
    details: {
      ...requestContext(c),
      Where: "OAuth consent screen",
      Client: client.name,
      "Redirect URI": form.redirect_uri,
      Access: "Full read, send, move and delete on every configured mailbox",
    },
  });

  const code = await issueCode(client.clientId, form.redirect_uri, form.code_challenge);
  const target = new URL(form.redirect_uri);
  target.searchParams.set("code", code);
  if (form.state) target.searchParams.set("state", form.state);
  return c.redirect(target.toString(), 302);
});

app.post("/oauth/token", async (c) => {
  const form = (await c.req.parseBody()) as Record<string, string>;
  try {
    if (form.grant_type === "authorization_code") {
      await redeemCode(form.code, form.client_id, form.redirect_uri, form.code_verifier ?? "");
      return c.json(issueTokens(form.client_id));
    }
    if (form.grant_type === "refresh_token") {
      const payload = verifyToken(form.refresh_token ?? "", "refresh");
      if (!payload) return c.json({ error: "invalid_grant" }, 400);
      return c.json(issueTokens(payload.cid));
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "invalid_grant", error_description: message }, 400);
  }
});

/* ------------------------------- Admin auth ------------------------------- */

function signedIn(c: any): boolean {
  return verifySession(getCookie(c, SESSION));
}

app.get("/", (c) => c.redirect("/admin"));

app.get("/admin", (c) => {
  if (!signedIn(c)) return c.html(loginPage());
  const url = new URL(c.req.url);
  return c.html(appPage(`${url.origin}/mcp`, Resource.McpToken.value));
});

app.post("/admin/login", async (c) => {
  const form = await c.req.parseBody();
  if (!safeEqual(String(form.password ?? ""), Resource.AdminPassword.value)) {
    await sendSecurityAlert({
      title: "Failed admin sign-in attempt",
      outcome: "failure",
      details: { ...requestContext(c), Where: "Admin web UI" },
    });
    return c.html(loginPage("That password is not correct."), 401);
  }
  await sendSecurityAlert({
    title: "Admin signed in",
    outcome: "success",
    details: { ...requestContext(c), Where: "Admin web UI" },
  });
  setCookie(c, SESSION, signSession(), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  return c.redirect("/admin");
});

app.post("/admin/logout", (c) => {
  deleteCookie(c, SESSION, { path: "/" });
  return c.redirect("/admin");
});

/* ---------------------------- Account management ---------------------------- */

app.use("/api/*", async (c, next) => {
  if (!signedIn(c)) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.get("/api/accounts", async (c) => c.json((await listAccounts()).map(redact)));

/* ---------------------------------- Outbox ---------------------------------- */

app.get("/api/outbox", async (c) =>
  c.json({ requireApproval: await requireApproval(), pending: await listPending() }),
);

app.post("/api/outbox/settings", async (c) => {
  const body = await c.req.json();
  await setRequireApproval(body.requireApproval !== false);
  return c.json({ requireApproval: await requireApproval() });
});

/** The human gate: this is the only path that actually puts a queued mail on the wire. */
app.post("/api/outbox/:id/approve", async (c) => {
  const pending = await getPending(c.req.param("id"));
  if (!pending) return c.json({ error: "This item is no longer waiting for approval." }, 404);
  const account = await getAccount(pending.accountId);
  if (!account) return c.json({ error: "The sending account no longer exists." }, 404);

  const recipients = [pending.to, pending.cc, pending.bcc].filter(Boolean).join(",");
  try {
    const result = await mailSendParked(account, pending.folder, pending.uid, recipients);
    await dropPending(pending.id);
    await sendSecurityAlert({
      title: "Mail approved and sent",
      outcome: "success",
      details: {
        ...requestContext(c),
        To: pending.to,
        Subject: pending.subject,
        Account: pending.accountLabel,
        "Filed in": result.filedIn,
      },
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

app.post("/api/outbox/:id/discard", async (c) => {
  const pending = await getPending(c.req.param("id"));
  if (!pending) return c.json({ error: "Not found" }, 404);
  await dropPending(pending.id);
  // The parked message stays in Drafts so nothing the user wrote is destroyed.
  return c.json({ discarded: true, stillInDrafts: `${pending.folder} (uid ${pending.uid})` });
});

app.post("/api/accounts", async (c) => {
  const b = await c.req.json();
  try {
    const imapUser = String(b.imapUser || b.email).trim();
    const account = await putAccount({
      accountId: b.accountId?.trim() || randomUUID(),
      label: String(b.label).trim(),
      email: String(b.email).trim(),
      imap: {
        host: String(b.imapHost).trim(),
        port: Number(b.imapPort),
        secure: Number(b.imapPort) === 993,
        user: imapUser,
      },
      smtp: {
        host: String(b.smtpHost).trim(),
        port: Number(b.smtpPort),
        // 465 is implicit TLS; 587 and 25 upgrade via STARTTLS.
        secure: Number(b.smtpPort) === 465,
        user: String(b.smtpUser || imapUser).trim(),
      },
      imapPassword: b.imapPassword || undefined,
      smtpPassword: b.smtpPassword || undefined,
    });
    return c.json(redact(account));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.delete("/api/accounts/:id", async (c) => {
  await deleteAccount(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/accounts/:id/test", async (c) => {
  const account = await getAccount(c.req.param("id"));
  if (!account) return c.json({ error: "No such account" }, 404);
  try {
    return c.json(await testAccount(account));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

app.get("/health", (c) => c.json({ ok: true, service: "webmail-mcp" }));

export const handler = handle(app);
