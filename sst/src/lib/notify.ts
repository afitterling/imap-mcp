import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { listAccounts } from "./store.js";
import { sendMessage } from "./mail.js";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export type Alert = {
  title: string;
  outcome: "success" | "failure";
  details: Record<string, string | undefined>;
};

/**
 * Atomic throttle so a brute-force attempt can't turn into a mail flood: the first
 * write in the window wins, the rest fail the condition and are dropped.
 */
async function claimWindow(key: string, windowSeconds: number): Promise<boolean> {
  try {
    await doc.send(
      new PutCommand({
        TableName: Resource.OAuth.name,
        Item: { id: `alert#${key}`, expiresAt: Math.floor(Date.now() / 1000) + windowSeconds },
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Mail the operator about a sign-in attempt. Sent from the first configured account
 * to its own address. Never throws: an alert failure must not break a login.
 */
export async function sendSecurityAlert(alert: Alert): Promise<void> {
  try {
    // Failures are throttled to one mail per 5 minutes; successes are rare, so always send.
    const throttleKey = `${alert.outcome}#${alert.title}`;
    if (alert.outcome === "failure" && !(await claimWindow(throttleKey, 300))) return;

    const accounts = await listAccounts();
    const sender = accounts[0];
    if (!sender) return; // Nothing configured yet — nowhere to send from.

    const rows = Object.entries(alert.details)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k.padEnd(14)} ${v}`)
      .join("\n");

    const mark = alert.outcome === "success" ? "✓" : "⚠";
    await sendMessage(sender, {
      to: sender.email,
      subject: `${mark} Webmail MCP — ${alert.title}`,
      text: [
        `${alert.title}`,
        "",
        rows,
        "",
        alert.outcome === "failure"
          ? "If this was not you, rotate the admin password and the MCP token now:"
          : "If this was not you, rotate your credentials:",
        "  sst secret set AdminPassword <new> --stage production",
        "  sst secret set McpToken <new> --stage production",
        "  sst secret set EncryptionKey <new> --stage production   # also revokes every OAuth grant",
        "",
        "Further failure alerts of this kind are suppressed for 5 minutes.",
      ].join("\n"),
    });
  } catch (err) {
    console.error("[alert] could not send security alert:", err);
  }
}

/** Caller fingerprint from the Lambda Function URL request headers. */
export function requestContext(c: any): Record<string, string | undefined> {
  const forwarded = c.req.header("x-forwarded-for");
  return {
    Time: new Date().toISOString(),
    "IP address": forwarded ? forwarded.split(",")[0].trim() : undefined,
    Browser: c.req.header("user-agent"),
  };
}
