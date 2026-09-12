import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Resource } from "sst";
import { randomUUID } from "node:crypto";
import { signSession, verifySession, safeEqual } from "./lib/crypto.js";
import { listAccounts, getAccount, putAccount, deleteAccount, redact } from "./lib/store.js";
import { testAccount } from "./lib/mail.js";
import { handleRpc } from "./mcp/server.js";
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

/** Bearer header, or ?token= for clients that cannot set headers. */
function authorized(c: any): boolean {
  const expected = Resource.McpToken.value;
  const header = c.req.header("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const query = c.req.query("token") ?? "";
  return safeEqual(bearer, expected) || safeEqual(query, expected);
}

app.post("/mcp", async (c) => {
  if (!authorized(c)) {
    return c.json({ error: "unauthorized" }, 401, {
      "WWW-Authenticate": 'Bearer realm="webmail-mcp"',
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
    return c.html(loginPage("That password is not correct."), 401);
  }
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
