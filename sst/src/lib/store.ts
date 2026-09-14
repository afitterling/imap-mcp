import { GetCommand, PutCommand, ScanCommand, DeleteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { doc } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";

const TABLE = () => Resource.Accounts.name;

export type Endpoint = { host: string; port: number; secure: boolean; user: string };

export type Account = {
  accountId: string;
  ownerId: string;
  label: string;
  email: string;
  imap: Endpoint;
  smtp: Endpoint;
  /** Claude may read but never change, send from, or draft in this mailbox. */
  readOnly: boolean;
  createdAt: string;
  /** Encrypted blobs — never leave the server. */
  imapPass?: string;
  smtpPass?: string;
};

/** Account shape safe to return to the browser or to an MCP client. */
export type PublicAccount = Omit<Account, "imapPass" | "smtpPass" | "ownerId">;

export function redact(a: Account): PublicAccount {
  const { imapPass: _i, smtpPass: _s, ownerId: _o, ...rest } = a;
  return { ...rest, readOnly: a.readOnly === true };
}

export async function listAccounts(ownerId: string): Promise<Account[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "byOwner",
      KeyConditionExpression: "ownerId = :o",
      ExpressionAttributeValues: { ":o": ownerId },
    }),
  );
  return ((res.Items ?? []) as Account[]).sort((a, b) => a.label.localeCompare(b.label));
}

export async function countAccounts(ownerId: string): Promise<number> {
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

/** Fetch only if `ownerId` owns it — every account read goes through the owner check. */
export async function getAccount(accountId: string, ownerId: string): Promise<Account | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { accountId } }));
  const a = res.Item as Account | undefined;
  return a && a.ownerId === ownerId ? a : undefined;
}

/**
 * Resolve by id, label or email so MCP callers can say "work" instead of a uuid.
 * Only the caller's own accounts are ever candidates.
 */
export async function resolveAccount(ref: string, ownerId: string): Promise<Account> {
  const direct = await getAccount(ref, ownerId);
  if (direct) return direct;
  const all = await listAccounts(ownerId);
  const needle = ref.trim().toLowerCase();
  const hit = all.find((a) => a.label.toLowerCase() === needle || a.email.toLowerCase() === needle);
  if (hit) return hit;
  const partial = all.filter((a) => a.label.toLowerCase().includes(needle) || a.email.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  const known = all.map((a) => `${a.label} <${a.email}>`).join(", ") || "none configured yet";
  throw new Error(`No mail account matches "${ref}". Known accounts: ${known}`);
}

export async function putAccount(
  input: Omit<Account, "createdAt" | "readOnly"> & { imapPassword?: string; smtpPassword?: string; readOnly?: boolean },
): Promise<Account> {
  const existing = await getAccount(input.accountId, input.ownerId);
  const account: Account = {
    accountId: input.accountId,
    ownerId: input.ownerId,
    label: input.label,
    email: input.email,
    imap: input.imap,
    smtp: input.smtp,
    readOnly: input.readOnly ?? existing?.readOnly ?? false,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    // Keep the stored secret when the form leaves the password field blank.
    imapPass: input.imapPassword ? encrypt(input.imapPassword) : existing?.imapPass,
    smtpPass: input.smtpPassword ? encrypt(input.smtpPassword) : existing?.smtpPass,
  };
  // Never let a put steal someone else's accountId.
  await doc.send(
    new PutCommand({
      TableName: TABLE(),
      Item: account,
      ConditionExpression: "attribute_not_exists(accountId) OR ownerId = :o",
      ExpressionAttributeValues: { ":o": input.ownerId },
    }),
  );
  return account;
}

export async function setReadOnly(accountId: string, ownerId: string, readOnly: boolean): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { accountId },
      UpdateExpression: "SET readOnly = :r",
      ConditionExpression: "ownerId = :o",
      ExpressionAttributeValues: { ":r": readOnly, ":o": ownerId },
    }),
  );
}

export async function deleteAccount(accountId: string, ownerId: string): Promise<void> {
  await doc.send(
    new DeleteCommand({
      TableName: TABLE(),
      Key: { accountId },
      ConditionExpression: "ownerId = :o",
      ExpressionAttributeValues: { ":o": ownerId },
    }),
  );
}

/**
 * Accounts created before ownership existed have no ownerId. The first administrator
 * to sign up claims them, so nothing configured in production goes dark.
 */
export async function claimOrphanAccounts(ownerId: string): Promise<number> {
  const res = await doc.send(new ScanCommand({ TableName: TABLE(), FilterExpression: "attribute_not_exists(ownerId)" }));
  const orphans = (res.Items ?? []) as Account[];
  await Promise.all(
    orphans.map((a) =>
      doc.send(
        new UpdateCommand({
          TableName: TABLE(),
          Key: { accountId: a.accountId },
          UpdateExpression: "SET ownerId = :o, readOnly = if_not_exists(readOnly, :f)",
          ConditionExpression: "attribute_not_exists(ownerId)",
          ExpressionAttributeValues: { ":o": ownerId, ":f": false },
        }),
      ),
    ),
  );
  return orphans.length;
}

export function imapPassword(a: Account): string {
  if (!a.imapPass) throw new Error(`Account "${a.label}" has no IMAP password stored.`);
  return decrypt(a.imapPass);
}

export function smtpPassword(a: Account): string {
  return a.smtpPass ? decrypt(a.smtpPass) : imapPassword(a);
}
