import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { type Env, jsonBody, bad, ip, ua, HttpError } from "./ctx.js";
import { requireSigned, listSessions, deleteSessionById, destroySession, type Signed } from "../lib/sessions.js";
import { listAccounts, getAccount, putAccount, deleteAccount, setReadOnly, redact } from "../lib/store.js";
import { testAccount, sendParkedMessage } from "../lib/mail.js";
import { listCalendars, getCalendar, putCalendar, deleteCalendar, setCalendarReadOnly, redactCalendar } from "../lib/calstore.js";
import { discoverCalendars, testCalendar, normalizeFeedUrl, assertPublicHost } from "../lib/calendar.js";
import { requireApproval, setRequireApproval } from "../lib/settings.js";
import { listPending, getPending, dropPending } from "../lib/outbox.js";
import { createToken, listTokens, revokeToken } from "../lib/tokens.js";
import { listGrants, revokeGrant } from "../lib/oauth.js";
import { audit, forUser, toCsv, type AuditKind } from "../lib/audit.js";
import { alertUser, requestContext } from "../lib/notify.js";
import { bumpSessionVersion, publicUser } from "../lib/users.js";
import { globalSignOut, userStatus } from "../lib/cognito.js";

export const api = new Hono<Env>();

api.use("*", async (c, next) => {
  await requireSigned(c); // throws 401 → handled globally
  await next();
});

const who = (c: any, s: Signed) => ({ userId: s.user.userId, ip: ip(c), ua: ua(c) });

api.get("/me", async (c) => {
  const s = await requireSigned(c);
  const mcpUrl = `${new URL(c.req.url).origin}/mcp`;
  const cognito = await userStatus(s.user.email);
  return c.json({ user: publicUser(s.user), mcpUrl, mfa: cognito?.mfa ?? [], cognitoStatus: cognito?.status });
});

/* ------------------------------- accounts ------------------------------- */

api.get("/accounts", async (c) => {
  const s = await requireSigned(c);
  return c.json((await listAccounts(s.user.userId)).map(redact));
});

api.post("/accounts", async (c) => {
  const s = await requireSigned(c);
  const b = await jsonBody(c);
  const imapUser = String(b.imapUser || b.email || "").trim();
  const email = String(b.email ?? "").trim();
  if (!email || !b.label || !b.imapHost || !b.smtpHost) throw bad("Label, email, IMAP host and SMTP host are required.");
  const isNew = !b.accountId;
  if (isNew && !b.imapPassword) throw bad("An IMAP password is required for a new account.");
  const account = await putAccount({
    accountId: String(b.accountId || "").trim() || randomUUID(),
    ownerId: s.user.userId,
    label: String(b.label).trim().slice(0, 60),
    email,
    imap: { host: String(b.imapHost).trim(), port: Number(b.imapPort), secure: Number(b.imapPort) === 993, user: imapUser },
    smtp: {
      host: String(b.smtpHost).trim(),
      port: Number(b.smtpPort),
      // 465 is implicit TLS; 587 and 25 upgrade via STARTTLS.
      secure: Number(b.smtpPort) === 465,
      user: String(b.smtpUser || imapUser).trim(),
    },
    readOnly: b.readOnly === true,
    imapPassword: b.imapPassword || undefined,
    smtpPassword: b.smtpPassword || undefined,
  });
  await audit({ ...who(c, s), kind: "account", action: isNew ? "account.create" : "account.update", outcome: "success", target: account.label, details: { email: account.email, imap: account.imap.host, readOnly: account.readOnly, passwordChanged: !!b.imapPassword } });
  return c.json(redact(account));
});

api.post("/accounts/:id/readonly", async (c) => {
  const s = await requireSigned(c);
  const a = await getAccount(c.req.param("id"), s.user.userId);
  if (!a) throw new HttpError(404, "No such account.");
  const b = await jsonBody(c);
  await setReadOnly(a.accountId, s.user.userId, b.readOnly === true);
  await audit({ ...who(c, s), kind: "account", action: "account.readonly", outcome: "success", target: a.label, details: { readOnly: b.readOnly === true } });
  return c.json({ ok: true, readOnly: b.readOnly === true });
});

api.delete("/accounts/:id", async (c) => {
  const s = await requireSigned(c);
  const a = await getAccount(c.req.param("id"), s.user.userId);
  if (!a) throw new HttpError(404, "No such account.");
  await deleteAccount(a.accountId, s.user.userId);
  await audit({ ...who(c, s), kind: "account", action: "account.delete", outcome: "success", target: a.label, details: { email: a.email } });
  return c.json({ ok: true });
});

api.post("/accounts/:id/test", async (c) => {
  const s = await requireSigned(c);
  const a = await getAccount(c.req.param("id"), s.user.userId);
  if (!a) throw new HttpError(404, "No such account.");
  try {
    const r = await testAccount(a);
    await audit({ ...who(c, s), kind: "account", action: "account.test", outcome: "success", target: a.label });
    return c.json(r);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit({ ...who(c, s), kind: "account", action: "account.test", outcome: "failure", target: a.label, details: { error: message } });
    throw new HttpError(502, message);
  }
});

/* ------------------------------- calendars ------------------------------- */

api.get("/calendars", async (c) => {
  const s = await requireSigned(c);
  return c.json((await listCalendars(s.user.userId)).map(redactCalendar));
});

/** Log in and list the collections, storing nothing — the user picks one in the dialog. */
api.post("/calendars/discover", async (c) => {
  const s = await requireSigned(c);
  const b = await jsonBody(c);
  const serverUrl = String(b.serverUrl ?? "").trim();
  const username = String(b.username ?? "").trim();
  let password = String(b.password ?? "");
  if (!serverUrl.startsWith("https://")) throw bad("The server URL must start with https://.");
  if (!username) throw bad("Username is required.");
  if (!password && b.calendarId) {
    // Editing: reuse the stored password when the field is left blank.
    const existing = await getCalendar(String(b.calendarId), s.user.userId);
    if (existing?.pass) password = (await import("../lib/calstore.js")).calendarPassword(existing);
  }
  if (!password) throw bad("Password is required.");
  await assertPublicHost(new URL(serverUrl).hostname);
  try {
    const found = await discoverCalendars({ serverUrl, username, password });
    await audit({ ...who(c, s), kind: "calendar", action: "calendar.discover", outcome: "success", target: serverUrl, details: { found: found.length } });
    return c.json(found);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit({ ...who(c, s), kind: "calendar", action: "calendar.discover", outcome: "failure", target: serverUrl, details: { error: message } });
    throw new HttpError(502, /401|unauthori/i.test(message) ? "Sign-in failed. For iCloud use an app-specific password, not your Apple ID password." : message);
  }
});

api.post("/calendars", async (c) => {
  const s = await requireSigned(c);
  const b = await jsonBody(c);
  const kind = b.kind === "ics" ? "ics" : "caldav";
  const label = String(b.label ?? "").trim().slice(0, 60);
  if (!label) throw bad("Label is required.");
  const isNew = !b.calendarId;
  let source;
  if (kind === "ics") {
    const feedUrl = normalizeFeedUrl(String(b.feedUrl ?? ""));
    await assertPublicHost(new URL(feedUrl).hostname);
    source = await putCalendar({ calendarId: String(b.calendarId || "").trim() || randomUUID(), ownerId: s.user.userId, label, kind, feedUrl });
  } else {
    const serverUrl = String(b.serverUrl ?? "").trim();
    const username = String(b.username ?? "").trim();
    const calendarUrl = String(b.calendarUrl ?? "").trim();
    if (!serverUrl.startsWith("https://") || !username || !calendarUrl) throw bad("Server URL, username and a chosen calendar are required.");
    if (isNew && !b.password) throw bad("A password is required for a new calendar.");
    source = await putCalendar({
      calendarId: String(b.calendarId || "").trim() || randomUUID(),
      ownerId: s.user.userId,
      label,
      kind,
      serverUrl,
      username,
      calendarUrl,
      calendarName: String(b.calendarName ?? "").trim().slice(0, 80) || undefined,
      password: b.password || undefined,
      readOnly: b.readOnly === true,
    });
  }
  await audit({ ...who(c, s), kind: "calendar", action: isNew ? "calendar.create" : "calendar.update", outcome: "success", target: source.label, details: { kind, server: source.serverUrl ?? source.feedUrl, calendar: source.calendarName, readOnly: source.readOnly } });
  return c.json(redactCalendar(source));
});

/** Add every calendar the account exposes at once — one source per collection, same login. */
api.post("/calendars/bulk", async (c) => {
  const s = await requireSigned(c);
  const b = await jsonBody(c);
  let serverUrl = String(b.serverUrl ?? "").trim();
  let username = String(b.username ?? "").trim();
  let password = String(b.password ?? "");
  const prefix = String(b.labelPrefix ?? "").trim().slice(0, 40);
  if (b.calendarId) {
    // From an existing entry: reuse its login, so the user need not retype the password.
    const from = await getCalendar(String(b.calendarId), s.user.userId);
    if (!from || from.kind !== "caldav") throw new HttpError(404, "No such calendar.");
    serverUrl ||= from.serverUrl ?? "";
    username ||= from.username ?? "";
    if (!password && from.pass) password = (await import("../lib/calstore.js")).calendarPassword(from);
  }
  if (!serverUrl.startsWith("https://") || !username || !password) throw bad("Server URL, username and password are required.");
  await assertPublicHost(new URL(serverUrl).hostname);
  const found = await discoverCalendars({ serverUrl, username, password });
  const existing = await listCalendars(s.user.userId);
  const created = [];
  const skipped = [];
  for (const cal of found) {
    if (existing.some((e) => e.calendarUrl === cal.url)) {
      skipped.push(cal.name);
      continue;
    }
    const base = prefix ? `${prefix} ${cal.name}` : cal.name;
    // Labels must stay unique so Claude can address each calendar by name.
    let label = base.slice(0, 60);
    for (let n = 2; [...existing, ...created].some((e) => e.label.toLowerCase() === label.toLowerCase()); n++) label = `${base.slice(0, 56)} ${n}`;
    const source = await putCalendar({
      calendarId: randomUUID(),
      ownerId: s.user.userId,
      label,
      kind: "caldav",
      serverUrl,
      username,
      calendarUrl: cal.url,
      calendarName: cal.name,
      password,
      readOnly: b.readOnly === true || cal.readOnly,
    });
    created.push(source);
  }
  await audit({ ...who(c, s), kind: "calendar", action: "calendar.create-all", outcome: "success", target: serverUrl, details: { created: created.length, skipped: skipped.length, readOnly: b.readOnly === true } });
  return c.json({ created: created.map(redactCalendar), skipped });
});

api.post("/calendars/:id/readonly", async (c) => {
  const s = await requireSigned(c);
  const cal = await getCalendar(c.req.param("id"), s.user.userId);
  if (!cal) throw new HttpError(404, "No such calendar.");
  if (cal.kind === "ics") throw bad("ICS subscriptions are always read-only.");
  const b = await jsonBody(c);
  await setCalendarReadOnly(cal.calendarId, s.user.userId, b.readOnly === true);
  await audit({ ...who(c, s), kind: "calendar", action: "calendar.readonly", outcome: "success", target: cal.label, details: { readOnly: b.readOnly === true } });
  return c.json({ ok: true, readOnly: b.readOnly === true });
});

api.delete("/calendars/:id", async (c) => {
  const s = await requireSigned(c);
  const cal = await getCalendar(c.req.param("id"), s.user.userId);
  if (!cal) throw new HttpError(404, "No such calendar.");
  await deleteCalendar(cal.calendarId, s.user.userId);
  await audit({ ...who(c, s), kind: "calendar", action: "calendar.delete", outcome: "success", target: cal.label, details: { kind: cal.kind } });
  return c.json({ ok: true });
});

api.post("/calendars/:id/test", async (c) => {
  const s = await requireSigned(c);
  const cal = await getCalendar(c.req.param("id"), s.user.userId);
  if (!cal) throw new HttpError(404, "No such calendar.");
  try {
    const r = await testCalendar(cal);
    await audit({ ...who(c, s), kind: "calendar", action: "calendar.test", outcome: "success", target: cal.label });
    return c.json(r);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit({ ...who(c, s), kind: "calendar", action: "calendar.test", outcome: "failure", target: cal.label, details: { error: message } });
    throw new HttpError(502, message);
  }
});

/* -------------------------------- outbox -------------------------------- */

api.get("/outbox", async (c) => {
  const s = await requireSigned(c);
  return c.json({ requireApproval: await requireApproval(s.user.userId), pending: await listPending(s.user.userId) });
});

api.post("/outbox/settings", async (c) => {
  const s = await requireSigned(c);
  const b = await jsonBody(c);
  const value = b.requireApproval !== false;
  await setRequireApproval(s.user.userId, value);
  await audit({ ...who(c, s), kind: "outbox", action: "outbox.require-approval", outcome: "success", details: { requireApproval: value } });
  if (!value) await alertUser(s.user, { title: "Direct sending enabled for Claude", outcome: "failure", details: { ...requestContext(c), Effect: "send_message now sends without approval" } });
  return c.json({ requireApproval: value });
});

/** The human gate: this is the only path that actually puts a queued mail on the wire. */
api.post("/outbox/:id/approve", async (c) => {
  const s = await requireSigned(c);
  const pending = await getPending(c.req.param("id"), s.user.userId);
  if (!pending) throw new HttpError(404, "This item is no longer waiting for approval.");
  const account = await getAccount(pending.accountId, s.user.userId);
  if (!account) throw new HttpError(404, "The sending account no longer exists.");
  const recipients = [pending.to, pending.cc, pending.bcc].filter(Boolean).join(",");
  try {
    const result = await sendParkedMessage(account, pending.folder, pending.uid, recipients);
    await dropPending(pending.id);
    await audit({ ...who(c, s), kind: "outbox", action: "outbox.approve", outcome: "success", target: pending.accountLabel, details: { to: pending.to, subject: pending.subject, filedIn: result.filedIn } });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit({ ...who(c, s), kind: "outbox", action: "outbox.approve", outcome: "failure", target: pending.accountLabel, details: { to: pending.to, subject: pending.subject, error: message } });
    throw new HttpError(502, message);
  }
});

api.post("/outbox/:id/discard", async (c) => {
  const s = await requireSigned(c);
  const pending = await getPending(c.req.param("id"), s.user.userId);
  if (!pending) throw new HttpError(404, "Not found");
  await dropPending(pending.id);
  await audit({ ...who(c, s), kind: "outbox", action: "outbox.discard", outcome: "success", target: pending.accountLabel, details: { to: pending.to, subject: pending.subject } });
  // The parked message stays in Drafts so nothing the user wrote is destroyed.
  return c.json({ discarded: true, stillInDrafts: `${pending.folder} (uid ${pending.uid})` });
});

/* ------------------------- tokens & connected apps ------------------------- */

api.get("/tokens", async (c) => c.json(await listTokens((await requireSigned(c)).user.userId)));

api.post("/tokens", async (c) => {
  const s = await requireSigned(c);
  const b = await jsonBody(c);
  const { token, pat } = await createToken(s.user.userId, String(b.name ?? ""), Number(b.ttlDays) || 90);
  await audit({ ...who(c, s), kind: "token", action: "token.create", outcome: "success", target: pat.name, details: { prefix: pat.prefix, expiresAt: new Date(pat.expiresAt * 1000).toISOString() } });
  await alertUser(s.user, { title: "New personal token created", outcome: "success", details: { ...requestContext(c), Name: pat.name, Prefix: pat.prefix } });
  return c.json({ token, pat });
});

api.delete("/tokens/:id", async (c) => {
  const s = await requireSigned(c);
  const ok = await revokeToken(s.user.userId, c.req.param("id"));
  await audit({ ...who(c, s), kind: "token", action: "token.revoke", outcome: ok ? "success" : "failure", target: c.req.param("id").slice(0, 8) });
  return c.json({ ok });
});

api.get("/grants", async (c) => c.json(await listGrants((await requireSigned(c)).user.userId)));

api.delete("/grants/:id", async (c) => {
  const s = await requireSigned(c);
  const ok = await revokeGrant(s.user.userId, c.req.param("id"));
  await audit({ ...who(c, s), kind: "oauth", action: "oauth.revoke", outcome: ok ? "success" : "failure", target: c.req.param("id").slice(0, 8) });
  return c.json({ ok });
});

/* -------------------------------- sessions -------------------------------- */

api.get("/sessions", async (c) => {
  const s = await requireSigned(c);
  const all = await listSessions(s.user.userId);
  return c.json(all.map((x) => ({ id: x.id, createdAt: x.createdAt, lastSeenAt: x.lastSeenAt, ip: x.ip, current: x.id === s.id })));
});

api.delete("/sessions/:id", async (c) => {
  const s = await requireSigned(c);
  const mine = (await listSessions(s.user.userId)).find((x) => x.id === c.req.param("id"));
  if (!mine) throw new HttpError(404, "No such session.");
  await deleteSessionById(mine.id);
  await audit({ ...who(c, s), kind: "security", action: "session.revoke", outcome: "success" });
  return c.json({ ok: true });
});

api.post("/sessions/revoke-all", async (c) => {
  const s = await requireSigned(c);
  await bumpSessionVersion(s.user);
  await destroySession(c);
  // Also revoke Cognito's refresh tokens so no browser can silently sign back in.
  await globalSignOut(s.user.email).catch((err) => console.error("[cognito] global sign-out failed:", err));
  await audit({ ...who(c, s), kind: "security", action: "session.revoke-all", outcome: "success" });
  return c.json({ ok: true });
});

/* -------------------------------- activity -------------------------------- */

function activityQuery(c: any) {
  const q = c.req.query();
  const kind = q.kind ? (String(q.kind) as AuditKind) : undefined;
  return { from: q.from ? `${q.from}T00:00:00` : undefined, to: q.to ? `${q.to}T23:59:59` : undefined, kind, cursor: q.cursor, limit: 100 };
}

api.get("/activity", async (c) => {
  const s = await requireSigned(c);
  return c.json(await forUser(s.user.userId, activityQuery(c)));
});

api.get("/activity.csv", async (c) => {
  const s = await requireSigned(c);
  const rows = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await forUser(s.user.userId, { ...activityQuery(c), cursor, limit: 500 });
    rows.push(...page.items);
    cursor = page.cursor;
    if (!cursor) break;
  }
  await audit({ ...who(c, s), kind: "security", action: "activity.export", outcome: "success", details: { rows: rows.length } });
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", `attachment; filename="webmail-mcp-activity.csv"`);
  return c.body(toCsv(rows));
});

