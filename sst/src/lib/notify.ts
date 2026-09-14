import { sendMessage } from "./mail.js";
import { claimWindow } from "./ratelimit.js";
import { listUsers, type User } from "./users.js";
import type { Account } from "./store.js";
import type { Context } from "hono";

export type Alert = {
  title: string;
  outcome: "success" | "failure";
  details: Record<string, string | undefined>;
};

/**
 * Alerts are sent from the first mailbox anyone has added. Undefined until somebody has
 * added one — at which point nothing can be mailed yet.
 */
export async function systemSender(): Promise<Account | undefined> {
  const { listAccounts } = await import("./store.js");
  for (const u of await listUsers()) {
    const [first] = await listAccounts(u.userId);
    if (first) return first;
  }
  return undefined;
}

export async function sendSystemMail(to: string, subject: string, text: string): Promise<boolean> {
  const sender = await systemSender();
  if (!sender) return false;
  await sendMessage(sender, { to, subject, text });
  return true;
}

function render(alert: Alert): string {
  const rows = Object.entries(alert.details)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k.padEnd(14)} ${v}`)
    .join("\n");
  return [
    alert.title,
    "",
    rows,
    "",
    alert.outcome === "failure"
      ? "If this was not you, sign in, change your password and review Security → Sessions and Connected apps."
      : "If this was not you, sign in now, change your password and revoke any token or app you do not recognise.",
    "",
    "Further alerts of this kind are suppressed for 5 minutes.",
  ].join("\n");
}

/**
 * Mail a user about something that happened on their account. Never throws: an alert
 * failure must not break a login. Failures are throttled per user and kind.
 */
export async function alertUser(user: Pick<User, "userId" | "email">, alert: Alert): Promise<void> {
  try {
    const throttleKey = `${user.userId}#${alert.outcome}#${alert.title}`;
    if (alert.outcome === "failure" && !(await claimWindow(throttleKey, 300))) return;
    const mark = alert.outcome === "success" ? "✓" : "⚠";
    await sendSystemMail(user.email, `${mark} WebMail / Private Office MCP — ${alert.title}`, render(alert));
  } catch (err) {
    console.error("[alert] could not send alert:", err);
  }
}

/** Things everyone should hear about (a new user joined, someone was disabled). */
export async function alertEveryone(alert: Alert): Promise<void> {
  try {
    if (alert.outcome === "failure" && !(await claimWindow(`all#${alert.title}`, 300))) return;
    const people = (await listUsers()).filter((u) => u.status === "active");
    const mark = alert.outcome === "success" ? "✓" : "⚠";
    await Promise.all(people.map((a) => sendSystemMail(a.email, `${mark} WebMail / Private Office MCP — ${alert.title}`, render(alert))));
  } catch (err) {
    console.error("[alert] could not alert admins:", err);
  }
}

/** Caller fingerprint from the Lambda Function URL request headers. */
export function requestContext(c: Context): Record<string, string | undefined> {
  const forwarded = c.req.header("x-forwarded-for");
  return {
    Time: new Date().toISOString(),
    "IP address": forwarded ? forwarded.split(",")[0].trim() : undefined,
    Browser: c.req.header("user-agent"),
  };
}
