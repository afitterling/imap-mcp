import { GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { doc } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";

const TABLE = () => Resource.Calendars.name;

export type CalendarKind = "caldav" | "ics";

export type CalendarSource = {
  calendarId: string;
  ownerId: string;
  label: string;
  kind: CalendarKind;
  /** CalDAV: server, login and the one collection this source points at. */
  serverUrl?: string;
  username?: string;
  /** Encrypted app-specific password — never leaves the server. */
  pass?: string;
  calendarUrl?: string;
  calendarName?: string;
  /** ICS: the subscription URL (webcal:// is stored as https://). */
  feedUrl?: string;
  /** Claude may read but never change this calendar. Always true for ICS feeds. */
  readOnly: boolean;
  createdAt: string;
};

export type PublicCalendar = Omit<CalendarSource, "pass" | "ownerId">;

export function redactCalendar(c: CalendarSource): PublicCalendar {
  const { pass: _p, ownerId: _o, ...rest } = c;
  return { ...rest, readOnly: c.kind === "ics" || c.readOnly === true };
}

export function isReadOnly(c: CalendarSource): boolean {
  return c.kind === "ics" || c.readOnly === true;
}

export async function listCalendars(ownerId: string): Promise<CalendarSource[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "byOwner",
      KeyConditionExpression: "ownerId = :o",
      ExpressionAttributeValues: { ":o": ownerId },
    }),
  );
  return ((res.Items ?? []) as CalendarSource[]).sort((a, b) => a.label.localeCompare(b.label));
}

export async function countCalendars(ownerId: string): Promise<number> {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "byOwner",
      KeyConditionExpression: "ownerId = :o",
      ExpressionAttributeValues: { ":o": ownerId },
      Select: "COUNT",
    }),
  );
  return res.Count ?? 0;
}

export async function getCalendar(calendarId: string, ownerId: string): Promise<CalendarSource | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { calendarId } }));
  const c = res.Item as CalendarSource | undefined;
  return c && c.ownerId === ownerId ? c : undefined;
}

/** Resolve by id, label or the CalDAV collection's display name — only within the owner's sources. */
export async function resolveCalendar(ref: string, ownerId: string): Promise<CalendarSource> {
  const direct = await getCalendar(ref, ownerId);
  if (direct) return direct;
  const all = await listCalendars(ownerId);
  const needle = ref.trim().toLowerCase();
  const exact = all.find((c) => c.label.toLowerCase() === needle || c.calendarName?.toLowerCase() === needle);
  if (exact) return exact;
  const partial = all.filter((c) => c.label.toLowerCase().includes(needle) || c.calendarName?.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  const known = all.map((c) => `${c.label}${c.calendarName ? ` (${c.calendarName})` : ""}`).join(", ") || "none configured yet";
  throw new Error(`No calendar matches "${ref}". Known calendars: ${known}`);
}

export async function putCalendar(
  input: Omit<CalendarSource, "createdAt" | "pass" | "readOnly"> & { password?: string; readOnly?: boolean },
): Promise<CalendarSource> {
  const existing = await getCalendar(input.calendarId, input.ownerId);
  const source: CalendarSource = {
    calendarId: input.calendarId,
    ownerId: input.ownerId,
    label: input.label,
    kind: input.kind,
    serverUrl: input.serverUrl,
    username: input.username,
    calendarUrl: input.calendarUrl,
    calendarName: input.calendarName,
    feedUrl: input.feedUrl,
    readOnly: input.kind === "ics" ? true : (input.readOnly ?? existing?.readOnly ?? false),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    // Keep the stored secret when the form leaves the password field blank.
    pass: input.password ? encrypt(input.password) : existing?.pass,
  };
  await doc.send(
    new PutCommand({
      TableName: TABLE(),
      Item: source,
      ConditionExpression: "attribute_not_exists(calendarId) OR ownerId = :o",
      ExpressionAttributeValues: { ":o": input.ownerId },
    }),
  );
  return source;
}

export async function setCalendarReadOnly(calendarId: string, ownerId: string, readOnly: boolean): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { calendarId },
      UpdateExpression: "SET readOnly = :r",
      ConditionExpression: "ownerId = :o",
      ExpressionAttributeValues: { ":r": readOnly, ":o": ownerId },
    }),
  );
}

export async function deleteCalendar(calendarId: string, ownerId: string): Promise<void> {
  await doc.send(
    new DeleteCommand({
      TableName: TABLE(),
      Key: { calendarId },
      ConditionExpression: "ownerId = :o",
      ExpressionAttributeValues: { ":o": ownerId },
    }),
  );
}

export function calendarPassword(c: CalendarSource): string {
  if (!c.pass) throw new Error(`Calendar "${c.label}" has no password stored.`);
  return decrypt(c.pass);
}
