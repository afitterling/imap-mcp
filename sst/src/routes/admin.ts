import { Hono } from "hono";
import { type Env, jsonBody, bad, ip, ua, HttpError } from "./ctx.js";
import { requireAdmin } from "../lib/sessions.js";
import { listUsers, getUser, updateUser, publicUser, bumpSessionVersion, type Role, type UserStatus } from "../lib/users.js";
import { countAccounts, listAccounts, redact } from "../lib/store.js";
import { countCalendars } from "../lib/calstore.js";
import { listTokens, revokeAllOfKind } from "../lib/tokens.js";
import { listGrants } from "../lib/oauth.js";
import { audit, forDay, toCsv, type AuditKind, type AuditRow } from "../lib/audit.js";
import { alertUser, alertAdmins, requestContext } from "../lib/notify.js";
import { adminDisableUser, adminEnableUser, adminGlobalSignOut, adminResetMfa, adminUserStatus } from "../lib/cognito.js";
import { getSystemSender, setSystemSender, getSupportContact, setSupportContact } from "../lib/settings.js";

export const admin = new Hono<Env>();

admin.use("*", async (c, next) => {
  await requireAdmin(c);
  await next();
});

admin.get("/users", async (c) => {
  const users = await listUsers();
  const rows = await Promise.all(
    users.map(async (u) => ({
      ...publicUser(u),
      cognito: await adminUserStatus(u.email),
      accounts: await countAccounts(u.userId),
      calendars: await countCalendars(u.userId),
      tokens: (await listTokens(u.userId)).length,
      grants: (await listGrants(u.userId)).length,
    })),
  );
  return c.json(rows);
});

async function target(c: any, actor: { userId: string }) {
  const u = await getUser(c.req.param("id"));
  if (!u) throw new HttpError(404, "No such user.");
  if (u.userId === actor.userId) throw bad("You cannot change your own account here. Use Security instead.");
  return u;
}

admin.post("/users/:id/status", async (c) => {
  const s = await requireAdmin(c);
  const u = await target(c, s.user);
  const value = String((await jsonBody(c)).value) as UserStatus;
  if (value !== "active" && value !== "disabled") throw bad("Status must be active or disabled.");
  await updateUser(u.userId, { status: value });
  if (value === "disabled") {
    await adminDisableUser(u.email);
    await bumpSessionVersion(u);
    await Promise.all([revokeAllOfKind(u.userId, "session#"), revokeAllOfKind(u.userId, "pat#"), revokeAllOfKind(u.userId, "grant#")]);
  }
  if (value === "active") await adminEnableUser(u.email);
  await audit({ userId: u.userId, actorId: s.user.userId, kind: "user", action: "user.status", outcome: "success", details: { status: value }, ip: ip(c), ua: ua(c) });
  await alertUser(u, { title: value === "disabled" ? "Your account was disabled" : "Your account was re-enabled", outcome: value === "disabled" ? "failure" : "success", details: { ...requestContext(c), By: s.user.email } });
  return c.json({ ok: true });
});

admin.post("/users/:id/role", async (c) => {
  const s = await requireAdmin(c);
  const u = await target(c, s.user);
  const value = String((await jsonBody(c)).value) as Role;
  if (value !== "admin" && value !== "user") throw bad("Role must be admin or user.");
  await updateUser(u.userId, { role: value });
  await audit({ userId: u.userId, actorId: s.user.userId, kind: "user", action: "user.role", outcome: "success", details: { role: value }, ip: ip(c), ua: ua(c) });
  await alertAdmins({ title: `Role changed: ${u.email} is now ${value}`, outcome: "success", details: { ...requestContext(c), By: s.user.email } });
  return c.json({ ok: true });
});

/** Lost authenticator: clear the MFA preference in Cognito (it forces a fresh setup at next sign-in) and sign out everywhere. */
admin.post("/users/:id/reset-mfa", async (c) => {
  const s = await requireAdmin(c);
  const u = await target(c, s.user);
  await adminResetMfa(u.email);
  await adminGlobalSignOut(u.email).catch(() => undefined);
  await bumpSessionVersion(u);
  await Promise.all([revokeAllOfKind(u.userId, "session#"), revokeAllOfKind(u.userId, "pat#"), revokeAllOfKind(u.userId, "grant#")]);
  await audit({ userId: u.userId, actorId: s.user.userId, kind: "user", action: "user.reset-mfa", outcome: "success", ip: ip(c), ua: ua(c) });
  await alertUser(u, { title: "Your two-factor settings were reset by an administrator", outcome: "failure", details: { ...requestContext(c), By: s.user.email, Next: "Sign in and enrol a new second factor" } });
  return c.json({ ok: true });
});

admin.post("/users/:id/signout", async (c) => {
  const s = await requireAdmin(c);
  const u = await target(c, s.user);
  await adminGlobalSignOut(u.email).catch(() => undefined);
  await bumpSessionVersion(u);
  const [sessions, pats, grants] = await Promise.all([revokeAllOfKind(u.userId, "session#"), revokeAllOfKind(u.userId, "pat#"), revokeAllOfKind(u.userId, "grant#")]);
  await audit({ userId: u.userId, actorId: s.user.userId, kind: "user", action: "user.signout-all", outcome: "success", details: { sessions, tokens: pats, grants }, ip: ip(c), ua: ua(c) });
  await alertUser(u, { title: "An administrator signed you out everywhere", outcome: "failure", details: { ...requestContext(c), By: s.user.email, Revoked: `${sessions} sessions, ${pats} tokens, ${grants} apps` } });
  return c.json({ ok: true });
});

/* -------------------------------- activity -------------------------------- */

async function withEmails(rows: AuditRow[]) {
  const ids = new Set<string>();
  rows.forEach((r) => {
    ids.add(r.userId);
    if (r.actorId) ids.add(r.actorId);
  });
  const emails = new Map<string, string>();
  await Promise.all([...ids].map(async (id) => emails.set(id, (await getUser(id))?.email ?? id)));
  return rows.map((r) => ({ ...r, userEmail: emails.get(r.userId), actorEmail: r.actorId ? emails.get(r.actorId) : undefined }));
}

function dayOf(c: any): string {
  const day = String(c.req.query("day") ?? new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw bad("day must be YYYY-MM-DD");
  return day;
}

admin.get("/activity", async (c) => {
  const kind = c.req.query("kind") ? (String(c.req.query("kind")) as AuditKind) : undefined;
  const page = await forDay(dayOf(c), { kind, cursor: c.req.query("cursor"), limit: 100 });
  return c.json({ items: await withEmails(page.items), cursor: page.cursor });
});

admin.get("/activity.csv", async (c) => {
  const s = await requireAdmin(c);
  const day = dayOf(c);
  const kind = c.req.query("kind") ? (String(c.req.query("kind")) as AuditKind) : undefined;
  const rows: AuditRow[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 40; i++) {
    const page = await forDay(day, { kind, cursor, limit: 500 });
    rows.push(...page.items);
    cursor = page.cursor;
    if (!cursor) break;
  }
  await audit({ userId: s.user.userId, kind: "security", action: "activity.export-all", outcome: "success", details: { day, rows: rows.length }, ip: ip(c), ua: ua(c) });
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", `attachment; filename="webmail-mcp-activity-${day}.csv"`);
  return c.body(toCsv(rows));
});

/* -------------------------------- settings -------------------------------- */

admin.get("/settings", async (c) => {
  const s = await requireAdmin(c);
  return c.json({
    systemSender: (await getSystemSender()) ?? "",
    accounts: (await listAccounts(s.user.userId)).map(redact),
    support: await getSupportContact(),
  });
});

admin.post("/settings", async (c) => {
  const s = await requireAdmin(c);
  const b = await jsonBody(c);
  const sender = String(b.systemSender ?? "");
  if (sender) {
    const mine = (await listAccounts(s.user.userId)).some((a) => a.accountId === sender);
    if (!mine) throw bad("The system sender must be one of your own accounts.");
  }
  await setSystemSender(sender || undefined);
  await setSupportContact({ email: String(b.supportEmail ?? ""), note: String(b.supportNote ?? "") });
  await audit({ userId: s.user.userId, kind: "settings", action: "settings.update", outcome: "success", details: { systemSender: sender || "auto", supportEmail: String(b.supportEmail ?? "") }, ip: ip(c), ua: ua(c) });
  return c.json({ ok: true });
});
