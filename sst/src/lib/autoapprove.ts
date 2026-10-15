import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { randomUUID } from "node:crypto";
import { doc } from "./db.js";
import { normalizeEmail } from "./allowlist.js";

const TABLE = () => Resource.OAuth.name;

/**
 * Recipients the user trusts Claude to mail without a click in the Outbox. A mail skips the
 * queue only when EVERY recipient (to, cc and bcc) is on this list for the sending account.
 *
 * The list is edited through the web app's /api routes only — there is deliberately no MCP
 * tool for it, so the model can never widen its own sending rights.
 */
export type AutoApproved = {
  id: string;
  /** Normalised (trimmed, lower-case) address. */
  address: string;
  /** The account this applies to; undefined = any of the user's accounts. */
  accountId?: string;
  createdAt: string;
};

export const MAX_ENTRIES = 50;
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export async function listAutoApproved(userId: string): Promise<AutoApproved[]> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { id: `config#autoapprove#${userId}` } }));
  return ((res.Item?.entries as AutoApproved[] | undefined) ?? []).slice();
}

async function save(userId: string, entries: AutoApproved[]): Promise<void> {
  await doc.send(new PutCommand({ TableName: TABLE(), Item: { id: `config#autoapprove#${userId}`, userId, entries } }));
}

export function validateAddress(input: unknown): string {
  const address = normalizeEmail(String(input ?? ""));
  if (!EMAIL.test(address)) throw new Error("Enter a single, plain e-mail address (name@example.com).");
  return address;
}

export async function addAutoApproved(userId: string, address: string, accountId?: string): Promise<AutoApproved> {
  const entries = await listAutoApproved(userId);
  const clean = validateAddress(address);
  const existing = entries.find((e) => e.address === clean && e.accountId === accountId);
  if (existing) return existing;
  if (entries.length >= MAX_ENTRIES) throw new Error(`At most ${MAX_ENTRIES} auto-approved recipients.`);
  const entry: AutoApproved = { id: randomUUID().slice(0, 8), address: clean, accountId, createdAt: new Date().toISOString() };
  entries.push(entry);
  await save(userId, entries);
  return entry;
}

export async function removeAutoApproved(userId: string, id: string): Promise<AutoApproved | undefined> {
  const entries = await listAutoApproved(userId);
  const gone = entries.find((e) => e.id === id);
  if (!gone) return undefined;
  await save(userId, entries.filter((e) => e.id !== id));
  return gone;
}

/* ------------------------------- evaluation ------------------------------- */

/**
 * Split a header-style recipient list ("Ann <a@x.y>, b@x.y") into bare addresses.
 * Returns undefined when any part is not a clean address, so anything odd falls back to the
 * Outbox rather than being guessed at.
 */
export function parseRecipients(...fields: (string | undefined)[]): string[] | undefined {
  const out: string[] = [];
  for (const field of fields) {
    if (!field?.trim()) continue;
    // Commas inside quoted display names are not separators.
    const parts = field.match(/(?:"[^"]*"|[^,;])+/g) ?? [];
    for (const raw of parts) {
      const part = raw.trim();
      if (!part) continue;
      const angle = part.match(/<([^<>]+)>\s*$/);
      const candidate = normalizeEmail(angle ? angle[1] : part);
      if (!EMAIL.test(candidate)) return undefined;
      out.push(candidate);
    }
  }
  return out;
}

/** True only when there is at least one recipient and every one of them is covered. */
export function allCovered(entries: AutoApproved[], accountId: string, recipients: string[] | undefined): boolean {
  if (!recipients?.length) return false;
  const allowed = new Set(entries.filter((e) => !e.accountId || e.accountId === accountId).map((e) => e.address));
  return recipients.every((r) => allowed.has(r));
}

/** Convenience for the send tools: may this mail from `accountId` go out without a click? */
export async function mayAutoSend(userId: string, accountId: string, ...fields: (string | undefined)[]): Promise<boolean> {
  return allCovered(await listAutoApproved(userId), accountId, parseRecipients(...fields));
}
