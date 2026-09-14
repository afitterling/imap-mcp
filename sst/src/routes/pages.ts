import { Hono } from "hono";
import { type Env, ip, ua, origin } from "./ctx.js";
import { landingPage } from "../web/pages/landing.js";
import { supportPage } from "../web/pages/support.js";
import { docsPage } from "../web/pages/docs.js";
import { authPage } from "../web/pages/login.js";
import { appPage } from "../web/pages/app.js";
import { readSession, createSession, destroySession, getSigned, type Signed } from "../lib/sessions.js";
import { upsertFromClaims, publicUser } from "../lib/users.js";
import { beginLogin, takeLoginState, exchangeCode, verifyIdToken, logoutUrl, userStatus } from "../lib/cognito.js";
import { getClient, createGrant, issueCode } from "../lib/oauth.js";
import { hit, LIMITS } from "../lib/ratelimit.js";
import { audit, ANONYMOUS } from "../lib/audit.js";
import { alertUser, alertEveryone, requestContext } from "../lib/notify.js";
import { claimOrphanAccounts } from "../lib/store.js";

export const pages = new Hono<Env>();

const nav = (s: Signed | undefined) => (s ? { name: s.user.name, email: s.user.email } : undefined);
export const callbackUri = (c: any) => `${origin(c)}/auth/callback`;

/* ------------------------------- public ------------------------------- */

pages.get("/", async (c) => c.html(landingPage(c.get("nonce"), nav(await getSigned(c)))));
pages.get("/support", async (c) => c.html(supportPage(c.get("nonce"), nav(await getSigned(c)))));
pages.get("/docs", async (c) => c.html(docsPage(c.get("nonce"), nav(await getSigned(c)))));
pages.get("/health", (c) => c.json({ ok: true, service: "webmail-mcp" }));
pages.get("/admin/login", (c) => c.redirect("/login"));
pages.get("/signup", (c) => c.redirect("/login")); // Cognito's managed login has the sign-up link

/* ------------------------------ sign-in ------------------------------ */

/** Hand the browser to Cognito's managed login (authorization code + PKCE). */
pages.get("/login", async (c) => {
  if (await getSigned(c)) return c.redirect("/app");
  const addr = ip(c) ?? "unknown";
  if (!(await hit("login-ip", addr, LIMITS.loginPerIp.limit, LIMITS.loginPerIp.window))) return c.text("Too many attempts. Please wait a few minutes.", 429);
  const next = c.req.query("next");
  const { url } = await beginLogin(callbackUri(c), { next: next && next.startsWith("/") && !next.startsWith("//") ? next : "/app" });
  return c.redirect(url);
});

/**
 * Cognito sends the browser back here after password + MFA. One callback serves both the
 * web app sign-in and the MCP OAuth consent flow — the stored state says which.
 */
pages.get("/auth/callback", async (c) => {
  const q = c.req.query();
  const nonce = c.get("nonce");
  const fail = (msg: string, status = 400) => c.html(authPage(nonce, { error: msg }), status as any);
  if (q.error) {
    await audit({ userId: ANONYMOUS, kind: "auth", action: "auth.login", outcome: "failure", details: { reason: q.error, description: q.error_description }, ip: ip(c), ua: ua(c) });
    return fail(q.error_description ? `Sign-in was not completed: ${q.error_description}` : "Sign-in was not completed.");
  }
  const state = q.state ? await takeLoginState(q.state) : undefined;
  if (!state || !q.code) return fail("This sign-in link has expired or was already used. Please start again.");

  let claims;
  let tokens;
  try {
    tokens = await exchangeCode(q.code, state.verifier, state.redirectUri);
    claims = await verifyIdToken(tokens.idToken);
  } catch (err) {
    console.error("[auth] callback failed:", err);
    await audit({ userId: ANONYMOUS, kind: "auth", action: "auth.login", outcome: "failure", details: { reason: "token-exchange" }, ip: ip(c), ua: ua(c) });
    return fail("Sign-in could not be verified. Please start again.", 401);
  }

  // Cognito's auto sign-in right after e-mail confirmation skips MFA setup; MFA is only
  // enforced from the next sign-in on. Never open a session without a registered second factor:
  // end the Cognito session and send the person back through sign-in, where setup is forced.
  const cognito = await userStatus(claims.email);
  if (!cognito?.mfa.length) {
    await audit({ userId: claims.sub, kind: "auth", action: "auth.login", outcome: "denied", target: claims.email, details: { reason: "mfa-not-set-up" }, ip: ip(c), ua: ua(c) });
    return c.html(
      authPage(nonce, {
        error: "Your account has no authenticator app yet. Sign in once more — you will be asked to set it up before you get in.",
        continueHref: await logoutUrl(`${origin(c)}/login`),
      }),
      403,
    );
  }

  const { user, created } = await upsertFromClaims(claims);
  if (user.status === "disabled") {
    await audit({ userId: user.userId, kind: "auth", action: "auth.login", outcome: "denied", details: { reason: "disabled" }, ip: ip(c), ua: ua(c) });
    return fail("This account has been disabled by an administrator.", 403);
  }
  if (created) {
    await audit({ userId: user.userId, kind: "auth", action: "auth.signup.complete", outcome: "success", ip: ip(c), ua: ua(c) });
    // Accounts from before ownership existed go to whoever signs up first.
    const claimed = await claimOrphanAccounts(user.userId);
    if (claimed) await audit({ userId: user.userId, kind: "account", action: "account.claim-orphans", outcome: "success", details: { count: claimed } });
    await alertEveryone({ title: `New user: ${user.email}`, outcome: "success", details: { ...requestContext(c), Name: user.name } });
  }

  // MCP OAuth consent: the user is authenticated, so mint the grant and send the client its code.
  if (state.oauth) {
    const p = state.oauth;
    const client = await getClient(p.client_id);
    if (!client || !client.redirectUris.includes(p.redirect_uri)) return fail("Invalid authorization request.");
    const grant = await createGrant(user.userId, client);
    const code = await issueCode(client, p.redirect_uri, p.code_challenge, user.userId, grant.id);
    await audit({ userId: user.userId, kind: "oauth", action: "oauth.consent", outcome: "success", target: client.name, details: { grant: grant.id.slice(0, 8) }, ip: ip(c), ua: ua(c) });
    await alertUser(user, {
      title: `New connector authorized: ${client.name}`,
      outcome: "success",
      details: { ...requestContext(c), Client: client.name, Access: "Read, draft, queue and move on your mailboxes and calendars (read-only ones excepted)", Revoke: "Connect Claude → Connected apps" },
    });
    const target = new URL(p.redirect_uri);
    target.searchParams.set("code", code);
    if (p.state) target.searchParams.set("state", p.state);
    return c.redirect(target.toString(), 302);
  }

  await destroySession(c);
  await createSession(c, user, { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn });
  await audit({ userId: user.userId, kind: "auth", action: "auth.login", outcome: "success", details: { via: "cognito" }, ip: ip(c), ua: ua(c) });
  await alertUser(user, { title: "New sign-in to your account", outcome: "success", details: { ...requestContext(c), Method: "Cognito (password + MFA)" } });
  return c.redirect(state.next ?? "/app");
});

pages.post("/logout", async (c) => {
  const s = await readSession(c);
  await destroySession(c);
  if (s) await audit({ userId: s.userId, kind: "auth", action: "auth.logout", outcome: "success", ip: ip(c), ua: ua(c) });
  // Also end the Cognito session so the next /login asks for credentials again.
  return c.redirect(await logoutUrl(`${origin(c)}/`));
});

/* --------------------------- signed-in pages --------------------------- */

pages.get("/app", async (c) => {
  const s = await getSigned(c);
  if (!s) return c.redirect("/login?next=/app");
  return c.html(appPage(c.get("nonce"), publicUser(s.user), `${origin(c)}/mcp`));
});

pages.get("/admin", (c) => c.redirect("/app"));
