import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { randomBytes } from "node:crypto";
import { doc, epoch } from "./db.js";

const TABLE = () => Resource.Audit.name;
const RETENTION_DAYS = 365;

/** Rows about things that happened before anyone was signed in (bad logins, denied sign-ups). */
export const ANONYMOUS = "anonymous";

export type AuditKind = "auth" | "mfa" | "oauth" | "token" | "mcp" | "account" | "calendar" | "outbox" | "user" | "security" | "settings";
export type Outcome = "success" | "failure" | "denied";

export type AuditEntry = {
  /** Whose activity this is (the affected user). */
  userId: string;
  /** Who did it, when different (an admin acting on a user). */
  actorId?: string;
  kind: AuditKind;
  action: string;
  outcome: Outcome;
  target?: string;
  details?: Record<string, string | number | boolean | undefined>;
  ip?: string;
  ua?: string;
  client?: string;
  durationMs?: number;
};

export type AuditRow = AuditEntry & { ts: string; day: string; at: string };

/** Callers never wait on the audit trail failing: a broken log must not break a login. */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const now = new Date();
    const at = now.toISOString();
    const row: AuditRow & { expiresAt: number } = {
      ...entry,
      details: entry.details && compact(entry.details),
      ts: `${at}#${randomBytes(4).toString("hex")}`,
      day: at.slice(0, 10),
      at,
      expiresAt: epoch() + RETENTION_DAYS * 86400,
    };
    // Structured line for CloudWatch Logs (the function logs in JSON format); no bodies, no secrets.
    console.log(JSON.stringify({ type: "audit", ...row, ua: undefined, expiresAt: undefined }));
    await doc.send(new PutCommand({ TableName: TABLE(), Item: row }));
  } catch (err) {
    console.error("[audit] write failed:", err, entry.kind, entry.action);
  }
}

function compact(details: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(details)) {
    if (v === undefined || v === null || v === "") continue;
    // Keep rows small; anything long is truncated, never a message body.
    out[k] = typeof v === "string" ? v.slice(0, 200) : (v as string | number | boolean);
  }
  return out;
}

export type AuditQuery = { from?: string; to?: string; kind?: AuditKind; limit?: number; cursor?: string };
export type AuditPage = { items: AuditRow[]; cursor?: string };

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined;
}
function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    return undefined;
  }
}

async function query(index: string | undefined, hashName: string, hashValue: string, q: AuditQuery): Promise<AuditPage> {
  const names: Record<string, string> = { "#h": hashName };
  const values: Record<string, unknown> = { ":h": hashValue };
  let keyCond = "#h = :h";
  if (q.from && q.to) {
    keyCond += " AND ts BETWEEN :from AND :to";
    values[":from"] = q.from;
    values[":to"] = `${q.to}￿`;
  } else if (q.from) {
    keyCond += " AND ts >= :from";
    values[":from"] = q.from;
  } else if (q.to) {
    keyCond += " AND ts <= :to";
    values[":to"] = `${q.to}￿`;
  }
  let filter: string | undefined;
  if (q.kind) {
    filter = "kind = :kind";
    values[":kind"] = q.kind;
  }
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: index,
      KeyConditionExpression: keyCond,
      FilterExpression: filter,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ScanIndexForward: false,
      Limit: Math.min(q.limit ?? 100, 500),
      ExclusiveStartKey: decodeCursor(q.cursor),
    }),
  );
  return { items: (res.Items ?? []) as AuditRow[], cursor: encodeCursor(res.LastEvaluatedKey) };
}

export function forUser(userId: string, q: AuditQuery = {}): Promise<AuditPage> {
  return query(undefined, "userId", userId, q);
}

/** Admin view: everyone's activity for one calendar day (UTC). */
export function forDay(day: string, q: AuditQuery = {}): Promise<AuditPage> {
  return query("byDay", "day", day, q);
}

export function toCsv(rows: AuditRow[]): string {
  const cell = (v: unknown) => {
    const s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["time", "user", "actor", "kind", "action", "outcome", "target", "client", "ip", "durationMs", "details"];
  const lines = rows.map((r) =>
    [r.at, r.userId, r.actorId ?? "", r.kind, r.action, r.outcome, r.target ?? "", r.client ?? "", r.ip ?? "", r.durationMs ?? "", r.details ?? ""]
      .map(cell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n") + "\n";
}
