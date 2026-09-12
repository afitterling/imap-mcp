import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { encrypt, decrypt } from "./crypto.js";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = Resource.Accounts.name;

export type Endpoint = { host: string; port: number; secure: boolean; user: string };

export type Account = {
  accountId: string;
  label: string;
  email: string;
  imap: Endpoint;
  smtp: Endpoint;
  createdAt: string;
  /** Encrypted blobs — never leave the server. */
  imapPass?: string;
  smtpPass?: string;
};

/** Account shape safe to return to the browser or to an MCP client. */
export type PublicAccount = Omit<Account, "imapPass" | "smtpPass">;

export function redact(a: Account): PublicAccount {
  const { imapPass: _i, smtpPass: _s, ...rest } = a;
  return rest;
}

export async function listAccounts(): Promise<Account[]> {
  const res = await doc.send(new ScanCommand({ TableName: TABLE }));
  return ((res.Items ?? []) as Account[]).sort((a, b) => a.label.localeCompare(b.label));
}

export async function getAccount(accountId: string): Promise<Account | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { accountId } }));
  return res.Item as Account | undefined;
}

/**
 * Resolve by id, label or email so MCP callers can say "work" instead of a uuid.
 */
export async function resolveAccount(ref: string): Promise<Account> {
  const direct = await getAccount(ref);
  if (direct) return direct;
  const all = await listAccounts();
  const needle = ref.trim().toLowerCase();
  const hit = all.find((a) => a.label.toLowerCase() === needle || a.email.toLowerCase() === needle);
  if (hit) return hit;
  const partial = all.filter((a) => a.label.toLowerCase().includes(needle) || a.email.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  const known = all.map((a) => `${a.label} <${a.email}>`).join(", ") || "none configured yet";
  throw new Error(`No mail account matches "${ref}". Known accounts: ${known}`);
}

export async function putAccount(
  input: Omit<Account, "createdAt"> & { imapPassword?: string; smtpPassword?: string; createdAt?: string },
): Promise<Account> {
  const existing = await getAccount(input.accountId);
  const account: Account = {
    accountId: input.accountId,
    label: input.label,
    email: input.email,
    imap: input.imap,
    smtp: input.smtp,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    // Keep the stored secret when the form leaves the password field blank.
    imapPass: input.imapPassword ? encrypt(input.imapPassword) : existing?.imapPass,
    smtpPass: input.smtpPassword ? encrypt(input.smtpPassword) : existing?.smtpPass,
  };
  await doc.send(new PutCommand({ TableName: TABLE, Item: account }));
  return account;
}

export async function deleteAccount(accountId: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: { accountId } }));
}

export function imapPassword(a: Account): string {
  if (!a.imapPass) throw new Error(`Account "${a.label}" has no IMAP password stored.`);
  return decrypt(a.imapPass);
}

export function smtpPassword(a: Account): string {
  return a.smtpPass ? decrypt(a.smtpPass) : imapPassword(a);
}
